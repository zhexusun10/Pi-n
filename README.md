<p align="center">
  <img src="assets/icon-dots.svg" width="84" height="84" alt="Pi^n logo">
</p>

<h1 align="center">Pi<sup>n</sup></h1>

<p align="center">
  <strong>Direct with one pi. Compile into many.</strong><br>
  A local-first desktop AI coding workbench powered by <a href="https://github.com/earendil-works/pi">Pi</a>.<br>
  Cut 16X Harness Tax out of the box—code fast with one Pi, or compile into many running in parallel.
</p>

<p align="center">
  <a href="https://github.com/zhexusun10/pi-n/releases/latest"><img src="https://img.shields.io/github/v/release/zhexusun10/pi-n?label=download&color=2563eb" alt="Latest release"></a>
  <a href="https://github.com/zhexusun10/pi-n/actions/workflows/planner-source.yml"><img src="https://github.com/zhexusun10/pi-n/actions/workflows/planner-source.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT license"></a>
  <a href="https://www.rust-lang.org/"><img src="https://img.shields.io/badge/rust-stable-orange.svg" alt="Rust stable"></a>
  <a href="https://github.com/earendil-works/pi"><img src="https://img.shields.io/badge/powered%20by-Pi-111827.svg" alt="Powered by Pi"></a>
</p>

<p align="center">
  <a href="#quick-start"><strong>Download</strong></a> ·
  <a href="#why-pin">Why Pi<sup>n</sup></a> ·
  <a href="#the-workbench">Workbench</a> ·
  <a href="#four-bundled-plugins">Bundled Plugins</a> ·
  <a href="#compile-mode-deterministic-multi-agent-execution">Compile Mode</a> ·
  <a href="docs/user-guide.md">User Guide</a> ·
  <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <img src="assets/readme-home.png" width="100%" alt="Pi^n home screen on the default Tri-color grid canvas showing Build Anything With Pi^n, Direct and Compile mode switcher, multi-workspace sidebar with color-pinned conversations, and a prompt to fix an OAuth token refresh race">
  <br><sub>Native desktop workbench for macOS &amp; Windows (plus browser build for Linux). Start in <strong>Direct</strong> mode with one upgraded Pi agent, or switch to <strong>Compile</strong> to orchestrate parallel execution graphs.</sub>
</p>

---

## Why Pi<sup>n</sup>

