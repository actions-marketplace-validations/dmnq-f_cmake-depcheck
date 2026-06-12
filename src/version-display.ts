import type { UpdateCheckResult } from './checker/types.js';
import { SHA_PATTERN } from './constants.js';

const SHA_SHORT_LEN = 8;

/** Abbreviate a commit SHA to its display length. */
function shortSha(sha: string): string {
  return sha.slice(0, SHA_SHORT_LEN);
}

/**
 * Display string for a dependency's currently pinned version, shared by the PR
 * body, the Action job summary, and the CLI table. SHA-pinned git deps that
 * reverse-resolved to a tag show the abbreviated pinned SHA with the
 * human-readable version in parentheses (e.g. `769abd9a (14.2.0)`); URL deps
 * show the resolved version, abbreviated when it is itself a commit SHA;
 * tag-pinned deps show the tag alone.
 */
export function currentVersionField(result: UpdateCheckResult, fallback = 'unknown'): string {
  const { dep, resolvedTag, resolvedVersion } = result;
  if (dep.gitTagIsSha && dep.gitTag && resolvedTag) {
    return `${shortSha(dep.gitTag)} (${resolvedTag})`;
  }
  if (resolvedVersion) {
    return SHA_PATTERN.test(resolvedVersion) ? shortSha(resolvedVersion) : resolvedVersion;
  }
  return dep.gitTag ?? fallback;
}

/**
 * Display string for a dependency's latest available version. SHA-pinned deps
 * show the abbreviated new commit SHA with the new version in parentheses
 * (e.g. `77a83211 (14.2.1)`); others show the version alone.
 */
export function latestVersionField(result: UpdateCheckResult, fallback = 'unknown'): string {
  const { dep, latestVersion, latestSha } = result;
  if (dep.gitTagIsSha && latestSha && latestVersion) {
    return `${shortSha(latestSha)} (${latestVersion})`;
  }
  return latestVersion ?? fallback;
}
