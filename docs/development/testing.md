# Testing

**Do not run full test suites by default.** Always choose the smallest targeted file, case filter, or Cargo `--lib` filter that covers your change. Broaden only for another affected boundary, a diagnostic reason, or an explicit request. Never rerun unchanged passing checks or reproduce the CI matrix locally; docs-only edits need link/diff review, not a build or test run. Report what you ran and any relevant gap.

## Authoring rules

- **Keep tests short and focused.** Prefer pure unit tests (`scripts/*.test.ts` or Rust `--lib`) over browser tests whenever DOM/layout is not under test. Avoid growing large monolith UI test files (`frontend-audit.test.mjs`, `conversation-history-ui.test.mjs`, `workspace-changes-ui.test.mjs`); keep each regression concise and isolated.
- **Never wake up Chromium multiple times in frontend UI tests.** Every browser test file must use `connectOrLaunchBrowser()` from [ui-browser.mjs](../../scripts/fixtures/ui-browser.mjs) at most once in `before`/`after` (sharing one Vite server and closing only per-test `context`/`page`), never inside individual `test()` calls. When running multiple UI test files together, invoke [run-ui-tests.mjs](../../scripts/run-ui-tests.mjs) so one `chromium.launchServer()` instance is shared across all files (`test-runner.test.mjs` enforces this contract).
- **Assert observable behavior.** Reuse existing coverage and add small regressions for changed behavior and meaningful failure paths — not source spelling, exact copy, decorative CSS, or workflow indentation. An unavailable browser, platform tool, or build environment is a validation gap, not a reason to retry unrelated suites.

## Focused checks

Pick only the row(s) matching your change — these are alternatives, not a checklist:

| Change | Focused command |
| --- | --- |
| TypeScript types | `npm run check` |
| Browser wire DTOs | `npm run api:generate`, then `npm run api:check`; `node scripts/node-ts.mjs --test scripts/api-protocol.test.ts` |
| Single JS/UI test case | `node --test --test-name-pattern="<case>" scripts/<file>.test.mjs` |
| Multiple UI test files (1 shared browser) | `node scripts/run-ui-tests.mjs scripts/<a-ui>.test.mjs scripts/<b-ui>.test.mjs` |
| TypeScript unit test (source-resolver group) | `node scripts/node-ts.mjs --test scripts/<file>.test.ts` |
| TypeScript unit test (tsx group) | `node --import tsx --test scripts/<file>.test.ts` |
| Rust backend library (`backend/src/`) | `node scripts/cargo.mjs test --manifest-path backend/Cargo.toml --no-default-features --features fixture --lib <filter>` |
| Rust backend integration (`backend/tests/`) | `node scripts/cargo.mjs test --manifest-path backend/Cargo.toml --no-default-features --features fixture --test <target> <filter>` |
| Rust compile-only check | `node scripts/cargo.mjs check --manifest-path backend/Cargo.toml --no-default-features` |
| Desktop shell (`src-tauri/`) | `node scripts/cargo.mjs test --manifest-path src-tauri/Cargo.toml <filter>` |

Omit `--test-name-pattern` to run a single file. A filter matching zero cases is not validation. Rebuild the Rust test target after editing `launch-binding.mjs` or `path-identity.mjs` (embedded into [batch_workspace_tests.rs](../../backend/src/batch_workspace_tests.rs) via `include_str!`).

Frontend-only TypeScript tests can run from a checkout without the Pi submodule. Tests that import Pi packages through `node-ts.mjs` still use the pinned submodule's source aliases.

## Test and script organization

[package.json](../../package.json) exposes stable `test:*` scripts; [test-suites.mjs](../../scripts/test-suites.mjs) owns their explicit file lists and command order; [test.mjs](../../scripts/test.mjs) runs them without a shell (preserving caller env like `CARGO_TARGET_DIR`) and stops at the first failure. There is deliberately no default/all suite.

```sh
npm run test:list                    # list suite scopes, no execution
npm run test:environment -- --list   # preview exact commands without executing
npm run test:inventory               # verify wiring, missing/unregistered/duplicate tests
npm run test:scripts                 # runner/setup/dev/build-isolation/release-helper regressions
```

Add every new `scripts/**/*.test.{mjs,ts}` file to a suite in [test-suites.mjs](../../scripts/test-suites.mjs) so `npm run test:inventory` passes.

