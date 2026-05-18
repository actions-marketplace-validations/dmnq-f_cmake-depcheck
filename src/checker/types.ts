import { FetchContentDependency } from '../parser/types.js';

export interface UpdateCheckResult {
  dep: FetchContentDependency;
  status:
    | 'up-to-date'
    | 'update-available'
    | 'pinned'
    | 'unpinned'
    | 'unsupported'
    | 'check-failed'
    | 'unresolved-variable';
  /**
   * How the dep is pinned in source, which determines the shape of any update edit.
   * - `'git-tag'`: GIT_TAG holds a comparable tag string; compared directly.
   *   Also the default for `'unpinned'` and `'unresolved-variable'` git deps.
   * - `'sha'`: GIT_TAG holds a commit SHA. For `'update-available'` / `'up-to-date'`,
   *   the SHA was reverse-resolved against an upstream tag's commit SHA. For
   *   `'pinned'` it means SHA pinned with no matching upstream tag, an
   *   explicit pin-comment override, or `resolveSha` disabled.
   * - `'url'`: URL dep; version extracted from the URL path, or non-GitHub URL.
   */
  versionSource: 'git-tag' | 'sha' | 'url';
  latestVersion?: string;
  updateType?: 'major' | 'minor' | 'patch';
  error?: string;
  /** Replacement download URL when a URL-type dep has an update available */
  updatedUrl?: string;
  /** Version/tag resolved from the dep's URL (GitHub URL deps only) */
  resolvedVersion?: string;
  /**
   * The upstream tag a SHA-pinned dep reverse-resolved to. Set only for
   * `versionSource: 'sha'` results that matched an upstream tag.
   */
  resolvedTag?: string;
  /**
   * Commit SHA of the new tag for `versionSource: 'sha'` `'update-available'`
   * results — used by PR generation to rewrite the pinned SHA.
   */
  latestSha?: string;
  /** Remote tags between current and latest (exclusive of current, inclusive of latest), newest first. */
  intermediateTags?: string[];
}
