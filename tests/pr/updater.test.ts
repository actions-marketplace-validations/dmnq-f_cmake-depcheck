import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@actions/core', () => ({
  info: vi.fn(),
  warning: vi.fn(),
}));

vi.mock('../../src/pr/release-notes.js', () => ({
  fetchReleaseNotes: vi.fn(),
}));

import { updateExistingPr, type PrUpdatePlan } from '../../src/pr/updater.js';
import { fetchReleaseNotes } from '../../src/pr/release-notes.js';
import type { ExistingPr } from '../../src/pr/cleanup.js';
import type { GitHubContext } from '../../src/pr/github.js';
import type { UpdateCheckResult } from '../../src/checker/types.js';
import type { FetchContentDependency } from '../../src/parser/types.js';

const mockedFetchReleaseNotes = vi.mocked(fetchReleaseNotes);

const ctx: GitHubContext = {
  owner: 'testowner',
  repo: 'testrepo',
  defaultBranch: 'main',
};

function makeDep(overrides: Partial<FetchContentDependency> = {}): FetchContentDependency {
  return {
    name: 'fmt',
    sourceType: 'git',
    gitRepository: 'https://github.com/fmtlib/fmt.git',
    gitTag: 'v10.2.1',
    location: { file: '/project/CMakeLists.txt', startLine: 10, endLine: 14 },
    ...overrides,
  };
}

function makeExistingPr(overrides: Partial<ExistingPr> = {}): ExistingPr {
  return {
    number: 42,
    branch: 'cmake-depcheck/update-fmt-a1b2c3d4',
    title: 'chore(deps): update fmt to 11.0.0',
    body: '<!-- cmake-depcheck:edit:v11.0.0 -->',
    url: 'https://github.com/testowner/testrepo/pull/42',
    ...overrides,
  };
}

function makePlan(overrides: Partial<PrUpdatePlan> = {}): PrUpdatePlan {
  return {
    existingPr: makeExistingPr(),
    edit: {
      file: 'CMakeLists.txt',
      line: 1,
      endLine: 5,
      oldText: 'v10.2.1',
      newText: 'v12.1.0',
    },
    result: {
      dep: makeDep(),
      status: 'update-available',
      latestVersion: '12.1.0',
      updateType: 'major',
    } as UpdateCheckResult,
    previousEditText: 'v11.0.0',
    ...overrides,
  };
}

function createMockOctokit() {
  return {
    rest: {
      repos: {
        getContent: vi.fn(),
        createOrUpdateFileContents: vi.fn(),
        getReleaseByTag: vi.fn(),
      },
      pulls: {
        update: vi.fn(),
      },
    },
  };
}

type MockOctokit = ReturnType<typeof createMockOctokit>;

