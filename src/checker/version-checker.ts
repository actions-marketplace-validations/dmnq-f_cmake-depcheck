import { FetchContentDependency } from '../parser/types.js';
import { UpdateCheckResult } from './types.js';
import { fetchRemoteTags, TagInfo } from './git-tags.js';
import { findLatestVersion, findIntermediateTags } from './version-compare.js';
import {
  extractGitHubUrlInfo,
  buildUpdatedUrl,
  verifyUrlExists,
  GitHubUrlInfo,
} from './github-url.js';
import { commentIndicatesPin } from '../cmake-utils.js';
import { SHA_PATTERN } from '../constants.js';

async function pool<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  const executing = new Set<Promise<void>>();
  for (const item of items) {
    const p = fn(item).then(() => {
      executing.delete(p);
    });
    executing.add(p);
    if (executing.size >= concurrency) {
      await Promise.race(executing);
    }
  }
  await Promise.all(executing);
}

/** Options controlling update-check behavior. */
export interface CheckOptions {
  /**
   * Reverse-resolve SHA-pinned git deps against upstream tag commit SHAs to
   * enable update checking on them. When false, SHA-pinned deps stay
   * `'pinned'` and are not network-checked. Defaults to true.
   */
  resolveSha?: boolean;
}

/**
 * Check all dependencies for available updates.
 * Pre-classifies skip cases, deduplicates by repo URL, and fetches tags concurrently.
 */
