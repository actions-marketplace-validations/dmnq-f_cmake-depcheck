import { describe, it, expect } from 'vitest';
import { formatJsonOutput, JsonOutputOptions } from '../../src/formatter/index.js';
import { FetchContentDependency } from '../../src/parser/types.js';
import { UpdateCheckResult } from '../../src/checker/types.js';

const FIXED_DATE = new Date('2026-03-23T12:00:00.000Z');

function makeDep(overrides: Partial<FetchContentDependency> = {}): FetchContentDependency {
  return {
    name: 'googletest',
    sourceType: 'git',
    gitRepository: 'https://github.com/google/googletest.git',
    gitTag: 'v1.14.0',
    gitTagIsSha: false,
    location: { file: '/project/CMakeLists.txt', startLine: 12, endLine: 17 },
    ...overrides,
  };
}

function makeResult(
  dep: FetchContentDependency,
  overrides: Partial<Omit<UpdateCheckResult, 'dep'>> = {},
): UpdateCheckResult {
  return { dep, status: 'up-to-date', versionSource: 'git-tag', ...overrides };
}

function baseOptions(overrides: Partial<JsonOutputOptions> = {}): JsonOutputOptions {
  return {
    deps: [makeDep()],
    allDepNames: ['googletest'],
    basePath: '/project',
    ignoredCount: 0,
    filteredCount: 0,
    scanMode: 'directory',
    entryPath: './project',
    filesScanned: ['/project/CMakeLists.txt'],
    warnings: [],
    now: FIXED_DATE,
    ...overrides,
  };
}

