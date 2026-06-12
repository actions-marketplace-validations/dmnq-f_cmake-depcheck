import * as path from 'node:path';
import { CommanderError } from 'commander';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { VERSION } from '../src/index.js';
import { createProgram } from '../src/cli.js';

vi.mock('../src/checker/version-checker.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    checkForUpdates: vi.fn(actual.checkForUpdates as (...args: unknown[]) => unknown),
  };
});

import { checkForUpdates } from '../src/checker/version-checker.js';
import { UpdateCheckResult } from '../src/checker/types.js';

const mockedCheckForUpdates = vi.mocked(checkForUpdates);

const FIXTURES = path.join(__dirname, 'fixtures');

let logLines: string[];
let errorLines: string[];
let stdoutChunks: string[];
let origLog: typeof console.log;
let origError: typeof console.error;
let origStdoutWrite: typeof process.stdout.write;

beforeEach(() => {
  logLines = [];
  errorLines = [];
  stdoutChunks = [];
  origLog = console.log;
  origError = console.error;
  origStdoutWrite = process.stdout.write;
  console.log = (msg: string) => logLines.push(msg);
  console.error = (msg: string) => errorLines.push(msg);
  process.stdout.write = ((chunk: string) => {
    stdoutChunks.push(chunk);
    return true;
  }) as typeof process.stdout.write;
  vi.resetAllMocks();
});

afterEach(() => {
  console.log = origLog;
  console.error = origError;
  process.stdout.write = origStdoutWrite;
});

async function runScan(...args: string[]) {
  const program = createProgram();
  program.exitOverride();
  await program.parseAsync(['node', 'cmake-depcheck', 'scan', ...args]);
}

function parseJsonOutput(): Record<string, unknown> {
  const raw = stdoutChunks.join('');
  return JSON.parse(raw) as Record<string, unknown>;
}

