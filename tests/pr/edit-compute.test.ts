import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import { computeEdit } from '../../src/pr/edit-compute.js';
import { parseCMakeContent } from '../../src/parser/cmake-parser.js';
import { resolveChain, resolveDependencyVariables } from '../../src/scanner/chain-resolver.js';
import type { UpdateCheckResult } from '../../src/checker/types.js';
import type { FetchContentDependency } from '../../src/parser/types.js';
import type { VariableInfo } from '../../src/scanner/chain-resolver.js';

const FIXTURES = path.join(__dirname, '..', 'fixtures');

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

function makeResult(overrides: Partial<UpdateCheckResult> = {}): UpdateCheckResult {
  return {
    dep: makeDep(),
    status: 'update-available',
    versionSource: 'git-tag',
    latestVersion: '12.1.0',
    updateType: 'major',
    ...overrides,
  };
}

describe('computeEdit', () => {
  it('returns null for non-update-available status', () => {
    const result = makeResult({ status: 'up-to-date' });
    expect(computeEdit(result)).toBeNull();
  });

  describe('literal GIT_TAG replacement', () => {
    it('computes edit for a literal GIT_TAG', () => {
      const result = makeResult({
        dep: makeDep({ gitTag: '10.2.1' }),
        latestVersion: '12.1.0',
      });
      const edit = computeEdit(result);

      expect(edit).toEqual({
        file: '/project/CMakeLists.txt',
        line: 10,
        endLine: 14,
        oldText: '10.2.1',
        newText: '12.1.0',
      });
    });

    it('preserves v prefix when current has v and latest does not', () => {
      const result = makeResult({
        dep: makeDep({ gitTag: 'v10.2.1' }),
        latestVersion: '12.1.0',
      });
      const edit = computeEdit(result);

      expect(edit).toEqual({
        file: '/project/CMakeLists.txt',
        line: 10,
        endLine: 14,
        oldText: 'v10.2.1',
        newText: 'v12.1.0',
      });
    });

    it('strips v prefix when current lacks v and latest has v', () => {
      const result = makeResult({
        dep: makeDep({ gitTag: '10.2.1' }),
        latestVersion: 'v12.1.0',
      });
      const edit = computeEdit(result);

      expect(edit).toEqual({
        file: '/project/CMakeLists.txt',
        line: 10,
        endLine: 14,
        oldText: '10.2.1',
        newText: '12.1.0',
      });
    });

    it('returns null when current and latest are the same after alignment', () => {
      const result = makeResult({
        dep: makeDep({ gitTag: 'v12.1.0' }),
        latestVersion: '12.1.0',
      });
      const edit = computeEdit(result);
      expect(edit).toBeNull();
    });
  });

  describe('variable-resolved GIT_TAG → set() replacement', () => {
    it('targets the set() variable when gitTagRaw contains ${VAR}', () => {
      const dep = makeDep({
        gitTag: '10.2.1',
        gitTagRaw: '${FMT_VERSION}',
      });
      const vars = new Map<string, VariableInfo>([
        ['FMT_VERSION', { value: '10.2.1', file: '/project/cmake/versions.cmake', line: 5 }],
      ]);
      const result = makeResult({ dep, latestVersion: '12.1.0' });
      const edit = computeEdit(result, vars);

      expect(edit).toEqual({
        file: '/project/cmake/versions.cmake',
        line: 5,
        endLine: 5,
        oldText: '10.2.1',
        newText: '12.1.0',
      });
    });

    it('preserves v prefix in variable value', () => {
      const dep = makeDep({
        gitTag: 'v1.2.3',
        gitTagRaw: '${LIB_VERSION}',
      });
      const vars = new Map<string, VariableInfo>([
        ['LIB_VERSION', { value: 'v1.2.3', file: '/project/versions.cmake', line: 3 }],
      ]);
      const result = makeResult({ dep, latestVersion: '2.0.0' });
      const edit = computeEdit(result, vars);

      expect(edit).toEqual({
        file: '/project/versions.cmake',
        line: 3,
        endLine: 3,
        oldText: 'v1.2.3',
        newText: 'v2.0.0',
      });
    });

    it('returns null when vars map is not provided', () => {
      const dep = makeDep({
        gitTag: '10.2.1',
        gitTagRaw: '${FMT_VERSION}',
      });
      const result = makeResult({ dep });
      expect(computeEdit(result)).toBeNull();
    });

    it('returns null when variable not found in vars', () => {
      const dep = makeDep({
        gitTag: '10.2.1',
        gitTagRaw: '${UNKNOWN_VAR}',
      });
      const vars = new Map<string, VariableInfo>();
      const result = makeResult({ dep });
      expect(computeEdit(result, vars)).toBeNull();
    });
  });

  describe('URL dep with updatedUrl', () => {
    it('computes edit for a literal URL replacement', () => {
      const dep = makeDep({
        sourceType: 'url',
        gitTag: undefined,
        gitRepository: undefined,
        url: 'https://github.com/owner/repo/archive/refs/tags/v1.0.0.tar.gz',
      });
      const result = makeResult({
        dep,
        latestVersion: '2.0.0',
        updatedUrl: 'https://github.com/owner/repo/archive/refs/tags/v2.0.0.tar.gz',
      });
      const edit = computeEdit(result);

      expect(edit).toEqual({
        file: '/project/CMakeLists.txt',
        line: 10,
        endLine: 14,
        oldText: 'https://github.com/owner/repo/archive/refs/tags/v1.0.0.tar.gz',
        newText: 'https://github.com/owner/repo/archive/refs/tags/v2.0.0.tar.gz',
      });
    });

    it('targets set() variable when urlRaw contains ${VAR}', () => {
      const dep = makeDep({
        sourceType: 'url',
        gitTag: undefined,
        gitRepository: undefined,
        url: 'https://github.com/owner/repo/archive/refs/tags/v1.0.0.tar.gz',
        urlRaw: 'https://github.com/owner/repo/archive/refs/tags/${REPO_VERSION}.tar.gz',
      });
      const vars = new Map<string, VariableInfo>([
        ['REPO_VERSION', { value: 'v1.0.0', file: '/project/versions.cmake', line: 2 }],
      ]);
      const result = makeResult({
        dep,
        latestVersion: '2.0.0',
        updatedUrl: 'https://github.com/owner/repo/archive/refs/tags/v2.0.0.tar.gz',
      });
      const edit = computeEdit(result, vars);

      expect(edit).toEqual({
        file: '/project/versions.cmake',
        line: 2,
        endLine: 2,
        oldText: 'v1.0.0',
        newText: 'v2.0.0',
      });
    });
  });

  describe('non-editable cases', () => {
    it('returns null for pinned status', () => {
      expect(computeEdit(makeResult({ status: 'pinned' }))).toBeNull();
    });

    it('returns null for unsupported status', () => {
      expect(computeEdit(makeResult({ status: 'unsupported' }))).toBeNull();
    });

    it('returns null for URL dep without updatedUrl', () => {
      const dep = makeDep({
        sourceType: 'url',
        gitTag: undefined,
        gitRepository: undefined,
        url: 'https://example.com/lib.tar.gz',
      });
      const result = makeResult({ dep, updatedUrl: undefined });
      expect(computeEdit(result)).toBeNull();
    });
  });

  describe('SHA-resolved git dep (composite edit)', () => {
    const PINNED_SHA = '407c905e45ad75fc29bf0f9bb7c5c2fd3475976f';
    const NEW_SHA = 'bbbbbb0000000000000000000000000000000000';

    function makeShaResult(
      overrides: Partial<UpdateCheckResult> = {},
      depOverrides: Partial<FetchContentDependency> = {},
    ): UpdateCheckResult {
      return makeResult({
        dep: makeDep({ gitTag: PINNED_SHA, gitTagIsSha: true, ...depOverrides }),
        versionSource: 'sha',
        resolvedTag: 'v12.1.0',
        latestVersion: 'v12.2.0',
        latestSha: NEW_SHA,
        updateType: 'minor',
        ...overrides,
      });
    }

    it('rewrites SHA and version-shaped comment together, preserving whitespace', () => {
      const result = makeShaResult(
        {},
        {
          gitTagComment: '12.1.0',
          gitTagCommentRaw: '  # 12.1.0',
        },
      );
      const edit = computeEdit(result);
      expect(edit).toEqual({
        file: '/project/CMakeLists.txt',
        line: 10,
        endLine: 14,
        oldText: `${PINNED_SHA}  # 12.1.0`,
        newText: `${NEW_SHA}  # 12.2.0`,
      });
    });

    it('preserves extra whitespace between SHA and #', () => {
      const result = makeShaResult(
        {},
        {
          gitTagComment: '12.1.0',
          gitTagCommentRaw: '   # 12.1.0',
        },
      );
      const edit = computeEdit(result);
      expect(edit?.oldText).toBe(`${PINNED_SHA}   # 12.1.0`);
      expect(edit?.newText).toBe(`${NEW_SHA}   # 12.1.0`.replace('12.1.0', '12.2.0'));
    });

    it('preserves a non-version trailing comment verbatim', () => {
      const result = makeShaResult(
        {},
        {
          gitTagComment: 'pinning until 5.x lands',
          gitTagCommentRaw: '  # pinning until 5.x lands',
        },
      );
      const edit = computeEdit(result);
      expect(edit?.oldText).toBe(`${PINNED_SHA}  # pinning until 5.x lands`);
      expect(edit?.newText).toBe(`${NEW_SHA}  # pinning until 5.x lands`);
    });

    it('rewrites only the version token within a longer comment', () => {
      const result = makeShaResult(
        {},
        {
          gitTagComment: 'bumped to 12.1.0 for security',
          gitTagCommentRaw: '  # bumped to 12.1.0 for security',
        },
      );
      const edit = computeEdit(result);
      expect(edit?.newText).toBe(`${NEW_SHA}  # bumped to 12.2.0 for security`);
    });

    it('aligns prefix style when comment uses a different convention than upstream', () => {
      const result = makeShaResult(
        { latestVersion: 'v12.2.0' },
        {
          gitTagComment: '12.1.0',
          gitTagCommentRaw: '  # 12.1.0',
        },
      );
      const edit = computeEdit(result);
      expect(edit?.newText).toBe(`${NEW_SHA}  # 12.2.0`);
    });

    it('rewrites only the SHA when no trailing comment is present', () => {
      const result = makeShaResult();
      const edit = computeEdit(result);
      expect(edit).toEqual({
        file: '/project/CMakeLists.txt',
        line: 10,
        endLine: 14,
        oldText: PINNED_SHA,
        newText: NEW_SHA,
      });
    });

    it('handles prefix-style hint (VER-2-14-3 → VER-2-14-4)', () => {
      const result = makeShaResult(
        { resolvedTag: 'VER-2-14-3', latestVersion: 'VER-2-14-4' },
        {
          gitTagComment: 'VER-2-14-3',
          gitTagCommentRaw: '  # VER-2-14-3',
        },
      );
      const edit = computeEdit(result);
      expect(edit?.newText).toBe(`${NEW_SHA}  # VER-2-14-4`);
    });

    it('returns null when SHA-resolved result is missing latestSha', () => {
      const result = makeShaResult({ latestSha: undefined });
      expect(computeEdit(result)).toBeNull();
    });

    describe('SHA pinned via variable (set() reference)', () => {
      it('targets the set() line and uses the VariableInfo hint', () => {
        const dep = makeDep({
          gitTag: PINNED_SHA,
          gitTagRaw: '${HARFBUZZ_GIT_COMMIT}',
          gitTagIsSha: true,
          location: { file: '/proj/src/foundation/CMakeLists.txt', startLine: 41, endLine: 45 },
        });
        const vars = new Map<string, VariableInfo>([
          [
            'HARFBUZZ_GIT_COMMIT',
            {
              value: PINNED_SHA,
              file: '/proj/cmake/ThirdPartyVersions.cmake',
              line: 16,
              hint: '14.1.0',
              hintRaw: '")  # 14.1.0',
            },
          ],
        ]);
        const result = makeShaResult({
          resolvedTag: '14.1.0',
          latestVersion: '14.2.0',
        });
        result.dep = dep;
        const edit = computeEdit(result, vars);
        expect(edit).toEqual({
          file: '/proj/cmake/ThirdPartyVersions.cmake',
          line: 16,
          endLine: 16,
          oldText: `${PINNED_SHA}")  # 14.1.0`,
          newText: `${NEW_SHA}")  # 14.2.0`,
        });
      });

      it('targets the set() line with no comment when VariableInfo has no hint', () => {
        const dep = makeDep({
          gitTag: PINNED_SHA,
          gitTagRaw: '${MY_COMMIT}',
          gitTagIsSha: true,
        });
        const vars = new Map<string, VariableInfo>([
          ['MY_COMMIT', { value: PINNED_SHA, file: '/proj/versions.cmake', line: 4 }],
        ]);
        const result = makeShaResult();
        result.dep = dep;
        const edit = computeEdit(result, vars);
        expect(edit).toEqual({
          file: '/proj/versions.cmake',
          line: 4,
          endLine: 4,
          oldText: PINNED_SHA,
          newText: NEW_SHA,
        });
      });

      it('returns null when vars map is missing for variable-resolved SHA dep', () => {
        const dep = makeDep({
          gitTag: PINNED_SHA,
          gitTagRaw: '${MY_COMMIT}',
          gitTagIsSha: true,
        });
        const result = makeShaResult();
        result.dep = dep;
        expect(computeEdit(result)).toBeNull();
      });

      it('returns null when the variable is not in the vars map', () => {
        const dep = makeDep({
          gitTag: PINNED_SHA,
          gitTagRaw: '${UNKNOWN}',
          gitTagIsSha: true,
        });
        const result = makeShaResult();
        result.dep = dep;
        expect(computeEdit(result, new Map<string, VariableInfo>())).toBeNull();
      });
    });
  });

  /**
   * Round-trip safety: scan a real fixture, synthesise an update-available
   * result against it, compute the edit, and assert that `oldText` is an
   * actual substring of the source file at `edit.line`. This catches the
   * whole class of bug where producer and consumer agree on a wrong format
   * (e.g. `hintRaw` missing the `")` between value and `#`).
   *
   * The synthesised result skips the real version-checker so we don't depend
   * on network and can pin both sides of the substitution deterministically.
   */
  describe('round-trip substring safety', () => {
    function scanFixture(name: string) {
      const entry = path.join(FIXTURES, name, 'CMakeLists.txt');
      const chain = resolveChain(entry);
      const deps: FetchContentDependency[] = [];
      for (const f of chain.files) {
        deps.push(...parseCMakeContent(fs.readFileSync(f, 'utf-8'), f));
      }
      resolveDependencyVariables(deps, chain.vars);
      return { deps, vars: chain.vars };
    }

    function assertOldTextInFile(edit: ReturnType<typeof computeEdit>) {
      expect(edit).not.toBeNull();
      if (!edit) return;
      const source = fs.readFileSync(edit.file, 'utf-8');
      const lines = source.split('\n');
      const slice = lines.slice(edit.line - 1, edit.endLine).join('\n');
      expect(slice).toContain(edit.oldText);
    }

    it('SHA pinned via set() variable: oldText is a substring of the source line', () => {
      const { deps, vars } = scanFixture('chain-sha-hint');
      const fmt = deps.find((d) => d.name === 'fmt')!;
      const edit = computeEdit(
        {
          dep: fmt,
          status: 'update-available',
          versionSource: 'sha',
          resolvedTag: '12.1.0',
          latestVersion: '12.2.0',
          latestSha: 'b'.repeat(40),
          updateType: 'minor',
        },
        vars,
      );
      assertOldTextInFile(edit);
    });

    it('inline SHA with trailing comment: oldText is a substring of the source line', () => {
      const { deps, vars } = scanFixture('commit-sha');
      const fmt = deps.find((d) => d.name === 'fmt')!;
      const edit = computeEdit(
        {
          dep: fmt,
          status: 'update-available',
          versionSource: 'sha',
          resolvedTag: '12.1.0',
          latestVersion: '12.2.0',
          latestSha: 'b'.repeat(40),
          updateType: 'minor',
        },
        vars,
      );
      assertOldTextInFile(edit);
    });

    it('literal GIT_TAG: oldText is a substring of the source line', () => {
      const { deps, vars } = scanFixture('basic-git');
      const fmt = deps.find((d) => d.name === 'fmt')!;
      const edit = computeEdit(
        {
          dep: fmt,
          status: 'update-available',
          versionSource: 'git-tag',
          latestVersion: '99.0.0',
          updateType: 'major',
        },
        vars,
      );
      assertOldTextInFile(edit);
    });
  });
});
