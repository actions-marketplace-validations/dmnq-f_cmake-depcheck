import * as core from '@actions/core';
import type { getOctokit } from '@actions/github';
import type { UpdateCheckResult } from '../checker/types.js';
import { currentVersionField, latestVersionField } from '../version-display.js';
import type { FileEdit } from './edit-compute.js';
import type { ExistingPr } from './cleanup.js';
import { buildPrBody, updateTypeLabel, type GitHubContext, type PrResult } from './github.js';
import { fetchReleaseNotes } from './release-notes.js';

type Octokit = ReturnType<typeof getOctokit>;

export interface PrUpdatePlan {
  /** The existing PR to update */
  existingPr: ExistingPr;
  /** The new edit to apply (computed from default branch state) */
  edit: FileEdit;
  /** The update check result with new version info */
  result: UpdateCheckResult;
  /** The exact text previously written to the file, extracted from the PR body edit marker */
  previousEditText: string;
}

/**
 * Push an additional commit to an existing PR branch to update the version,
 * then update the PR title and body via API.
 *
 * Reads file content from the PR branch HEAD (not the default branch),
 * preserving any user commits on the branch. Searches for previousEditText
 * (from the edit marker) in the target line range.
 */
export async function updateExistingPr(
  octokit: Octokit,
  ctx: GitHubContext,
  plan: PrUpdatePlan,
): Promise<PrResult> {
  const { existingPr, edit, result, previousEditText } = plan;
  const name = result.dep.name;
  const version = result.latestVersion!;

  // 1. Read file from the PR branch HEAD
  const { data: fileData } = await octokit.rest.repos.getContent({
    owner: ctx.owner,
    repo: ctx.repo,
    path: edit.file,
    ref: existingPr.branch,
  });

  if (!('content' in fileData) || !('sha' in fileData)) {
    return {
      name,
      action: 'error',
      error: `Could not read file ${edit.file} from branch ${existingPr.branch}`,
    };
  }

  const content = Buffer.from(fileData.content, 'base64').toString('utf-8');

  // 2. Search for the previously written text in the target line range
  const lines = content.split('\n');
  const searchStart = edit.line - 1;
  const searchEnd = Math.min(edit.endLine, lines.length);
  let matchIdx = -1;
  for (let i = searchStart; i < searchEnd; i++) {
    if (lines[i].includes(previousEditText)) {
      matchIdx = i;
      break;
    }
  }

  if (matchIdx === -1) {
    return {
      name,
      action: 'skipped',
      skipped: 'previously proposed text not found on PR branch, manual resolution needed',
    };
  }

  // 3. Replace with the new text and commit
  lines[matchIdx] = lines[matchIdx].replace(previousEditText, edit.newText);
  const newContent = lines.join('\n');

  try {
    await octokit.rest.repos.createOrUpdateFileContents({
      owner: ctx.owner,
      repo: ctx.repo,
      path: edit.file,
      message: `chore(deps): update ${name} to ${version}`,
      content: Buffer.from(newContent).toString('base64'),
      sha: fileData.sha,
      branch: existingPr.branch,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { name, action: 'error', error: `Failed to commit update: ${message}` };
  }

  // 4. Rebuild PR body with refreshed metadata, release notes, and new edit marker
  const repoUrl = result.dep.gitRepository ?? result.dep.url ?? '';

  let releaseNotesSection = '';
  const currentTag = result.dep.gitTag ?? result.resolvedVersion ?? '';
  if (result.intermediateTags && result.intermediateTags.length > 0 && currentTag) {
    try {
      releaseNotesSection = await fetchReleaseNotes(
        octokit,
        repoUrl,
        currentTag,
        version,
        result.intermediateTags,
      );
    } catch {
      // Release notes are best-effort
    }
  }

  const body = buildPrBody(
    name,
    currentVersionField(result),
    latestVersionField(result),
    updateTypeLabel(result.updateType),
    repoUrl,
    edit.file,
    edit.newText,
    releaseNotesSection,
  );

  // 5. Update PR title and body
  await octokit.rest.pulls.update({
    owner: ctx.owner,
    repo: ctx.repo,
    pull_number: existingPr.number,
    title: `chore(deps): update ${name} to ${version}`,
    body,
  });

  core.info(`Updated PR #${existingPr.number} for ${name}: ${previousEditText} → ${edit.newText}`);

  return {
    name,
    action: 'updated',
    prNumber: existingPr.number,
    prUrl: existingPr.url,
  };
}
