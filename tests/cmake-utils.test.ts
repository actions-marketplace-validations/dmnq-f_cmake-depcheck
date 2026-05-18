import { describe, it, expect } from 'vitest';
import { trailingCommentOnLineContaining, commentIndicatesPin } from '../src/cmake-utils.js';

describe('trailingCommentOnLineContaining', () => {
  it('captures cleaned comment body and raw tail with leading whitespace', () => {
    const content = 'FetchContent_Declare(\n  GIT_TAG abc123  # 14.1.0\n)\n';
    const result = trailingCommentOnLineContaining(content, 'abc123', 1, 3);
    expect(result).toEqual({ comment: '14.1.0', raw: '  # 14.1.0' });
  });

  it('returns undefined when the matching line has no trailing comment', () => {
    const content = 'FetchContent_Declare(\n  GIT_TAG abc123\n)\n';
    expect(trailingCommentOnLineContaining(content, 'abc123', 1, 3)).toBeUndefined();
  });

  it('returns undefined when the needle is not found in any line', () => {
    const content = 'FetchContent_Declare(\n  GIT_TAG abc123  # 14.1.0\n)\n';
    expect(trailingCommentOnLineContaining(content, 'def456', 1, 3)).toBeUndefined();
  });

  it('honors the line range', () => {
    const content = 'line1\nGIT_TAG abc123  # outside\nGIT_TAG abc123  # inside\n';
    const result = trailingCommentOnLineContaining(content, 'abc123', 3, 3);
    expect(result).toEqual({ comment: 'inside', raw: '  # inside' });
  });

  it('preserves multiple spaces between needle and #', () => {
    const content = 'GIT_TAG abc123   # 14.1.0\n';
    const result = trailingCommentOnLineContaining(content, 'abc123', 1, 1);
    expect(result?.raw).toBe('   # 14.1.0');
  });

  it('handles ${VAR} as needle', () => {
    const content = 'GIT_TAG ${MY_VAR}  # 14.1.0\n';
    const result = trailingCommentOnLineContaining(content, '${MY_VAR}', 1, 1);
    expect(result).toEqual({ comment: '14.1.0', raw: '  # 14.1.0' });
  });

  it('captures quotes and parens between needle and # for set()-style lines', () => {
    const content = 'set(VAR "abc123")  # 14.1.0\n';
    const result = trailingCommentOnLineContaining(content, 'abc123', 1, 1);
    expect(result).toEqual({ comment: '14.1.0', raw: '")  # 14.1.0' });
  });

  it('returns undefined when # only appears before the needle', () => {
    const content = 'set(X "#hash") set(Y "abc123")\n';
    expect(trailingCommentOnLineContaining(content, 'abc123', 1, 1)).toBeUndefined();
  });

  it('captures comment containing spaces and a version prefix', () => {
    const content = 'GIT_TAG abc123 # bumped to VER-2-14-3 for security\n';
    const result = trailingCommentOnLineContaining(content, 'abc123', 1, 1);
    expect(result?.comment).toBe('bumped to VER-2-14-3 for security');
  });

  it('trims trailing whitespace from raw', () => {
    const content = 'GIT_TAG abc123 # 14.1.0   \n';
    const result = trailingCommentOnLineContaining(content, 'abc123', 1, 1);
    expect(result?.raw).toBe(' # 14.1.0');
  });
});

describe('commentIndicatesPin', () => {
  it.each([
    ['pinned', true],
    ['PIN', true],
    ['Pinning', true],
    ['pinning until 5.x lands', true],
    ['do not bump, pinned', true],
    ['pinned to bugfix', true],
    ['DO NOT BUMP - PINNED', true],
  ])('matches %j as a pin indicator', (input, expected) => {
    expect(commentIndicatesPin(input)).toBe(expected);
  });

  it.each([
    ['14.1.0', false],
    ['v14.1.0', false],
    ['pinpoint version', false],
    ['endpoint', false],
    ['spinning the wheel', false],
    ['', false],
    ['TODO bump', false],
    ['VER-2-14-3', false],
  ])('does not match %j', (input, expected) => {
    expect(commentIndicatesPin(input)).toBe(expected);
  });
});
