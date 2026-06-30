import * as path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { scan } from '../src/scan.js';

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

describe('scan()', () => {
  describe('directory mode', () => {
    it('returns deps and metadata for basic-git fixture', async () => {
      const result = await scan({ path: path.join(FIXTURES, 'basic-git'), scanOnly: true });
      expect(result.scanMode).toBe('directory');
      expect(result.deps).toHaveLength(2);
      expect(result.basePath).toBe(path.join(FIXTURES, 'basic-git'));
      expect(result.filesScanned.length).toBeGreaterThan(0);
      expect(result.warnings).toEqual([]);
      expect(result.ignoredCount).toBe(0);
      expect(result.updateResults).toBeUndefined();
    });

    it('returns empty deps for no-fetchcontent fixture', async () => {
      const result = await scan({ path: path.join(FIXTURES, 'no-fetchcontent'), scanOnly: true });
      expect(result.deps).toHaveLength(0);
    });
  });

  describe('chain mode', () => {
    it('returns deps and warnings for chain-unresolvable fixture', async () => {
      const result = await scan({
        path: path.join(FIXTURES, 'chain-unresolvable', 'CMakeLists.txt'),
        scanOnly: true,
      });
      expect(result.scanMode).toBe('chain');
      expect(result.deps).toHaveLength(2);
      expect(result.warnings).toHaveLength(2);
    });

    it('resolves variables in chain-variable-deps fixture', async () => {
      const result = await scan({
        path: path.join(FIXTURES, 'chain-variable-deps', 'CMakeLists.txt'),
        scanOnly: true,
      });
      expect(result.deps).toHaveLength(1);
      expect(result.deps[0].gitTag).toBe('v1.17.0');
    });

    it('refreshes gitTagIsSha after resolving a SHA stored in a variable', async () => {
      const result = await scan({
        path: path.join(FIXTURES, 'sha-in-variable', 'CMakeLists.txt'),
        scanOnly: true,
      });
      expect(result.deps).toHaveLength(1);
      const dep = result.deps[0];
      expect(dep.gitTag).toBe('c740f0fda4274d6ffd2e5b64a25b06ef69803a07');
      expect(dep.gitTagRaw).toBe('${FREETYPE_GIT_COMMIT}');
      expect(dep.gitTagIsSha).toBe(true);
    });
  });

  describe('ignore filtering', () => {
    it('excludes dependencies by name and reports ignoredCount', async () => {
      const result = await scan({
        path: path.join(FIXTURES, 'basic-git'),
        ignoreNames: ['googletest'],
        scanOnly: true,
      });
      expect(result.deps).toHaveLength(1);
      expect(result.deps[0].name).toBe('fmt');
      expect(result.ignoredCount).toBe(1);
    });

    it('matches names case-insensitively', async () => {
      const result = await scan({
        path: path.join(FIXTURES, 'basic-git'),
        ignoreNames: ['GoogleTest'],
        scanOnly: true,
      });
      expect(result.ignoredCount).toBe(1);
    });

    it('supports regex patterns in ignore names', async () => {
      const result = await scan({
        path: path.join(FIXTURES, 'basic-git'),
        ignoreNames: ['google.*'],
        scanOnly: true,
      });
      expect(result.ignoredCount).toBe(1);
      expect(result.deps[0].name).toBe('fmt');
    });

    it('throws on invalid regex pattern', async () => {
      await expect(
        scan({
          path: path.join(FIXTURES, 'basic-git'),
          ignoreNames: ['foo('],
          scanOnly: true,
        }),
      ).rejects.toThrow('Invalid --ignore pattern');
    });
  });

  describe('update checking', () => {
    it('includes updateResults when scanOnly is false', async () => {
      mockedCheckForUpdates.mockImplementation(async (deps) => {
        return deps.map((dep): UpdateCheckResult => ({ dep, status: 'up-to-date' }));
      });

      const result = await scan({ path: path.join(FIXTURES, 'basic-git') });
      expect(result.updateResults).toBeDefined();
      expect(result.updateResults).toHaveLength(2);
    });

    it('passes onProgress callback to checkForUpdates', async () => {
      const progressCalls: [number, number][] = [];
      mockedCheckForUpdates.mockImplementation(async (deps, onProgress) => {
        if (onProgress) {
          onProgress(1, deps.length);
        }
        return deps.map((dep): UpdateCheckResult => ({ dep, status: 'up-to-date' }));
      });

      await scan({
        path: path.join(FIXTURES, 'basic-git'),
        onProgress: (completed, total) => progressCalls.push([completed, total]),
      });
      expect(progressCalls).toHaveLength(1);
      expect(progressCalls[0][0]).toBe(1);
    });
  });

  describe('update-type filtering', () => {
    it('filters update-available results by type', async () => {
      mockedCheckForUpdates.mockImplementation(async (deps) => {
        return deps.map((dep, i): UpdateCheckResult => ({
          dep,
          status: 'update-available',
          latestVersion: `v${i + 2}.0.0`,
          updateType: i === 0 ? 'major' : 'minor',
        }));
      });

      const result = await scan({
        path: path.join(FIXTURES, 'basic-git'),
        updateTypes: new Set(['minor']),
      });
      expect(result.updateResults).toHaveLength(1);
      expect(result.updateResults![0].updateType).toBe('minor');
    });

    it('tracks filteredCount correctly', async () => {
      mockedCheckForUpdates.mockImplementation(async (deps) => {
        return deps.map((dep, i): UpdateCheckResult => ({
          dep,
          status: 'update-available',
          latestVersion: `v${i + 2}.0.0`,
          updateType: i === 0 ? 'major' : 'patch',
        }));
      });

      const result = await scan({
        path: path.join(FIXTURES, 'basic-git'),
        updateTypes: new Set(['patch']),
      });
      expect(result.filteredCount).toBe(1);
    });

    it('keeps non-update-available results unfiltered', async () => {
      mockedCheckForUpdates.mockImplementation(async (deps) => {
        return [
          { dep: deps[0], status: 'up-to-date' } as UpdateCheckResult,
          {
            dep: deps[1],
            status: 'update-available',
            latestVersion: 'v2.0.0',
            updateType: 'major',
          } as UpdateCheckResult,
        ];
      });

      const result = await scan({
        path: path.join(FIXTURES, 'basic-git'),
        updateTypes: new Set(['minor']),
      });
      // up-to-date is kept, major update-available is filtered
      expect(result.updateResults).toHaveLength(1);
      expect(result.updateResults![0].status).toBe('up-to-date');
      expect(result.filteredCount).toBe(1);
    });

    it('handles unknown type (undefined updateType)', async () => {
      mockedCheckForUpdates.mockImplementation(async (deps) => {
        return deps.map((dep): UpdateCheckResult => ({
          dep,
          status: 'update-available',
          latestVersion: 'v2.0.0',
          updateType: undefined,
        }));
      });

      // unknown included
      const result1 = await scan({
        path: path.join(FIXTURES, 'basic-git'),
        updateTypes: new Set(['unknown']),
      });
      expect(result1.updateResults).toHaveLength(2);
      expect(result1.filteredCount).toBe(0);

      // unknown not included
      const result2 = await scan({
        path: path.join(FIXTURES, 'basic-git'),
        updateTypes: new Set(['major']),
      });
      expect(result2.updateResults).toHaveLength(0);
      expect(result2.filteredCount).toBe(2);
    });

    it('returns filteredCount 0 when updateTypes is undefined', async () => {
      mockedCheckForUpdates.mockImplementation(async (deps) => {
        return deps.map((dep): UpdateCheckResult => ({
          dep,
          status: 'update-available',
          latestVersion: 'v2.0.0',
          updateType: 'major',
        }));
      });

      const result = await scan({ path: path.join(FIXTURES, 'basic-git') });
      expect(result.filteredCount).toBe(0);
      expect(result.updateResults).toHaveLength(2);
    });

    it('keeps deps array in sync with updateResults', async () => {
      mockedCheckForUpdates.mockImplementation(async (deps) => {
        return deps.map((dep, i): UpdateCheckResult => ({
          dep,
          status: 'update-available',
          latestVersion: `v${i + 2}.0.0`,
          updateType: i === 0 ? 'major' : 'minor',
        }));
      });

      const result = await scan({
        path: path.join(FIXTURES, 'basic-git'),
        updateTypes: new Set(['minor']),
      });
      expect(result.deps).toHaveLength(1);
      expect(result.updateResults).toHaveLength(1);
      expect(result.updateResults![0].dep).toBe(result.deps[0]);
    });

    it('is a no-op when combined with scanOnly', async () => {
      const result = await scan({
        path: path.join(FIXTURES, 'basic-git'),
        updateTypes: new Set(['minor']),
        scanOnly: true,
      });
      expect(result.filteredCount).toBe(0);
      expect(result.updateResults).toBeUndefined();
      expect(result.deps).toHaveLength(2);
    });
  });
});
