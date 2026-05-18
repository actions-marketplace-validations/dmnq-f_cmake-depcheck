import * as semver from 'semver';

interface VersionResult {
  latest: string;
  updateType?: 'major' | 'minor' | 'patch';
}

/**
 * Try to parse a tag as semver, stripping a leading `v` if present.
 * Returns the parsed SemVer or null.
 */
function parseSemver(tag: string): semver.SemVer | null {
  return semver.parse(tag) ?? semver.parse(tag.replace(/^v/i, ''));
}

/**
 * Determine if a tag has a `v` prefix.
 */
function hasVPrefix(tag: string): boolean {
  return /^v/i.test(tag);
}

/**
 * Try semver-based comparison.
 * Returns a VersionResult if the current tag and at least one remote tag parse as semver.
 */
function trySemver(currentTag: string, allTags: string[]): VersionResult | null {
  const currentParsed = parseSemver(currentTag);
  if (!currentParsed) return null;

  const currentIsPrerelease = currentParsed.prerelease.length > 0;
  const currentHasV = hasVPrefix(currentTag);

  let best: { tag: string; parsed: semver.SemVer } | null = null;

  for (const tag of allTags) {
    const parsed = parseSemver(tag);
    if (!parsed) continue;

    // Skip pre-release tags unless current is also a pre-release
    if (!currentIsPrerelease && parsed.prerelease.length > 0) continue;

    if (!best || semver.gt(parsed, best.parsed)) {
      best = { tag, parsed };
    }
  }

  if (!best) return null;

  if (semver.lte(best.parsed, currentParsed)) {
    return { latest: currentTag };
  }

  const diffType = semver.diff(currentParsed, best.parsed);
  let updateType: 'major' | 'minor' | 'patch' | undefined;
  if (diffType === 'major' || diffType === 'premajor') updateType = 'major';
  else if (diffType === 'minor' || diffType === 'preminor') updateType = 'minor';
  else if (diffType === 'patch' || diffType === 'prepatch' || diffType === 'prerelease')
    updateType = 'patch';

  // Preserve original prefix style
  let latestTag = best.tag;
  if (currentHasV && !hasVPrefix(latestTag)) {
    latestTag = `v${latestTag}`;
  } else if (!currentHasV && hasVPrefix(latestTag)) {
    latestTag = latestTag.replace(/^v/i, '');
  }

  return { latest: latestTag, updateType };
}

/**
 * Extract a non-numeric prefix from a tag.
 * E.g. "VER-2-14-0" → "VER-", "release-1.8.0" → "release-", "v1.0" → "v"
 * Returns null if no prefix is found (starts with a digit).
 */
function extractPrefix(tag: string): string | null {
  const match = tag.match(/^([^0-9]+)/);
  return match ? match[1] : null;
}

/**
 * Try prefix-based comparison for non-semver tags.
 * Extracts a prefix, filters matching tags, and compares version parts.
 */
function tryPrefixBased(currentTag: string, allTags: string[]): VersionResult | null {
  const prefix = extractPrefix(currentTag);
  if (!prefix) return null;

  // No guard for "v" prefix — this function is only called when trySemver already
  // returned null, so tags like "v2-14-2" (non-semver despite v prefix) land here.

  const currentRemainder = currentTag.slice(prefix.length);
  if (!currentRemainder) return null;

  const candidates = allTags
    .filter((t) => t.startsWith(prefix))
    .map((t) => ({ tag: t, remainder: t.slice(prefix.length) }))
    .filter((c) => c.remainder.length > 0);

  if (candidates.length === 0) return null;

  // Try semver on remainders (replacing `-` with `.` for patterns like `2-14-0`)
  const normalize = (r: string) => r.replace(/-/g, '.');
  const currentNormalized = semver.parse(normalize(currentRemainder));

  if (currentNormalized) {
    let best: { tag: string; parsed: semver.SemVer } | null = null;

    for (const c of candidates) {
      const parsed = semver.parse(normalize(c.remainder));
      if (!parsed) continue;
      if (!best || semver.gt(parsed, best.parsed)) {
        best = { tag: c.tag, parsed };
      }
    }

    if (!best) return null;
    if (semver.lte(best.parsed, currentNormalized)) {
      return { latest: currentTag };
    }

    const diffType = semver.diff(currentNormalized, best.parsed);
    let updateType: 'major' | 'minor' | 'patch' | undefined;
    if (diffType === 'major' || diffType === 'premajor') updateType = 'major';
    else if (diffType === 'minor' || diffType === 'preminor') updateType = 'minor';
    else if (diffType === 'patch' || diffType === 'prepatch' || diffType === 'prerelease')
      updateType = 'patch';

    return { latest: best.tag, updateType };
  }

  // Fall back to lexicographic sort on the remainder
  const sorted = [...candidates].sort((a, b) => a.remainder.localeCompare(b.remainder));
  const last = sorted[sorted.length - 1];

  if (last.remainder <= currentRemainder) {
    return { latest: currentTag };
  }

  return { latest: last.tag };
}

/**
 * Find all tags strictly between currentTag and latestTag, sorted newest-first.
 * Only includes non-prerelease semver tags (or prefix-matched equivalents).
 * Always includes latestTag as the first element (injected if not present in allTags).
 */
export function findIntermediateTags(
  currentTag: string,
  latestTag: string,
  allTags: string[],
): string[] {
  const currentParsed = parseSemver(currentTag);
  const latestParsed = parseSemver(latestTag);

  if (!currentParsed || !latestParsed) {
    return [latestTag];
  }

  const intermediate: { tag: string; parsed: semver.SemVer }[] = [];

  for (const tag of allTags) {
    const parsed = parseSemver(tag);
    if (!parsed) continue;
    if (parsed.prerelease.length > 0) continue;
    if (semver.gt(parsed, currentParsed) && semver.lte(parsed, latestParsed)) {
      intermediate.push({ tag, parsed });
    }
  }

  intermediate.sort((a, b) => semver.rcompare(a.parsed, b.parsed));

  const result = intermediate.map((i) => i.tag);

  // Guarantee latestTag is always present as the first element
  if (result.length === 0 || result[0] !== latestTag) {
    result.unshift(latestTag);
  }

  return result;
}

/**
 * Find the latest version from a list of remote tags compared to the current tag.
 *
 * Returns:
 * - `{ latest, updateType? }` if comparison is possible
 *   - `latest === currentTag` means up-to-date
 *   - `updateType` is set for semver-classifiable updates
 * - `null` if no comparison is possible (no parseable tags)
 */
export function findLatestVersion(currentTag: string, allTags: string[]): VersionResult | null {
  if (allTags.length === 0) return null;

  return trySemver(currentTag, allTags) ?? tryPrefixBased(currentTag, allTags);
}

/**
 * Find the first version-shaped token in a freeform string (e.g. a trailing
 * comment). Returns the substring that parses as semver (`14.1.0`, `v14.1.0`)
 * or has a recognizable version prefix followed by digits (`VER-2-14-3`,
 * `release-1.0`). Returns null when no version-shaped token is present.
 *
 * Used only by PR-edit construction to know which substring inside a trailing
 * comment to replace alongside a SHA rewrite. Not part of the detection path
 * — comments are never used to drive update checking.
 */
export function findVersionTokenInComment(comment: string): string | null {
  for (const token of comment.split(/\s+/)) {
    if (!token) continue;
    if (parseSemver(token)) return token;
    const prefix = extractPrefix(token);
    if (prefix && /\d/.test(token.substring(prefix.length))) return token;
  }
  return null;
}