describe('updateExistingPr', () => {
  let octokit: MockOctokit;

  beforeEach(() => {
    octokit = createMockOctokit();
    mockedFetchReleaseNotes.mockReset();
  });

  it('commits update and refreshes PR title/body on happy path', async () => {
    // File on PR branch has the previously proposed version
    const fileContent = [
      'FetchContent_Declare(',
      '  fmt',
      '  GIT_REPOSITORY https://github.com/fmtlib/fmt.git',
      '  GIT_TAG v11.0.0',
      ')',
    ].join('\n');
    const content = Buffer.from(fileContent).toString('base64');
    octokit.rest.repos.getContent.mockResolvedValue({
      data: { content, sha: 'branch-file-sha' },
    });
    octokit.rest.repos.createOrUpdateFileContents.mockResolvedValue({});
    octokit.rest.pulls.update.mockResolvedValue({});

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await updateExistingPr(octokit as any, ctx, makePlan());

    expect(result).toEqual({
      name: 'fmt',
      action: 'updated',
      prNumber: 42,
      prUrl: 'https://github.com/testowner/testrepo/pull/42',
    });

    // Verify reads from PR branch, not default branch
    expect(octokit.rest.repos.getContent).toHaveBeenCalledWith(
      expect.objectContaining({ ref: 'cmake-depcheck/update-fmt-a1b2c3d4' }),
    );

    // Verify committed content replaced v11.0.0 with v12.1.0
    const committedContent = Buffer.from(
      octokit.rest.repos.createOrUpdateFileContents.mock.calls[0][0].content,
      'base64',
    ).toString('utf-8');
    expect(committedContent).toContain('GIT_TAG v12.1.0');
    expect(committedContent).not.toContain('v11.0.0');

    // Verify uses branch file SHA, not main
    expect(octokit.rest.repos.createOrUpdateFileContents).toHaveBeenCalledWith(
      expect.objectContaining({
        sha: 'branch-file-sha',
        branch: 'cmake-depcheck/update-fmt-a1b2c3d4',
      }),
    );

    // Verify PR title and body updated
    expect(octokit.rest.pulls.update).toHaveBeenCalledWith(
      expect.objectContaining({
        pull_number: 42,
        title: 'chore(deps): update fmt to 12.1.0',
      }),
    );

    // Verify new body contains new edit marker
    const newBody = octokit.rest.pulls.update.mock.calls[0][0].body as string;
    expect(newBody).toContain('<!-- cmake-depcheck:edit:v12.1.0 -->');
  });

  it('shows abbreviated SHA with version for SHA-pinned deps in the refreshed body', async () => {
    const currentSha = '769abd9ad368f63d3fcdf5e69fc99a907e4da6ad';
    const prevSha = 'a'.repeat(40);
    const newSha = '77a832110d40b0179636f5be8f8781f8299d7e50';
    const content = Buffer.from(`GIT_TAG ${prevSha}\n`).toString('base64');
    octokit.rest.repos.getContent.mockResolvedValue({
      data: { content, sha: 'branch-file-sha' },
    });
    octokit.rest.repos.createOrUpdateFileContents.mockResolvedValue({});
    octokit.rest.pulls.update.mockResolvedValue({});

    const plan = makePlan({
      edit: { file: 'CMakeLists.txt', line: 1, endLine: 5, oldText: currentSha, newText: newSha },
      result: {
        dep: makeDep({ gitTag: currentSha, gitTagIsSha: true }),
        status: 'update-available',
        versionSource: 'sha',
        resolvedTag: '14.2.0',
        latestVersion: '14.2.1',
        latestSha: newSha,
        updateType: 'patch',
      } as UpdateCheckResult,
      previousEditText: prevSha,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await updateExistingPr(octokit as any, ctx, plan);

    const newBody = octokit.rest.pulls.update.mock.calls[0][0].body as string;
    expect(newBody).toContain('| **Current** | `769abd9a (14.2.0)` |');
    expect(newBody).toContain('| **Latest** | `77a83211 (14.2.1)` |');
  });

  it('searches for previousEditText, not edit.oldText', async () => {
    // File on PR branch has v11.0.0 (from previous update),
    // but edit.oldText is v10.2.1 (current on main).
    // The updater should find v11.0.0, not v10.2.1.
    const fileContent = 'GIT_TAG v11.0.0\n';
    const content = Buffer.from(fileContent).toString('base64');
    octokit.rest.repos.getContent.mockResolvedValue({
      data: { content, sha: 'sha' },
    });
    octokit.rest.repos.createOrUpdateFileContents.mockResolvedValue({});
    octokit.rest.pulls.update.mockResolvedValue({});

    const plan = makePlan({
      edit: {
        file: 'CMakeLists.txt',
        line: 1,
        endLine: 1,
        oldText: 'v10.2.1',
        newText: 'v12.1.0',
      },
      previousEditText: 'v11.0.0',
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await updateExistingPr(octokit as any, ctx, plan);
    expect(result.action).toBe('updated');
  });

  it('works for URL deps (marker stores full URL)', async () => {
    const oldUrl = 'https://github.com/foo/bar/archive/refs/tags/v1.0.tar.gz';
    const newUrl = 'https://github.com/foo/bar/archive/refs/tags/v2.0.tar.gz';
    const fileContent = `URL ${oldUrl}\n`;
    const content = Buffer.from(fileContent).toString('base64');
    octokit.rest.repos.getContent.mockResolvedValue({
      data: { content, sha: 'sha' },
    });
    octokit.rest.repos.createOrUpdateFileContents.mockResolvedValue({});
    octokit.rest.pulls.update.mockResolvedValue({});

    const plan = makePlan({
      existingPr: makeExistingPr({
        body: `<!-- cmake-depcheck:edit:${oldUrl} -->`,
      }),
      edit: {
        file: 'CMakeLists.txt',
        line: 1,
        endLine: 1,
        oldText: 'https://github.com/foo/bar/archive/refs/tags/v0.5.tar.gz',
        newText: newUrl,
      },
      result: {
        dep: makeDep({ sourceType: 'url', url: oldUrl }),
        status: 'update-available',
        latestVersion: '2.0',
        updatedUrl: newUrl,
      } as UpdateCheckResult,
      previousEditText: oldUrl,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await updateExistingPr(octokit as any, ctx, plan);
    expect(result.action).toBe('updated');

    const committedContent = Buffer.from(
      octokit.rest.repos.createOrUpdateFileContents.mock.calls[0][0].content,
      'base64',
    ).toString('utf-8');
    expect(committedContent).toContain(newUrl);
    expect(committedContent).not.toContain(oldUrl);
  });

  it('skips when previously proposed text not found on branch', async () => {
    // File on PR branch was modified by user — v11.0.0 is gone
    const fileContent = 'GIT_TAG v99.99.99\n';
    const content = Buffer.from(fileContent).toString('base64');
    octokit.rest.repos.getContent.mockResolvedValue({
      data: { content, sha: 'sha' },
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await updateExistingPr(octokit as any, ctx, makePlan());

    expect(result.action).toBe('skipped');
    expect(result.skipped).toContain('not found on PR branch');
    expect(octokit.rest.repos.createOrUpdateFileContents).not.toHaveBeenCalled();
  });

  it('returns error when file cannot be read from branch', async () => {
    octokit.rest.repos.getContent.mockResolvedValue({
      data: [{ name: 'dir' }],
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await updateExistingPr(octokit as any, ctx, makePlan());
    expect(result.action).toBe('error');
    expect(result.error).toContain('Could not read file');
  });

  it('handles commit failure gracefully', async () => {
    const fileContent = 'GIT_TAG v11.0.0\n';
    const content = Buffer.from(fileContent).toString('base64');
    octokit.rest.repos.getContent.mockResolvedValue({
      data: { content, sha: 'sha' },
    });
    octokit.rest.repos.createOrUpdateFileContents.mockRejectedValue(new Error('409 Conflict'));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await updateExistingPr(octokit as any, ctx, makePlan());
    expect(result.action).toBe('error');
    expect(result.error).toContain('409 Conflict');
  });

  it('refreshes release notes in updated PR body', async () => {
    const fileContent = 'GIT_TAG v11.0.0\n';
    const content = Buffer.from(fileContent).toString('base64');
    octokit.rest.repos.getContent.mockResolvedValue({
      data: { content, sha: 'sha' },
    });
    octokit.rest.repos.createOrUpdateFileContents.mockResolvedValue({});
    octokit.rest.pulls.update.mockResolvedValue({});
    mockedFetchReleaseNotes.mockResolvedValue('### Release Notes\n\nNew stuff');

    const plan = makePlan({
      result: {
        dep: makeDep(),
        status: 'update-available',
        latestVersion: '12.1.0',
        updateType: 'major',
        intermediateTags: ['v12.1.0', 'v12.0.0'],
      } as UpdateCheckResult,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await updateExistingPr(octokit as any, ctx, plan);

    const newBody = octokit.rest.pulls.update.mock.calls[0][0].body as string;
    expect(newBody).toContain('### Release Notes');
    expect(newBody).toContain('New stuff');
  });
});