describe('cli', () => {
  it('exports a version string', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  describe('--scan-only', () => {
    it('outputs found dependencies', async () => {
      await runScan('--path', path.join(FIXTURES, 'basic-git'), '--scan-only');
      expect(logLines[0]).toMatch(/Found 2 dependencies in 1 file/);
    });

    it('reports no dependencies for empty project', async () => {
      await runScan('--path', path.join(FIXTURES, 'no-fetchcontent'), '--scan-only');
      expect(logLines[0]).toBe('No dependencies found.');
    });

    it('--ignore excludes dependencies by name', async () => {
      await runScan(
        '--path',
        path.join(FIXTURES, 'basic-git'),
        '--ignore',
        'googletest',
        '--scan-only',
      );
      expect(logLines[0]).toMatch(/Found 1 dependencies in 1 file/);
      const output = logLines.join('\n');
      expect(output).toMatch(/fmt/);
      expect(output).not.toMatch(/googletest/);
    });

    it('does not call checkForUpdates', async () => {
      await runScan('--path', path.join(FIXTURES, 'basic-git'), '--scan-only');
      expect(mockedCheckForUpdates).not.toHaveBeenCalled();
    });
  });

  describe('chain mode with --scan-only', () => {
    it('chain-basic: finds 3 deps across 3 files', async () => {
      await runScan('--path', path.join(FIXTURES, 'chain-basic', 'CMakeLists.txt'), '--scan-only');
      expect(logLines[0]).toMatch(/Found 3 dependencies in 3 file/);
    });

    it('chain-unresolvable: finds 2 deps + 2 warnings', async () => {
      await runScan(
        '--path',
        path.join(FIXTURES, 'chain-unresolvable', 'CMakeLists.txt'),
        '--scan-only',
      );
      expect(logLines[0]).toMatch(/Found 2 dependencies in 2 file/);
      expect(errorLines).toHaveLength(2);
    });

    it('chain-nested: finds 3 deps with correct relative resolution', async () => {
      await runScan('--path', path.join(FIXTURES, 'chain-nested', 'CMakeLists.txt'), '--scan-only');
      expect(logLines[0]).toMatch(/Found 3 dependencies/);
      const output = logLines.join('\n');
      expect(output).toMatch(/engine.*deps\.cmake/);
    });

    it('chain-variable-deps: resolves variables in dependency fields', async () => {
      await runScan(
        '--path',
        path.join(FIXTURES, 'chain-variable-deps', 'CMakeLists.txt'),
        '--scan-only',
      );
      expect(logLines[0]).toMatch(/Found 1 dependencies/);
      const output = logLines.join('\n');
      expect(output).toMatch(/v1\.17\.0/);
      expect(output).not.toMatch(/\$\{GTEST_VERSION\}/);
    });

    it('cmake-variables: resolves GIT_TAG variable in chain mode', async () => {
      await runScan(
        '--path',
        path.join(FIXTURES, 'cmake-variables', 'CMakeLists.txt'),
        '--scan-only',
      );
      const output = logLines.join('\n');
      expect(output).toMatch(/v1\.17\.0/);
      expect(output).not.toMatch(/\$\{GTEST_VERSION\}/);
    });
  });

  describe('update checking (default)', () => {
    it('shows update columns when checking for updates', async () => {
      mockedCheckForUpdates.mockImplementation(async (deps) => {
        return deps.map(
          (dep): UpdateCheckResult => ({
            dep,
            status: 'up-to-date',
          }),
        );
      });

      await runScan('--path', path.join(FIXTURES, 'basic-git'));
      const output = logLines.join('\n');
      expect(output).toMatch(/Name/);
      expect(output).toMatch(/Current/);
      expect(output).toMatch(/Latest/);
      expect(output).toMatch(/Status/);
      expect(output).toMatch(/up to date/);
    });

    it('shows update-available status with latest version', async () => {
      mockedCheckForUpdates.mockImplementation(async (deps) => {
        return deps.map(
          (dep): UpdateCheckResult => ({
            dep,
            status: 'update-available',
            latestVersion: 'v99.0.0',
            updateType: 'major',
          }),
        );
      });

      await runScan('--path', path.join(FIXTURES, 'basic-git'));
      const output = logLines.join('\n');
      expect(output).toMatch(/v99\.0\.0/);
      expect(output).toMatch(/major update/);
    });

    it('shows abbreviated SHA with version for SHA-pinned deps', async () => {
      const newSha = '77a832110d40b0179636f5be8f8781f8299d7e50';
      mockedCheckForUpdates.mockImplementation(async (deps) =>
        deps.map(
          (dep): UpdateCheckResult => ({
            dep,
            status: 'update-available',
            versionSource: 'sha',
            resolvedTag: '12.1.0',
            latestVersion: '12.2.0',
            latestSha: newSha,
            updateType: 'minor',
          }),
        ),
      );

      await runScan('--path', path.join(FIXTURES, 'commit-sha', 'CMakeLists.txt'));
      const output = logLines.join('\n');
      // fmt's pinned SHA 407c905e… abbreviates and gains the resolved version
      expect(output).toMatch(/407c905e \(12\.1\.0\)/);
      // Latest column shows the new SHA abbreviated alongside the new version
      expect(output).toMatch(/77a83211 \(12\.2\.0\)/);
    });

    it('prints check-failed errors to stderr', async () => {
      mockedCheckForUpdates.mockImplementation(async (deps) => {
        return deps.map(
          (dep): UpdateCheckResult => ({
            dep,
            status: 'check-failed',
            error: 'network error',
          }),
        );
      });

      await runScan('--path', path.join(FIXTURES, 'basic-git'));
      expect(errorLines.some((l) => l.includes('network error'))).toBe(true);
    });
  });

  describe('--json', () => {
    it('outputs valid JSON to stdout', async () => {
      await runScan('--path', path.join(FIXTURES, 'basic-git'), '--scan-only', '--json');
      const output = parseJsonOutput();
      expect(output.schemaVersion).toBe(2);
      expect(output.dependencies).toBeInstanceOf(Array);
    });

    it('suppresses human-readable table output', async () => {
      await runScan('--path', path.join(FIXTURES, 'basic-git'), '--scan-only', '--json');
      expect(logLines).toHaveLength(0);
    });

    it('--json --scan-only omits updateCheck and summary', async () => {
      await runScan('--path', path.join(FIXTURES, 'basic-git'), '--scan-only', '--json');
      const output = parseJsonOutput();
      expect(output).not.toHaveProperty('summary');
      const deps = output.dependencies as Record<string, unknown>[];
      for (const dep of deps) {
        expect(dep).not.toHaveProperty('updateCheck');
      }
    });

    it('--json with update checking includes updateCheck and summary', async () => {
      mockedCheckForUpdates.mockImplementation(async (deps) => {
        return deps.map(
          (dep): UpdateCheckResult => ({
            dep,
            status: 'up-to-date',
          }),
        );
      });

      await runScan('--path', path.join(FIXTURES, 'basic-git'), '--json');
      const output = parseJsonOutput();
      expect(output).toHaveProperty('summary');
      const deps = output.dependencies as Record<string, unknown>[];
      for (const dep of deps) {
        expect(dep).toHaveProperty('updateCheck');
      }
    });

    it('meta.timestamp is a valid ISO 8601 string', async () => {
      await runScan('--path', path.join(FIXTURES, 'basic-git'), '--scan-only', '--json');
      const output = parseJsonOutput();
      const meta = output.meta as Record<string, unknown>;
      const ts = meta.timestamp as string;
      expect(new Date(ts).toISOString()).toBe(ts);
    });

    it('warnings appear in JSON warnings array (chain-mode)', async () => {
      await runScan(
        '--path',
        path.join(FIXTURES, 'chain-unresolvable', 'CMakeLists.txt'),
        '--scan-only',
        '--json',
      );
      const output = parseJsonOutput();
      const warnings = output.warnings as string[];
      expect(warnings).toHaveLength(2);
      // Warnings should be in JSON, not stderr
      expect(errorLines).toHaveLength(0);
    });

    it('meta.scanMode is "directory" for directory input', async () => {
      await runScan('--path', path.join(FIXTURES, 'basic-git'), '--scan-only', '--json');
      const output = parseJsonOutput();
      const meta = output.meta as Record<string, unknown>;
      expect(meta.scanMode).toBe('directory');
    });

    it('meta.scanMode is "chain" for file input', async () => {
      await runScan(
        '--path',
        path.join(FIXTURES, 'chain-basic', 'CMakeLists.txt'),
        '--scan-only',
        '--json',
      );
      const output = parseJsonOutput();
      const meta = output.meta as Record<string, unknown>;
      expect(meta.scanMode).toBe('chain');
    });
  });

  describe('--fail-on-updates', () => {
    it('exits 1 when updates are available (human-readable)', async () => {
      mockedCheckForUpdates.mockImplementation(async (deps) => {
        return deps.map(
          (dep): UpdateCheckResult => ({
            dep,
            status: 'update-available',
            latestVersion: 'v99.0.0',
            updateType: 'major',
          }),
        );
      });

      const err = await runScan(
        '--path',
        path.join(FIXTURES, 'basic-git'),
        '--fail-on-updates',
      ).catch((e) => e);
      expect(err).toBeInstanceOf(CommanderError);
      expect((err as CommanderError).exitCode).toBe(1);
    });

    it('exits 0 when all up-to-date (human-readable)', async () => {
      mockedCheckForUpdates.mockImplementation(async (deps) => {
        return deps.map(
          (dep): UpdateCheckResult => ({
            dep,
            status: 'up-to-date',
          }),
        );
      });

      await expect(
        runScan('--path', path.join(FIXTURES, 'basic-git'), '--fail-on-updates'),
      ).resolves.toBeUndefined();
    });

    it('exits 1 when updates are available (--json)', async () => {
      mockedCheckForUpdates.mockImplementation(async (deps) => {
        return deps.map(
          (dep): UpdateCheckResult => ({
            dep,
            status: 'update-available',
            latestVersion: 'v99.0.0',
            updateType: 'major',
          }),
        );
      });

      const err = await runScan(
        '--path',
        path.join(FIXTURES, 'basic-git'),
        '--json',
        '--fail-on-updates',
      ).catch((e) => e);
      expect(err).toBeInstanceOf(CommanderError);
      expect((err as CommanderError).exitCode).toBe(1);
      // JSON should still be emitted before the error
      const output = parseJsonOutput();
      expect(output.schemaVersion).toBe(2);
    });

    it('exits 0 when all up-to-date (--json)', async () => {
      mockedCheckForUpdates.mockImplementation(async (deps) => {
        return deps.map(
          (dep): UpdateCheckResult => ({
            dep,
            status: 'up-to-date',
          }),
        );
      });

      await expect(
        runScan('--path', path.join(FIXTURES, 'basic-git'), '--json', '--fail-on-updates'),
      ).resolves.toBeUndefined();
    });

    it('--scan-only --fail-on-updates emits warning and exits 0', async () => {
      await expect(
        runScan('--path', path.join(FIXTURES, 'basic-git'), '--scan-only', '--fail-on-updates'),
      ).resolves.toBeUndefined();
      expect(errorLines.some((l) => l.includes('--fail-on-updates has no effect'))).toBe(true);
    });
  });

  describe('--update-types', () => {
    it('filters results by update type in human-readable output', async () => {
      mockedCheckForUpdates.mockImplementation(async (deps) => {
        return deps.map(
          (dep, i): UpdateCheckResult => ({
            dep,
            status: 'update-available',
            latestVersion: `v${i + 2}.0.0`,
            updateType: i === 0 ? 'major' : 'minor',
          }),
        );
      });

      await runScan('--path', path.join(FIXTURES, 'basic-git'), '--update-types', 'minor');
      const output = logLines.join('\n');
      expect(output).toMatch(/minor update/);
      expect(output).not.toMatch(/major update/);
    });

    it('shows filteredCount in summary line when non-zero', async () => {
      mockedCheckForUpdates.mockImplementation(async (deps) => {
        return deps.map(
          (dep, i): UpdateCheckResult => ({
            dep,
            status: 'update-available',
            latestVersion: `v${i + 2}.0.0`,
            updateType: i === 0 ? 'major' : 'minor',
          }),
        );
      });

      await runScan('--path', path.join(FIXTURES, 'basic-git'), '--update-types', 'minor');
      expect(logLines[0]).toMatch(/filtered by update type/);
    });

    it('shows both ignoredCount and filteredCount in summary line', async () => {
      // chain-basic has 3 deps: ignore 1, filter 1 major, keep 1 minor
      mockedCheckForUpdates.mockImplementation(async (deps) => {
        return deps.map(
          (dep, i): UpdateCheckResult => ({
            dep,
            status: 'update-available',
            latestVersion: `v${i + 2}.0.0`,
            updateType: i === 0 ? 'major' : 'minor',
          }),
        );
      });

      await runScan(
        '--path',
        path.join(FIXTURES, 'chain-basic', 'CMakeLists.txt'),
        '--ignore',
        'googletest',
        '--update-types',
        'minor',
      );
      expect(logLines[0]).toMatch(/omitted due to ignore configuration/);
      expect(logLines[0]).toMatch(/filtered by update type/);
      expect(logLines[0]).toMatch(/\(.*,.*\)/);
    });

    it('emits warning with --scan-only', async () => {
      await runScan(
        '--path',
        path.join(FIXTURES, 'basic-git'),
        '--scan-only',
        '--update-types',
        'minor',
      );
      expect(errorLines.some((l) => l.includes('--update-types has no effect'))).toBe(true);
    });

    it('exits with error on invalid update type', async () => {
      const err = await runScan(
        '--path',
        path.join(FIXTURES, 'basic-git'),
        '--update-types',
        'bogus',
      ).catch((e) => e);
      expect(err).toBeInstanceOf(CommanderError);
      expect((err as CommanderError).exitCode).toBe(1);
    });

    it('includes filteredCount in JSON output', async () => {
      mockedCheckForUpdates.mockImplementation(async (deps) => {
        return deps.map(
          (dep): UpdateCheckResult => ({
            dep,
            status: 'update-available',
            latestVersion: 'v2.0.0',
            updateType: 'major',
          }),
        );
      });

      await runScan(
        '--path',
        path.join(FIXTURES, 'basic-git'),
        '--json',
        '--update-types',
        'minor',
      );
      const output = parseJsonOutput();
      expect(output.filteredCount).toBe(2);
    });

    it('--fail-on-updates only triggers for non-filtered updates', async () => {
      mockedCheckForUpdates.mockImplementation(async (deps) => {
        return deps.map(
          (dep): UpdateCheckResult => ({
            dep,
            status: 'update-available',
            latestVersion: 'v2.0.0',
            updateType: 'major',
          }),
        );
      });

      // All updates are major, but we only allow minor — so no updates remain, no failure
      await expect(
        runScan(
          '--path',
          path.join(FIXTURES, 'basic-git'),
          '--fail-on-updates',
          '--update-types',
          'minor',
        ),
      ).resolves.toBeUndefined();
    });
  });

  describe('--no-resolve-sha', () => {
    it('default invocation passes resolveSha:true (or undefined) to checkForUpdates', async () => {
      mockedCheckForUpdates.mockImplementation(async (deps) =>
        deps.map((dep): UpdateCheckResult => ({ dep, status: 'up-to-date' })),
      );
      await runScan('--path', path.join(FIXTURES, 'basic-git'));
      expect(mockedCheckForUpdates).toHaveBeenCalledTimes(1);
      const opts = mockedCheckForUpdates.mock.calls[0][2] ?? {};
      expect(opts.resolveSha).not.toBe(false);
    });

    it('--no-resolve-sha passes resolveSha:false to checkForUpdates', async () => {
      mockedCheckForUpdates.mockImplementation(async (deps) =>
        deps.map((dep): UpdateCheckResult => ({ dep, status: 'up-to-date' })),
      );
      await runScan('--path', path.join(FIXTURES, 'basic-git'), '--no-resolve-sha');
      expect(mockedCheckForUpdates).toHaveBeenCalledTimes(1);
      const opts = mockedCheckForUpdates.mock.calls[0][2] ?? {};
      expect(opts.resolveSha).toBe(false);
    });
  });
});
