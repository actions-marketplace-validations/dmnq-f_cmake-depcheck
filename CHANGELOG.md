# Changelog

## [3.0.2](https://github.com/dmnq-f/cmake-depcheck/compare/v3.0.1...v3.0.2) (2026-05-18)


### Bug Fixes

* Preserve characters between value and # in PR edit oldText ([a093286](https://github.com/dmnq-f/cmake-depcheck/commit/a093286c5a533d202d6c58c725ce32354e275f19))

## [3.0.1](https://github.com/dmnq-f/cmake-depcheck/compare/v3.0.0...v3.0.1) (2026-05-18)


### Bug Fixes

* Correct line numbers and PR edits for SHA-pinned variable deps ([300be34](https://github.com/dmnq-f/cmake-depcheck/commit/300be3454ea33dbf89050994facc763f63947cf9))

## [3.0.0](https://github.com/dmnq-f/cmake-depcheck/compare/v2.0.1...v3.0.0) (2026-05-18)


### ⚠ BREAKING CHANGES

* SHA-pinned `GIT_TAG` deps are now network-checked by default and may flip from `'pinned'` to `'update-available'`, which can trigger `--fail-on-updates` gates or auto-PR creation that previously ignored them. Set `--no-resolve-sha` (CLI), or `resolve-sha: 'false'` (action input) to restore prior behavior.

### Features

* Enable update checking on SHA-pinned dependencies ([#50](https://github.com/dmnq-f/cmake-depcheck/issues/50)) ([e8498bd](https://github.com/dmnq-f/cmake-depcheck/commit/e8498bdf499d510bb733fcd666b00c72c44e5670))

## [2.0.1](https://github.com/dmnq-f/cmake-depcheck/compare/v2.0.0...v2.0.1) (2026-04-14)


### Bug Fixes

* Recompute gitTagIsSha after chain variable resolution ([abd0f32](https://github.com/dmnq-f/cmake-depcheck/commit/abd0f32a92361da496143368de88a43246c341fe))

## [2.0.0](https://github.com/dmnq-f/cmake-depcheck/compare/v1.3.0...v2.0.0) (2026-03-26)


### ⚠ BREAKING CHANGES

* PR lifecycle management (update-in-place, stale cleanup) ([#15](https://github.com/dmnq-f/cmake-depcheck/issues/15))

### Features

* add --update-types filter for scan results ([d90a133](https://github.com/dmnq-f/cmake-depcheck/commit/d90a13306274d21f659941a62e5d84a9f0ce7583))
* include upstream release notes in auto-update PRs ([9f1be33](https://github.com/dmnq-f/cmake-depcheck/commit/9f1be33d4a15ff9ad42d16acb932eb743c966998))
* PR lifecycle management (update-in-place, stale cleanup) ([#15](https://github.com/dmnq-f/cmake-depcheck/issues/15)) ([1c6c690](https://github.com/dmnq-f/cmake-depcheck/commit/1c6c690d84c09e6aadb2f9e0157222dd881ba7ce))

## [1.3.0](https://github.com/dmnq-f/cmake-depcheck/compare/v1.2.0...v1.3.0) (2026-03-24)


### Features

* add --update-types filter for scan results ([d90a133](https://github.com/dmnq-f/cmake-depcheck/commit/d90a13306274d21f659941a62e5d84a9f0ce7583))
* include upstream release notes in auto-update PRs ([9f1be33](https://github.com/dmnq-f/cmake-depcheck/commit/9f1be33d4a15ff9ad42d16acb932eb743c966998))
