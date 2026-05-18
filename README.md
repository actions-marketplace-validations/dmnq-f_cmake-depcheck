# CMake Dependency Checker

[![CI](https://github.com/dmnq-f/cmake-depcheck/actions/workflows/ci.yml/badge.svg)](https://github.com/dmnq-f/cmake-depcheck/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/cmake-depcheck)](https://www.npmjs.com/package/cmake-depcheck)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

Scans CMake files for `FetchContent_` dependencies, checks upstream repositories for newer versions, and reports what's out of date. Think `npm outdated`, but for CMake's FetchContent dependencies.

## Quick Start

### GitHub Action

```yaml
- uses: dmnq-f/cmake-depcheck@v2
  with:
    path: CMakeLists.txt
    fail-on-updates: true # Default: false
    create-prs: true # Default: false
```

### CLI

```bash
npx cmake-depcheck scan --path ./CMakeLists.txt
```

```
Found 4 dependencies in 3 file(s):

  Name        Current  Latest   Status        Location
  googletest  v1.17.0  v1.17.0  up to date    CMakeLists.txt:7
  fmt         10.2.1   12.1.0   major update  cmake/deps.cmake:2
  spdlog      v1.13.0  v1.17.0  minor update  libs/logging/CMakeLists.txt:4
  json        v3.11.3  v3.12.0  minor update  CMakeLists.txt:19
```

## GitHub Action

### Basic usage

```yaml
name: Dependency Check
on:
  schedule:
    - cron: '0 8 * * 1'
  workflow_dispatch:

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: dmnq-f/cmake-depcheck@v2
        with:
          path: CMakeLists.txt
          # Additional options see below
```

### Auto-update PRs

Set `create-prs: true` to open one pull request per outdated dependency. Each PR updates the version pin in the CMake source file — either the `GIT_TAG` value directly or the originating `set()` variable. PRs include upstream release notes (from GitHub Releases) for all versions between your current pin and the latest, capped at the 5 most recent versions, with a link to the full changelog.

**Token and repository settings:**

- Ensure your repository settings allow for automatic PR creation, see the corresponding [Managing GitHub Actions settings for a repository](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository#preventing-github-actions-from-creating-or-approving-pull-requests) section.
- PRs created with the default `GITHUB_TOKEN` will not trigger `on: pull_request` workflows — this is a [GitHub restriction](https://docs.github.com/en/actions/using-workflows/triggering-a-workflow#triggering-a-workflow-from-a-workflow) to prevent recursive runs. If your branch protection requires status checks, use a GitHub App token or PAT instead:

```yaml
permissions:
  contents: write
  pull-requests: write

steps:
  - uses: actions/checkout@v6
  - uses: dmnq-f/cmake-depcheck@v2
    with:
      path: CMakeLists.txt
      create-prs: true
      token: ${{ secrets.PAT }}
```

### Filtering by update type

Use `update-types` to limit which update types appear in results, trigger `fail-on-updates`, or get PRs. This is a scan-level filter — non-matching `update-available` results are excluded from all outputs.

```yaml
- uses: dmnq-f/cmake-depcheck@v2
  with:
    path: CMakeLists.txt
    update-types: minor,patch
    fail-on-updates: true
```

Valid values: `major`, `minor`, `patch`, `unknown`. The job summary notes how many updates were filtered.

### Inputs

| Input             | Description                                                                                                                                                                    | Default               |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------- |
| `path`            | Path to CMakeLists.txt (recommended, will follow project hierarchy) or project root directory (simple directory tree traversal)                                                | `CMakeLists.txt`      |
| `scan-only`       | List dependencies without checking for updates                                                                                                                                 | `false`               |
| `exclude`         | Directory exclusion patterns, one per line                                                                                                                                     |                       |
| `ignore`          | Dependency names to exclude from results, one per line                                                                                                                         |                       |
| `update-types`    | Only include these update types in results and PRs (comma-separated: `major`, `minor`, `patch`, `unknown`)                                                                     |                       |
| `fail-on-updates` | Fail the workflow if any dependency has an available update                                                                                                                    | `false`               |
| `create-prs`      | Create pull requests for available updates                                                                                                                                     | `false`               |
| `dry-run`         | Log what PRs would be created without actually creating them (requires `create-prs: true`)                                                                                     | `false`               |
| `resolve-sha`     | Reverse-resolve SHA-pinned `GIT_TAG` values against upstream tag commit SHAs to enable update checking on them. Set to `false` to keep SHA-pinned deps classified as `pinned`. | `true`                |
| `token`           | GitHub token for creating PRs                                                                                                                                                  | `${{ github.token }}` |

### Outputs

| Output              | Description                                                     |
| ------------------- | --------------------------------------------------------------- |
| `has-updates`       | Whether any dependency has an available update (`true`/`false`) |
| `total`             | Total number of dependencies found                              |
| `updates-available` | Number of dependencies with available updates                   |
| `result-json`       | Full scan result as JSON string                                 |
| `prs-created`       | Number of pull requests created                                 |

## CLI

### Installation

Requires Node.js 24+.

```bash
npm install -g cmake-depcheck
```

Or run directly with `npx`:

```bash
npx cmake-depcheck scan --path ./CMakeLists.txt
```

### Scan from a CMakeLists.txt (recommended)

When given a file, cmake-depcheck follows the chain of `include()` and `add_subdirectory()` calls to discover all related CMake files and their dependencies. This mirrors how CMake itself traverses your project and gives the most accurate results.

```bash
cmake-depcheck scan --path ./CMakeLists.txt
```

Chain resolution handles:

- `include(cmake/deps.cmake)` — resolved relative to the file containing the call
- `include(cmake/deps)` — `.cmake` extension appended automatically
- `add_subdirectory(libs/networking)` — looks for `CMakeLists.txt` in the subdirectory
- `${CMAKE_CURRENT_SOURCE_DIR}`, `${CMAKE_CURRENT_LIST_DIR}`, `${PROJECT_SOURCE_DIR}`, and other variables set via `set()` are resolved automatically
- Generator expressions (`$<...>`) and variables that can't be resolved produce a warning on stderr

### Scan a directory

Alternatively, scan an entire directory tree. This recursively finds all `CMakeLists.txt` and `.cmake` files and parses them for FetchContent declarations.

```bash
cmake-depcheck scan --path ./my-project
```

Build directories (`build*/`, `cmake-build-*/`, `_deps/`) and hidden directories are excluded by default. Add custom exclusions with `--exclude`:

```bash
cmake-depcheck scan --path . --exclude "^vendor$" --exclude "^third_party$"
```

Exclusion patterns are regular expressions matched against directory names.

Directory mode is useful for a quick overview or when your project structure doesn't follow standard `add_subdirectory()` patterns.

### Scan only (no update check)

By default, the scan command checks upstream repositories for newer versions. Use `--scan-only` to skip network calls and just list what's declared:

```bash
cmake-depcheck scan --path ./CMakeLists.txt --scan-only
```

### Ignoring dependencies

Use `--ignore` to exclude specific dependencies from the output by name (repeatable, case-insensitive). Names are matched exactly by default; use regex syntax for patterns:

```bash
cmake-depcheck scan --path . --ignore ominous-dep --ignore "stb.*"
```

Ignored dependencies are still parsed but omitted from the results. The summary line indicates how many were filtered.

### JSON output

Use `--json` to get machine-readable output instead of the human-readable table. All JSON goes to stdout; warnings and progress go to stderr.

```bash
cmake-depcheck scan --path ./CMakeLists.txt --json
```

The JSON output includes dependency details, update check results, scan metadata, and aggregate summary counts.

Combine with `--scan-only` to get a machine-readable inventory without hitting the network:

```bash
cmake-depcheck scan --path . --scan-only --json
```

### Filtering by update type

Use `--update-types` to limit results to specific update types. This filters `update-available` results before they appear in output, trigger `--fail-on-updates`, or generate PRs:

```bash
cmake-depcheck scan --path . --fail-on-updates --update-types minor,patch
```

Exits with code 1 only if minor or patch updates are available. Major updates are silently filtered. Valid values: `major`, `minor`, `patch`, `unknown`.

### Failing on updates

Use `--fail-on-updates` to exit with code 1 when any dependency has an available update. Works with both human-readable and JSON output:

```bash
cmake-depcheck scan --path . --fail-on-updates
cmake-depcheck scan --path . --json --fail-on-updates
```

### SHA-pinned dependencies

By default, `GIT_TAG` values that look like commit SHAs are reverse-resolved against upstream tags: if the pinned SHA matches the commit SHA of an upstream tag, that tag drives update checking like a regular tag. SHA pins that don't match any upstream tag stay classified as `pinned`. Generated PRs rewrite the SHA to the new tag's commit SHA; any trailing comment (e.g. `# 14.1.0`) gets its version token updated alongside, preserving the surrounding text and whitespace.

A trailing comment containing the words `pin`, `pinned`, or `pinning` acts as a per-dep opt-out — the dep stays classified as `pinned` even if its SHA matches an upstream tag:

```cmake
GIT_TAG c740f0fda4274d6ffd2e5b64a25b06ef69803a07  # pinned to bugfix XYZ
```

Use `--no-resolve-sha` to disable SHA reverse-resolution globally:

```bash
cmake-depcheck scan --path . --no-resolve-sha
```

## Limitations

- **Limited variable expansion.** When scanning from a specific file (chain mode), cmake-depcheck tracks `set()` calls and resolves `${VAR}` references in both file paths and dependency declarations. This covers common patterns like `set(GTEST_VERSION "v1.14.0")` followed by `GIT_TAG ${GTEST_VERSION}`. However, `CACHE` variables, `PARENT_SCOPE`, environment variables, and values computed via `string()`, `list()`, or `math()` are not resolved. In directory scan mode, no variable resolution is performed.
- **No conditional evaluation.** Declarations inside `if()` blocks are always included regardless of the condition.
- **No cross-file include resolution in directory mode.** Directory scanning finds files by walking the filesystem, not by tracing `include()` calls. Use file mode for precise chain-following.
- **Best-effort version comparison.** Semver tags (with or without `v` prefix) are compared accurately. Non-semver tags (e.g., `VER-2-14-0`) use prefix-based heuristics. SHA-pinned dependencies are reported as `pinned` but not checked for updates.
- **URL dependency support is GitHub-only.** URL-based dependencies pointing to GitHub releases or archives are checked for updates using the same tag comparison as git deps. Non-GitHub URLs (e.g., custom mirrors, GitLab) are reported as `unsupported`.
- **Only direct-form `FetchContent_Populate` is detected.** When `FetchContent_Populate` is called with source arguments (e.g., `GIT_REPOSITORY`, `URL`), it acts as a combined declaration+population and is treated as a dependency. Simple trigger calls like `FetchContent_Populate(depname)` are ignored — the dependency data lives in the corresponding `FetchContent_Declare`.

## Building from Source

```bash
git clone https://github.com/dmnq-f/cmake-depcheck.git
cd cmake-depcheck
npm install
npm run build
npm test
```

Development without a build step:

```bash
npm run dev -- scan --path ./CMakeLists.txt
```
