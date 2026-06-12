#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command, CommanderError } from 'commander';
import { VERSION } from './index.js';
import { FetchContentDependency } from './parser/types.js';
import { UpdateCheckResult } from './checker/types.js';
import { formatJsonOutput } from './formatter/index.js';
import { scan } from './scan.js';
import { parseUpdateTypes } from './update-types.js';
import { currentVersionField, latestVersionField } from './version-display.js';

const STATUS_LABELS: Record<UpdateCheckResult['status'], string> = {
  'up-to-date': 'up to date',
  'update-available': 'update available',
  pinned: 'pinned',
  unpinned: 'unpinned',
  unsupported: 'unsupported',
  'check-failed': 'check failed',
  'unresolved-variable': 'unresolved var',
};

function statusLabel(result: UpdateCheckResult): string {
  if (result.status === 'update-available' && result.updateType) {
    return `${result.updateType} update`;
  }
  return STATUS_LABELS[result.status];
}

function currentLabel(dep: FetchContentDependency, result?: UpdateCheckResult): string {
  const fallback = dep.sourceType === 'git' ? (dep.gitTag ?? '') : (dep.url ?? '');
  if (result) {
    if (result.status === 'unsupported') return '(url)';
    if (result.status === 'unpinned') return '(none)';
    return currentVersionField(result, fallback);
  }
  return fallback;
}

function printResults(
  deps: FetchContentDependency[],
  basePath: string,
  ignoredCount: number,
  filteredCount: number,
  updateResults?: UpdateCheckResult[],
): void {
  if (deps.length === 0) {
    console.log('No dependencies found.');
    return;
  }

  const fileSet = new Set(deps.map((d) => d.location.file));
  const suffixes: string[] = [];
  if (ignoredCount > 0) suffixes.push(`${ignoredCount} omitted due to ignore configuration`);
  if (filteredCount > 0) suffixes.push(`${filteredCount} filtered by update type`);
  let summary = `Found ${deps.length} dependencies in ${fileSet.size} file(s)`;
  if (suffixes.length > 0) summary += ` (${suffixes.join(', ')})`;
  console.log(summary + ':\n');

  if (updateResults) {
    const resultMap = new Map<FetchContentDependency, UpdateCheckResult>();
    for (const r of updateResults) {
      resultMap.set(r.dep, r);
    }

    // Build rows sorted by actionability: updates first, then up-to-date, then skipped
    const STATUS_ORDER: Record<UpdateCheckResult['status'], number> = {
      'update-available': 0,
      'check-failed': 1,
      'unresolved-variable': 2,
      'up-to-date': 3,
      pinned: 4,
      unpinned: 5,
      unsupported: 6,
    };

    const rows = deps
      .map((dep) => {
        const result = resultMap.get(dep)!;
        const relFile = path.relative(basePath, dep.location.file);
        return {
          name: dep.name,
          current: currentLabel(dep, result),
          latest: latestVersionField(result, '\u2014'),
          status: statusLabel(result),
          location: `${relFile}:${dep.location.startLine}`,
          sortKey: STATUS_ORDER[result.status],
        };
      })
      .sort((a, b) => a.sortKey - b.sortKey);

    const nameW = Math.max('Name'.length, ...rows.map((r) => r.name.length));
    const currentW = Math.max('Current'.length, ...rows.map((r) => r.current.length));
    const latestW = Math.max('Latest'.length, ...rows.map((r) => r.latest.length));
    const statusW = Math.max('Status'.length, ...rows.map((r) => r.status.length));

    console.log(
      `  ${'Name'.padEnd(nameW)}  ${'Current'.padEnd(currentW)}  ${'Latest'.padEnd(latestW)}  ${'Status'.padEnd(statusW)}  Location`,
    );

    for (const row of rows) {
      console.log(
        `  ${row.name.padEnd(nameW)}  ${row.current.padEnd(currentW)}  ${row.latest.padEnd(latestW)}  ${row.status.padEnd(statusW)}  ${row.location}`,
      );
    }

    // Print errors to stderr
    for (const result of updateResults) {
      if (result.status === 'check-failed' && result.error) {
        console.error(`Error checking ${result.dep.name}: ${result.error}`);
      }
    }
  } else {
    // Scan-only mode: original format
    const nameWidth = Math.max(...deps.map((d) => d.name.length));
    const typeWidth = 3;

    for (const dep of deps) {
      const version = dep.sourceType === 'git' ? (dep.gitTag ?? '') : (dep.url ?? '');
      const relFile = path.relative(basePath, dep.location.file);
      const location = `${relFile}:${dep.location.startLine}`;

      console.log(
        `  ${dep.name.padEnd(nameWidth)}  ${dep.sourceType.padEnd(typeWidth)}  ${version.padEnd(50)}  ${location}`,
      );
    }
  }
}

