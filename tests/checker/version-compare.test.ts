import { describe, it, expect } from 'vitest';
import {
  findLatestVersion,
  findIntermediateTags,
  findVersionTokenInComment,
} from '../../src/checker/version-compare.js';

describe('findLatestVersion', () => {
  describe('semver comparison', () => {
    it('detects a minor update with v-prefix', () => {
      const result = findLatestVersion('v1.14.0', ['v1.13.0', 'v1.14.0', 'v1.15.0', 'v1.15.2']);
      expect(result).toEqual({ latest: 'v1.15.2', updateType: 'minor' });
    });

    it('detects a major update without v-prefix', () => {
      const result = findLatestVersion('10.2.1', [
        '10.0.0',
        '10.1.0',
        '10.2.1',
        '11.0.0',
        '12.1.0',
      ]);
      expect(result).toEqual({ latest: '12.1.0', updateType: 'major' });
    });

    it('detects a patch update', () => {
      const result = findLatestVersion('v1.14.0', ['v1.14.0', 'v1.14.1']);
      expect(result).toEqual({ latest: 'v1.14.1', updateType: 'patch' });
    });

    it('reports up-to-date when current is latest', () => {
      const result = findLatestVersion('v1.17.0', ['v1.15.0', 'v1.16.0', 'v1.17.0']);
      expect(result).toEqual({ latest: 'v1.17.0' });
      expect(result!.updateType).toBeUndefined();
    });

    it('skips pre-release tags when current is stable', () => {
      const result = findLatestVersion('v1.14.0', ['v1.14.0', 'v1.15.0-rc1', 'v1.15.0']);
      expect(result).toEqual({ latest: 'v1.15.0', updateType: 'minor' });
    });

    it('includes pre-release tags when current is pre-release', () => {
      const result = findLatestVersion('v1.15.0-rc1', ['v1.14.0', 'v1.15.0-rc1', 'v1.15.0-rc2']);
      expect(result).toEqual({ latest: 'v1.15.0-rc2', updateType: 'patch' });
    });

    it('handles mixed v-prefix: current has v, tags do not', () => {
      const result = findLatestVersion('v1.0.0', ['1.0.0', '1.1.0']);
      expect(result!.latest).toBe('v1.1.0');
    });

    it('handles mixed v-prefix: current has no v, tags have v', () => {
      const result = findLatestVersion('1.0.0', ['v1.0.0', 'v1.1.0']);
      expect(result!.latest).toBe('1.1.0');
    });
  });

  describe('prefix-based comparison', () => {
    it('detects update with VER- prefix', () => {
      const result = findLatestVersion('VER-2-14-0', [
        'VER-2-13-0',
        'VER-2-14-0',
        'VER-2-14-1',
        'VER-2-14-2',
      ]);
      expect(result).toEqual({ latest: 'VER-2-14-2', updateType: 'patch' });
    });

    it('reports up-to-date with prefix-based tags', () => {
      const result = findLatestVersion('VER-2-14-2', ['VER-2-13-0', 'VER-2-14-0', 'VER-2-14-2']);
      expect(result).toEqual({ latest: 'VER-2-14-2' });
    });

    it('detects update with release- prefix', () => {
      const result = findLatestVersion('release-1.8.0', [
        'release-1.7.0',
        'release-1.8.0',
        'release-2.0.0',
      ]);
      expect(result).toEqual({ latest: 'release-2.0.0', updateType: 'major' });
    });

    it('filters out tags with different prefix', () => {
      const result = findLatestVersion('VER-2-14-0', [
        'VER-2-14-0',
        'VER-2-14-2',
        'v3.0.0',
        'release-5.0',
      ]);
      expect(result).toEqual({ latest: 'VER-2-14-2', updateType: 'patch' });
    });

    it('handles v-prefixed non-semver tags like v2-14-2', () => {
      const result = findLatestVersion('v2-14-2', ['v2-14-2', 'v2-14-3', 'v2-15-0']);
      expect(result).toEqual({ latest: 'v2-15-0', updateType: 'minor' });
    });
  });

  describe('findIntermediateTags', () => {
    it('returns [latestTag] when current and latest are adjacent', () => {
      const result = findIntermediateTags('v1.0.0', 'v1.1.0', ['v1.0.0', 'v1.1.0']);
      expect(result).toEqual(['v1.1.0']);
    });

    it('returns tags in descending semver order, newest first', () => {
      const result = findIntermediateTags('v1.0.0', 'v1.3.0', [
        'v1.0.0',
        'v1.1.0',
        'v1.2.0',
        'v1.3.0',
      ]);
      expect(result).toEqual(['v1.3.0', 'v1.2.0', 'v1.1.0']);
    });

    it('excludes prerelease tags', () => {
      const result = findIntermediateTags('v1.0.0', 'v1.2.0', [
        'v1.0.0',
        'v1.1.0-rc1',
        'v1.1.0',
        'v1.2.0-beta.1',
        'v1.2.0',
      ]);
      expect(result).toEqual(['v1.2.0', 'v1.1.0']);
    });

    it('excludes the current tag, includes the latest tag', () => {
      const result = findIntermediateTags('v1.0.0', 'v1.2.0', ['v1.0.0', 'v1.1.0', 'v1.2.0']);
      expect(result).not.toContain('v1.0.0');
      expect(result).toContain('v1.2.0');
    });

    it('handles v-prefixed and non-prefixed tags correctly', () => {
      const result = findIntermediateTags('1.0.0', '1.2.0', ['1.0.0', '1.1.0', '1.2.0']);
      expect(result).toEqual(['1.2.0', '1.1.0']);
    });

    it('returns [latestTag] as fallback when tags do not parse as semver', () => {
      const result = findIntermediateTags('abc', 'def', ['abc', 'def', 'ghi']);
      expect(result).toEqual(['def']);
    });

    it('returns [latestTag] when allTags is empty', () => {
      const result = findIntermediateTags('v1.0.0', 'v2.0.0', []);
      expect(result).toEqual(['v2.0.0']);
    });

    it('injects latestTag when allTags has unprefixed variant', () => {
      const result = findIntermediateTags('v1.0.0', 'v2.0.0', ['1.0.0', '1.1.0', '2.0.0']);
      expect(result[0]).toBe('v2.0.0');
      expect(result).toContain('2.0.0');
    });
  });

  describe('edge cases', () => {
    it('returns null for empty tag list', () => {
      expect(findLatestVersion('v1.0.0', [])).toBeNull();
    });

    it('returns null when no tags are parseable', () => {
      expect(findLatestVersion('v1.0.0', ['latest', 'stable', 'nightly'])).toBeNull();
    });

    it('returns null for non-parseable current tag with no prefix match', () => {
      expect(findLatestVersion('some-random-tag', ['v1.0.0', 'v2.0.0'])).toBeNull();
    });
  });
});

describe('findVersionTokenInComment', () => {
  it.each([
    ['14.1.0', '14.1.0'],
    ['v14.1.0', 'v14.1.0'],
    ['VER-2-14-3', 'VER-2-14-3'],
    ['release-1.0.0', 'release-1.0.0'],
    ['security fix v2.0.0', 'v2.0.0'],
    ['bumped to 14.1.0 for security', '14.1.0'],
  ])('extracts %j as %j', (input, expected) => {
    expect(findVersionTokenInComment(input)).toBe(expected);
  });

  it.each([
    ['TODO bump', null],
    ['pinning until 5.x lands', null],
    ['pinned', null],
    ['', null],
    ['no version here', null],
  ])('returns null for %j', (input, expected) => {
    expect(findVersionTokenInComment(input)).toBe(expected);
  });
});
