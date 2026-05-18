import * as path from 'node:path';
import { VERSION } from '../index.js';
import { FetchContentDependency } from '../parser/types.js';
import { UpdateCheckResult } from '../checker/types.js';
import { ScanResult } from '../scan.js';

export interface JsonOutputOptions extends ScanResult {
  entryPath: string;
  now?: Date;
}

interface JsonDependency {
  name: string;
  sourceType: 'git' | 'url';
  gitRepository?: string;
  gitTag?: string;
  gitTagIsSha?: boolean;
  gitTagComment?: string;
  url?: string;
  location: {
    file: string;
    startLine: number;
    endLine: number;
  };
  updateCheck?: {
    status: string;
    versionSource?: 'git-tag' | 'sha' | 'url';
    latestVersion?: string;
    updateType?: string;
    error?: string;
    updatedUrl?: string;
    resolvedVersion?: string;
    resolvedTag?: string;
    latestSha?: string;
  };
}

interface JsonSummary {
  total: number;
  upToDate: number;
  updatesAvailable: number;
  pinned: number;
  unpinned: number;
  unsupported: number;
  checkFailed: number;
  unresolvedVariable: number;
}

function buildDependency(
  dep: FetchContentDependency,
  basePath: string,
  resultMap?: Map<FetchContentDependency, UpdateCheckResult>,
): JsonDependency {
  const entry: JsonDependency = {
    name: dep.name,
    sourceType: dep.sourceType,
    location: {
      file: path.relative(basePath, dep.location.file),
      startLine: dep.location.startLine,
      endLine: dep.location.endLine,
    },
  };

  if (dep.sourceType === 'git') {
    if (dep.gitRepository !== undefined) entry.gitRepository = dep.gitRepository;
    if (dep.gitTag !== undefined) entry.gitTag = dep.gitTag;
    if (dep.gitTagIsSha !== undefined) entry.gitTagIsSha = dep.gitTagIsSha;
    if (dep.gitTagComment !== undefined) entry.gitTagComment = dep.gitTagComment;
  } else {
    if (dep.url !== undefined) entry.url = dep.url;
  }

  if (resultMap) {
    const result = resultMap.get(dep);
    if (result) {
      const check: JsonDependency['updateCheck'] = {
        status: result.status,
        versionSource: result.versionSource,
      };
      if (result.latestVersion !== undefined) check.latestVersion = result.latestVersion;
      if (result.updateType !== undefined) check.updateType = result.updateType;
      if (result.status === 'check-failed' && result.error !== undefined) {
        check.error = result.error;
      }
      if (result.updatedUrl !== undefined) check.updatedUrl = result.updatedUrl;
      if (result.resolvedVersion !== undefined) check.resolvedVersion = result.resolvedVersion;
      if (result.resolvedTag !== undefined) check.resolvedTag = result.resolvedTag;
      if (result.latestSha !== undefined) check.latestSha = result.latestSha;
      entry.updateCheck = check;
    }
  }

  return entry;
}

function buildSummary(updateResults: UpdateCheckResult[]): JsonSummary {
  const summary: JsonSummary = {
    total: updateResults.length,
    upToDate: 0,
    updatesAvailable: 0,
    pinned: 0,
    unpinned: 0,
    unsupported: 0,
    checkFailed: 0,
    unresolvedVariable: 0,
  };

  for (const r of updateResults) {
    switch (r.status) {
      case 'up-to-date':
        summary.upToDate++;
        break;
      case 'update-available':
        summary.updatesAvailable++;
        break;
      case 'pinned':
        summary.pinned++;
        break;
      case 'unpinned':
        summary.unpinned++;
        break;
      case 'unsupported':
        summary.unsupported++;
        break;
      case 'check-failed':
        summary.checkFailed++;
        break;
      case 'unresolved-variable':
        summary.unresolvedVariable++;
        break;
    }
  }

  return summary;
}

export function formatJsonOutput(options: JsonOutputOptions): object {
  const {
    deps,
    basePath,
    ignoredCount,
    filteredCount,
    scanMode,
    entryPath,
    filesScanned,
    warnings,
    updateResults,
    now,
  } = options;

  const resultMap = updateResults
    ? new Map<FetchContentDependency, UpdateCheckResult>(updateResults.map((r) => [r.dep, r]))
    : undefined;

  const output: Record<string, unknown> = {
    schemaVersion: 2,
    meta: {
      version: VERSION,
      scanMode,
      entryPath,
      filesScanned: filesScanned.map((f) => path.relative(basePath, f)),
      timestamp: (now ?? new Date()).toISOString(),
    },
    dependencies: deps.map((dep) => buildDependency(dep, basePath, resultMap)),
    ignoredCount,
    filteredCount,
    warnings,
  };

  if (updateResults) {
    output.summary = buildSummary(updateResults);
  }

  return output;
}