export function createProgram(): Command {
  const program = new Command();

  program
    .name('cmake-depcheck')
    .description('Check for updates to CMake FetchContent dependencies')
    .version(VERSION);

  program
    .command('scan')
    .description('Scan CMake files for FetchContent dependencies')
    .requiredOption('--path <path>', 'Path to CMakeLists.txt or project root')
    .option(
      '--exclude <pattern>',
      'Additional directory exclusion pattern (repeatable)',
      collect,
      [],
    )
    .option('--ignore <name>', 'Exclude a dependency by name (repeatable)', collect, [])
    .option(
      '--update-types <types>',
      'Only include these update types (comma-separated: major, minor, patch, unknown)',
    )
    .option('--scan-only', 'List dependencies without checking for updates')
    .option('--json', 'Emit JSON to stdout (suppresses standard CLI output)')
    .option('--fail-on-updates', 'Exit with code 1 if any updates are available')
    .option(
      '--no-resolve-sha',
      'Skip SHA reverse-resolution; SHA-pinned GIT_TAG values stay classified as pinned',
    )
    .action(
      async (options: {
        path: string;
        exclude: string[];
        ignore: string[];
        updateTypes?: string;
        scanOnly?: boolean;
        json?: boolean;
        failOnUpdates?: boolean;
        resolveSha: boolean;
      }) => {
        if (options.failOnUpdates && options.scanOnly) {
          console.error(
            'Warning: --fail-on-updates has no effect with --scan-only (no update checks performed)',
          );
        }

        if (options.updateTypes && options.scanOnly) {
          console.error(
            'Warning: --update-types has no effect with --scan-only (no update checks performed)',
          );
        }

        let updateTypes: Set<string> | undefined;
        if (options.updateTypes) {
          try {
            updateTypes = parseUpdateTypes(options.updateTypes);
          } catch (err) {
            throw new CommanderError(
              1,
              'cmake-depcheck.invalid_update_type',
              err instanceof Error ? err.message : String(err),
            );
          }
        }

        const onProgress =
          !options.json && process.stderr.isTTY
            ? (completed: number, total: number) => {
                process.stderr.write(`Checking for updates... (${completed}/${total})\r`);
              }
            : undefined;

        const result = await scan({
          path: options.path,
          excludePatterns: options.exclude.map((p) => new RegExp(p)),
          ignoreNames: options.ignore,
          updateTypes,
          scanOnly: options.scanOnly,
          resolveSha: options.resolveSha,
          onProgress,
        });

        if (onProgress && process.stderr.isTTY) {
          process.stderr.write('\r' + ' '.repeat(40) + '\r');
        }

        if (options.json) {
          const output = formatJsonOutput({
            ...result,
            entryPath: options.path,
          });
          process.stdout.write(JSON.stringify(output, null, 2) + '\n');
        } else {
          for (const warning of result.warnings) {
            console.error(warning);
          }
          printResults(
            result.deps,
            result.basePath,
            result.ignoredCount,
            result.filteredCount,
            result.updateResults,
          );
        }

        if (
          options.failOnUpdates &&
          result.updateResults?.some((r) => r.status === 'update-available')
        ) {
          throw new CommanderError(1, 'cmake-depcheck.updates_available', '');
        }
      },
    );

  return program;
}

function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

if (fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createProgram().parse();
}
