# Repository homepage settings

GitHub About fields are remote repository settings; committing Markdown does not update them. A maintainer with permission can edit **About → settings** on the repository page.

## Description

```text
Pi^n — Direct with one pi. Compile into many. Out-of-the-box Pi coding workbench with 4 purpose-built plugins and a compiled multi-agent Rust runtime.
```

## Homepage

Until an actual documentation site or hosted demo exists, link to installation:

```text
https://github.com/zhexusun10/pi-n#quick-start
```

This is not a hosted application. Do not use a localhost address or an undeployed GitHub Pages URL.

## Topics

```text
coding-agent
multi-agent
agentic-ai
llm
rust
git
local-first
developer-tools
task-graph
deterministic-runtime
```

## Optional GitHub CLI update

Confirm the CLI is authenticated and you have permission. Inspect existing fields before changing remote settings:

```sh
gh repo view zhexusun10/pi-n --json description,homepageUrl,repositoryTopics

gh repo edit zhexusun10/pi-n \
  --description "Pi^n — Direct with one pi. Compile into many. Out-of-the-box Pi coding workbench with 4 purpose-built plugins and a compiled multi-agent Rust runtime." \
  --homepage "https://github.com/zhexusun10/pi-n#quick-start" \
  --add-topic coding-agent,multi-agent,agentic-ai,llm,rust,git,local-first,developer-tools,task-graph,deterministic-runtime

gh repo view zhexusun10/pi-n --json description,homepageUrl,repositoryTopics
```

## Documentation and assets

- [English product homepage](../README.md)
- [Chinese product homepage](../README.zh-CN.md)
- [Canonical documentation index](../docs/index.md)

The English and Chinese README screenshots show the current Pi^n frontend across six views: the Home screen (default Tri-color grid, Direct / Compile controls, Auto hidden), the Direct collapsed-cards minimalist mode (`Collapse cards` active with single-line activity summary rows and `Expand cards`), Direct detailed card inspection paired with inline File Changes diffs and a `Compacted` context card, the docked workspace terminal with the Pi `/` slash-command palette, Settings → Global Pi extensions (highlighting all four bundled plugins), and a Compile mode multi-node execution graph with parallel lanes and a bounded feedback edge.

To refresh all twelve screenshots (six English, six Simplified Chinese), install the project dependencies and Playwright Chromium (`npx playwright install chromium`), then run `node scripts/readme-screenshots.mjs` from the repository root. Windows uses installed Microsoft Edge by default; `PI_N_BROWSER_CHANNEL` can select another installed browser. The capture mocks the API and does not require a backend, a real project or provider credentials. Review both languages and keep README captions aligned with the captured controls; do not mix historical UI screenshots into the current showcase.

Maintainer checks belong in development documentation or issue tracking, not the product README.