describe('formatJsonOutput', () => {
  it('sets schemaVersion to 1', () => {
    const output = formatJsonOutput(baseOptions()) as Record<string, unknown>;
    expect(output.schemaVersion).toBe(2);
  });

  it('includes meta with correct fields', () => {
    const output = formatJsonOutput(baseOptions()) as Record<string, unknown>;
    const meta = output.meta as Record<string, unknown>;
    expect(meta.scanMode).toBe('directory');
    expect(meta.entryPath).toBe('./project');
    expect(meta.filesScanned).toEqual(['CMakeLists.txt']);
    expect(meta.timestamp).toBe('2026-03-23T12:00:00.000Z');
    expect(meta.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('relativizes location.file paths', () => {
    const output = formatJsonOutput(baseOptions()) as Record<string, unknown>;
    const deps = output.dependencies as Record<string, unknown>[];
    const loc = deps[0].location as Record<string, unknown>;
    expect(loc.file).toBe('CMakeLists.txt');
    expect(loc.startLine).toBe(12);
    expect(loc.endLine).toBe(17);
  });

  it('relativizes filesScanned paths', () => {
    const output = formatJsonOutput(
      baseOptions({
        filesScanned: ['/project/CMakeLists.txt', '/project/cmake/deps.cmake'],
      }),
    ) as Record<string, unknown>;
    const meta = output.meta as Record<string, unknown>;
    expect(meta.filesScanned).toEqual(['CMakeLists.txt', 'cmake/deps.cmake']);
  });

  describe('scan-only mode (no updateResults)', () => {
    it('omits updateCheck on dependencies', () => {
      const output = formatJsonOutput(baseOptions()) as Record<string, unknown>;
      const deps = output.dependencies as Record<string, unknown>[];
      expect(deps[0]).not.toHaveProperty('updateCheck');
    });

    it('omits summary', () => {
      const output = formatJsonOutput(baseOptions()) as Record<string, unknown>;
      expect(output).not.toHaveProperty('summary');
    });

    it('includes dependency fields', () => {
      const output = formatJsonOutput(baseOptions()) as Record<string, unknown>;
      const deps = output.dependencies as Record<string, unknown>[];
      expect(deps[0].name).toBe('googletest');
      expect(deps[0].sourceType).toBe('git');
      expect(deps[0].gitRepository).toBe('https://github.com/google/googletest.git');
      expect(deps[0].gitTag).toBe('v1.14.0');
      expect(deps[0].gitTagIsSha).toBe(false);
    });
  });

  describe('full mode (with updateResults)', () => {
    it('includes updateCheck on dependencies', () => {
      const dep = makeDep();
      const result = makeResult(dep, {
        status: 'update-available',
        latestVersion: 'v1.15.0',
        updateType: 'minor',
      });
      const output = formatJsonOutput(
        baseOptions({ deps: [dep], updateResults: [result] }),
      ) as Record<string, unknown>;
      const deps = output.dependencies as Record<string, unknown>[];
      const check = deps[0].updateCheck as Record<string, unknown>;
      expect(check.status).toBe('update-available');
      expect(check.latestVersion).toBe('v1.15.0');
      expect(check.updateType).toBe('minor');
    });

    it('includes summary with correct counts', () => {
      const dep = makeDep();
      const result = makeResult(dep);
      const output = formatJsonOutput(
        baseOptions({ deps: [dep], updateResults: [result] }),
      ) as Record<string, unknown>;
      const summary = output.summary as Record<string, unknown>;
      expect(summary.total).toBe(1);
      expect(summary.upToDate).toBe(1);
      expect(summary.updatesAvailable).toBe(0);
    });
  });

  it('counts each status type correctly in summary', () => {
    const deps = [
      makeDep({ name: 'a' }),
      makeDep({ name: 'b' }),
      makeDep({ name: 'c' }),
      makeDep({ name: 'd' }),
      makeDep({ name: 'e', sourceType: 'url', url: 'https://example.com/e.tar.gz' }),
      makeDep({ name: 'f' }),
      makeDep({ name: 'g' }),
    ];
    const results: UpdateCheckResult[] = [
      makeResult(deps[0], { status: 'up-to-date' }),
      makeResult(deps[1], {
        status: 'update-available',
        latestVersion: 'v2.0.0',
        updateType: 'major',
      }),
      makeResult(deps[2], { status: 'pinned' }),
      makeResult(deps[3], { status: 'unpinned' }),
      makeResult(deps[4], { status: 'unsupported' }),
      makeResult(deps[5], { status: 'check-failed', error: 'timeout' }),
      makeResult(deps[6], { status: 'unresolved-variable' }),
    ];
    const output = formatJsonOutput(baseOptions({ deps, updateResults: results })) as Record<
      string,
      unknown
    >;
    const summary = output.summary as Record<string, unknown>;
    expect(summary).toEqual({
      total: 7,
      upToDate: 1,
      updatesAvailable: 1,
      pinned: 1,
      unpinned: 1,
      unsupported: 1,
      checkFailed: 1,
      unresolvedVariable: 1,
    });
  });

  it('check-failed entries include error field', () => {
    const dep = makeDep();
    const result = makeResult(dep, { status: 'check-failed', error: 'network error' });
    const output = formatJsonOutput(
      baseOptions({ deps: [dep], updateResults: [result] }),
    ) as Record<string, unknown>;
    const deps = output.dependencies as Record<string, unknown>[];
    const check = deps[0].updateCheck as Record<string, unknown>;
    expect(check.error).toBe('network error');
  });

  it('non-failed entries do not include error field', () => {
    const dep = makeDep();
    const result = makeResult(dep, { status: 'up-to-date' });
    const output = formatJsonOutput(
      baseOptions({ deps: [dep], updateResults: [result] }),
    ) as Record<string, unknown>;
    const deps = output.dependencies as Record<string, unknown>[];
    const check = deps[0].updateCheck as Record<string, unknown>;
    expect(check).not.toHaveProperty('error');
  });

  it('update-available entries include updateType', () => {
    const dep = makeDep();
    const result = makeResult(dep, {
      status: 'update-available',
      latestVersion: 'v2.0.0',
      updateType: 'major',
    });
    const output = formatJsonOutput(
      baseOptions({ deps: [dep], updateResults: [result] }),
    ) as Record<string, unknown>;
    const deps = output.dependencies as Record<string, unknown>[];
    const check = deps[0].updateCheck as Record<string, unknown>;
    expect(check.updateType).toBe('major');
  });

  it('up-to-date entries do not include updateType', () => {
    const dep = makeDep();
    const result = makeResult(dep, { status: 'up-to-date' });
    const output = formatJsonOutput(
      baseOptions({ deps: [dep], updateResults: [result] }),
    ) as Record<string, unknown>;
    const deps = output.dependencies as Record<string, unknown>[];
    const check = deps[0].updateCheck as Record<string, unknown>;
    expect(check).not.toHaveProperty('updateType');
  });

  it('empty project produces empty dependencies and zero summary', () => {
    const output = formatJsonOutput(baseOptions({ deps: [], updateResults: [] })) as Record<
      string,
      unknown
    >;
    expect(output.dependencies).toEqual([]);
    const summary = output.summary as Record<string, unknown>;
    expect(summary.total).toBe(0);
  });

  it('ignoredCount reflects filtered deps', () => {
    const output = formatJsonOutput(baseOptions({ ignoredCount: 3 })) as Record<string, unknown>;
    expect(output.ignoredCount).toBe(3);
  });

  it('filteredCount appears in output', () => {
    const output = formatJsonOutput(baseOptions({ filteredCount: 5 })) as Record<string, unknown>;
    expect(output.filteredCount).toBe(5);
  });

  it('filteredCount defaults to 0', () => {
    const output = formatJsonOutput(baseOptions()) as Record<string, unknown>;
    expect(output.filteredCount).toBe(0);
  });

  it('warnings array is populated', () => {
    const output = formatJsonOutput(
      baseOptions({ warnings: ['Warning: unresolvable path', 'Warning: file not found'] }),
    ) as Record<string, unknown>;
    expect(output.warnings).toEqual(['Warning: unresolvable path', 'Warning: file not found']);
  });

  it('unsupported dependencies include url but not git fields', () => {
    const dep = makeDep({
      name: 'zlib',
      sourceType: 'url',
      url: 'https://example.com/zlib.tar.gz',
      gitRepository: undefined,
      gitTag: undefined,
      gitTagIsSha: undefined,
    });
    const output = formatJsonOutput(baseOptions({ deps: [dep] })) as Record<string, unknown>;
    const deps = output.dependencies as Record<string, unknown>[];
    expect(deps[0].url).toBe('https://example.com/zlib.tar.gz');
    expect(deps[0]).not.toHaveProperty('gitRepository');
    expect(deps[0]).not.toHaveProperty('gitTag');
    expect(deps[0]).not.toHaveProperty('gitTagIsSha');
  });

  it('defaults timestamp to now when now is omitted', () => {
    const output = formatJsonOutput(baseOptions({ now: undefined })) as Record<string, unknown>;
    const meta = output.meta as Record<string, unknown>;
    const ts = meta.timestamp as string;
    expect(() => new Date(ts)).not.toThrow();
    expect(new Date(ts).toISOString()).toBe(ts);
  });

  it('includes updatedUrl in updateCheck when present', () => {
    const dep = makeDep();
    const result = makeResult(dep, {
      status: 'update-available',
      latestVersion: 'v2.0.0',
      updateType: 'major',
      updatedUrl: 'https://github.com/owner/repo/archive/v2.0.0.tar.gz',
    });
    const output = formatJsonOutput(
      baseOptions({ deps: [dep], updateResults: [result] }),
    ) as Record<string, unknown>;
    const deps = output.dependencies as Record<string, unknown>[];
    const check = deps[0].updateCheck as Record<string, unknown>;
    expect(check.updatedUrl).toBe('https://github.com/owner/repo/archive/v2.0.0.tar.gz');
  });

  it('omits updatedUrl from updateCheck when not present', () => {
    const dep = makeDep();
    const result = makeResult(dep, {
      status: 'update-available',
      latestVersion: 'v2.0.0',
      updateType: 'major',
    });
    const output = formatJsonOutput(
      baseOptions({ deps: [dep], updateResults: [result] }),
    ) as Record<string, unknown>;
    const deps = output.dependencies as Record<string, unknown>[];
    const check = deps[0].updateCheck as Record<string, unknown>;
    expect(check).not.toHaveProperty('updatedUrl');
  });

  it('includes resolvedVersion in updateCheck when present', () => {
    const dep = makeDep();
    const result = makeResult(dep, {
      status: 'up-to-date',
      resolvedVersion: 'v1.2.3',
    });
    const output = formatJsonOutput(
      baseOptions({ deps: [dep], updateResults: [result] }),
    ) as Record<string, unknown>;
    const deps = output.dependencies as Record<string, unknown>[];
    const check = deps[0].updateCheck as Record<string, unknown>;
    expect(check.resolvedVersion).toBe('v1.2.3');
  });

  it('surfaces versionSource on updateCheck for every classification', () => {
    const dep = makeDep();
    const result = makeResult(dep, { status: 'pinned', versionSource: 'sha' });
    const output = formatJsonOutput(
      baseOptions({ deps: [dep], updateResults: [result] }),
    ) as Record<string, unknown>;
    const deps = output.dependencies as Record<string, unknown>[];
    const check = deps[0].updateCheck as Record<string, unknown>;
    expect(check.versionSource).toBe('sha');
  });

  it('surfaces resolvedTag and latestSha for SHA-resolved update-available results', () => {
    const dep = makeDep({
      gitTag: '407c905e45ad75fc29bf0f9bb7c5c2fd3475976f',
      gitTagIsSha: true,
      gitTagComment: '12.1.0',
    });
    const result = makeResult(dep, {
      status: 'update-available',
      versionSource: 'sha',
      latestVersion: 'v12.2.0',
      updateType: 'minor',
      resolvedTag: 'v12.1.0',
      latestSha: 'bbbbbb0000000000000000000000000000000000',
    });
    const output = formatJsonOutput(
      baseOptions({ deps: [dep], updateResults: [result] }),
    ) as Record<string, unknown>;
    const deps = output.dependencies as Record<string, unknown>[];
    const check = deps[0].updateCheck as Record<string, unknown>;

    expect(check.versionSource).toBe('sha');
    expect(check.resolvedTag).toBe('v12.1.0');
    expect(check.latestSha).toBe('bbbbbb0000000000000000000000000000000000');
    expect(deps[0].gitTagComment).toBe('12.1.0');
  });
});
