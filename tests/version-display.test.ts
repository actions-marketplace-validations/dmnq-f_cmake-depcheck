import { describe, it, expect } from 'vitest';

import { currentVersionField, latestVersionField } from '../src/version-display.js';
import type { UpdateCheckResult } from '../src/checker/types.js';
import type { FetchContentDependency } from '../src/parser/types.js';

const CURRENT_SHA = '769abd9ad368f63d3fcdf5e69fc99a907e4da6ad';
const NEW_SHA = '77a832110d40b0179636f5be8f8781f8299d7e50';

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

function makeResult(overrides: Partial<UpdateCheckResult> = {}): UpdateCheckResult {
  return {
    dep: makeDep(),
    status: 'update-available',
    versionSource: 'git-tag',
    latestVersion: '12.1.0',
    ...overrides,
  };
}

describe('currentVersionField', () => {
  it('shows abbreviated SHA with resolved version for SHA-pinned deps', () => {
    const result = makeResult({
      dep: makeDep({ gitTag: CURRENT_SHA, gitTagIsSha: true }),
      versionSource: 'sha',
      resolvedTag: '14.2.0',
    });
    expect(currentVersionField(result)).toBe('769abd9a (14.2.0)');
  });

  it('shows the tag alone for tag-pinned deps', () => {
    expect(currentVersionField(makeResult())).toBe('v10.2.1');
  });

  it('shows resolvedVersion for URL deps', () => {
    const result = makeResult({
      dep: makeDep({ sourceType: 'url', gitTag: undefined, gitRepository: undefined }),
      versionSource: 'url',
      resolvedVersion: '2.0.0',
    });
    expect(currentVersionField(result)).toBe('2.0.0');
  });

  it('abbreviates a SHA-like resolvedVersion for URL deps', () => {
    const result = makeResult({
      dep: makeDep({ sourceType: 'url', gitTag: undefined, gitRepository: undefined }),
      versionSource: 'url',
      resolvedVersion: CURRENT_SHA,
    });
    expect(currentVersionField(result)).toBe('769abd9a');
  });

  it('does not append version when a SHA-pinned dep did not resolve to a tag', () => {
    const result = makeResult({
      dep: makeDep({ gitTag: CURRENT_SHA, gitTagIsSha: true }),
      versionSource: 'sha',
    });
    expect(currentVersionField(result)).toBe(CURRENT_SHA);
  });

  it('uses the fallback when no version information is available', () => {
    const result = makeResult({
      dep: makeDep({ gitTag: undefined }),
      resolvedVersion: undefined,
    });
    expect(currentVersionField(result)).toBe('unknown');
    expect(currentVersionField(result, '—')).toBe('—');
  });
});

describe('latestVersionField', () => {
  it('shows abbreviated new SHA with new version for SHA-pinned deps', () => {
    const result = makeResult({
      dep: makeDep({ gitTag: CURRENT_SHA, gitTagIsSha: true }),
      versionSource: 'sha',
      latestVersion: '14.2.1',
      latestSha: NEW_SHA,
    });
    expect(latestVersionField(result)).toBe('77a83211 (14.2.1)');
  });

  it('shows the version alone for tag-pinned deps', () => {
    expect(latestVersionField(makeResult())).toBe('12.1.0');
  });

  it('shows the version alone when latestSha is absent', () => {
    const result = makeResult({
      dep: makeDep({ gitTag: CURRENT_SHA, gitTagIsSha: true }),
      versionSource: 'sha',
      latestVersion: '14.2.1',
    });
    expect(latestVersionField(result)).toBe('14.2.1');
  });

  it('uses the fallback when latestVersion is absent', () => {
    const result = makeResult({ latestVersion: undefined });
    expect(latestVersionField(result)).toBe('unknown');
    expect(latestVersionField(result, '—')).toBe('—');
  });
});
