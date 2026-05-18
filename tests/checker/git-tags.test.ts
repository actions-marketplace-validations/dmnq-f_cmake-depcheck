import { describe, it, expect } from 'vitest';
import { parseGitLsRemoteOutput } from '../../src/checker/git-tags.js';

describe('parseGitLsRemoteOutput', () => {
  it('extracts tag/commit-SHA pairs from ls-remote output', () => {
    const raw = [
      'abc123def456abc123def456abc123def456abc12345\trefs/tags/v1.0.0',
      'def456abc123def456abc123def456abc123def45678\trefs/tags/v1.1.0',
      'ghi789abc123def456abc123def456abc123def45678\trefs/tags/v2.0.0',
    ].join('\n');

    expect(parseGitLsRemoteOutput(raw)).toEqual([
      {
        tag: 'v1.0.0',
        commitSha: 'abc123def456abc123def456abc123def456abc12345',
        tagSha: 'abc123def456abc123def456abc123def456abc12345',
      },
      {
        tag: 'v1.1.0',
        commitSha: 'def456abc123def456abc123def456abc123def45678',
        tagSha: 'def456abc123def456abc123def456abc123def45678',
      },
      {
        tag: 'v2.0.0',
        commitSha: 'ghi789abc123def456abc123def456abc123def45678',
        tagSha: 'ghi789abc123def456abc123def456abc123def45678',
      },
    ]);
  });

  it('captures both tag-object SHA and dereferenced commit SHA for annotated tags', () => {
    const raw = [
      'tagobjA000000000000000000000000000000000000\trefs/tags/v1.0.0',
      'commitAAA0000000000000000000000000000000000\trefs/tags/v1.0.0^{}',
      'tagobjB000000000000000000000000000000000000\trefs/tags/v1.1.0',
      'commitBBB0000000000000000000000000000000000\trefs/tags/v1.1.0^{}',
    ].join('\n');

    expect(parseGitLsRemoteOutput(raw)).toEqual([
      {
        tag: 'v1.0.0',
        tagSha: 'tagobjA000000000000000000000000000000000000',
        commitSha: 'commitAAA0000000000000000000000000000000000',
      },
      {
        tag: 'v1.1.0',
        tagSha: 'tagobjB000000000000000000000000000000000000',
        commitSha: 'commitBBB0000000000000000000000000000000000',
      },
    ]);
  });

  it('handles lightweight tags (no ^{} entry) — tagSha == commitSha', () => {
    const raw = ['lightSHA00000000000000000000000000000000000\trefs/tags/v1.0.1'].join('\n');
    expect(parseGitLsRemoteOutput(raw)).toEqual([
      {
        tag: 'v1.0.1',
        commitSha: 'lightSHA00000000000000000000000000000000000',
        tagSha: 'lightSHA00000000000000000000000000000000000',
      },
    ]);
  });

  it('handles mixed annotated and lightweight tags in the same input', () => {
    const raw = [
      'tagobjA000000000000000000000000000000000000\trefs/tags/v1.0.0',
      'commitAAA0000000000000000000000000000000000\trefs/tags/v1.0.0^{}',
      'lightSHA00000000000000000000000000000000000\trefs/tags/v1.0.1',
    ].join('\n');
    expect(parseGitLsRemoteOutput(raw)).toEqual([
      {
        tag: 'v1.0.0',
        tagSha: 'tagobjA000000000000000000000000000000000000',
        commitSha: 'commitAAA0000000000000000000000000000000000',
      },
      {
        tag: 'v1.0.1',
        commitSha: 'lightSHA00000000000000000000000000000000000',
        tagSha: 'lightSHA00000000000000000000000000000000000',
      },
    ]);
  });

  it('returns empty array for empty output', () => {
    expect(parseGitLsRemoteOutput('')).toEqual([]);
  });

  it('returns empty array for whitespace-only output', () => {
    expect(parseGitLsRemoteOutput('  \n  \n  ')).toEqual([]);
  });

  it('skips refs that are not under refs/tags/', () => {
    const raw = [
      'abc123\trefs/heads/main',
      'def456abc123def456abc123def456abc123def45678\trefs/tags/v1.0.0',
    ].join('\n');
    expect(parseGitLsRemoteOutput(raw)).toEqual([
      {
        tag: 'v1.0.0',
        commitSha: 'def456abc123def456abc123def456abc123def45678',
        tagSha: 'def456abc123def456abc123def456abc123def45678',
      },
    ]);
  });

  it('handles non-semver tag names', () => {
    const raw = [
      'abc123\trefs/tags/VER-2-14-0',
      'def456\trefs/tags/VER-2-14-2',
      'ghi789\trefs/tags/release-1.0',
    ].join('\n');
    expect(parseGitLsRemoteOutput(raw).map((t) => t.tag)).toEqual([
      'VER-2-14-0',
      'VER-2-14-2',
      'release-1.0',
    ]);
  });
});
