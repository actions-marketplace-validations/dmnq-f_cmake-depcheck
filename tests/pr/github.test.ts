import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/pr/release-notes.js', () => ({
  fetchReleaseNotes: vi.fn(),
}));

import { createUpdatePr, branchName, type GitHubContext } from '../../src/pr/github.js';
import { fetchReleaseNotes } from '../../src/pr/release-notes.js';
import type { UpdateCheckResult } from '../../src/checker/types.js';
import type { FileEdit } from '../../src/pr/edit-compute.js';
import type { FetchContentDependency } from '../../src/parser/types.js';

const mockedFetchReleaseNotes = vi.mocked(fetchReleaseNotes);

function makeDep(overrides: Partial<FetchContentDependency> = {}): FetchContentDependency {
  return {
    name: 'fmt',
    sourceType: 'git',
    gitRepository: 'https://github.com/fmtlib/fmt.git',
    gitTag: 'v10.2.1',
    location: {
      file: '/project/CMakeLists.txt',
      startLine: 10,
      endLine: 14,
    },
    ...overrides,
  };
}

function makeUpdateResult(overrides: Partial<UpdateCheckResult> = {}): UpdateCheckResult {
  return {
    dep: makeDep(),
    status: 'update-available',
    latestVersion: '12.1.0',
    updateType: 'major',
    ...overrides,
  };
}

const ctx: GitHubContext = {
  owner: 'testowner',
  repo: 'testrepo',
  defaultBranch: 'main',
};

const edit: FileEdit = {
  file: 'CMakeLists.txt',
  line: 1,
  endLine: 4,
  oldText: 'v10.2.1',
  newText: 'v12.1.0',
};

function createMockOctokit() {
  return {
    rest: {
      git: {
        getRef: vi.fn(),
        createRef: vi.fn(),
      },
      repos: {
        getContent: vi.fn(),
        createOrUpdateFileContents: vi.fn(),
      },
      pulls: {
        create: vi.fn(),
      },
      issues: {
        getLabel: vi.fn(),
        createLabel: vi.fn(),
        addLabels: vi.fn(),
      },
    },
  };
}

type MockOctokit = ReturnType<typeof createMockOctokit>;

describe('branchName', () => {
  it('produces consistent hash for same file and line', () => {
    const a = branchName('fmt', 'CMakeLists.txt', 10);
    const b = branchName('fmt', 'CMakeLists.txt', 10);
    expect(a).toBe(b);
  });

  it('produces different hash for different line, same file', () => {
    const a = branchName('fmt', 'CMakeLists.txt', 10);
    const b = branchName('fmt', 'CMakeLists.txt', 20);
    expect(a).not.toBe(b);
  });

  it('produces different hash for different file, same line', () => {
    const a = branchName('fmt', 'CMakeLists.txt', 10);
    const b = branchName('fmt', 'src/CMakeLists.txt', 10);
    expect(a).not.toBe(b);
  });

  it('includes dep name in the branch', () => {
    const branch = branchName('fmt', 'CMakeLists.txt', 10);
    expect(branch).toMatch(/^cmake-depcheck\/update-fmt-[0-9a-f]{8}$/);
  });

  it('uses repo-relative paths consistently', () => {
    // Absolute paths should NOT be used, but if the same relative path is passed
    // from different machines, the hash should be identical
    const a = branchName('fmt', 'src/deps/CMakeLists.txt', 5);
    const b = branchName('fmt', 'src/deps/CMakeLists.txt', 5);
    expect(a).toBe(b);
  });
});

