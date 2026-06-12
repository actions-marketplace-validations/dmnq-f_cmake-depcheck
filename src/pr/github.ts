import { createHash } from 'node:crypto';
import type { getOctokit } from '@actions/github';
import type { UpdateCheckResult } from '../checker/types.js';
import { currentVersionField, latestVersionField } from '../version-display.js';
import type { FileEdit } from './edit-compute.js';
import { buildEditMarker } from './edit-marker.js';
import { fetchReleaseNotes } from './release-notes.js';

type Octokit = ReturnType<typeof getOctokit>;

export interface GitHubContext {
  owner: string;
  repo: string;
  defaultBranch: string;
}

export interface PrResult {
  /** Dependency name */
  name: string;
  /** What happened to this dependency's PR */
  action: 'created' | 'updated' | 'closed-stale' | 'skipped' | 'error';
  /** PR number (for created/updated) */
  prNumber?: number;
  /** PR URL (for created/updated) */
  prUrl?: string;
  /** Reason (for skipped) */
  skipped?: string;
  /** Error message (for error) */
  error?: string;
  /** The PR number that was closed (for closed-stale) */
  closedPrNumber?: number;
  /** True when the action was not actually performed (dry-run mode) */
  dryRun?: boolean;
}

function locationHash(file: string, line: number): string {
  return createHash('sha256').update(`${file}:${line}`).digest('hex').slice(0, 8);
}

/**
 * Compute the branch name for a dependency update PR.
 * @param depName - Dependency name
 * @param file - Repo-relative file path (NOT absolute)
 * @param line - 1-based start line of the edit target
 */
export function branchName(depName: string, file: string, line: number): string {
  return `cmake-depcheck/update-${depName}-${locationHash(file, line)}`;
}

export function updateTypeLabel(type?: 'major' | 'minor' | 'patch'): string {
  return type ?? 'unknown';
}

async function branchExists(
  octokit: Octokit,
  ctx: GitHubContext,
  branch: string,
): Promise<boolean> {
  try {
    await octokit.rest.git.getRef({
      owner: ctx.owner,
      repo: ctx.repo,
      ref: `heads/${branch}`,
    });
    return true;
  } catch (err: unknown) {
    if (typeof err === 'object' && err !== null && 'status' in err && err.status === 404) {
      return false;
    }
    throw err;
  }
}

export async function ensureLabel(octokit: Octokit, ctx: GitHubContext): Promise<void> {
  try {
    await octokit.rest.issues.getLabel({
      owner: ctx.owner,
      repo: ctx.repo,
      name: 'dependencies',
    });
  } catch {
    try {
      await octokit.rest.issues.createLabel({
        owner: ctx.owner,
        repo: ctx.repo,
        name: 'dependencies',
        color: '0366d6',
        description: 'Dependency updates',
      });
    } catch {
      // Label creation denied (e.g. insufficient permissions) — not fatal
    }
  }
}

/**
 * Build the standard PR body for a dependency update.
 * Exported for reuse by the updater when refreshing PR bodies.
 */
export function buildPrBody(
  name: string,
  currentVersion: string,
  version: string,
  updateType: string,
  repoUrl: string,
  file: string,
  editNewText: string,
  releaseNotesSection?: string,
): string {
  const bodyParts = [
    `## Dependency Update`,
    ``,
    `| | |`,
    `|---|---|`,
    `| **Package** | ${name} |`,
    `| **Current** | \`${currentVersion}\` |`,
    `| **Latest** | \`${version}\` |`,
    `| **Update type** | ${updateType} |`,
    `| **Repository** | ${repoUrl} |`,
    `| **File** | \`${file}\` |`,
    ``,
  ];

  if (releaseNotesSection) {
    bodyParts.push(releaseNotesSection, ``);
  }

  bodyParts.push(
    `---`,
    `*This PR was automatically created by [cmake-depcheck](https://github.com/dmnq-f/cmake-depcheck).*`,
    buildEditMarker(editNewText),
  );

  return bodyParts.join('\n');
}