| Location / entry | Responsibility |
| --- | --- |
| `scripts/*.test.*`, `scripts/fixtures/` | JS/TS regressions and shared helpers (`ui-browser.mjs`, `current-api.mjs`). |
| `scripts/run-ui-tests.mjs` | Multi-file Playwright runner sharing one `chromium.launchServer()` (`PI_N_TEST_BROWSER_WS_ENDPOINT`). |
| `backend/src/*tests*`, `backend/tests/` | Rust library and integration tests, filtered with Cargo. |
| `src-tauri/src/`, `src-tauri/tests/` | Desktop shell Rust unit and sidecar lifecycle tests. |
| `benchmark/test_*.py` | Harbor adapter tests; see [Harbor](../benchmarks/harbor.md#adapter-tests). |
| `probe:*`, `scripts/readme-screenshots.mjs`, `scripts/planning-trajectory.mjs` | Opt-in diagnostics/asset generation, not routine validation. |
| `clean:stale`, `cleanup:workspaces` | Explicit maintenance commands; never run as test cleanup. |

Browser fixtures follow the current wire contract via [current-api.mjs](../../scripts/fixtures/current-api.mjs) (keep old-format rejection cases separate from current response builders).

## Build isolation

If a running backend locks Cargo artifacts, wrap the **same targeted command** instead of stopping the backend or running a full suite:

```sh
node scripts/temporary-target.mjs -- node scripts/cargo.mjs <original-arguments>
```

The wrapper cleans only its own temporary target directory and reuses an explicit `CARGO_TARGET_DIR`. For an npm suite use `npm run test:temporary -- <script>`. Release builds and [packaging](../../scripts/package-release.mjs) must share one target directory.

## Specialized Rust boundaries

Choose only the affected boundary (`--no-default-features --features fixture --lib <filter> -- --test-threads=1`):

| Area | Filter / target | Reference contract |
| --- | --- | --- |
| Managed W/S snapshots & recovery | `workspace_files::tests`, `environment::snapshot_tests`, `rooted_terminals_with_w_and_s_bindings`, `rooted_result_reconstructs_missing_w` | [Managed roots & recovery](../architecture/native-environments.md#current-state-historical-evidence-and-ownership) |
| Native runtime evidence, selectors & blobs | `runtime_evidence`, `runtime_project_code_proof`, `streaming_git_blob`, `environment::best_effort_tests::rooted_` | [Native runtime inputs](../architecture/native-environments.md#native-runtime-inputs-during-recovery) |
| Private HOME branch inheritance | `unbound_home_fork`, `home_fork_metadata` | [Unbound private HOME branches](../architecture/native-environments.md#unbound-private-home-branches) |
| Files-only publication | `--test files_only_publication`, `--test publication_recovery`, `--lib workspace_view_tests`, `scripts/planner-workspace-runtime.test.ts` | [Workspaces & Git](../architecture/workspace-snapshots-and-feedback.md) |
| Zero-config source HOME (not implemented; opt-in, currently **fails**) | `zero_configuration_home_source_and_parent_without_setup -- --ignored --nocapture --test-threads=1` | [Zero-config HOME blocker](../architecture/native-environments.md#zero-configuration-source-home-discovery) |

For full real-backend files-only publication acceptance (requires pinned Pi, native Git/Bash, and platform boundary):

```sh
node scripts/cargo.mjs build --manifest-path backend/Cargo.toml --no-default-features --bin pi-n
node scripts/accept-files-only-publication.mjs
```

## Opt-in baselines and microbenchmarks

All probes below are `#[ignore]` local component measurements (disposable fixtures, no model calls, no timing gates):

```sh
node scripts/cargo.mjs test --manifest-path backend/Cargo.toml --no-default-features --features fixture --lib <filter> -- --ignored --nocapture --test-threads=1
```

| `--lib` filter | Source | Scope |
| --- | --- | --- |
| `environment_project_baseline`, `managed_recovery_preflight_benchmark` | [environment_probe.rs](../../backend/src/workspace_view/environment_probe.rs) | Offline Node/Python/Rust baselines and dirty managed-view recovery; see [environment-baselines.md](environment-baselines.md). |
| `environment_dependency_sealing_benchmark` | [seal_tests.rs](../../backend/src/workspace_files/seal_tests.rs) | Immutable E sealing/store growth (`PI_N_ENV_SEAL_PROBE_REPORT`). |
| `staging_bench::delta_index_staging` | [staging_bench.rs](../../backend/src/graph_merge/publication/staging_bench.rs) | Full-index vs. delta-index staging (64–50k paths). |
| `view_equality_benchmark`, `view_normalization_benchmark` | [equality_tests.rs](../../backend/src/workspace_view/equality_tests.rs) | Borrowed view equality and schema-6 checksum serialization. |
| `index_flag_batching_benchmark` | [workspace_git_index_tests.rs](../../backend/src/workspace_git_index_tests.rs) | Batched Git index flag restoration. |
| `scan_bench::file_scanning_benchmark`, `scan_bench::snapshot_staging_benchmark` | [scan_bench.rs](../../backend/src/workspace_view/scan_bench.rs) | Parallel file scanning and SHA-1/SHA-256 staging. |
| `sha256_blob_batching_benchmark` | [sha256_stage_bench.rs](../../backend/src/workspace_view/sha256_stage_bench.rs) | Batched `fast-import` SHA-256 blob staging. |
| `workspace_cleanup_lock_benchmark` | [cleanup_bench.rs](../../backend/src/cleanup_bench.rs) | Detached out-of-lock cleanup lock-wait vs. sync cleanup. |
| `file_summary_persistence_benchmark` | [persistence_bench.rs](../../backend/src/file_changes/persistence_bench.rs) | File-change sidecar persistence lock contention. |

## Broader suites (on demand)

Pass `-- --list` to any `test:*` script to inspect its commands without executing. Run these only when explicitly needed, never as a default routine:

| Script | Scope / prerequisites |
| --- | --- |
| `test:frontend`, `test:backend` | Pure frontend unit suite; full Rust fixture suite. |
| `test:ui`, `test:ui:audit` | Mocked-API feature and deep audit browser suites (one shared Chromium via `run-ui-tests.mjs`; Chromium or `PI_N_BROWSER_CHANNEL`). |
| `test:bundle`, `test:ui-polish` | Temporary production bundle lazy-load checks; opt-in bilingual viewport sweep (`PI_N_UI_SCREENSHOTS`). |
| `test:pi`, `test:extensions` | Pinned Pi transport/SDK contracts; Planner TS check + extension smoke. |
| `test:native`, `test:native:scripts`, `test:planner-bash` | Native paths, launchers, Planner workspace rebinding, and host Bash semantics. |
| `test:filesystem` | Native ACLs, path identity, symlinks, and snapshot integrity (Rust/Git). |
| `test:prewarm`, `test:merger`, `test:bindings` | Prewarm acceptance; Git composition/publication; project bindings/routing. |
| `test:environment`, `test:environment:acceptance`, `test:environment-chain` | Native environment admission/lifecycle (Python 3.11+, Git, Bash, platform boundary; Windows accepts `PI_N_ENV_TEST_PARENT`; offline Conda/ML opt-in via `PI_N_ENV_TEST_{CONDA,ML}_MANIFEST`). |
| `test:hardening`, `test:windows-native`, `test:macos-browser`, `test:concurrent`, `test:conversation-acceptance` | Production HTTP/filesystem hardening, OS-specific acceptance, HTTP concurrency, and [conversation-log acceptance](conversation-logs.md#acceptance-prerequisites). |
| `test:build-cache`, `test:release`, `test:desktop` | Temporary target isolation; release/updater/signing contracts; Tauri v2 desktop shell suite. |

Native suites require the real [platform boundary](../architecture/filesystem-isolation.md#platform-boundaries) (bubblewrap/namespaces on Linux, Seatbelt on macOS).

## CI

[planner-source.yml](../../.github/workflows/planner-source.yml), [release.yml](../../.github/workflows/release.yml), and [security-audit.yml](../../.github/workflows/security-audit.yml) own CI coverage:

- **Linux** runs host-neutral frontend and full Rust fixture suites on pushes, PRs, and weekly schedules.
- **macOS** runs the full fixture suite on PRs/schedules, plus `test:filesystem` (Apple Silicon, Intel, and case-sensitive APFS) and `test:macos-browser` on ARM.
- **Windows** runs focused native checks (PTY/ConPTY lifecycle, ACL/path checks, `rooted_` recovery, and runtime-evidence checks) rather than repeating host-neutral suites.
- Weekly/manual runs also publish the model-free [dependency-cost report](environment-baselines.md).
