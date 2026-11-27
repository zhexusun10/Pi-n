Use [docs/index.md](docs/index.md) as the documentation entry point. Keep task maps there and background/procedures in linked documents; read only documentation relevant to the current task.

Record user-visible or notable code/doc changes under `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md).

For testing, follow [docs/development/testing.md](docs/development/testing.md): run only the smallest targeted check for your change (do not run full test suites by default), keep tests concise, and reuse the shared Playwright browser (`scripts/fixtures/ui-browser.mjs` / `scripts/run-ui-tests.mjs`) in frontend UI tests instead of launching Chromium repeatedly.
