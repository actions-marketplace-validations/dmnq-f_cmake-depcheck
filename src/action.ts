import * as path from 'node:path';
import * as core from '@actions/core';
import { fileURLToPath } from 'node:url';
import { scan } from './scan.js';
import { UpdateCheckResult } from './checker/types.js';
import { parseUpdateTypes } from './update-types.js';
import { currentVersionField, latestVersionField } from './version-display.js';
import { createPullRequests, type PrResult } from './pr/index.js';

function parseMultiLineInput(raw: string): string[] {
  return raw
    .split('\n')
    .flatMap((line) => line.split(','))
    .map((s) => s.trim())
    .filter(Boolean);
}

function statusLabel(status: UpdateCheckResult['status']): string {
  switch (status) {
    case 'up-to-date':
      return 'up to date';
    case 'update-available':
      return 'update available';
    case 'check-failed':
      return 'check failed';
    case 'unresolved-variable':
      return 'unresolved variable';
    default:
      return status;
  }
}

function annotate(result: UpdateCheckResult): void {
  const dep = result.dep;
  const file = path.relative(process.cwd(), dep.location.file);
  const startLine = dep.location.startLine;

  switch (result.status) {
    case 'up-to-date':
      break;

    case 'update-available':
      core.warning(
        `${dep.name}: ${dep.gitTag ?? result.resolvedVersion ?? '?'} → ${result.latestVersion} (${result.updateType} update)`,
        { file, startLine },
      );
      break;

    case 'check-failed':
      core.warning(`${dep.name}: update check failed — ${result.error}`, { file, startLine });
      break;

    case 'unresolved-variable':
      core.warning(`${dep.name}: version contains an unresolved CMake variable`, {
        file,
        startLine,
      });
      break;

    case 'pinned':
    case 'unpinned':
    case 'unsupported':
      break;
  }
}

export async function run(): Promise<void> {
  const inputPath = core.getInput('path') || 'CMakeLists.txt';
  const scanOnly = core.getInput('scan-only') === 'true';
  const failOnUpdates = core.getInput('fail-on-updates') === 'true';
  const exclude = parseMultiLineInput(core.getInput('exclude'));
  const ignore = parseMultiLineInput(core.getInput('ignore'));
  const updateTypesRaw = core.getInput('update-types');
  const updateTypes = updateTypesRaw ? parseUpdateTypes(updateTypesRaw) : undefined;
  const resolveSha = core.getInput('resolve-sha') !== 'false';

  const result = await scan({
    path: inputPath,
    scanOnly,
    excludePatterns: exclude.length > 0 ? exclude.map((p) => new RegExp(p)) : undefined,
    ignoreNames: ignore.length > 0 ? ignore : undefined,
    updateTypes,
    resolveSha,
  });

  // Annotations
  if (result.updateResults) {
    for (const r of result.updateResults) {
      annotate(r);
    }
  }

  // Job summary
  const rows: {
    name: string;
    current: string;
    latest: string;
    status: string;
    location: string;
  }[] = [];

  if (result.updateResults) {
    for (const r of result.updateResults) {
      const dep = r.dep;
      rows.push({
        name: dep.name,
        current: currentVersionField(r, '—'),
        latest: latestVersionField(r, '—'),
        status: statusLabel(r.status),
        location: `${path.relative(process.cwd(), dep.location.file)}:${dep.location.startLine}`,
      });
    }
  } else {
    for (const dep of result.deps) {
      rows.push({
        name: dep.name,
        current: dep.gitTag ?? '—',
        latest: '—',
        status: 'scan only',
        location: `${path.relative(process.cwd(), dep.location.file)}:${dep.location.startLine}`,
      });
    }
  }

  if (rows.length > 0) {
    const summaryBuilder = core.summary.addHeading('CMake Dependency Check', 3).addTable([
      [
        { data: 'Name', header: true },
        { data: 'Current', header: true },
        { data: 'Latest', header: true },
        { data: 'Status', header: true },
        { data: 'Location', header: true },
      ],
      ...rows.map((r) => [r.name, r.current, r.latest, r.status, r.location]),
    ]);

    if (result.filteredCount > 0) {
      summaryBuilder.addRaw(`<p>${result.filteredCount} update(s) filtered by update type.</p>`);
    }

    await summaryBuilder.write();
  }

  // Outputs
  const updatesAvailable =
    result.updateResults?.filter((r) => r.status === 'update-available').length ?? 0;

  core.setOutput('has-updates', String(updatesAvailable > 0));
  core.setOutput('total', String(result.deps.length));
  core.setOutput('updates-available', String(updatesAvailable));
  core.setOutput('result-json', JSON.stringify(result));

  // PR creation
  const createPrs = core.getInput('create-prs') === 'true';
  const dryRun = core.getInput('dry-run') === 'true';
  let prsCreated = 0;

  if (createPrs && result.updateResults) {
    const updatable = result.updateResults.filter((r) => r.status === 'update-available');
    if (updatable.length > 0) {
      const token = core.getInput('token');
      const scannedDepNames = new Set(result.allDepNames);
      const prResults = await createPullRequests(
        result.updateResults,
        result.vars,
        token,
        dryRun,
        scannedDepNames,
      );
      prsCreated = prResults.filter((r) => r.action === 'created' && !r.dryRun).length;
      appendPrSummary(prResults, dryRun);
    }
  }

  core.setOutput('prs-created', String(prsCreated));

  if (failOnUpdates && updatesAvailable > 0) {
    core.setFailed(`${updatesAvailable} dependency update(s) available`);
  }
}

function appendPrSummary(prResults: PrResult[], dryRun: boolean): void {
  if (prResults.length === 0) return;

  const prRows = prResults.map((r) => {
    const prefix = r.dryRun ? '[dry-run] ' : '';
    let status: string;
    switch (r.action) {
      case 'created':
        status = r.dryRun ? `${prefix}would create PR` : `#${r.prNumber}`;
        break;
      case 'updated':
        status = r.dryRun ? `${prefix}would update PR #${r.prNumber}` : `#${r.prNumber} (updated)`;
        break;
      case 'closed-stale':
        status = r.dryRun
          ? `${prefix}would close stale PR #${r.closedPrNumber}`
          : `closed stale PR #${r.closedPrNumber}`;
        break;
      case 'skipped':
        status = `skipped (${r.skipped})`;
        break;
      case 'error':
        status = `failed: ${r.error}`;
        break;
    }
    return [r.name, status];
  });

  const heading = dryRun ? 'Pull Requests (dry run)' : 'Pull Requests';
  core.summary
    .addHeading(heading, 3)
    .addTable([
      [
        { data: 'Dependency', header: true },
        { data: 'Result', header: true },
      ],
      ...prRows,
    ])
    .write();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run().catch((error: Error) => {
    core.setFailed(error.message);
  });
}
