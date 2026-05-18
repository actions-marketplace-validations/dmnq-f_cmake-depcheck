/**
 * Find the index of the matching closing parenthesis, handling nesting.
 * Returns -1 if not found.
 */
export function findClosingParen(content: string, openIndex: number): number {
  let depth = 1;
  for (let i = openIndex + 1; i < content.length; i++) {
    if (content[i] === '(') depth++;
    else if (content[i] === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Count newlines in a string up to a given index to determine line number.
 */
export function lineNumberAt(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) {
    if (content[i] === '\n') line++;
  }
  return line;
}

/**
 * Strip CMake comments (# to end of line) from text.
 */
export function stripComments(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('#');
      return idx === -1 ? line : line.substring(0, idx);
    })
    .join('\n');
}

/**
 * Strip surrounding double quotes from a string.
 */
export function stripQuotes(arg: string): string {
  if (arg.startsWith('"') && arg.endsWith('"')) {
    return arg.slice(1, -1);
  }
  return arg;
}

/**
 * Find the first line within `[startLine, endLine]` of `content` that contains
 * `needle`, and extract its trailing comment.
 *
 * Returns `{ comment, raw }` where `comment` is the body after `#` (trimmed)
 * and `raw` is the verbatim substring from immediately after `needle` through
 * end of line (trailing whitespace trimmed). `raw` therefore preserves
 * anything between the value and the `#` — for a `set(X "<sha>") # 14.1.0`
 * line searched with the SHA as needle, `raw` is `")  # 14.1.0`, not just
 * `  # 14.1.0`. This lets callers concatenate `needle + raw` and substring-
 * match the original line exactly.
 *
 * Returns `undefined` when no line within the range contains `needle`, or
 * when the matching line has no `#` comment after the needle. Lines are
 * 1-based; `endLine` is inclusive.
 */
export function trailingCommentOnLineContaining(
  content: string,
  needle: string,
  startLine: number,
  endLine: number,
): { comment: string; raw: string } | undefined {
  const lines = content.split('\n');
  const last = Math.min(endLine, lines.length);
  for (let i = Math.max(1, startLine) - 1; i < last; i++) {
    const line = lines[i];
    const needleIdx = line.indexOf(needle);
    if (needleIdx === -1) continue;
    const afterNeedle = needleIdx + needle.length;
    const hashIdx = line.indexOf('#', afterNeedle);
    if (hashIdx === -1) return undefined;
    const raw = line.substring(afterNeedle).replace(/\s+$/, '');
    const comment = line.substring(hashIdx + 1).trim();
    return { comment, raw };
  }
  return undefined;
}

/**
 * Returns true when the comment contains an explicit pin indicator
 * (`pin`, `pinned`, or `pinning` as a standalone word, case-insensitive).
 *
 * Used to let maintainers deliberately freeze a SHA-pinned dep via the
 * trailing comment without disabling SHA resolution globally. Word boundaries
 * prevent false positives on `pinpoint`, `endpoint`, `spinning`, etc.
 */
export function commentIndicatesPin(comment: string): boolean {
  return /\b(pin|pinned|pinning)\b/i.test(comment);
}

/**
 * Tokenize CMake arguments. Handles quoted and unquoted args,
 * line continuations (backslash at EOL).
 */
export function tokenize(body: string): string[] {
  const joined = body.replace(/\\\n/g, ' ');
  const tokens: string[] = [];
  let i = 0;

  while (i < joined.length) {
    if (/\s/.test(joined[i])) {
      i++;
      continue;
    }

    if (joined[i] === '"') {
      let end = i + 1;
      while (end < joined.length && joined[end] !== '"') {
        if (joined[end] === '\\') end++;
        end++;
      }
      tokens.push(joined.substring(i + 1, end));
      i = end + 1;
      continue;
    }

    let end = i;
    while (end < joined.length && !/\s/.test(joined[end]) && joined[end] !== '"') {
      end++;
    }
    tokens.push(joined.substring(i, end));
    i = end;
  }

  return tokens;
}
