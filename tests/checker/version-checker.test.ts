import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FetchContentDependency } from '../../src/parser/types.js';
import type { TagInfo } from '../../src/checker/git-tags.js';

vi.mock('../../src/checker/git-tags.js', () => ({
  fetchRemoteTags: vi.fn(),
  parseGitLsRemoteOutput: vi.fn(),
}));

/**
 * Wrap a list of tag names as `TagInfo` entries with deterministic dummy SHAs.
 * Used by tests that don't exercise SHA reverse-resolution.
 */
function tagInfos(tags: string[]): TagInfo[] {
  return tags.map((tag, i) => {
    const sha = `dummysha${i.toString().padStart(32, '0')}`;
    return { tag, commitSha: sha, tagSha: sha };
  });
}

vi.mock('../../src/checker/github-url.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    verifyUrlExists: vi.fn(actual.verifyUrlExists as (...args: unknown[]) => unknown),
  };
});

import { checkForUpdates } from '../../src/checker/version-checker.js';
import { fetchRemoteTags } from '../../src/checker/git-tags.js';
import { verifyUrlExists } from '../../src/checker/github-url.js';

const mockedFetchRemoteTags = vi.mocked(fetchRemoteTags);
const mockedVerifyUrlExists = vi.mocked(verifyUrlExists);

function makeDep(overrides: Partial<FetchContentDependency> = {}): FetchContentDependency {
  return {
    name: 'test-dep',
    sourceType: 'git',
    gitRepository: 'https://github.com/test/repo.git',
    gitTag: 'v1.0.0',
    location: { file: '/test/CMakeLists.txt', startLine: 1, endLine: 5 },
    ...overrides,
  };
}

