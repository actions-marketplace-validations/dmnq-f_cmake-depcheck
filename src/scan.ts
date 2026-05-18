import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseCMakeContent } from './parser/index.js';
import { scanDirectory, resolveChain, resolveDependencyVariables } from './scanner/index.js';
import type { VariableInfo } from './scanner/index.js';
import { FetchContentDependency } from './parser/types.js';
import { checkForUpdates } from './checker/index.js';
import { UpdateCheckResult } from './checker/types.js';
import { isAllowedUpdateType } from './update-types.js';

export interface ScanOptions {
  /** Path to CMakeLists.txt or project root directory */
  path: string;
  /** Additional directory exclusion patterns (directory mode only) */
  excludePatterns?: RegExp[];
  /** Dependency names to exclude from results (matched case-insensitively as exact names) */
  ignoreNames?: string[];
  /** If true, skip update checking */
  scanOnly?: boolean;
  /** Update types to include in results. If set, update-available results with non-matching updateType are filtered out. */
  updateTypes?: Set<string>;
  /**
   * Reverse-resolve SHA-pinned git deps against upstream tag commit SHAs to
   * enable update checking on them. When `false`, SHA-pinned deps stay
   * classified as `'pinned'` and are not network-checked. Defaults to `true`.
   */
  resolveSha?: boolean;
  /** Progress callback for update checking — caller decides if/how to show progress */
  onProgress?: (completed: number, total: number) => void;
}

export interface ScanResult {
  /** Discovered dependencies (post-ignore filtering) */
  deps: FetchContentDependency[];
  /** All dependency names discovered in scanned files, before ignore filtering.
   *  Used by PR lifecycle management to scope stale PR cleanup. */
  allDepNames: string[];
  /** Absolute base path for relativizing locations */
  basePath: string;
  /** How files were discovered */
  scanMode: 'directory' | 'chain';
  /** All CMake files that were scanned (absolute paths) */
  filesScanned: string[];
  /** Warnings from chain resolution, unresolvable paths, etc. */
  warnings: string[];
  /** Number of dependencies excluded by ignore config */
  ignoredCount: number;
  /** Number of update-available results excluded by update-type filter */
  filteredCount: number;
  /** Update check results, absent when scanOnly is true */
  updateResults?: UpdateCheckResult[];
  /** Variable table from chain resolution (absent in directory scan mode) */
  vars?: Map<string, VariableInfo>;
}

export async function scan(options: ScanOptions): Promise<ScanResult> {
  const targetPath = path.resolve(options.path);
  const stat = fs.statSync(targetPath);

  let deps: FetchContentDependency[] = [];
  let basePath: string;
  let scanMode: 'directory' | 'chain';
  let filesScanned: string[];
  let warnings: string[] = [];
  let vars: Map<string, VariableInfo> | undefined;

  if (stat.isDirectory()) {
    scanMode = 'directory';
    basePath = targetPath;
    filesScanned = scanDirectory(targetPath, options.excludePatterns ?? []);
    for (const file of filesScanned) {
      const content = fs.readFileSync(file, 'utf-8');
      deps = deps.concat(parseCMakeContent(content, file));
    }
  } else {
    scanMode = 'chain';
    basePath = path.dirname(targetPath);
    const chain = resolveChain(targetPath);
    filesScanned = chain.files;
    warnings = chain.warnings;
    vars = chain.vars;
    for (const file of chain.files) {
      const content = fs.readFileSync(file, 'utf-8');
      deps = deps.concat(parseCMakeContent(content, file));
    }
    resolveDependencyVariables(deps, chain.vars);
  }

  // Capture all dep names before ignore filtering (for PR cleanup scoping)
  const allDepNames = deps.map((d) => d.name);

  let ignoredCount = 0;
  if (options.ignoreNames && options.ignoreNames.length > 0) {
    const patterns = options.ignoreNames.map((name) => {
      try {
        return new RegExp(`^${name}$`, 'i');
      } catch {
        throw new Error(`Invalid --ignore pattern "${name}": not a valid regular expression`);
      }
    });
    const before = deps.length;
    deps = deps.filter((d) => !patterns.some((p) => p.test(d.name)));
    ignoredCount = before - deps.length;
  }

  let updateResults: UpdateCheckResult[] | undefined;
  if (!options.scanOnly) {
    updateResults = await checkForUpdates(deps, options.onProgress, {
      resolveSha: options.resolveSha,
    });
  }

  let filteredCount = 0;
  if (options.updateTypes && updateResults) {
    const allowed = options.updateTypes;
    const before = updateResults.length;
    updateResults = updateResults.filter((r) => {
      if (r.status !== 'update-available') return true;
      return isAllowedUpdateType(r.updateType, allowed);
    });
    filteredCount = before - updateResults.length;

    // Remove filtered deps from the deps array to keep them in sync
    const keptDeps = new Set(updateResults.map((r) => r.dep));
    deps = deps.filter((d) => keptDeps.has(d));
  }

  return {
    deps,
    allDepNames,
    basePath,
    scanMode,
    filesScanned,
    warnings,
    ignoredCount,
    filteredCount,
    updateResults,
    vars,
  };
}