**We love [Pi](https://github.com/earendil-works/pi).** Compared to bloated coding harnesses, Pi is remarkably token-efficient—no hardcoded few-shots, no baked-in prior bias, giving frontier models maximum room to reason and the broadest generality across real engineering work. To us, Pi is the cleanest, most elegant agent harness runtime built so far.

Just sending a single `"Hi"` on the same repo and the same model shows the difference immediately—**~16× less system-prompt overhead (`1.08k` vs. `18k` tokens)**, which translates into **2–4× lower end-to-end cost** across real multi-turn engineering sessions:

<table>
  <thead>
    <tr>
      <th align="center">Codex — <code>18k tokens</code> (7% context used)</th>
      <th align="center">Pi<sup>n</sup> — <code>1.08k tokens</code> (0% context used)</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td width="50%"><img src="assets/token-usage-codex.png" width="100%" alt="Codex spending 18k tokens (7% of context window) just to reply to Hi"></td>
      <td width="50%"><img src="assets/token-usage-pi-n.png" width="100%" alt="Pi^n spending only 1.08k tokens (0% of context window) to reply to Hi on the same repo and model"></td>
    </tr>
  </tbody>
</table>

Independent benchmarks confirm both the **Harness Tax** and the strength of Pi's minimal scaffold:

- **[Coding Agents Harness Tax](https://arena.ai/blog/coding-agents-harness-tax)** *(Arena.ai, 2026)* evaluated 21 model–harness pairs across Claude Code, Codex CLI, and Pi on SWE-bench Lite and Terminal-Bench 2.0: Claude Code started with **>10× Pi's mean initial context** and cost **1.5–2.0× as much as Pi** for comparable task success, while an alternative harness outperformed the model's native vendor harness in **9 of 12** Anthropic/OpenAI comparisons (e.g., GPT-5.6 Sol hit **83.3% in Pi vs. 78.9% in Codex** on Terminal-Bench 2.0 at roughly half the cost).
- **[Finding the Right Fit: Model-Harness Interactions across Agent Tasks](https://arxiv.org/html/2610.00917v1)** *(Li et al., arXiv:2610.00917, 2026)* evaluated 66 configurations across TUA-Bench, ALE-CLI, and Terminal-Bench 4: GPT-6 Astra achieved its best ALE-CLI and Terminal-Bench 4 scores under **Pi's lean scaffold**—beating native Codex on both (`+2.15` and `+4.76` pts) and outperforming DeepSeek Harness on Terminal-Bench 4 (`60.32%` vs. `52.38%`) at **under a quarter of the cost per task** (`$4.66` vs. `$19.94`).

**But Pi is a minimal runtime, not an out-of-the-box product.** By design, Pi keeps anything outside the minimal agent loop out of its core repository—and in day-to-day engineering, four real gaps show up fast:

- **No built-in web search** — Real tasks constantly require checking current docs, RFCs, or breaking API changes, yet bare Pi ships without a `web_search` tool.
- **Fragile loop edges** — Bare Pi's shell has no default timeout and ends a run outright on output-token caps or dropped streams. In [Li et al. (2026)](https://arxiv.org/html/2610.00917v1), **34 Pi runs** stalled silently in an unbounded shell command until deadline, penalizing models that don't always set manual timeouts or that hit output limits—failure modes the authors note are best fixed at runtime with bounded command timeouts and scoped continuation.
- **Redundant system-prompt prose** — Pi's default system prompt repeats tool descriptions already present in tool schemas and carries Pi self-documentation that 99% of coding tasks never need.
- **CLI-only ergonomics** — Visual diffs, collapsible reading, docked terminals, auth, and cross-project organization are left for every user to wire up themselves.

We deeply respect Pi's discipline in keeping its core minimal—**and that is exactly why Pi<sup>n</sup> exists.** Pi<sup>n</sup> leaves Pi's pure, unbiased loop intact while turning it into a complete daily driver:

- **Four surgical plugins, active from prompt one** — **`pi-trim`**, **`pi-continuity`**, **`pi-simple-timeout`**, and **`pi-better-web-search`** close every gap above out of the box, without injecting opinionated prompt bias.
- **Zero-setup native workbench** — macOS &amp; Windows desktop installers (plus Linux browser bundle) ship with the Rust backend, pinned Pi `1.6.1`, private Node.js `22.19.0`, and on-demand portable Git—while staying 100% compatible with Pi's OAuth/API keys, `models.json`, MCP, Skills, and extensions.
- **Calm when reading, surgical when inspecting** — Toggle between full tool/reasoning/diff inspection and a quiet one-line minimalist summary in one click, paired with a docked native terminal, swipeable chart decks, and mid-flight steering.
- **Scale cleanly to `n` Pis (`Compile` mode)** — When work splits into independent tracks (schema, API, UI, workers, tests), compile your goal into a **deterministic** Rust execution graph—**no more lost in translation**, **no Supervisor in the execution loop**, just real Git workspace handoffs.

---

## The Workbench

Designed for all-day engineering, Pi<sup>n</sup> lets **deep execution inspection** and **zero-noise minimalist reading** live side by side—flipping between them in a single click.

### Inspect Every Step—or Read Just the Signal

<p align="center">
  <img src="assets/readme-direct.png" width="100%" alt="Pi^n Direct mode in detailed view solving an OAuth token refresh race: Chain of Thought, web_search for RFC 9700, edit on src/auth/session.ts, Compacted card (124.6k to 18.4k tokens with billing), vitest exit-0 card, and the right-hand File changes inline TypeScript diff">
  <br><sub><strong>Detailed view + inline diffs:</strong> Inspect Chain of Thought, live tool exit codes, automatic <strong>Compacted</strong> cards (<code>124.6k → 18.4k tokens</code> + billing), and syntax-highlighted diffs in the <strong>File changes</strong> drawer.</sub>
</p>

<p align="center">
  <img src="assets/readme-minimal.png" width="100%" alt="Pi^n Direct mode in minimalist view showing a single-line activity summary for an API p99 latency optimization (412 ms to 38 ms), an interactive 3-card benchmark chart deck (1 / 3), and the Expand cards toggle above the composer">
  <br><sub><strong>Minimalist view (one click via <code>Collapse cards</code>):</strong> Multi-step reasoning and tool calls fold into one quiet summary line while generated benchmark plots stack into a swipeable card deck (<code>1 / 3</code>). Expand any line locally or click <code>Expand cards</code> anytime.</sub>
</p>

- **Structured Transcripts & Inline Diffs** — Inspect collapsible Chain of Thought, tool cards with status badges and exit codes, **Compacted** context cards (token savings, billing, and retained files), and non-error cache/reasoning notices. Open **File changes** in Direct or Compile mode for per-file `+/-` stats, inline syntax-highlighted diffs, and one-click external-editor launch.
- **Zero-Noise Reading Without Lock-In** — `Collapse cards` folds consecutive reasoning, edits, shell runs, and web searches into a single semantic summary line remembered across conversations—while every group stays expandable on demand.
- **Interactive Image Decks & HD Lightbox** — When an agent generates 3+ charts or screenshots, Pi<sup>n</sup> stacks them into a swipeable, keyboard-navigable deck (`1 / 3`) with click-to-preview full-resolution lightboxes and right-click copy, save, or open-in-viewer actions.
- **Built for Flow & Multi-Project Work** — Pin key conversations with customizable brand-color dots, drag to reorder workspaces and threads, branch history by editing earlier messages, interrupt and steer mid-flight with **`Option+S` / `Alt+S`**, recall queued messages with **`Option+Q` / `Alt+Q`**, and search across your workspace with **`⌘G` / `Ctrl+G`**.

### Docked Native Terminal & Instant Slash Commands (`/`)

<p align="center">
  <img src="assets/readme-terminal.png" width="100%" alt="Pi^n Direct workbench with collapsed activity rows, the /c slash command palette showing /copy, /compact, /mcp, and /scoped-models, and the docked xterm.js workspace terminal running git status and vitest">
  <br><sub>Docked native PTY terminal (<code>xterm.js</code>) paired with the interactive <code>/</code> command palette (filtered to <code>/c</code>) over a clean collapsed-card transcript.</sub>
</p>

- **Real Shell, Right Where You Code** — Pop open an `xterm.js` PTY terminal in your project directory (or home directory before binding a workspace) straight from the composer. Resize, maximize, or minimize while keeping dev servers and test watchers running.
- **Inline Model Picker & `/` Command Palette** — Switch models and thinking levels directly from the composer (or via `/model` and `/thinking`), curate global model pickers via `/scoped-models`, run `/compact`, `/session`, `/copy`, or `/name`, adjust shell timeouts via `/timeout`, inspect `/pi-trim`, manage `/mcp` servers, and trigger `/skill:...` inline.
- **Thoughtful Desktop Craft** — Pick from three home canvases (**Tri-color grid**, **Dot pattern**, **Animated paths**) and **Blue** or **Black** accent themes, switch between **English** and **简体中文**, get background completion alerts (with optional sound), enable **Launch at login**, and stay up to date with signed in-app updates.

---

## Four Bundled Plugins

Each bundled extension fixes one concrete gap in bare Pi—without adding few-shots or prompt bias—pre-enabled by default and managed visually under **Settings → Global Pi extensions**:

<p align="center">
  <img src="assets/readme-plugins.png" width="100%" alt="Pi^n Settings showing Global Pi extensions with all four bundled plugins enabled by default (pi-trim locked, pi-continuity, pi-simple-timeout, and pi-better-web-search) and an opt-in external extension discovered from ~/.pi/agent under Available extensions">
  <br><sub>All four bundled plugins are active out of the box. External extensions discovered in <code>~/.pi/agent</code> appear as safe opt-in items under <strong>Available extensions</strong>.</sub>
</p>

| Plugin | Default | Gap in bare Pi | How Pi<sup>n</sup> solves it |
| --- | --- | --- | --- |
| **[`pi-trim`](https://github.com/zhexusun10/pi-trim)** | Always on | System prompt duplicates tool descriptions and loads Pi self-docs irrelevant to 99% of tasks | *"Less Pi in Pi."* Strips Pi's redundant tool-list prose and self-referential boilerplate (cutting Pi 1.5.0 default system text by **70.4%**) while keeping every tool schema, `<rules>`, and your instructions untouched. |
| **[`pi-continuity`](https://github.com/zhexusun10/pi-continuity)** | On | Output-limit truncations, dropped streams, and transient errors fail turns with no clean recovery | Resumes output-cap truncations, dropped streams, retry cooldowns, quota polling, empty replies, and dangling tool tails cleanly via Pi's public session boundaries—zero synthetic `"Continue"` prompts. |
| **[`pi-simple-timeout`](https://github.com/zhexusun10/pi-timeout)** | On | Models that omit timeouts can hang test suites or shell commands indefinitely | Enforces a sensible **180s** default timeout (live-adjustable via `/timeout`) on Pi's `bash` tool so stalled commands never wedge a run. |
| **[`pi-better-web-search`](https://github.com/zhexusun10/pi-better-web-search)** | On | Ships with no `web_search` tool for live docs, RFCs, or API lookups | Unified `web_search` + URL fetching across **Parallel, Keenable, Exa, Perplexity, and DeepSeek** with automatic fallback. Works free out of the box via **Keenable's public endpoint** and auto-switches once you add a private API key. |

> **100% Pi ecosystem compatible:** Auto-discovers `~/.pi/agent` extensions (opt-in in Settings), supports Pi's built-in **MCP** client (`mcp.json` / `.pi/mcp.json`, managed via `/mcp`), loads workspace and global **Skills** (`/skill:...`), and stays synced with `~/.pi/agent/models.json`.

---

## Compile Mode: Deterministic Multi-Agent Execution

> **No more lost in translation. No Supervisor in the Execution Loop. Deterministic.**

Most multi-agent frameworks trap execution inside a fragile chat loop where a "Supervisor LLM" summarizes instructions, messages sub-agents, and re-interprets replies. Every hop burns tokens, distorts technical constraints, and turns orchestration into guesswork.

**Pi<sup>n</sup> compiles the workflow out of the conversation.** Switch the composer from **Direct** to **Compile** whenever a goal splits cleanly into parallel tracks—such as schema migrations, API endpoints, background workers, frontend UI, and end-to-end verification.

<p align="center">
  <img src="assets/readme-graph.png" width="100%" alt="Pi^n Compile mode executing a 7-node, 4-batch full-stack billing & usage graph: completed schema migration and Stripe client, parallel billing API, React UI, and usage metering lanes, downstream E2E security audit with a purple dashed Feedback loop back to usage metering, and final docs & release node">
  <br><sub>A live 7-node, 4-batch full-stack execution graph: completed foundation (<code>01–02</code>), concurrent feature lanes (<code>03–05</code>), downstream E2E &amp; security verification (<code>06</code>) with a bounded purple <strong>Feedback</strong> loop back to <code>05_usage_metering</code>, and final release packaging (<code>07</code>).</sub>
</p>

```text
Coding goal
  │
  ├── Direct (default) ──→ Single Pi Agent (+ 4 bundled plugins) ──→ Your project
  │
  └── Compile (or Auto)
          │
          ▼
       Planner ──→ Execution Graph ──→ Rust Compiler ──→ Approval (Auto or Manual)
                                                               │
                                                               ▼
                                                   Deterministic Rust Runtime
                                                      ├── Pi Agent A ──┐
                                                      ├── Pi Agent B ──┼──→ Git Workspace Inheritance
                                                      └── Pi Agent C ──┘            │
                                                                                    ▼
                                                                            Downstream Agent(s)
                                                                                    │
                                                                                    ▼
                                                                           Atomic Publish to Project
                                                                                    │
                                                                                    ▼
                                                                       Post-task Planner Review (Loop)
```

1. **No More Lost in Translation** — Agents never communicate through lossy chat summaries. Downstream nodes inherit verifiable **Git commit history and full workspace state** (including `.gitignore` artifacts), starting from exact code and a clean context window.
2. **No Supervisor in the Execution Loop** — The Planner compiles the execution graph once, then steps out completely. No middle-manager LLM summarizing instructions, babysitting workers, or burning tokens between hops.
3. **Deterministic** — Dependency resolution, bounded concurrency (2–40 workers), adaptive workspace isolation (shared source for ≤3 nodes; macOS Seatbelt / Linux `bubblewrap` for larger waves), retries, invalidation, and atomic publication are all deterministic Rust state transitions.
4. **Autonomous Loops & Bounded Feedback** — **Auto Approve** and **Post-task Planner review** are on by default so the Planner inspects delivered code and drives follow-up iterations automatically. Turn on **Enable Feedback** to wire verification nodes back to upstream nodes with explicit retry budgets.
5. **Zero Hardcoded Role Theater** — Every node runs a full-capability Pi coding agent; specialization comes purely from its task objective and inherited repository state.

### Direct vs. Compile

| | Direct (Default) | Compile |
| --- | --- | --- |
| **Best for** | Everyday coding, bug fixes, tightly coupled changes | Parallel workstreams (DB + API + UI + workers + E2E tests) |
| **Agents** | Single upgraded Pi agent (+ 4 bundled plugins) | Multi-node execution graph (DAG + optional bounded feedback) |
| **Planning & approval** | Starts immediately | Compiled graph; Auto Approve & Post-task review on by default |
| **Workspace** | Direct in your project | Adaptive: shared source for ≤3 nodes; isolated workspaces for >3 |
| **Scheduling** | Sequential | Dependency-aware, bounded parallelism (2–40 workers) in Rust |

> **Tip:** Unlock bounded rework edges under **Settings → Compile mode settings → Enable Feedback**.

---

## Quick Start

### 1. Desktop App (Recommended — macOS & Windows)

Download the latest installer from **[GitHub Releases](https://github.com/zhexusun10/pi-n/releases/latest)** and verify its SHA-256 against `SHA256SUMS.txt`:

- **macOS (Apple Silicon):** `Pi-n_<version>_aarch64.dmg`
- **macOS (Intel):** `Pi-n_<version>_x64.dmg`
- **Windows (x64):** `Pi-n_<version>_x64-setup.exe` *(per-user NSIS installer)*

No separate Node.js, npm, Rust, or Git installation required—the bundle ships with the Rust backend, pinned Pi runtime, all four plugins, private Node.js `22.19.0`, and automatic SHA-256-verified portable Git bootstrap if host Git is missing.

<details>
<summary>Data directory, automatic migration &amp; signed in-app updates</summary>

- **Data storage:** Runtime state lives in your OS app-data directory (`~/Library/Application Support/io.github.zhexusun10.pi-n/data` on macOS; `%APPDATA%\io.github.zhexusun10.pi-n\data` on Windows); provider logins remain shared in `~/.pi-n/pi-agent`.
- **Automatic migration:** On first launch, any existing `.pi-n` store (or `PI_N_LEGACY_DATA_DIR`) is copied atomically under an exclusive lock, leaving the original directory intact.
- **In-app updates:** Signed releases update directly from **Settings → Software Update** (macOS swaps the app bundle in place and relaunches; Windows hands off to the signed NSIS installer). See the [updater capability matrix](docs/development/desktop-releases.md#updater--install-capability-matrix).

</details>

### 2. Prebuilt CLI / Browser Archive (macOS, Linux & Windows)

Download `pi-n-*.tar.gz` or `pi-n-windows-x64.zip` from [GitHub Releases](https://github.com/zhexusun10/pi-n/releases/latest), verify `SHA256SUMS.txt`, extract, and run `./start.sh` (macOS/Linux) or `start.bat` (Windows). *(Requires Node.js 22.19+ and Git on `PATH`.)*

### 3. Run or Build from Source

```sh
git clone --recurse-submodules https://github.com/zhexusun10/pi-n.git
cd pi-n
npm run dev
```

`npm run dev` verifies prerequisites, initializes the `pi/` submodule, installs locked dependencies, and builds the Rust backend *(for an existing clone, run `git submodule update --init --recursive` first)*.

- **Browser workbench:** Open <http://127.0.0.1:1420> in dev mode, or run `npm run build && npm start` and open <http://127.0.0.1:1421>.
- **Desktop dev (Tauri v2):** `npm run desktop:dev`
- **Build installers:** `npm run desktop:build` *(supports `--target macos-arm64`, `macos-x64`, or `windows-x64` on the matching OS)*.

### Your First 60 Seconds

1. **Bind & sign in** — Open **Settings** to pick a project folder, sign in to your model provider (OAuth browser/device flow, API key, or `npm run pi`), and choose your default `provider/model`.
2. **Code in Direct mode** — All four plugins are live from prompt one. Flip between detailed and minimalist views anytime, open **File changes** for inline diffs, or pop open the docked terminal.
3. **Scale to Compile mode** — Switch the composer to **Compile** for multi-stream work, steer any active agent with **`Option+S` / `Alt+S`**, and review published commits right in your repo.

<details>
<summary>System requirements &amp; platform isolation notes</summary>

- **Desktop installers:** Network access and model provider auth only.
- **Archives &amp; source builds:** Node.js 22.19+, Git, and npm; source builds also require stable Rust and native toolchains (macOS Xcode Command Line Tools; Windows MSVC Build Tools).
- **Workspace size &amp; isolation:** Direct mode and unisolated Compile runs have no workspace size limit; isolated Compile runs enforce a 15 GB guard (adjustable via subfolder or by disabling *Isolate parallel node workspaces*). macOS uses Seatbelt sandboxes and keeps the system awake while running (`PI_N_KEEP_AWAKE=0` to disable); Linux requires `bubblewrap` with unprivileged namespaces; Windows workspaces are not filesystem sandboxes.

</details>

---

## Documentation

| Guide | What it covers |
| --- | --- |
| **[User Guide](docs/user-guide.md)** | Everyday workflow, steering controls, slash commands, workspace isolation, and recovery |
| **[Desktop Releases & Secrets](docs/development/desktop-releases.md)** | Tauri v2 builds, installers, updater signing keys, macOS notarization, and release CI |
| **[Architecture Contracts](docs/architecture/overview.md)** | System boundaries, compiler rules, Rust runtime, and Git workspace handoffs |
| **[Benchmarks](docs/benchmarks/harbor.md)** | Harbor evaluation harness and benchmark methodology |
| **[Contributing](CONTRIBUTING.md)** & **[Testing](docs/development/testing.md)** | Development setup, ownership boundaries, and targeted test suites |
| **[Docs Index](docs/index.md)** & **[Security](SECURITY.md)** | Full documentation map, agent rules ([AGENTS.md](AGENTS.md)), and vulnerability reporting |

## References

- Pan, M. Z., Yang, S., Arabzadeh, N., Chiang, W.-L., Stoica, I., & Zaharia, M. (2026). *Coding Agents Harness Tax* (*HarnessTax: How Much Does Harness Matter for Coding Agents?*). Arena.ai. <https://arena.ai/blog/coding-agents-harness-tax>
- Li, Y., Zhou, Y., Teng, Y. L., Yang, F., Deng, Y., Lyu, Z., Dong, X., Chen, F., & An, B. (2026). *Finding the Right Fit: Model-Harness Interactions across Agent Tasks*. arXiv:2610.00917v1. <https://arxiv.org/html/2610.00917v1>

## License

Original Pi<sup>n</sup> code is licensed under the [MIT License](LICENSE), copyright © 2026 Sun Zhe-xu. The upstream `pi/` submodule is governed by its own [MIT license](pi/LICENSE). Bundled plugins and third-party dependencies retain their respective licenses.