describe('createUpdatePr', () => {
  let octokit: MockOctokit;

  beforeEach(() => {
    octokit = createMockOctokit();
    mockedFetchReleaseNotes.mockReset();
  });

  it('skips when branch already exists', async () => {
    octokit.rest.git.getRef.mockResolvedValue({ data: { object: { sha: 'abc123' } } });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await createUpdatePr(octokit as any, ctx, makeUpdateResult(), edit);

    expect(result).toEqual({ name: 'fmt', action: 'skipped', skipped: 'branch exists' });
    expect(octokit.rest.repos.getContent).not.toHaveBeenCalled();
  });

  it('creates branch, commits, and opens PR on happy path', async () => {
    octokit.rest.git.getRef
      .mockRejectedValueOnce({ status: 404 })
      .mockResolvedValueOnce({ data: { object: { sha: 'base-sha-123' } } });

    const content = Buffer.from(
      'FetchContent_Declare(\n  freetype\n  GIT_TAG v10.2.1\n)\n',
    ).toString('base64');
    octokit.rest.repos.getContent.mockResolvedValue({
      data: { content, sha: 'file-sha-456' },
    });
    octokit.rest.git.createRef.mockResolvedValue({});
    octokit.rest.repos.createOrUpdateFileContents.mockResolvedValue({});
    octokit.rest.issues.addLabels.mockResolvedValue({});
    octokit.rest.pulls.create.mockResolvedValue({
      data: { number: 42, html_url: 'https://github.com/testowner/testrepo/pull/42' },
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await createUpdatePr(octokit as any, ctx, makeUpdateResult(), edit);

    expect(result).toEqual({
      name: 'fmt',
      action: 'created',
      prNumber: 42,
      prUrl: 'https://github.com/testowner/testrepo/pull/42',
    });

    // Branch name uses location hash, not version
    const expectedBranch = branchName('fmt', 'CMakeLists.txt', 1);
    expect(octokit.rest.git.createRef).toHaveBeenCalledWith({
      owner: 'testowner',
      repo: 'testrepo',
      ref: `refs/heads/${expectedBranch}`,
      sha: 'base-sha-123',
    });

    expect(octokit.rest.repos.createOrUpdateFileContents).toHaveBeenCalledWith(
      expect.objectContaining({
        path: 'CMakeLists.txt',
        branch: expectedBranch,
        sha: 'file-sha-456',
      }),
    );

    expect(octokit.rest.pulls.create).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'chore(deps): update fmt to 12.1.0',
        head: expectedBranch,
        base: 'main',
      }),
    );
  });

  it('PR body contains edit marker', async () => {
    octokit.rest.git.getRef
      .mockRejectedValueOnce({ status: 404 })
      .mockResolvedValueOnce({ data: { object: { sha: 'base-sha' } } });

    const content = Buffer.from('GIT_TAG v10.2.1\n').toString('base64');
    octokit.rest.repos.getContent.mockResolvedValue({
      data: { content, sha: 'file-sha' },
    });
    octokit.rest.git.createRef.mockResolvedValue({});
    octokit.rest.repos.createOrUpdateFileContents.mockResolvedValue({});
    octokit.rest.issues.addLabels.mockResolvedValue({});
    octokit.rest.pulls.create.mockResolvedValue({
      data: { number: 1, html_url: 'url' },
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await createUpdatePr(octokit as any, ctx, makeUpdateResult(), edit);

    const body = octokit.rest.pulls.create.mock.calls[0][0].body as string;
    expect(body).toContain('<!-- cmake-depcheck:edit:v12.1.0 -->');
  });

  it('shows abbreviated SHA with version for SHA-pinned deps in the PR body', async () => {
    octokit.rest.git.getRef
      .mockRejectedValueOnce({ status: 404 })
      .mockResolvedValueOnce({ data: { object: { sha: 'base-sha' } } });

    const currentSha = '769abd9ad368f63d3fcdf5e69fc99a907e4da6ad';
    const newSha = '77a832110d40b0179636f5be8f8781f8299d7e50';
    const content = Buffer.from(`GIT_TAG ${currentSha}\n`).toString('base64');
    octokit.rest.repos.getContent.mockResolvedValue({
      data: { content, sha: 'file-sha' },
    });
    octokit.rest.git.createRef.mockResolvedValue({});
    octokit.rest.repos.createOrUpdateFileContents.mockResolvedValue({});
    octokit.rest.issues.addLabels.mockResolvedValue({});
    octokit.rest.pulls.create.mockResolvedValue({ data: { number: 1, html_url: 'url' } });

    const result = makeUpdateResult({
      dep: makeDep({ gitTag: currentSha, gitTagIsSha: true }),
      versionSource: 'sha',
      resolvedTag: '14.2.0',
      latestVersion: '14.2.1',
      latestSha: newSha,
    });
    const shaEdit: FileEdit = {
      file: 'CMakeLists.txt',
      line: 1,
      endLine: 1,
      oldText: currentSha,
      newText: newSha,
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await createUpdatePr(octokit as any, ctx, result, shaEdit);

    const body = octokit.rest.pulls.create.mock.calls[0][0].body as string;
    expect(body).toContain('| **Current** | `769abd9a (14.2.0)` |');
    expect(body).toContain('| **Latest** | `77a83211 (14.2.1)` |');
    // Title still uses the plain version, not the combined field
    expect(octokit.rest.pulls.create.mock.calls[0][0].title).toBe(
      'chore(deps): update fmt to 14.2.1',
    );
  });

  it('finds GIT_TAG on a line after startLine within the block', async () => {
    octokit.rest.git.getRef
      .mockRejectedValueOnce({ status: 404 })
      .mockResolvedValueOnce({ data: { object: { sha: 'base-sha' } } });

    const fileContent = [
      'FetchContent_Declare(',
      '  freetype',
      '  GIT_REPOSITORY https://github.com/freetype/freetype.git',
      '  GIT_TAG VER-2-14-2',
      ')',
    ].join('\n');
    const content = Buffer.from(fileContent).toString('base64');
    octokit.rest.repos.getContent.mockResolvedValue({
      data: { content, sha: 'file-sha' },
    });
    octokit.rest.git.createRef.mockResolvedValue({});
    octokit.rest.repos.createOrUpdateFileContents.mockResolvedValue({});
    octokit.rest.issues.addLabels.mockResolvedValue({});
    octokit.rest.pulls.create.mockResolvedValue({
      data: { number: 10, html_url: 'https://github.com/testowner/testrepo/pull/10' },
    });

    const depEdit: FileEdit = {
      file: 'CMakeLists.txt',
      line: 1,
      endLine: 5,
      oldText: 'VER-2-14-2',
      newText: 'VER-2-14-3',
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await createUpdatePr(octokit as any, ctx, makeUpdateResult(), depEdit);

    expect(result.prNumber).toBe(10);

    const committedContent = Buffer.from(
      octokit.rest.repos.createOrUpdateFileContents.mock.calls[0][0].content,
      'base64',
    ).toString('utf-8');
    expect(committedContent).toContain('GIT_TAG VER-2-14-3');
    expect(committedContent).not.toContain('VER-2-14-2');
  });

  it('does not match version string outside the block range', async () => {
    octokit.rest.git.getRef
      .mockRejectedValueOnce({ status: 404 })
      .mockResolvedValueOnce({ data: { object: { sha: 'base-sha' } } });

    const fileContent = [
      '# Using version 1.2.3 of somelib',
      '',
      'FetchContent_Declare(',
      '  somelib',
      '  GIT_REPOSITORY https://x.git',
      '  GIT_TAG 1.2.3',
      ')',
    ].join('\n');
    const content = Buffer.from(fileContent).toString('base64');
    octokit.rest.repos.getContent.mockResolvedValue({
      data: { content, sha: 'file-sha' },
    });
    octokit.rest.git.createRef.mockResolvedValue({});
    octokit.rest.repos.createOrUpdateFileContents.mockResolvedValue({});
    octokit.rest.issues.addLabels.mockResolvedValue({});
    octokit.rest.pulls.create.mockResolvedValue({
      data: { number: 11, html_url: 'url' },
    });

    const depEdit: FileEdit = {
      file: 'CMakeLists.txt',
      line: 3,
      endLine: 7,
      oldText: '1.2.3',
      newText: '2.0.0',
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await createUpdatePr(octokit as any, ctx, makeUpdateResult(), depEdit);
    expect(result.prNumber).toBe(11);

    const committedContent = Buffer.from(
      octokit.rest.repos.createOrUpdateFileContents.mock.calls[0][0].content,
      'base64',
    ).toString('utf-8');
    expect(committedContent).toContain('# Using version 1.2.3 of somelib');
    expect(committedContent).toContain('GIT_TAG 2.0.0');
  });

  it('returns error when old text not found in file content', async () => {
    octokit.rest.git.getRef
      .mockRejectedValueOnce({ status: 404 })
      .mockResolvedValueOnce({ data: { object: { sha: 'base-sha' } } });

    const content = Buffer.from('GIT_TAG v9.9.9\n').toString('base64');
    octokit.rest.repos.getContent.mockResolvedValue({
      data: { content, sha: 'file-sha' },
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await createUpdatePr(octokit as any, ctx, makeUpdateResult(), edit);

    expect(result.action).toBe('error');
    expect(result.error).toMatch(/Could not find.*between lines/);
    expect(octokit.rest.git.createRef).not.toHaveBeenCalled();
  });

  it('returns error when file content cannot be read', async () => {
    octokit.rest.git.getRef
      .mockRejectedValueOnce({ status: 404 })
      .mockResolvedValueOnce({ data: { object: { sha: 'base-sha' } } });

    octokit.rest.repos.getContent.mockResolvedValue({
      data: [{ name: 'file1' }],
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await createUpdatePr(octokit as any, ctx, makeUpdateResult(), edit);

    expect(result.action).toBe('error');
    expect(result.error).toMatch(/Could not read file/);
  });

  it('does not call ensureLabel (handled by orchestrator)', async () => {
    octokit.rest.git.getRef
      .mockRejectedValueOnce({ status: 404 })
      .mockResolvedValueOnce({ data: { object: { sha: 'base-sha' } } });

    const content = Buffer.from('GIT_TAG v10.2.1\n').toString('base64');
    octokit.rest.repos.getContent.mockResolvedValue({
      data: { content, sha: 'file-sha' },
    });
    octokit.rest.git.createRef.mockResolvedValue({});
    octokit.rest.repos.createOrUpdateFileContents.mockResolvedValue({});
    octokit.rest.issues.addLabels.mockResolvedValue({});
    octokit.rest.pulls.create.mockResolvedValue({
      data: { number: 1, html_url: 'https://github.com/testowner/testrepo/pull/1' },
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await createUpdatePr(octokit as any, ctx, makeUpdateResult(), edit);

    expect(octokit.rest.issues.getLabel).not.toHaveBeenCalled();
    expect(octokit.rest.issues.createLabel).not.toHaveBeenCalled();
  });

  describe('release notes in PR body', () => {
    function setupHappyPath(octokit: MockOctokit) {
      octokit.rest.git.getRef
        .mockRejectedValueOnce({ status: 404 })
        .mockResolvedValueOnce({ data: { object: { sha: 'base-sha' } } });

      const content = Buffer.from('GIT_TAG v10.2.1\n').toString('base64');
      octokit.rest.repos.getContent.mockResolvedValue({
        data: { content, sha: 'file-sha' },
      });
      octokit.rest.git.createRef.mockResolvedValue({});
      octokit.rest.repos.createOrUpdateFileContents.mockResolvedValue({});
      octokit.rest.issues.addLabels.mockResolvedValue({});
      octokit.rest.pulls.create.mockResolvedValue({
        data: { number: 99, html_url: 'https://github.com/testowner/testrepo/pull/99' },
      });
    }

    it('includes release notes when intermediateTags is present', async () => {
      setupHappyPath(octokit);
      mockedFetchReleaseNotes.mockResolvedValueOnce('### Release Notes\n\nSome notes');

      const dep = makeUpdateResult({ intermediateTags: ['v12.1.0', 'v11.0.0'] });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await createUpdatePr(octokit as any, ctx, dep, edit);

      const body = octokit.rest.pulls.create.mock.calls[0][0].body as string;
      expect(body).toContain('### Release Notes');
      expect(body).toContain('Some notes');
    });

    it('body is unchanged when intermediateTags is absent', async () => {
      setupHappyPath(octokit);

      const dep = makeUpdateResult();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await createUpdatePr(octokit as any, ctx, dep, edit);

      const body = octokit.rest.pulls.create.mock.calls[0][0].body as string;
      expect(body).not.toContain('Release Notes');
      expect(mockedFetchReleaseNotes).not.toHaveBeenCalled();
    });

    it('body is unchanged when fetchReleaseNotes returns empty string', async () => {
      setupHappyPath(octokit);
      mockedFetchReleaseNotes.mockResolvedValueOnce('');

      const dep = makeUpdateResult({ intermediateTags: ['v12.1.0'] });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await createUpdatePr(octokit as any, ctx, dep, edit);

      const body = octokit.rest.pulls.create.mock.calls[0][0].body as string;
      expect(body).not.toContain('Release Notes');
      expect(body).toContain('|\n\n---');
    });

    it('PR creation succeeds when fetchReleaseNotes throws', async () => {
      setupHappyPath(octokit);
      mockedFetchReleaseNotes.mockRejectedValueOnce(new Error('unexpected'));

      const dep = makeUpdateResult({ intermediateTags: ['v12.1.0'] });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await createUpdatePr(octokit as any, ctx, dep, edit);

      expect(result.prNumber).toBe(99);
    });
  });

  it('ensureLabel creates label when it does not exist', async () => {
    const { ensureLabel } = await import('../../src/pr/github.js');

    octokit.rest.issues.getLabel.mockRejectedValue({ status: 404 });
    octokit.rest.issues.createLabel.mockResolvedValue({});

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await ensureLabel(octokit as any, ctx);

    expect(octokit.rest.issues.createLabel).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'dependencies' }),
    );
  });
});
