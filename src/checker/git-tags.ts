import { execFile } from 'node:child_process';

/**
 * A tag from `git ls-remote --tags` paired with both SHAs it may be pinned by.
 *
 * - `commitSha` is the dereferenced (`refs/tags/X^{}`) SHA for annotated tags,
 *   i.e. the commit `git clone --branch X` lands on.
 * - `tagSha` is the bare `refs/tags/X` SHA — the tag-object SHA for annotated
 *   tags, identical to `commitSha` for lightweight tags.
 *
 * Users pin either the commit SHA (what `git rev-parse HEAD` returns) or the
 * tag-object SHA (what `git rev-parse refs/tags/X` returns for annotated tags).
 */
export interface TagInfo {
  /** Tag name with the `refs/tags/` prefix and any `^{}` suffix stripped. */
  tag: string;
  /** Dereferenced commit SHA (the commit the tag ultimately points at). */
  commitSha: string;
  /** Bare `refs/tags/X` SHA. Equals `commitSha` for lightweight tags. */
  tagSha: string;
}

/**
 * Parse raw `git ls-remote --tags` output into tag/SHA records.
 *
 * For each tag we capture both the bare-ref SHA and the dereferenced
 * (`refs/tags/X^{}`) SHA when present. Lightweight tags only have the bare
 * entry; in that case both fields hold the same value (already a commit SHA).
 */
export function parseGitLsRemoteOutput(raw: string): TagInfo[] {
  if (!raw.trim()) return [];

  const order: string[] = [];
  const byTag = new Map<string, { tagSha: string; commitSha: string }>();

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 2) continue;
    const sha = parts[0];
    const ref = parts[1];
    if (!ref.startsWith('refs/tags/')) continue;
    const dereferenced = ref.endsWith('^{}');
    const tag = ref.replace('refs/tags/', '').replace(/\^\{\}$/, '');

    const existing = byTag.get(tag);
    if (!existing) {
      byTag.set(tag, { tagSha: sha, commitSha: sha });
      order.push(tag);
    } else if (dereferenced) {
      existing.commitSha = sha;
    } else {
      existing.tagSha = sha;
    }
  }

  return order.map((tag) => {
    const entry = byTag.get(tag)!;
    return { tag, commitSha: entry.commitSha, tagSha: entry.tagSha };
  });
}

/**
 * Fetch all tags (paired with commit SHAs) from a remote git repository via
 * `git ls-remote --tags`. Times out after 15 seconds.
 */
export function fetchRemoteTags(repoUrl: string): Promise<TagInfo[]> {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);

    execFile(
      'git',
      ['ls-remote', '--tags', repoUrl],
      { signal: controller.signal },
      (err, stdout) => {
        clearTimeout(timeout);
        if (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            reject(new Error('git executable not found in PATH'));
          } else if (err.killed || controller.signal.aborted) {
            reject(new Error(`Timed out fetching tags from ${repoUrl}`));
          } else {
            reject(new Error(`Failed to fetch tags from ${repoUrl}: ${err.message}`));
          }
          return;
        }
        resolve(parseGitLsRemoteOutput(stdout));
      },
    );
  });
}