export async function checkForUpdates(
  deps: FetchContentDependency[],
  onProgress?: (completed: number, total: number) => void,
  options: CheckOptions = {},
): Promise<UpdateCheckResult[]> {
  const resolveSha = options.resolveSha !== false;
  const results = new Map<FetchContentDependency, UpdateCheckResult>();
  const urlGitHubInfo = new Map<FetchContentDependency, GitHubUrlInfo>();

  // Pre-classify deps that don't need a network check
  const needsCheck: FetchContentDependency[] = [];
  for (const dep of deps) {
    if (dep.sourceType === 'url') {
      const ghInfo = dep.url ? extractGitHubUrlInfo(dep.url) : null;
      if (!ghInfo) {
        results.set(dep, { dep, status: 'unsupported', versionSource: 'url' });
      } else if (SHA_PATTERN.test(ghInfo.tag)) {
        results.set(dep, {
          dep,
          status: 'pinned',
          versionSource: 'url',
          resolvedVersion: ghInfo.tag,
        });
      } else {
        urlGitHubInfo.set(dep, ghInfo);
        needsCheck.push(dep);
      }
    } else if (!dep.gitTag) {
      results.set(dep, { dep, status: 'unpinned', versionSource: 'git-tag' });
    } else if (dep.gitTagIsSha) {
      if (!resolveSha || !dep.gitRepository) {
        results.set(dep, { dep, status: 'pinned', versionSource: 'sha' });
      } else {
        needsCheck.push(dep);
      }
    } else if (dep.gitTag.includes('${')) {
      results.set(dep, { dep, status: 'unresolved-variable', versionSource: 'git-tag' });
    } else if (!dep.gitRepository) {
      results.set(dep, {
        dep,
        status: 'check-failed',
        versionSource: 'git-tag',
        error: 'No git repository URL',
      });
    } else {
      needsCheck.push(dep);
    }
  }

  // Deduplicate by repo URL
  const repoToDeps = new Map<string, FetchContentDependency[]>();
  for (const dep of needsCheck) {
    const ghInfo = urlGitHubInfo.get(dep);
    const url = ghInfo ? ghInfo.repoUrl : dep.gitRepository!;
    const group = repoToDeps.get(url);
    if (group) {
      group.push(dep);
    } else {
      repoToDeps.set(url, [dep]);
    }
  }

  // Fetch tags for each unique repo with concurrency limit
  const repoTags = new Map<string, TagInfo[]>();
  const repoErrors = new Map<string, string>();
  let completed = 0;
  const totalRepos = repoToDeps.size;

  await pool([...repoToDeps.keys()], 4, async (repoUrl) => {
    try {
      const tags = await fetchRemoteTags(repoUrl);
      repoTags.set(repoUrl, tags);
    } catch (err) {
      repoErrors.set(repoUrl, err instanceof Error ? err.message : String(err));
    }
    completed++;
    onProgress?.(completed, totalRepos);
  });

  // Map results back to each dependency
  for (const dep of needsCheck) {
    const ghInfo = urlGitHubInfo.get(dep);
    const repoUrl = ghInfo ? ghInfo.repoUrl : dep.gitRepository!;
    const isShaPinned = !ghInfo && dep.gitTagIsSha === true;
    const versionSource: 'git-tag' | 'sha' | 'url' = ghInfo
      ? 'url'
      : isShaPinned
        ? 'sha'
        : 'git-tag';

    // Per-dep pin-comment escape hatch: maintainer marked this SHA as deliberately frozen
    if (isShaPinned && dep.gitTagComment !== undefined && commentIndicatesPin(dep.gitTagComment)) {
      results.set(dep, { dep, status: 'pinned', versionSource: 'sha' });
      continue;
    }

    const error = repoErrors.get(repoUrl);
    if (error) {
      results.set(dep, {
        dep,
        status: 'check-failed',
        versionSource,
        error,
        ...(ghInfo && { resolvedVersion: ghInfo.tag }),
      });
      continue;
    }

    const tagInfos = repoTags.get(repoUrl) ?? [];

    // SHA reverse-resolution: find the upstream tag whose SHA matches the pinned SHA.
    // Accept either the commit SHA or the tag-object SHA — users pin either convention.
    let resolvedTag: string | undefined;
    let pinStyle: 'commit' | 'tag' = 'commit';
    if (isShaPinned) {
      const pinnedSha = dep.gitTag!.toLowerCase();
      const match = tagInfos.find(
        (t) => t.commitSha.toLowerCase() === pinnedSha || t.tagSha.toLowerCase() === pinnedSha,
      );
      if (!match) {
        results.set(dep, { dep, status: 'pinned', versionSource: 'sha' });
        continue;
      }
      resolvedTag = match.tag;
      pinStyle = match.tagSha.toLowerCase() === pinnedSha ? 'tag' : 'commit';
    }

    const currentTag = resolvedTag ?? (ghInfo ? ghInfo.tag : dep.gitTag!);
    const tags = tagInfos.map((t) => t.tag);
    const versionResult = findLatestVersion(currentTag, tags);

    if (!versionResult) {
      results.set(dep, {
        dep,
        status: 'check-failed',
        versionSource,
        error: 'No comparable tags found',
        ...(ghInfo && { resolvedVersion: ghInfo.tag }),
        ...(resolvedTag && { resolvedTag }),
      });
      continue;
    }

    if (versionResult.latest === currentTag) {
      results.set(dep, {
        dep,
        status: 'up-to-date',
        versionSource,
        latestVersion: versionResult.latest,
        ...(ghInfo && { resolvedVersion: ghInfo.tag }),
        ...(resolvedTag && { resolvedTag }),
      });
    } else if (ghInfo) {
      // URL dep with an available update — build the updated URL
      const candidateUrl = buildUpdatedUrl(ghInfo, versionResult.latest);

      // Validate releases-download URLs with HEAD request
      if (ghInfo.pattern === 'releases-download') {
        try {
          const exists = await verifyUrlExists(candidateUrl);
          if (!exists) {
            results.set(dep, {
              dep,
              status: 'check-failed',
              versionSource,
              error: `Release asset not found at expected URL for ${versionResult.latest}`,
              resolvedVersion: ghInfo.tag,
            });
            continue;
          }
        } catch (err) {
          results.set(dep, {
            dep,
            status: 'check-failed',
            versionSource,
            error: err instanceof Error ? err.message : String(err),
            resolvedVersion: ghInfo.tag,
          });
          continue;
        }
      }

      results.set(dep, {
        dep,
        status: 'update-available',
        versionSource,
        latestVersion: versionResult.latest,
        updateType: versionResult.updateType,
        updatedUrl: candidateUrl,
        resolvedVersion: ghInfo.tag,
        intermediateTags: findIntermediateTags(currentTag, versionResult.latest, tags),
      });
    } else {
      // Git dep (literal tag OR SHA-resolved) with an available update.
      // For SHA-resolved deps, preserve the user's pin convention (commit vs tag-object SHA).
      let latestSha: string | undefined;
      if (isShaPinned) {
        const latestInfo = tagInfos.find((t) => t.tag === versionResult.latest);
        latestSha = pinStyle === 'tag' ? latestInfo?.tagSha : latestInfo?.commitSha;
      }
      results.set(dep, {
        dep,
        status: 'update-available',
        versionSource,
        latestVersion: versionResult.latest,
        updateType: versionResult.updateType,
        ...(resolvedTag && { resolvedTag }),
        ...(latestSha && { latestSha }),
        intermediateTags: findIntermediateTags(currentTag, versionResult.latest, tags),
      });
    }
  }

  // Preserve original dep order
  return deps.map((dep) => results.get(dep)!);
}