describe('checkForUpdates', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('detects an update-available dependency', async () => {
    mockedFetchRemoteTags.mockResolvedValue(tagInfos(['v1.0.0', 'v1.1.0', 'v2.0.0']));

    const results = await checkForUpdates([makeDep({ gitTag: 'v1.0.0' })]);

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('update-available');
    expect(results[0].latestVersion).toBe('v2.0.0');
    expect(results[0].updateType).toBe('major');
  });

  it('includes intermediateTags on update-available results', async () => {
    mockedFetchRemoteTags.mockResolvedValue(tagInfos(['v1.0.0', 'v1.1.0', 'v2.0.0']));

    const results = await checkForUpdates([makeDep({ gitTag: 'v1.0.0' })]);

    expect(results[0].status).toBe('update-available');
    expect(results[0].intermediateTags).toEqual(['v2.0.0', 'v1.1.0']);
  });

  it('reports up-to-date when current is latest', async () => {
    mockedFetchRemoteTags.mockResolvedValue(tagInfos(['v1.0.0', 'v1.1.0']));

    const results = await checkForUpdates([makeDep({ gitTag: 'v1.1.0' })]);

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('up-to-date');
    expect(results[0].intermediateTags).toBeUndefined();
  });

  it('skips URL-source deps without network call', async () => {
    const dep = makeDep({
      sourceType: 'url',
      gitRepository: undefined,
      gitTag: undefined,
      url: 'https://example.com/lib.tar.gz',
    });

    const results = await checkForUpdates([dep]);

    expect(results[0].status).toBe('unsupported');
    expect(mockedFetchRemoteTags).not.toHaveBeenCalled();
  });

  it('with resolveSha:false, SHA-pinned deps stay pinned without network call', async () => {
    const dep = makeDep({
      gitTag: 'a'.repeat(40),
      gitTagIsSha: true,
    });

    const results = await checkForUpdates([dep], undefined, { resolveSha: false });

    expect(results[0].status).toBe('pinned');
    expect(results[0].versionSource).toBe('sha');
    expect(mockedFetchRemoteTags).not.toHaveBeenCalled();
  });

  it('with resolveSha:false also skips network when gitRepository is missing', async () => {
    const dep = makeDep({
      gitTag: 'a'.repeat(40),
      gitTagIsSha: true,
      gitRepository: undefined,
    });

    const results = await checkForUpdates([dep], undefined, { resolveSha: false });

    expect(results[0].status).toBe('pinned');
    expect(results[0].versionSource).toBe('sha');
  });

  it('skips deps with no gitTag', async () => {
    const dep = makeDep({ gitTag: undefined });

    const results = await checkForUpdates([dep]);

    expect(results[0].status).toBe('unpinned');
    expect(mockedFetchRemoteTags).not.toHaveBeenCalled();
  });

  it('skips deps with unresolved variables', async () => {
    const dep = makeDep({ gitTag: '${SOME_VERSION}' });

    const results = await checkForUpdates([dep]);

    expect(results[0].status).toBe('unresolved-variable');
    expect(mockedFetchRemoteTags).not.toHaveBeenCalled();
  });

  it('deduplicates fetches for same repository', async () => {
    mockedFetchRemoteTags.mockResolvedValue(tagInfos(['v1.0.0', 'v2.0.0']));

    const dep1 = makeDep({ name: 'dep1', gitTag: 'v1.0.0' });
    const dep2 = makeDep({ name: 'dep2', gitTag: 'v1.0.0' });

    const results = await checkForUpdates([dep1, dep2]);

    expect(mockedFetchRemoteTags).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(2);
    expect(results[0].status).toBe('update-available');
    expect(results[1].status).toBe('update-available');
  });

  it('handles fetch errors gracefully', async () => {
    mockedFetchRemoteTags.mockRejectedValue(new Error('network error'));

    const results = await checkForUpdates([makeDep()]);

    expect(results[0].status).toBe('check-failed');
    expect(results[0].error).toContain('network error');
  });

  it('handles mixed deps: some skip, some check', async () => {
    mockedFetchRemoteTags.mockResolvedValue(tagInfos(['v1.0.0', 'v1.1.0']));

    const deps = [
      makeDep({ name: 'git-dep', gitTag: 'v1.0.0' }),
      makeDep({
        name: 'url-dep',
        sourceType: 'url',
        gitRepository: undefined,
        gitTag: undefined,
        url: 'https://example.com/lib.tar.gz',
      }),
      makeDep({ name: 'pinned', gitTag: 'a'.repeat(40), gitTagIsSha: true }),
    ];

    const results = await checkForUpdates(deps);

    expect(results).toHaveLength(3);
    expect(results[0].status).toBe('update-available');
    expect(results[1].status).toBe('unsupported');
    expect(results[2].status).toBe('pinned');
  });

  it('preserves original dep order', async () => {
    mockedFetchRemoteTags.mockResolvedValue(tagInfos(['v1.0.0']));

    const deps = [
      makeDep({ name: 'pinned', gitTag: 'a'.repeat(40), gitTagIsSha: true }),
      makeDep({ name: 'git-dep', gitTag: 'v1.0.0' }),
      makeDep({ name: 'unpinned', gitTag: undefined }),
    ];

    const results = await checkForUpdates(deps);

    expect(results[0].dep.name).toBe('pinned');
    expect(results[1].dep.name).toBe('git-dep');
    expect(results[2].dep.name).toBe('unpinned');
  });

  it('calls progress callback with correct counts', async () => {
    mockedFetchRemoteTags.mockResolvedValue(tagInfos(['v1.0.0']));

    const dep1 = makeDep({ name: 'dep1', gitRepository: 'https://repo1.git', gitTag: 'v1.0.0' });
    const dep2 = makeDep({ name: 'dep2', gitRepository: 'https://repo2.git', gitTag: 'v1.0.0' });

    const progressCalls: [number, number][] = [];
    await checkForUpdates([dep1, dep2], (completed, total) => {
      progressCalls.push([completed, total]);
    });

    expect(progressCalls).toHaveLength(2);
    expect(progressCalls[0][1]).toBe(2);
    expect(progressCalls[1][1]).toBe(2);
    // Both should complete (order may vary due to concurrency)
    const completedValues = progressCalls.map((c) => c[0]).sort();
    expect(completedValues).toEqual([1, 2]);
  });

  describe('GitHub URL deps', () => {
    function makeUrlDep(
      url: string,
      overrides: Partial<FetchContentDependency> = {},
    ): FetchContentDependency {
      return makeDep({
        sourceType: 'url',
        gitRepository: undefined,
        gitTag: undefined,
        url,
        ...overrides,
      });
    }

    it('non-GitHub URL dep gets unsupported status', async () => {
      const dep = makeUrlDep('https://example.com/lib.tar.gz');
      const results = await checkForUpdates([dep]);
      expect(results[0].status).toBe('unsupported');
      expect(results[0].resolvedVersion).toBeUndefined();
      expect(mockedFetchRemoteTags).not.toHaveBeenCalled();
    });

    it('GitHub URL dep with SHA ref gets pinned status with resolvedVersion', async () => {
      const sha = 'a'.repeat(40);
      const dep = makeUrlDep(`https://github.com/owner/repo/archive/${sha}.tar.gz`);
      const results = await checkForUpdates([dep]);
      expect(results[0].status).toBe('pinned');
      expect(results[0].resolvedVersion).toBe(sha);
      expect(mockedFetchRemoteTags).not.toHaveBeenCalled();
    });

    it('archive pattern: detects up-to-date with resolvedVersion', async () => {
      mockedFetchRemoteTags.mockResolvedValue(tagInfos(['v1.2.3']));
      const dep = makeUrlDep('https://github.com/owner/repo/archive/v1.2.3.tar.gz');
      const results = await checkForUpdates([dep]);
      expect(results[0].status).toBe('up-to-date');
      expect(results[0].resolvedVersion).toBe('v1.2.3');
    });

    it('archive pattern: detects update-available with updatedUrl and resolvedVersion', async () => {
      mockedFetchRemoteTags.mockResolvedValue(tagInfos(['v1.2.3', 'v1.3.0']));
      const dep = makeUrlDep('https://github.com/owner/repo/archive/v1.2.3.tar.gz');
      const results = await checkForUpdates([dep]);
      expect(results[0].status).toBe('update-available');
      expect(results[0].latestVersion).toBe('v1.3.0');
      expect(results[0].updatedUrl).toBe('https://github.com/owner/repo/archive/v1.3.0.tar.gz');
      expect(results[0].resolvedVersion).toBe('v1.2.3');
      // No HEAD validation for archive patterns
      expect(mockedVerifyUrlExists).not.toHaveBeenCalled();
    });

    it('includes intermediateTags on update-available URL deps', async () => {
      mockedFetchRemoteTags.mockResolvedValue(tagInfos(['v1.2.3', 'v1.2.5', 'v1.3.0']));
      const dep = makeUrlDep('https://github.com/owner/repo/archive/v1.2.3.tar.gz');
      const results = await checkForUpdates([dep]);
      expect(results[0].intermediateTags).toBeDefined();
      expect(results[0].intermediateTags).toContain('v1.3.0');
    });

    it('releases-download pattern: update-available with valid HEAD', async () => {
      mockedFetchRemoteTags.mockResolvedValue(tagInfos(['v3.11.3', 'v3.12.0']));
      mockedVerifyUrlExists.mockResolvedValue(true);
      const dep = makeUrlDep(
        'https://github.com/nlohmann/json/releases/download/v3.11.3/json.tar.xz',
      );
      const results = await checkForUpdates([dep]);
      expect(results[0].status).toBe('update-available');
      expect(results[0].updatedUrl).toBe(
        'https://github.com/nlohmann/json/releases/download/v3.12.0/json.tar.xz',
      );
      expect(results[0].resolvedVersion).toBe('v3.11.3');
      expect(mockedVerifyUrlExists).toHaveBeenCalledTimes(1);
    });

    it('releases-download pattern: 404 HEAD results in check-failed with resolvedVersion', async () => {
      mockedFetchRemoteTags.mockResolvedValue(tagInfos(['v3.11.3', 'v3.12.0']));
      mockedVerifyUrlExists.mockResolvedValue(false);
      const dep = makeUrlDep(
        'https://github.com/nlohmann/json/releases/download/v3.11.3/json.tar.xz',
      );
      const results = await checkForUpdates([dep]);
      expect(results[0].status).toBe('check-failed');
      expect(results[0].error).toContain('Release asset not found');
      expect(results[0].error).toContain('v3.12.0');
      expect(results[0].resolvedVersion).toBe('v3.11.3');
    });

    it('releases-download pattern: HEAD network error results in check-failed', async () => {
      mockedFetchRemoteTags.mockResolvedValue(tagInfos(['v3.11.3', 'v3.12.0']));
      mockedVerifyUrlExists.mockRejectedValue(new Error('network timeout'));
      const dep = makeUrlDep(
        'https://github.com/nlohmann/json/releases/download/v3.11.3/json.tar.xz',
      );
      const results = await checkForUpdates([dep]);
      expect(results[0].status).toBe('check-failed');
      expect(results[0].error).toContain('network timeout');
    });

    it('updatedUrl and resolvedVersion not present on git-type deps', async () => {
      mockedFetchRemoteTags.mockResolvedValue(tagInfos(['v1.0.0', 'v2.0.0']));
      const dep = makeDep({ gitTag: 'v1.0.0' });
      const results = await checkForUpdates([dep]);
      expect(results[0].status).toBe('update-available');
      expect(results[0].updatedUrl).toBeUndefined();
      expect(results[0].resolvedVersion).toBeUndefined();
    });

    it('GitHub URL dep shares fetchRemoteTags call with git dep pointing to same repo', async () => {
      mockedFetchRemoteTags.mockResolvedValue(tagInfos(['v1.0.0', 'v2.0.0']));
      mockedVerifyUrlExists.mockResolvedValue(true);

      const gitDep = makeDep({
        name: 'git-dep',
        gitRepository: 'https://github.com/owner/repo.git',
        gitTag: 'v1.0.0',
      });
      const urlDep = makeUrlDep(
        'https://github.com/owner/repo/releases/download/v1.0.0/file.tar.gz',
        { name: 'url-dep' },
      );

      const results = await checkForUpdates([gitDep, urlDep]);

      expect(mockedFetchRemoteTags).toHaveBeenCalledTimes(1);
      expect(results[0].status).toBe('update-available');
      expect(results[1].status).toBe('update-available');
      expect(results[1].updatedUrl).toBeDefined();
    });
  });

  describe('versionSource', () => {
    it('git-tag deps get versionSource:git-tag', async () => {
      mockedFetchRemoteTags.mockResolvedValue(tagInfos(['v1.0.0', 'v1.1.0']));
      const results = await checkForUpdates([makeDep({ gitTag: 'v1.0.0' })]);
      expect(results[0].versionSource).toBe('git-tag');
    });

    it('unpinned and unresolved-variable deps get versionSource:git-tag', async () => {
      const results = await checkForUpdates([
        makeDep({ name: 'a', gitTag: undefined }),
        makeDep({ name: 'b', gitTag: '${SOME}' }),
      ]);
      expect(results[0].versionSource).toBe('git-tag');
      expect(results[1].versionSource).toBe('git-tag');
    });

    it('check-failed (no gitRepository) deps get versionSource:git-tag', async () => {
      const results = await checkForUpdates([
        makeDep({ gitTag: 'v1.0.0', gitRepository: undefined }),
      ]);
      expect(results[0].status).toBe('check-failed');
      expect(results[0].versionSource).toBe('git-tag');
    });

    it('SHA pin (resolveSha:false) gets versionSource:sha', async () => {
      const results = await checkForUpdates(
        [makeDep({ gitTag: 'a'.repeat(40), gitTagIsSha: true })],
        undefined,
        { resolveSha: false },
      );
      expect(results[0].versionSource).toBe('sha');
    });

    it('URL deps get versionSource:url across all branches', async () => {
      mockedFetchRemoteTags.mockResolvedValue(tagInfos(['v1.0.0']));
      const unsupported = await checkForUpdates([
        makeDep({
          sourceType: 'url',
          gitRepository: undefined,
          gitTag: undefined,
          url: 'https://example.com/lib.tar.gz',
        }),
      ]);
      expect(unsupported[0].status).toBe('unsupported');
      expect(unsupported[0].versionSource).toBe('url');

      const urlSha = await checkForUpdates([
        makeDep({
          sourceType: 'url',
          gitRepository: undefined,
          gitTag: undefined,
          url: `https://github.com/owner/repo/archive/${'b'.repeat(40)}.tar.gz`,
        }),
      ]);
      expect(urlSha[0].status).toBe('pinned');
      expect(urlSha[0].versionSource).toBe('url');
    });
  });

  describe('SHA reverse-resolution', () => {
    const PINNED_SHA = '407c905e45ad75fc29bf0f9bb7c5c2fd3475976f';
    const NEWER_SHA = 'bbbbbb0000000000000000000000000000000000';

    function makeSha(overrides: Partial<FetchContentDependency> = {}): FetchContentDependency {
      return makeDep({ gitTag: PINNED_SHA, gitTagIsSha: true, ...overrides });
    }

    /** Build a lightweight TagInfo (tagSha === commitSha). */
    function light(tag: string, sha: string): TagInfo {
      return { tag, commitSha: sha, tagSha: sha };
    }

    /** Build an annotated TagInfo with distinct tag-object and commit SHAs. */
    function annotated(tag: string, tagSha: string, commitSha: string): TagInfo {
      return { tag, commitSha, tagSha };
    }

    it('matches an upstream tag commit SHA → up-to-date when latest', async () => {
      mockedFetchRemoteTags.mockResolvedValue([
        light('v12.0.0', 'aaaa000000000000000000000000000000000000'),
        light('v12.1.0', PINNED_SHA),
      ]);
      const [result] = await checkForUpdates([makeSha()]);
      expect(result.status).toBe('up-to-date');
      expect(result.versionSource).toBe('sha');
      expect(result.resolvedTag).toBe('v12.1.0');
      expect(result.latestSha).toBeUndefined();
    });

    it('matches an upstream tag → update-available with latestSha when stale', async () => {
      mockedFetchRemoteTags.mockResolvedValue([
        light('v12.1.0', PINNED_SHA),
        light('v12.2.0', NEWER_SHA),
      ]);
      const [result] = await checkForUpdates([makeSha()]);
      expect(result.status).toBe('update-available');
      expect(result.versionSource).toBe('sha');
      expect(result.resolvedTag).toBe('v12.1.0');
      expect(result.latestVersion).toBe('v12.2.0');
      expect(result.latestSha).toBe(NEWER_SHA);
      expect(result.updateType).toBe('minor');
    });

    it('matches the dereferenced ^{} (commit) SHA of an annotated tag', async () => {
      const TAG_OBJ_SHA = 'tagobj0000000000000000000000000000000000';
      mockedFetchRemoteTags.mockResolvedValue([annotated('v12.1.0', TAG_OBJ_SHA, PINNED_SHA)]);
      const [result] = await checkForUpdates([makeSha()]);
      expect(result.status).toBe('up-to-date');
      expect(result.resolvedTag).toBe('v12.1.0');
    });

    it('also matches the tag-object SHA of an annotated tag (bagel-style pin)', async () => {
      const COMMIT_SHA = 'commit00000000000000000000000000000000000';
      mockedFetchRemoteTags.mockResolvedValue([annotated('v12.1.0', PINNED_SHA, COMMIT_SHA)]);
      const [result] = await checkForUpdates([makeSha()]);
      expect(result.status).toBe('up-to-date');
      expect(result.resolvedTag).toBe('v12.1.0');
    });

    it('preserves tag-object pin style on update — latestSha is the new tag-object SHA', async () => {
      const OLD_COMMIT = 'oldcommit00000000000000000000000000000000';
      const NEW_TAG_OBJ = 'newtagobj0000000000000000000000000000000';
      const NEW_COMMIT = 'newcommit0000000000000000000000000000000';
      mockedFetchRemoteTags.mockResolvedValue([
        annotated('v12.1.0', PINNED_SHA, OLD_COMMIT),
        annotated('v12.2.0', NEW_TAG_OBJ, NEW_COMMIT),
      ]);
      const [result] = await checkForUpdates([makeSha()]);
      expect(result.status).toBe('update-available');
      expect(result.latestSha).toBe(NEW_TAG_OBJ);
    });

    it('preserves commit-SHA pin style on update — latestSha is the new commit SHA', async () => {
      const OLD_TAG_OBJ = 'oldtagobj0000000000000000000000000000000';
      const NEW_TAG_OBJ = 'newtagobj0000000000000000000000000000000';
      const NEW_COMMIT = 'newcommit0000000000000000000000000000000';
      mockedFetchRemoteTags.mockResolvedValue([
        annotated('v12.1.0', OLD_TAG_OBJ, PINNED_SHA),
        annotated('v12.2.0', NEW_TAG_OBJ, NEW_COMMIT),
      ]);
      const [result] = await checkForUpdates([makeSha()]);
      expect(result.status).toBe('update-available');
      expect(result.latestSha).toBe(NEW_COMMIT);
    });

    it('SHA matches no upstream tag → pinned (honest)', async () => {
      mockedFetchRemoteTags.mockResolvedValue(tagInfos(['v12.1.0', 'v12.2.0']));
      const [result] = await checkForUpdates([makeSha()]);
      expect(result.status).toBe('pinned');
      expect(result.versionSource).toBe('sha');
      expect(result.resolvedTag).toBeUndefined();
    });

    it('SHA comparison is case-insensitive', async () => {
      mockedFetchRemoteTags.mockResolvedValue([light('v12.1.0', PINNED_SHA.toUpperCase())]);
      const [result] = await checkForUpdates([makeSha()]);
      expect(result.status).toBe('up-to-date');
      expect(result.resolvedTag).toBe('v12.1.0');
    });

    it('pin-comment short-circuits even when SHA would match a stale tag', async () => {
      mockedFetchRemoteTags.mockResolvedValue([
        light('v12.1.0', PINNED_SHA),
        light('v12.2.0', NEWER_SHA),
      ]);
      const [result] = await checkForUpdates([makeSha({ gitTagComment: 'pinned to bugfix XYZ' })]);
      expect(result.status).toBe('pinned');
      expect(result.versionSource).toBe('sha');
      expect(result.resolvedTag).toBeUndefined();
      expect(result.latestSha).toBeUndefined();
    });

    it('version-shaped comment does NOT act as a pin indicator', async () => {
      mockedFetchRemoteTags.mockResolvedValue([
        light('v12.1.0', PINNED_SHA),
        light('v12.2.0', NEWER_SHA),
      ]);
      const [result] = await checkForUpdates([makeSha({ gitTagComment: '12.1.0' })]);
      expect(result.status).toBe('update-available');
      expect(result.latestVersion).toBe('v12.2.0');
    });

    it('SHA dep without gitRepository stays pinned without network', async () => {
      const [result] = await checkForUpdates([makeSha({ gitRepository: undefined })]);
      expect(result.status).toBe('pinned');
      expect(result.versionSource).toBe('sha');
      expect(mockedFetchRemoteTags).not.toHaveBeenCalled();
    });
  });
});