export async function createUpdatePr(
  octokit: Octokit,
  ctx: GitHubContext,
  dep: UpdateCheckResult,
  edit: FileEdit,
): Promise<PrResult> {
  const name = dep.dep.name;
  const version = dep.latestVersion!;
  const branch = branchName(name, edit.file, edit.line);

  // 1. Check if branch already exists (orphaned branch without a PR)
  if (await branchExists(octokit, ctx, branch)) {
    return { name, action: 'skipped', skipped: 'branch exists' };
  }

  // 2. Get default branch HEAD SHA
  const { data: refData } = await octokit.rest.git.getRef({
    owner: ctx.owner,
    repo: ctx.repo,
    ref: `heads/${ctx.defaultBranch}`,
  });
  const baseSha = refData.object.sha;

  // 3. Read target file content via API
  const { data: fileData } = await octokit.rest.repos.getContent({
    owner: ctx.owner,
    repo: ctx.repo,
    path: edit.file,
    ref: ctx.defaultBranch,
  });

  if (!('content' in fileData) || !('sha' in fileData)) {
    return { name, action: 'error', error: `Could not read file ${edit.file} from repository` };
  }

  const content = Buffer.from(fileData.content, 'base64').toString('utf-8');

  // 4. Apply line-scoped text replacement
  const lines = content.split('\n');
  const searchStart = edit.line - 1;
  const searchEnd = Math.min(edit.endLine, lines.length);
  let matchIdx = -1;
  for (let i = searchStart; i < searchEnd; i++) {
    if (lines[i].includes(edit.oldText)) {
      matchIdx = i;
      break;
    }
  }

  if (matchIdx === -1) {
    return {
      name,
      action: 'error',
      error: `Could not find "${edit.oldText}" in ${edit.file} between lines ${edit.line}–${edit.endLine} (file may have been modified)`,
    };
  }

  lines[matchIdx] = lines[matchIdx].replace(edit.oldText, edit.newText);
  const newContent = lines.join('\n');

  // 5. Create branch
  await octokit.rest.git.createRef({
    owner: ctx.owner,
    repo: ctx.repo,
    ref: `refs/heads/${branch}`,
    sha: baseSha,
  });

  // 6. Update file on the new branch
  await octokit.rest.repos.createOrUpdateFileContents({
    owner: ctx.owner,
    repo: ctx.repo,
    path: edit.file,
    message: `chore(deps): update ${name} to ${version}`,
    content: Buffer.from(newContent).toString('base64'),
    sha: fileData.sha,
    branch,
  });

  // 7. Build PR body and open PR
  const repoUrl = dep.dep.gitRepository ?? dep.dep.url ?? '';

  let releaseNotesSection = '';
  const currentTag = dep.dep.gitTag ?? dep.resolvedVersion ?? '';
  if (dep.intermediateTags && dep.intermediateTags.length > 0 && currentTag) {
    try {
      releaseNotesSection = await fetchReleaseNotes(
        octokit,
        repoUrl,
        currentTag,
        version,
        dep.intermediateTags,
      );
    } catch {
      // Release notes are best-effort — don't fail the PR
    }
  }

  const body = buildPrBody(
    name,
    currentVersionField(dep),
    latestVersionField(dep),
    updateTypeLabel(dep.updateType),
    repoUrl,
    edit.file,
    edit.newText,
    releaseNotesSection,
  );

  const { data: pr } = await octokit.rest.pulls.create({
    owner: ctx.owner,
    repo: ctx.repo,
    title: `chore(deps): update ${name} to ${version}`,
    body,
    head: branch,
    base: ctx.defaultBranch,
  });

  // Try to add label (non-fatal if it fails)
  try {
    await octokit.rest.issues.addLabels({
      owner: ctx.owner,
      repo: ctx.repo,
      issue_number: pr.number,
      labels: ['dependencies'],
    });
  } catch {
    // Label assignment failed — not fatal
  }

  return { name, action: 'created', prNumber: pr.number, prUrl: pr.html_url };
}
