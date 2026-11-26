// Capture the real Pi^n frontend with synthetic API data; no backend or credentials required.
// Run from the repository root with Playwright Chromium (Edge on Windows),
// or select an installed browser with PI_N_BROWSER_CHANNEL.
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';

const repository = '/demo/video-forensics';
const config = {
  repository,
  model: 'anthropic/claude-sonnet-4-5',
  thinkingLevel: 'medium',
  maxParallel: 8,
  isolateParallelNodes: true,
  maxFeedback: 2,
  feedbackEnabled: true,
  autoApprove: true,
  postTaskReview: true,
  plannerWriteTools: true,
};
const empty = {
  runId: '',
  config: null,
  graph: { originalGoal: '', nodes: [], edges: [] },
  nodes: {},
  plan: null,
  executions: [],
  events: [],
  approved: false,
  paused: false,
  phase: 'draft',
  base: '',
  feedbackCounts: {},
};
const repoInfo = { path: repository, name: 'video-forensics', branch: 'main', head: '', clean: true };

/** Render crisp, retina-ready PNG validation plots in headless Chromium for MarkdownImageStack. */
async function renderChartPngs(browser, zh) {
  const ctx = await browser.newContext({
    viewport: { width: 640, height: 300 },
    deviceScaleFactor: 2,
    locale: zh ? 'zh-CN' : 'en-US',
  });
  const page = await ctx.newPage();

  const fontStack = zh
    ? "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif"
    : "-apple-system, BlinkMacSystemFont, 'Inter', 'SF Pro Display', system-ui, sans-serif";

  const makeDoc = (svg) => `<!doctype html><html><body style="margin:0;background:#ffffff;font-family:${fontStack};">${svg}</body></html>`;

  const crfSvg = `
<svg xmlns="http://www.w3.org/2000/svg" width="640" height="300" viewBox="0 0 640 300">
  <rect width="640" height="300" fill="#ffffff"/>
  <text x="34" y="34" font-size="16.5" font-weight="600" fill="#0f172a">${zh ? 'H.264 压缩鲁棒性：频域分支 AUROC' : 'H.264 Compression Robustness — Freq Branch AUROC'}</text>
  <text x="34" y="54" font-size="12" fill="#64748b">${zh ? '验证集按来源分组切片（n = 4,800）· CRF 28 提升 +3.8%' : 'Source-grouped val split (n = 4,800) · +3.8% gain at CRF 28'}</text>

  <!-- Legend -->
  <g transform="translate(34, 68)">
    <line x1="0" y1="6" x2="18" y2="6" stroke="#2563eb" stroke-width="3" stroke-linecap="round"/>
    <circle cx="9" cy="6" r="3.5" fill="#2563eb"/>
    <text x="26" y="10" font-size="11.5" font-weight="500" fill="#0f172a">${zh ? '自适应 CRF 增强（新）' : 'Adaptive CRF Augment (new)'}</text>
    <line x1="204" y1="6" x2="222" y2="6" stroke="#94a3b8" stroke-width="2.5" stroke-dasharray="5 4" stroke-linecap="round"/>
    <text x="230" y="10" font-size="11.5" fill="#64748b">${zh ? '基线模型' : 'Baseline'}</text>
  </g>

  <!-- Plot grid -->
  <g stroke="#e2e8f0" stroke-width="1">
    <line x1="72" y1="96" x2="598" y2="96"/>
    <line x1="72" y1="136" x2="598" y2="136"/>
    <line x1="72" y1="176" x2="598" y2="176"/>
    <line x1="72" y1="216" x2="598" y2="216"/>
    <line x1="72" y1="256" x2="598" y2="256" stroke="#cbd5e1"/>
  </g>

  <!-- Y axis labels -->
  <g font-size="11" fill="#64748b" text-anchor="end">
    <text x="62" y="100">1.00</text>
    <text x="62" y="140">0.95</text>
    <text x="62" y="180">0.90</text>
    <text x="62" y="220">0.85</text>
    <text x="62" y="260">0.80</text>
  </g>

  <!-- X axis labels -->
  <g font-size="11" fill="#64748b" text-anchor="middle">
    <text x="94" y="276">Raw</text>
    <text x="214" y="276">CRF 18</text>
    <text x="334" y="276">CRF 23</text>
    <text x="454" y="276" font-weight="600" fill="#0f172a">CRF 28</text>
    <text x="574" y="276">CRF 32</text>
  </g>

  <!-- Highlight column at CRF 28 -->
  <rect x="432" y="92" width="44" height="164" rx="6" fill="#eff6ff" opacity="0.88"/>

  <!-- Shaded area under new curve -->
  <path d="M 94 115 L 214 121 L 334 130 L 454 142 L 574 162 L 574 256 L 94 256 Z" fill="url(#blueGrad)"/>
  <defs>
    <linearGradient id="blueGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#2563eb" stop-opacity="0.14"/>
      <stop offset="100%" stop-color="#2563eb" stop-opacity="0.01"/>
    </linearGradient>
  </defs>

  <!-- Baseline curve -->
  <polyline fill="none" stroke="#94a3b8" stroke-width="2.4" stroke-dasharray="6 4" points="94,119 214,132 334,151 454,173 574,210"/>
  <g fill="#ffffff" stroke="#94a3b8" stroke-width="2">
    <circle cx="94" cy="119" r="3.8"/>
    <circle cx="214" cy="132" r="3.8"/>
    <circle cx="334" cy="151" r="3.8"/>
    <circle cx="454" cy="173" r="3.8"/>
    <circle cx="574" cy="210" r="3.8"/>
  </g>

  <!-- New adaptive curve -->
  <polyline fill="none" stroke="#2563eb" stroke-width="2.8" stroke-linejoin="round" points="94,115 214,121 334,130 454,142 574,162"/>
  <g fill="#2563eb" stroke="#ffffff" stroke-width="2">
    <circle cx="94" cy="115" r="4.6"/>
    <circle cx="214" cy="121" r="4.6"/>
    <circle cx="334" cy="130" r="4.6"/>
    <circle cx="454" cy="142" r="5.5"/>
    <circle cx="574" cy="162" r="4.6"/>
  </g>

  <!-- Delta callout at CRF 28 -->
  <line x1="454" y1="148" x2="454" y2="168" stroke="#16a34a" stroke-width="2" stroke-dasharray="3 2"/>
  <rect x="468" y="114" width="114" height="42" rx="8" fill="#ffffff" stroke="#bfdbfe" stroke-width="1.2"/>
  <text x="478" y="131" font-size="11.5" font-weight="700" fill="#1d4ed8">0.942 AUROC</text>
  <text x="478" y="147" font-size="10.5" font-weight="600" fill="#16a34a">+3.8% vs 0.904</text>
</svg>`;

  const rocSvg = `
<svg xmlns="http://www.w3.org/2000/svg" width="640" height="300" viewBox="0 0 640 300">
  <rect width="640" height="300" fill="#ffffff"/>
  <text x="34" y="34" font-size="16.5" font-weight="600" fill="#0f172a">${zh ? 'CRF 28 验证集 ROC 曲线' : 'CRF 28 Validation ROC Curve'}</text>
  <text x="34" y="54" font-size="12" fill="#64748b">${zh ? '2D-FFT 径向频谱 + 小波高频残差特征' : '2D-FFT radial spectrum + wavelet high-frequency residuals'}</text>
  <g stroke="#e2e8f0" stroke-width="1">
    <line x1="72" y1="84" x2="598" y2="84"/>
    <line x1="72" y1="128" x2="598" y2="128"/>
    <line x1="72" y1="172" x2="598" y2="172"/>
    <line x1="72" y1="216" x2="598" y2="216"/>
    <line x1="72" y1="260" x2="598" y2="260" stroke="#cbd5e1"/>
  </g>
  <line x1="72" y1="260" x2="598" y2="84" stroke="#cbd5e1" stroke-width="1.5" stroke-dasharray="5 5"/>
  <path d="M 72 260 C 86 150, 124 98, 206 90 C 310 84, 460 84, 598 84 L 598 260 Z" fill="#2563eb" fill-opacity="0.1"/>
  <path d="M 72 260 C 86 150, 124 98, 206 90 C 310 84, 460 84, 598 84" fill="none" stroke="#2563eb" stroke-width="2.8"/>
  <path d="M 72 260 C 106 180, 166 126, 258 106 C 370 90, 480 86, 598 84" fill="none" stroke="#f97316" stroke-width="2.2" stroke-dasharray="5 4"/>
  <rect x="374" y="182" width="204" height="62" rx="10" fill="#f8fafc" stroke="#e2e8f0"/>
  <text x="390" y="207" font-size="12.5" font-weight="600" fill="#1d4ed8">Adaptive Augment: 0.942</text>
  <text x="390" y="230" font-size="12" fill="#ea580c">Baseline (CRF 23): 0.904</text>
</svg>`;

  const calSvg = `
<svg xmlns="http://www.w3.org/2000/svg" width="640" height="300" viewBox="0 0 640 300">
  <rect width="640" height="300" fill="#ffffff"/>
  <text x="34" y="34" font-size="16.5" font-weight="600" fill="#0f172a">${zh ? '温度缩放后置信度校准曲线' : 'Post-Temperature Scaling Calibration'}</text>
  <text x="34" y="54" font-size="12" fill="#64748b">${zh ? 'ECE 从 0.061 降至 0.019（10 等宽分箱）' : 'ECE reduced from 0.061 to 0.019 across 10 bins'}</text>
  <g stroke="#e2e8f0" stroke-width="1">
    <line x1="72" y1="84" x2="598" y2="84"/>
    <line x1="72" y1="128" x2="598" y2="128"/>
    <line x1="72" y1="172" x2="598" y2="172"/>
    <line x1="72" y1="216" x2="598" y2="216"/>
    <line x1="72" y1="260" x2="598" y2="260" stroke="#cbd5e1"/>
  </g>
  <line x1="72" y1="260" x2="598" y2="84" stroke="#94a3b8" stroke-width="1.5" stroke-dasharray="5 5"/>
  <polyline fill="none" stroke="#16a34a" stroke-width="2.8" points="98,250 150,232 202,214 254,196 306,176 358,158 410,138 462,120 514,102 566,88"/>
  <g fill="#16a34a" stroke="#ffffff" stroke-width="2">
    <circle cx="98" cy="250" r="4"/><circle cx="150" cy="232" r="4"/><circle cx="202" cy="214" r="4"/>
    <circle cx="254" cy="196" r="4"/><circle cx="306" cy="176" r="4"/><circle cx="358" cy="158" r="4"/>
    <circle cx="410" cy="138" r="4"/><circle cx="462" cy="120" r="4"/><circle cx="514" cy="102" r="4"/>
    <circle cx="566" cy="88" r="4"/>
  </g>
</svg>`;

  const charts = {};
  for (const [key, svg] of [
    ['plots/crf_robustness.png', crfSvg],
    ['plots/freq_roc.png', rocSvg],
    ['plots/calibration.png', calSvg],
  ]) {
    await page.setContent(makeDoc(svg), { waitUntil: 'load' });
    charts[key] = await page.screenshot({ type: 'png' });
  }
  await ctx.close();
  return charts;
}

const server = await createServer({
  cacheDir: 'node_modules/.vite-readme-capture',
  server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, open: false },
});

let browser;
try {
  await server.listen();
  browser = await chromium.launch({
    channel: process.env.PI_N_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : 'chromium'),
    headless: true,
  });

  for (const lang of ['en', 'zh-CN']) {
    const zh = lang === 'zh-CN';
    const chartPngs = await renderChartPngs(browser, zh);

    const minimalTitle = zh ? '频域分支 CRF 鲁棒性校准' : 'Frequency branch CRF calibration';
    const directTitle = zh ? '压缩鲁棒性增强与重试回退' : 'H.264 compression augmentation & retry';
    const graphTitle = zh ? 'AI 视频检测工程流水线' : 'AI video detection pipeline';

    const landingGoal = zh
      ? '为 src/forensics/augment.py 补充自适应 H.264 压缩数据增强，查阅最新 PyAV 编码器参数文档，添加带抖动的指数退避重试，并用 pytest 验证频域检测分支在 CRF 28 下的 AUROC。'
      : 'Add adaptive H.264 compression augmentation in src/forensics/augment.py. Check current PyAV codec flags, add jittered retry backoff for batch transcode workers, and verify frequency-branch AUROC at CRF 28 with pytest.';

    const minimalGoal = zh
      ? '修复频域分支在 CRF 28 下的 AUROC 退化，补充校准并绘制验证曲线。'
      : 'Fix the CRF 28 frequency-branch AUROC drop, calibrate logits, and plot val curves.';

    const graphGoal = zh
      ? '在 src/forensics/ 中构建可复现的 AI 生成视频检测流水线：先并行搭建工程脚手架与防泄漏数据集划分，再并行训练空间、时序与频域三条分支，完成验证集鲁棒性审计（带频域有界反馈回路）后执行留出集评估与 CLI 打包。'
      : 'Build a reproducible AI-generated video detection pipeline in src/forensics/. Scaffold the package and leakage-safe splits, train spatial, temporal, and frequency branches in parallel, run val robustness checks with bounded frequency feedback, then run holdout eval and package the CLI.';

    // -------------------------------------------------------------------------
    // 1) Minimalist (collapsed-cards) fixture: 6 tool calls + thinking collapsed
    //    into a single whisper-quiet ActivitySummaryRow, concise prose, and a
    //    3-card MarkdownImageStack of validation plots — all fitting above the
    //    composer with `Expand cards` / `展开卡片` cleanly visible.
    // -------------------------------------------------------------------------
    const minimalSummary = zh
      ? '已将 `augment.py` 切换为随机 `CRF 23–32` 自适应增强并完成温度缩放校准：CRF 28 AUROC 由 **0.904 → 0.942**（`+3.8%`），`ECE` 降至 **`0.019`**，`pytest` **14 / 14** 全部通过。\n\n![H.264 压缩鲁棒性曲线](plots/crf_robustness.png) ![CRF 28 ROC 曲线](plots/freq_roc.png) ![温度缩放校准曲线](plots/calibration.png)'
      : 'Switched `augment.py` to seeded `CRF 23–32` augmentation with temperature scaling: CRF 28 AUROC rose **0.904 → 0.942** (`+3.8%`), `ECE` dropped to **`0.019`**, and `pytest` passed **14 / 14**.\n\n![AUROC vs. H.264 CRF](plots/crf_robustness.png) ![CRF 28 ROC Curve](plots/freq_roc.png) ![Calibration Curve](plots/calibration.png)';

    const minimalEvents = [
      {
        type: 'message_end',
        message: { role: 'assistant', content: [{ type: 'thinking', thinking: zh ? '先阅读 augment.py 与 freq_branch.py，核对 PyAV libx264 参数并实现自适应压缩增强。' : 'Inspect augment.py and freq_branch.py, verify PyAV libx264 options, and add adaptive CRF augmentation.' }] },
      },
      {
        type: 'tool_execution_start',
        toolCallId: 'min-read-1',
        toolName: 'read',
        args: { path: 'src/forensics/augment.py' },
      },
      {
        type: 'tool_execution_end',
        toolCallId: 'min-read-1',
        toolName: 'read',
        isError: false,
        durationMs: 22,
        result: { content: [{ type: 'text', text: 'DEFAULT_CRF = 23\nclass SpatialAugment: ...' }] },
      },
      {
        type: 'tool_execution_start',
        toolCallId: 'min-read-2',
        toolName: 'read',
        args: { path: 'src/forensics/freq_branch.py' },
      },
      {
        type: 'tool_execution_end',
        toolCallId: 'min-read-2',
        toolName: 'read',
        isError: false,
        durationMs: 18,
        result: { content: [{ type: 'text', text: 'class SpectralDetector(nn.Module): ...' }] },
      },
      {
        type: 'tool_execution_start',
        toolCallId: 'min-web',
        toolName: 'web_search',
        args: { query: 'PyAV libx264 crf preset options' },
      },
      {
        type: 'tool_execution_end',
        toolCallId: 'min-web',
        toolName: 'web_search',
        isError: false,
        durationMs: 520,
        result: { content: [{ type: 'text', text: 'PyAV add_stream("libx264") accepts stream.options = {"crf": str(crf), "preset": "veryfast"}.' }] },
      },
      {
        type: 'tool_execution_start',
        toolCallId: 'min-edit-1',
        toolName: 'edit',
        args: { path: 'src/forensics/augment.py', oldText: 'DEFAULT_CRF = 23', newText: 'DEFAULT_CRF_RANGE = (23, 32)' },
      },
      {
        type: 'tool_execution_end',
        toolCallId: 'min-edit-1',
        toolName: 'edit',
        isError: false,
        durationMs: 31,
        result: { content: [{ type: 'text', text: 'Updated src/forensics/augment.py' }] },
      },
      {
        type: 'tool_execution_start',
        toolCallId: 'min-edit-2',
        toolName: 'edit',
        args: { path: 'src/forensics/calibrate.py', oldText: 'temperature = 1.0', newText: 'temperature = fit_nll_temperature(val_logits, val_labels)' },
      },
      {
        type: 'tool_execution_end',
        toolCallId: 'min-edit-2',
        toolName: 'edit',
        isError: false,
        durationMs: 28,
        result: { content: [{ type: 'text', text: 'Updated src/forensics/calibrate.py' }] },
      },
      {
        type: 'tool_execution_start',
        toolCallId: 'min-bash',
        toolName: 'bash',
        args: { command: 'pytest tests/test_augment.py -q && python scripts/eval_crf.py --plot' },
      },
      {
        type: 'tool_execution_end',
        toolCallId: 'min-bash',
        toolName: 'bash',
        isError: false,
        durationMs: 1840,
        result: {
          content: [{ type: 'text', text: '14 passed in 1.42s\nSaved plots/crf_robustness.png, plots/freq_roc.png, plots/calibration.png' }],
          details: { exitCode: 0 },
        },
      },
      {
        type: 'message_end',
        message: { role: 'assistant', content: [{ type: 'text', text: minimalSummary }] },
      },
    ];
    const minimalOutput = minimalEvents.map(item => JSON.stringify(item)).join('\n') + '\n';
    const minimalOutputBytes = Buffer.byteLength(minimalOutput);

    const minimalFileChanges = {
      files: [
        { path: 'src/forensics/augment.py', status: 'modified', additions: 34, deletions: 7, nodes: ['task'], executionIds: ['exec-min-1'], source: 'edit' },
        { path: 'src/forensics/calibrate.py', status: 'modified', additions: 19, deletions: 3, nodes: ['task'], executionIds: ['exec-min-1'], source: 'edit' },
      ],
      totalFiles: 2,
      addedCount: 0,
      modifiedCount: 2,
      deletedCount: 0,
      renamedCount: 0,
      totalAdditions: 53,
      totalDeletions: 10,
    };

    const minimalSnapshot = {
      ...empty,
      runId: 'demo-minimal',
      title: minimalTitle,
      config,
      planType: 'serial',
      approved: true,
      paused: false,
      phase: 'completed',
      graph: {
        originalGoal: minimalGoal,
        nodes: [{ id: 'task', task: minimalGoal }],
        edges: [],
      },
      nodes: {
        task: { status: 'completed', revision: 1, head: 'c8f10a2', instruction: '', error: null },
      },
      executions: [
        {
          id: 'exec-min-1',
          node: 'task',
          revision: 1,
          attempt: 1,
          sessionId: 'demo-min-session',
          worktree: repository,
          before: '8d1e40b',
          after: 'c8f10a2',
          workspaceLineage: [],
          input: { instruction: minimalGoal },
          result: { summary: minimalSummary },
          status: 'completed',
          startedAt: 1764000100000,
          completedAt: 1764000138400,
          output: '',
          outputBytes: minimalOutputBytes,
          pid: null,
          metrics: {
            model: config.model,
            durationSeconds: 38.4,
            assistantMessages: 2,
            tools: 6,
            toolErrors: 0,
            usage: { input: 24100, output: 2480, cacheRead: 16800, cacheWrite: 0, reasoning: 820, totalTokens: 44200 },
          },
          fileChanges: minimalFileChanges,
        },
      ],
      fileChanges: minimalFileChanges,
      events: [{ sequence: 1, timestamp: 1, type: 'created' }],
    };

    // -------------------------------------------------------------------------
    // 2) Direct (detailed card mode + inline diff inspector) fixture:
    //    short non-truncating tool headers, Compacted card, and inline diff.
    // -------------------------------------------------------------------------
    const directThinking = zh
      ? '先查阅 PyAV 最新 libx264 编码选项确认 `crf` 与 `preset` 传参规范，随后更新 `src/forensics/augment.py` 补充随机 CRF 压缩与指数退避重试逻辑，最后运行 `pytest` 回归测试确认全部用例通过。'
      : 'Check current PyAV `libx264` option handling for `crf` and `preset`, update `src/forensics/augment.py` with deterministic-seeded CRF augmentation and jittered retry backoff, then run `pytest` to verify the suite.';

    const directSearchOutput = JSON.stringify({
      provider: 'keenable',
      results: [
        {
          title: 'PyAV VideoStream.options — libx264 CRF & preset flags',
          url: 'https://pyav.basswood-io.com/docs/stable/api/video.html',
          snippet: 'Pass options={"crf": str(crf), "preset": "veryfast"} on add_stream("libx264") before encoding frames.',
        },
      ],
    }, null, 2);

    const directCompactionSummary = zh
      ? '已完成 `src/forensics/augment.py` 与 `tests/test_augment.py` 的代码研读与 PyAV 文档检索；保留已修改的压缩增强与重试模块以执行最终回归验证。'
      : 'Completed inspection of `src/forensics/augment.py` and `tests/test_augment.py`, verified PyAV libx264 flags via web search, and retained modified augmentation and retry modules for final test verification.';

    const directSummary = zh
      ? '已完成自适应 H.264 压缩增强与重试回退，并全部通过回归测试：\n\n- **自适应压缩管线（`src/forensics/augment.py`）**：新增 `H264CompressionAugment`，按可复现随机种子采样 `CRF ∈ [23, 32]`，通过 PyAV `libx264` 在内存缓冲区完成转码。\n- **抖动退避重试（`src/forensics/retry.py`）**：为批量转码 Worker 增加 `retry_with_backoff` 装饰器，处理瞬时解码超时与 I/O 抖动。\n- **验证结果（`tests/test_augment.py`）**：`pytest -q` **14 / 14** 全部通过，CRF 28 验证切片 AUROC 稳定在 **0.942**（+3.8%）。'
      : 'Implemented adaptive H.264 compression augmentation and jittered retry backoff — all checks pass:\n\n- **Adaptive compression (`src/forensics/augment.py`)**: Added `H264CompressionAugment` with deterministic seed sampling across `CRF 23–32` using in-memory PyAV `libx264` transcoding.\n- **Retry backoff (`src/forensics/retry.py`)**: Added bounded exponential backoff with jitter for batch transcode workers.\n- **Verification (`tests/test_augment.py`)**: `pytest -q` passed **14 / 14** tests; val AUROC at CRF 28 improved to **0.942** (+3.8%).';

    const directEvents = [
      {
        type: 'message_end',
        message: { role: 'assistant', content: [{ type: 'thinking', thinking: directThinking }] },
      },
      {
        type: 'tool_execution_start',
        toolCallId: 'direct-web-search',
        toolName: 'web_search',
        args: { query: 'PyAV libx264 crf preset options' },
      },
      {
        type: 'tool_execution_end',
        toolCallId: 'direct-web-search',
        toolName: 'web_search',
        isError: false,
        durationMs: 640,
        result: { content: [{ type: 'text', text: directSearchOutput }] },
      },
      {
        type: 'tool_execution_start',
        toolCallId: 'direct-edit-augment',
        toolName: 'edit',
        args: { path: 'src/forensics/augment.py', oldText: 'class SpatialAugment:', newText: 'class H264CompressionAugment:' },
      },
      {
        type: 'tool_execution_end',
        toolCallId: 'direct-edit-augment',
        toolName: 'edit',
        isError: false,
        durationMs: 38,
        result: { content: [{ type: 'text', text: 'Successfully replaced lines 18–56 in src/forensics/augment.py' }] },
      },
      {
        type: 'compaction',
        reason: 'threshold',
        tokensBefore: 118400,
        estimatedTokensAfter: 16200,
        summary: directCompactionSummary,
        details: {
          modifiedFiles: ['src/forensics/augment.py', 'src/forensics/retry.py', 'tests/test_augment.py'],
          readFiles: ['configs/dataset.yaml', 'src/forensics/freq_branch.py'],
        },
      },
      {
        type: 'tool_execution_start',
        toolCallId: 'direct-pytest',
        toolName: 'bash',
        args: { command: 'pytest tests/test_augment.py -q' },
      },
      {
        type: 'tool_execution_end',
        toolCallId: 'direct-pytest',
        toolName: 'bash',
        isError: false,
        durationMs: 1420,
        result: {
          content: [{ type: 'text', text: '..............                                                           [100%]\n14 passed in 1.42s' }],
          details: { exitCode: 0 },
        },
      },
      {
        type: 'message_end',
        message: { role: 'assistant', content: [{ type: 'text', text: directSummary }] },
      },
    ];
    const directOutput = directEvents.map(item => JSON.stringify(item)).join('\n') + '\n';
    const directOutputBytes = Buffer.byteLength(directOutput);

    const directFileChanges = {
      files: [
        {
          path: 'src/forensics/augment.py',
          status: 'modified',
          additions: 34,
          deletions: 7,
          nodes: ['task'],
          executionIds: ['exec-direct-1'],
          source: 'edit',
        },
        {
          path: 'src/forensics/retry.py',
          status: 'added',
          additions: 22,
          deletions: 0,
          nodes: ['task'],
          executionIds: ['exec-direct-1'],
          source: 'write',
        },
        {
          path: 'tests/test_augment.py',
          status: 'modified',
          additions: 18,
          deletions: 4,
          nodes: ['task'],
          executionIds: ['exec-direct-1'],
          source: 'edit',
        },
      ],
      totalFiles: 3,
      addedCount: 1,
      modifiedCount: 2,
      deletedCount: 0,
      renamedCount: 0,
      totalAdditions: 74,
      totalDeletions: 11,
    };

    const directDiffs = {
      'src/forensics/augment.py': {
        runId: 'demo-direct',
        path: 'src/forensics/augment.py',
        oldPath: null,
        binary: false,
        truncated: false,
        hiddenLines: 0,
        lines: [
          { kind: 'hunk', text: '@@ -16,11 +16,32 @@ from dataclasses import dataclass' },
          { kind: 'context', text: 'import io' },
          { kind: 'context', text: 'import random' },
          { kind: 'added', text: 'import av' },
          { kind: 'added', text: 'from .retry import retry_with_backoff' },
          { kind: 'context', text: '' },
          { kind: 'removed', text: 'DEFAULT_CRF = 23' },
          { kind: 'added', text: 'DEFAULT_CRF_RANGE = (23, 32)' },
          { kind: 'context', text: '' },
          { kind: 'added', text: '@dataclass(frozen=True)' },
          { kind: 'added', text: 'class H264CompressionAugment:' },
          { kind: 'added', text: '    crf_range: tuple[int, int] = DEFAULT_CRF_RANGE' },
          { kind: 'added', text: '    preset: str = "veryfast"' },
          { kind: 'added', text: '    seed: int = 42' },
          { kind: 'added', text: '' },
          { kind: 'added', text: '    @retry_with_backoff(max_attempts=3, base_delay=0.15)' },
          { kind: 'added', text: '    def __call__(self, frames: list, clip_index: int = 0) -> list:' },
          { kind: 'added', text: '        rng = random.Random(self.seed + clip_index)' },
          { kind: 'added', text: '        crf = rng.randint(*self.crf_range)' },
          { kind: 'added', text: '        buf = io.BytesIO()' },
          { kind: 'added', text: '        with av.open(buf, mode="w", format="mp4") as out:' },
          { kind: 'added', text: '            stream = out.add_stream("libx264", rate=24)' },
          { kind: 'added', text: '            stream.options = {"crf": str(crf), "preset": self.preset}' },
          { kind: 'added', text: '            for frame in frames:' },
          { kind: 'added', text: '                for packet in stream.encode(frame):' },
          { kind: 'added', text: '                    out.mux(packet)' },
          { kind: 'added', text: '            for packet in stream.encode():' },
          { kind: 'added', text: '                out.mux(packet)' },
          { kind: 'added', text: '        return decode_frames_from_buffer(buf.getvalue())' },
        ],
      },
      'src/forensics/retry.py': {
        runId: 'demo-direct',
        path: 'src/forensics/retry.py',
        oldPath: null,
        binary: false,
        truncated: false,
        hiddenLines: 0,
        lines: [
          { kind: 'hunk', text: '@@ -0,0 +1,22 @@' },
          { kind: 'added', text: 'import random' },
          { kind: 'added', text: 'import time' },
          { kind: 'added', text: 'from functools import wraps' },
          { kind: 'added', text: '' },
          { kind: 'added', text: 'def retry_with_backoff(max_attempts: int = 3, base_delay: float = 0.2):' },
          { kind: 'added', text: '    def decorator(fn):' },
          { kind: 'added', text: '        @wraps(fn)' },
          { kind: 'added', text: '        def wrapped(*args, **kwargs):' },
          { kind: 'added', text: '            for attempt in range(max_attempts):' },
          { kind: 'added', text: '                try:' },
          { kind: 'added', text: '                    return fn(*args, **kwargs)' },
          { kind: 'added', text: '                except TimeoutError:' },
          { kind: 'added', text: '                    if attempt + 1 >= max_attempts:' },
          { kind: 'added', text: '                        raise' },
          { kind: 'added', text: '                    jitter = random.uniform(0.0, base_delay)' },
          { kind: 'added', text: '                    time.sleep(base_delay * (2 ** attempt) + jitter)' },
          { kind: 'added', text: '        return wrapped' },
          { kind: 'added', text: '    return decorator' },
        ],
      },
      'tests/test_augment.py': {
        runId: 'demo-direct',
        path: 'tests/test_augment.py',
        oldPath: null,
        binary: false,
        truncated: false,
        hiddenLines: 0,
        lines: [
          { kind: 'hunk', text: '@@ -22,6 +22,20 @@ def test_spatial_augment_preserves_shape():' },
          { kind: 'added', text: 'def test_h264_compression_augment_deterministic_seed():' },
          { kind: 'added', text: '    aug = H264CompressionAugment(crf_range=(24, 30), seed=7)' },
          { kind: 'added', text: '    out_a = aug(sample_frames(), clip_index=3)' },
          { kind: 'added', text: '    out_b = aug(sample_frames(), clip_index=3)' },
          { kind: 'added', text: '    assert len(out_a) == len(out_b) == 8' },
          { kind: 'added', text: '    assert frame_psnr(out_a[0], out_b[0]) == float("inf")' },
        ],
      },
    };

    const directSnapshot = {
      ...empty,
      runId: 'demo-direct',
      title: directTitle,
      config,
      planType: 'serial',
      approved: true,
      paused: false,
      phase: 'completed',
      graph: {
        originalGoal: landingGoal,
        nodes: [{ id: 'task', task: landingGoal }],
        edges: [],
      },
      nodes: {
        task: { status: 'completed', revision: 1, head: 'a4c9f21', instruction: '', error: null },
      },
      executions: [
        {
          id: 'exec-direct-1',
          node: 'task',
          revision: 1,
          attempt: 1,
          sessionId: 'demo-direct-session',
          worktree: repository,
          before: '8d1e40b',
          after: 'a4c9f21',
          workspaceLineage: [],
          input: { instruction: landingGoal },
          result: { summary: directSummary },
          status: 'completed',
          startedAt: 1764000000000,
          completedAt: 1764000042800,
          output: '',
          outputBytes: directOutputBytes,
          pid: null,
          metrics: {
            model: config.model,
            durationSeconds: 42.8,
            assistantMessages: 2,
            tools: 3,
            toolErrors: 0,
            usage: { input: 28400, output: 3120, cacheRead: 19200, cacheWrite: 0, reasoning: 980, totalTokens: 51700 },
          },
          fileChanges: directFileChanges,
        },
      ],
      fileChanges: directFileChanges,
      events: [{ sequence: 1, timestamp: 1, type: 'created' }],
    };

    // -------------------------------------------------------------------------
    // 3) Compile (multi-agent graph) fixture: crisp, high-legibility 7-node,
    //    4-batch active execution graph with Completed + Running + Waiting
    //    lanes and a bounded Execution feedback loop.
    // -------------------------------------------------------------------------
    const nodeSpecs = [
      [
        '01_package_scaffold',
        'Scaffold src/forensics/ package, YAML config schema, dataset loaders, and base pytest suite.',
        '搭建 src/forensics/ 包结构、YAML 配置规范、数据加载器与基础 pytest 测试套件。',
        'completed',
      ],
      [
        '02_data_audit_splits',
        'Deduplicate manifests, freeze source-grouped train/val/test splits, and enforce leakage tests.',
        '清洗去重样本清单，按来源分组冻结 train/val/test 划分并编写防泄漏校验测试。',
        'completed',
      ],
      [
        '03_spatial_branch',
        'Build RGB & noise-residual feature pipeline, train spatial CNN on train, and calibrate val logits.',
        '实现 RGB 与噪声残差管线，在训练集训练空间 CNN 并在验证集完成概率校准。',
        'completed',
      ],
      [
        '04_temporal_branch',
        'Extract optical-flow & flicker consistency signals and train compact GRU detector on train.',
        '提取光流与帧间闪烁一致性特征，在训练集训练轻量 GRU 时序检测器并记录验证指标。',
        'running',
      ],
      [
        '05_freq_branch',
        'Build 2D-FFT radial & wavelet extractors and train spectral detector with CRF augmentations.',
        '构建 2D-FFT 径向频谱与小波提取器，结合自适应 CRF 增强训练频域检测模型。',
        'running',
      ],
      [
        '06_val_robustness',
        'Stress-test branches under H.264 CRF & blur on val; send <FEEDBACK> to 05_freq_branch if AUROC drops >5%.',
        '在验证集执行 H.264 压缩与模糊压测；若 AUROC 降幅 >5% 则向 05_freq_branch 发送 <FEEDBACK>。',
        'waiting',
      ],
      [
        '07_holdout_and_cli',
        'Freeze fusion weights, run locked test eval, export ONNX/CLI bundle, and write MODEL_CARD.md.',
        '冻结融合权重，执行单次留出测试集评估，导出 ONNX 与 CLI 工具并生成 MODEL_CARD.md。',
        'waiting',
      ],
    ];

    const nodes = nodeSpecs.map(([id, en, cn]) => ({ id, task: zh ? cn : en }));
    const names = nodes.map(node => node.id);
    assert.equal(new Set(names).size, 7, 'demo node names must be unique');

    const dependencies = [
      ['01_package_scaffold', '03_spatial_branch'],
      ['02_data_audit_splits', '03_spatial_branch'],
      ['01_package_scaffold', '04_temporal_branch'],
      ['02_data_audit_splits', '04_temporal_branch'],
      ['01_package_scaffold', '05_freq_branch'],
      ['02_data_audit_splits', '05_freq_branch'],
      ['03_spatial_branch', '06_val_robustness'],
      ['04_temporal_branch', '06_val_robustness'],
      ['05_freq_branch', '06_val_robustness'],
      ['06_val_robustness', '07_holdout_and_cli'],
    ].map(([from, to]) => ({ from, to, feedback: false }));

    const edges = [...dependencies, { from: '06_val_robustness', to: '05_freq_branch', feedback: true }];
    assert.equal(edges.length, 11);
    assert.equal(new Set(edges.map(edge => `${edge.from}:${edge.to}`)).size, edges.length, 'edges must be unique');
    assert.ok(edges.every(edge => names.includes(edge.from) && names.includes(edge.to) && edge.from !== edge.to));

    const remaining = new Set(names);
    const executionBatches = [];
    while (remaining.size) {
      const ready = [...remaining].filter(name =>
        dependencies.every(edge => edge.to !== name || !remaining.has(edge.from))).sort();
      assert.ok(ready.length, 'demo dependencies must be acyclic');
      executionBatches.push(ready);
      for (const name of ready) remaining.delete(name);
    }
    assert.deepEqual(executionBatches.map(batch => batch.length), [2, 3, 1, 1]);

    const terminals = names.filter(name => !dependencies.some(edge => edge.from === name)).sort();
    assert.deepEqual(terminals, ['07_holdout_and_cli']);

    const graphNodesState = Object.fromEntries(
      nodeSpecs.map(([id, , , status]) => [
        id,
        {
          status,
          revision: status === 'waiting' ? 0 : 1,
          head: status === 'completed' ? '9b4e11f' : null,
          instruction: '',
          error: null,
        },
      ]),
    );

    const graphExecutions = nodeSpecs
      .filter(([, , , status]) => status !== 'waiting')
      .map(([id, en, cn, status], idx) => ({
        id: `exec-graph-${idx + 1}`,
        node: id,
        revision: 1,
        attempt: 1,
        sessionId: `demo-graph-${id}`,
        worktree: repository,
        before: '8d1e40b',
        after: status === 'completed' ? '9b4e11f' : null,
        workspaceLineage: [],
        input: { instruction: zh ? cn : en },
        result: status === 'completed' ? { summary: 'Done' } : null,
        status,
        startedAt: 1764000200000 + idx * 1000,
        completedAt: status === 'completed' ? 1764000240000 + idx * 1000 : null,
        output: '',
        outputBytes: 0,
        pid: null,
      }));

    const graphSnapshot = {
      ...empty,
      runId: 'demo-graph',
      title: graphTitle,
      config,
      planType: 'graph',
      approved: true,
      paused: false,
      planningId: 'demo-plan',
      planning: {
        planningId: 'demo-plan',
        roles: {
          planner: {
            model: config.model,
            sessionId: 'demo-planner-session',
            sessionStart: '2026-11-18T09:15:00Z',
            durationSeconds: 14.2,
            assistantMessages: 2,
            tools: 3,
            toolErrors: 0,
            usage: { input: 12800, output: 1620, cacheRead: 8400, cacheWrite: 0, reasoning: 540, totalTokens: 23360 },
          },
        },
        totalPlanningDuration: 14.2,
        modelDuration: 13.1,
        status: 'completed',
        planType: 'graph',
        goal: graphGoal,
        runId: 'demo-graph',
      },
      phase: 'running',
      graph: { originalGoal: graphGoal, nodes, edges },
      nodes: graphNodesState,
      executions: graphExecutions,
      plan: { executionBatches, rootNodes: executionBatches[0], terminals, warnings: [] },
      events: [{ sequence: 1, timestamp: 1, type: 'created', planning_id: 'demo-plan' }],
    };

    const thinkingText = zh
      ? '先并行完成工程脚手架与按来源分组的防泄漏数据划分，随后同时展开空间、时序与频域三条独立分支，最后在验证集执行压缩与模糊压测（仅频域挂载返回 `05_freq_branch` 的有界 `<FEEDBACK>` 回路），达标后再执行唯一一次留出测试评估与 CLI 打包。'
      : 'Start with package scaffolding and leakage-safe splits in parallel, then fan out spatial, temporal, and frequency branches concurrently. Gate them with `06_val_robustness` (wired with bounded `<FEEDBACK>` back to `05_freq_branch` only) before locked holdout eval and CLI bundling.';

    const bashOut = [
      'pyproject.toml',
      'configs/dataset.yaml',
      'docs/DATASET_README.md',
      'data/manifests/clips_raw.parquet',
    ].join('\n');

    const readmeDoc = [
      '# Video Forensics Dataset Manifest',
      '- Clips: 48,000 real/synthetic videos across 14 generators and 1,240 source creators',
      '- Constraints: group splits by `creator_id` + perceptual hash cluster; evaluate `test` split exactly once',
    ].join('\n');

    const summaryText = zh
      ? '已编译为 **7 个节点、4 个执行批次** 的并行执行图（含 1 条有界反馈回路）并启动调度：\n\n- **基础与防泄漏（`01`–`02`）**：已完成脚手架与防泄漏 `train/val/test` 划分。\n- **三条并行分支（`03`–`05`）**：空间分支已完成，时序与频域分支正在并行训练。\n- **压测反馈与交付（`06`–`07`）**：`06_val_robustness` 支持向 `05_freq_branch` 触发有界 `<FEEDBACK>` 返工，达标后由 `07_holdout_and_cli` 一次性完成留出评估与打包。'
      : 'Compiled and launched a **7-node, 4-batch** parallel execution graph with one bounded feedback loop:\n\n- **Foundation (`01`–`02`)**: Package scaffold and leakage-safe splits completed.\n- **Parallel lanes (`03`–`05`)**: Spatial branch completed; temporal and frequency branches are running concurrently.\n- **Validation & delivery (`06`–`07`)**: `06_val_robustness` gates fusion with bounded `<FEEDBACK>` to `05_freq_branch` before `07_holdout_and_cli` runs holdout eval and CLI packaging.';

    const plannerEvents = [
      {
        type: 'message_end',
        message: { role: 'assistant', content: [{ type: 'thinking', thinking: thinkingText }] },
      },
      {
        type: 'tool_execution_start',
        toolCallId: 'inspect-repo',
        toolName: 'bash',
        args: { command: 'ls -la src configs' },
      },
      {
        type: 'tool_execution_end',
        toolCallId: 'inspect-repo',
        toolName: 'bash',
        isError: false,
        durationMs: 84,
        result: { content: [{ type: 'text', text: bashOut }], details: { exitCode: 0 } },
      },
      {
        type: 'tool_execution_start',
        toolCallId: 'read-dataset',
        toolName: 'read',
        args: { path: 'docs/DATASET_README.md' },
      },
      {
        type: 'tool_execution_end',
        toolCallId: 'read-dataset',
        toolName: 'read',
        isError: false,
        result: { content: [{ type: 'text', text: readmeDoc }] },
      },
      {
        type: 'tool_execution_start',
        toolCallId: 'graph',
        toolName: 'edit_graph',
        args: { nodes: nodes.map(({ id, task }) => ({ id, task })), edges },
      },
      {
        type: 'tool_execution_end',
        toolCallId: 'graph',
        toolName: 'edit_graph',
        isError: false,
        result: {
          content: [{ type: 'text', text: `Successfully applied ${nodes.length} node edit(s) and ${edges.length} edge edit(s).` }],
          details: {},
        },
      },
      {
        type: 'message_end',
        message: { role: 'assistant', content: [{ type: 'text', text: summaryText }] },
      },
    ];
    const plannerOutput = plannerEvents.map(item => JSON.stringify(item)).join('\n') + '\n';
    const plannerOutputBytes = Buffer.byteLength(plannerOutput);

    // -------------------------------------------------------------------------
    // 4) Bundled Pi extensions, providers & slash commands fixture
    // -------------------------------------------------------------------------
    const extensionCatalog = {
      globalDirectory: '~/.pi/agent',
      webSearch: { keenablePublic: true, hasDedicatedApi: false },
      extensions: [
        {
          id: 'npm:pi-trim',
          name: 'pi-trim',
          source: 'npm:pi-trim',
          path: 'bundled/pi-trim',
          enabled: true,
          bundled: true,
          required: true,
        },
        {
          id: 'npm:pi-continuity',
          name: 'pi-continuity',
          source: 'npm:pi-continuity',
          path: 'bundled/pi-continuity',
          enabled: true,
          bundled: true,
          required: false,
        },
        {
          id: 'npm:pi-simple-timeout',
          name: 'pi-simple-timeout',
          source: 'npm:pi-simple-timeout',
          path: 'bundled/pi-simple-timeout',
          enabled: true,
          bundled: true,
          required: false,
        },
        {
          id: 'npm:pi-better-web-search',
          name: 'pi-better-web-search',
          source: 'npm:pi-better-web-search',
          path: 'bundled/pi-better-web-search',
          enabled: true,
          bundled: true,
          required: false,
        },
        {
          id: '~/.pi/agent/extensions/custom-hooks.ts',
          name: 'custom-hooks.ts',
          source: 'local',
          path: '~/.pi/agent/extensions/custom-hooks.ts',
          enabled: false,
          bundled: false,
          required: false,
        },
      ],
    };

    const providerCatalog = {
      providers: [
        {
          id: 'anthropic',
          name: 'Anthropic',
          authenticated: true,
          authType: 'oauth',
          status: 'configured',
        },
        {
          id: 'openai-codex',
          name: 'OpenAI Codex',
          authenticated: true,
          authType: 'oauth',
          status: 'configured',
        },
      ],
      models: [
        {
          id: 'claude-sonnet-4-5',
          provider: 'anthropic',
          name: 'Claude Sonnet 4.5',
          reasoning: true,
          thinkingLevels: ['off', 'low', 'medium', 'high'],
        },
        {
          id: 'gpt-5.3-codex',
          provider: 'openai-codex',
          name: 'GPT-5.3 Codex',
          reasoning: true,
          thinkingLevels: ['low', 'medium', 'high'],
        },
      ],
      warning: null,
    };

    const slashCommands = [
      { name: 'timeout', description: zh ? '设置 Bash 工具默认超时（默认 180s）' : 'Set default bash tool timeout (default 180s)', source: 'pi-simple-timeout' },
      { name: 'pi-trim', description: zh ? '查看或切换系统提示词精简模式（default / aggressive）' : 'Switch system-prompt trim mode (default / aggressive)', source: 'pi-trim' },
      { name: 'mcp', description: zh ? '查看、登录或重连 MCP 服务器' : 'Inspect, log in, or reconnect MCP servers', source: 'builtin:mcp' },
      { name: 'skill:video-eval', description: zh ? '运行标准视频检测验证集评估流程' : 'Run video validation workflow', source: 'skill' },
    ];

    const terminalOutputSample = [
      '\x1b[32m➜\x1b[0m \x1b[36mvideo-forensics\x1b[0m \x1b[90mgit:(\x1b[31mmain\x1b[90m)\x1b[0m git status -s\r\n',
      ' \x1b[33mM\x1b[0m src/forensics/augment.py\r\n',
      ' \x1b[32m??\x1b[0m src/forensics/retry.py\r\n',
      ' \x1b[33mM\x1b[0m tests/test_augment.py\r\n',
      '\x1b[32m➜\x1b[0m \x1b[36mvideo-forensics\x1b[0m \x1b[90mgit:(\x1b[31mmain\x1b[90m)\x1b[0m pytest tests/test_augment.py -q\r\n',
      '\x1b[32m..............\x1b[0m                                                           \x1b[36m[100%]\x1b[0m\r\n',
      '\x1b[1;32m14 passed\x1b[0m \x1b[32min 1.42s\x1b[0m\r\n',
      '\x1b[32m➜\x1b[0m \x1b[36mvideo-forensics\x1b[0m \x1b[90mgit:(\x1b[31mmain\x1b[90m)\x1b[0m ',
    ].join('');

    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1.5,
      locale: zh ? 'zh-CN' : 'en-US',
      reducedMotion: 'reduce',
      colorScheme: 'light',
    });

    await context.addInitScript(({ lang, repository, config, minimalTitle, directTitle, graphTitle, terminalOutputSample }) => {
      try {
        Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true });
      } catch {
        // Ignore if non-configurable.
      }
      const callbacks = new Map();
      const eventListeners = new Map();
      let nextCb = 1;
      let nextEventId = 1;

      const emitEvent = (eventName, payload) => {
        const list = eventListeners.get(eventName) || [];
        for (const item of list) {
          const cb = callbacks.get(item.handler);
          if (cb) cb({ event: eventName, id: item.id, payload });
        }
      };

      const toBase64 = (text) => {
        const bytes = new TextEncoder().encode(text);
        let binary = '';
        for (const byte of bytes) binary += String.fromCharCode(byte);
        return btoa(binary);
      };

      window.isTauri = true;
      window.__TAURI_INTERNALS__ = {
        metadata: {
          currentWindow: { label: 'main' },
          currentWebview: { label: 'main', windowLabel: 'main' },
        },
        transformCallback(callback) {
          const id = nextCb++;
          callbacks.set(id, callback);
          return id;
        },
        invoke(cmd, args = {}) {
          if (cmd === 'backend_url') return Promise.resolve(window.location.origin);
          if (cmd === 'plugin:window|is_fullscreen') return Promise.resolve(false);
          if (cmd === 'plugin:window|is_maximized') return Promise.resolve(false);
          if (cmd === 'plugin:event|listen') {
            const id = nextEventId++;
            const list = eventListeners.get(args.event) || [];
            list.push({ id, handler: args.handler });
            eventListeners.set(args.event, list);
            return Promise.resolve(id);
          }
          if (cmd === 'plugin:event|unlisten') {
            const list = eventListeners.get(args.event) || [];
            eventListeners.set(args.event, list.filter(item => item.id !== args.eventId));
            return Promise.resolve(null);
          }
          if (cmd === 'plugin:autostart|is_enabled') return Promise.resolve(false);
          if (cmd === 'terminal_create') {
            const sessionId = 'demo-pty-1';
            setTimeout(() => {
              emitEvent('pi-n://terminal-output', {
                sessionId,
                data: toBase64(terminalOutputSample),
              });
            }, 120);
            return Promise.resolve({
              sessionId,
              shell: '/bin/zsh',
              cwd: args.workspacePath || repository,
              ptyBackend: 'unix',
            });
          }
          if (cmd === 'terminal_write' || cmd === 'terminal_resize' || cmd === 'terminal_kill') {
            return Promise.resolve(null);
          }
          return Promise.resolve(null);
        },
      };

      localStorage.setItem('pi_n_language_v1', lang);
      localStorage.setItem('pi_n_plan_mode', 'serial');
      localStorage.setItem('pi_n_landing_background_v1', 'grid');
      localStorage.setItem('pi_n_collapse_cards_v1', '0');
      localStorage.setItem('pi_n_projects', JSON.stringify([{
        id: repository,
        path: repository,
        name: 'video-forensics',
        branch: 'main',
        clean: true,
        lastOpened: 1,
      }]));
      localStorage.setItem('pi_n_workspace_runs', JSON.stringify({
        [repository]: ['demo-minimal', 'demo-direct', 'demo-graph'],
      }));
      localStorage.setItem('pi_n_run_labels', JSON.stringify({
        'demo-minimal': minimalTitle,
        'demo-direct': directTitle,
        'demo-graph': graphTitle,
      }));
      localStorage.setItem('pi_n_config', JSON.stringify(config));
      localStorage.setItem('pi_n_workbench_split_ratio', '0.52');
    }, { lang, repository, config, minimalTitle, directTitle, graphTitle, terminalOutputSample });

    const errors = [];
    await context.route('**/api/*', async route => {
      const command = new URL(route.request().url()).pathname.slice(5);
      const body = route.request().postDataJSON() || {};

      if (command === 'get_workspace_image') {
        const png = chartPngs[body.path];
        if (png) {
          await route.fulfill({
            status: 200,
            contentType: 'image/png',
            body: png,
          });
          return;
        }
        await route.fulfill({ status: 404, body: 'Not found' });
        return;
      }

      let result;
      switch (command) {
        case 'bootstrap':
        case 'save_config':
          result = {
            config,
            snapshot: empty,
            runs: ['demo-minimal', 'demo-direct', 'demo-graph'],
            conversations: [
              {
                runId: 'demo-minimal',
                repository,
                title: minimalTitle,
                planType: 'serial',
                phase: 'completed',
                hasActiveExecutions: false,
              },
              {
                runId: 'demo-direct',
                repository,
                title: directTitle,
                planType: 'serial',
                phase: 'completed',
                hasActiveExecutions: false,
              },
              {
                runId: 'demo-graph',
                repository,
                title: graphTitle,
                planType: 'graph',
                phase: 'running',
                hasActiveExecutions: true,
              },
            ],
            repositoryInfo: repoInfo,
            dataPath: '/demo/.pi-n',
          };
          break;
        case 'history':
        case 'snapshot':
          result = body.runId === 'demo-graph'
            ? graphSnapshot
            : body.runId === 'demo-minimal'
              ? minimalSnapshot
              : body.runId === 'demo-direct'
                ? directSnapshot
                : empty;
          break;
        case 'snapshot_if_changed':
          result = {
            version: 'demo',
            snapshot: body.runId === 'demo-graph'
              ? graphSnapshot
              : body.runId === 'demo-minimal'
                ? minimalSnapshot
                : body.runId === 'demo-direct'
                  ? directSnapshot
                  : null,
          };
          break;
        case 'get_planning_output': {
          const offset = body.offset || 0;
          result = {
            planningId: body.planningId,
            role: 'planner',
            content: offset ? '' : plannerOutput,
            startOffset: offset,
            nextOffset: plannerOutputBytes,
            totalBytes: plannerOutputBytes,
            complete: true,
            running: false,
          };
          break;
        }
        case 'get_execution_output': {
          const offset = body.offset || 0;
          const isMin = body.runId === 'demo-minimal' || body.executionId === 'exec-min-1';
          const out = isMin ? minimalOutput : directOutput;
          const total = isMin ? minimalOutputBytes : directOutputBytes;
          result = {
            runId: body.runId || 'demo-direct',
            executionId: body.executionId || (isMin ? 'exec-min-1' : 'exec-direct-1'),
            content: offset ? '' : out,
            startOffset: offset,
            nextOffset: total,
            totalBytes: total,
            complete: true,
            status: 'completed',
          };
          break;
        }
        case 'get_file_changes':
          result = {
            runId: body.runId || 'demo-graph',
            executionId: null,
            executionIds: null,
            summary: body.runId === 'demo-direct'
              ? directFileChanges
              : body.runId === 'demo-minimal'
                ? minimalFileChanges
                : {
                    files: [],
                    totalFiles: 0,
                    addedCount: 0,
                    modifiedCount: 0,
                    deletedCount: 0,
                    renamedCount: 0,
                    totalAdditions: 0,
                    totalDeletions: 0,
                  },
          };
          break;
        case 'get_file_diff':
          result = directDiffs[body.path] || {
            runId: body.runId || 'demo-direct',
            path: body.path || '',
            oldPath: null,
            binary: false,
            truncated: false,
            hiddenLines: 0,
            lines: [],
          };
          break;
        case 'repository_status':
          result = { repository, valid: true, error: null };
          break;
        case 'detect_repository':
          result = repoInfo;
          break;
        case 'list_plannings':
          result = [];
          break;
        case 'list_files':
          result = { files: ['src/forensics/augment.py', 'src/forensics/retry.py', 'tests/test_augment.py'] };
          break;
        case 'list_skills':
          result = { skills: [{ name: 'video-eval', description: zh ? '运行标准视频检测验证集评估流程' : 'Run video validation workflow' }] };
          break;
        case 'provider_auth':
          result = providerCatalog;
          break;
        case 'pi_extensions':
          result = extensionCatalog;
          break;
        case 'composer_command':
        case 'extension_command':
          result = { instance: 'demo-cmd', commands: slashCommands };
          break;
        case 'environment_capabilities':
          result = { platform: 'macos', arch: 'arm64', nativeWorkspace: true };
          break;
        default:
          errors.push(`Unexpected API: ${command}`);
          result = null;
      }
      try {
        await route.fulfill({ json: { result } });
      } catch {
        /* A superseded poll can be aborted. */
      }
    });

    const page = await context.newPage();
    page.setDefaultTimeout(90_000);
    page.setDefaultNavigationTimeout(90_000);
    page.on('pageerror', error => errors.push(String(error)));

    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`, { waitUntil: 'domcontentloaded' });
    await page.locator('.app-shell.is-tauri-macos').waitFor();
    await page.locator('.desktop-titlebar.is-macos').waitFor();
    await page.evaluate(() => {
      const titlebar = document.querySelector('.desktop-titlebar.is-macos');
      if (!titlebar || titlebar.querySelector('.macos-traffic-lights-capture')) return;
      const group = document.createElement('div');
      group.className = 'macos-traffic-lights-capture';
      group.setAttribute('aria-hidden', 'true');
      Object.assign(group.style, {
        position: 'absolute',
        left: '12px',
        top: '50%',
        transform: 'translateY(-50%)',
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        pointerEvents: 'none',
        zIndex: '20',
      });
      for (const [bg, border] of [
        ['#FF5F56', 'rgba(224, 68, 62, 0.85)'],
        ['#FFBD2E', 'rgba(222, 161, 35, 0.85)'],
        ['#27C93F', 'rgba(26, 171, 41, 0.85)'],
      ]) {
        const dot = document.createElement('span');
        Object.assign(dot.style, {
          width: '14px',
          height: '14px',
          borderRadius: '50%',
          background: bg,
          boxShadow: `inset 0 0 0 0.5px ${border}`,
          display: 'block',
        });
        group.appendChild(dot);
      }
      titlebar.appendChild(group);
    });

    // -------------------------------------------------------------------------
    // Shot 1: Home / Landing screen (Tri-color notebook grid, Direct & Compile)
    // -------------------------------------------------------------------------
    await page.locator('.landing-screen').waitFor();
    await page.locator('.landing-page-grid').waitFor();
    await page.locator('.landing-screen textarea').fill(landingGoal);
    await page.locator('.landing-screen textarea').blur();
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(450);
    assert.deepEqual(await page.locator('.landing-screen .prompt-box-mode-btn').allTextContents(), ['Direct', 'Compile']);
    await page.screenshot({ path: `assets/readme-home${zh ? '-zh' : ''}.png`, animations: 'disabled' });

    // -------------------------------------------------------------------------
    // Shot 2: Minimalist Collapsed-Cards Mode (ActivitySummaryRow + Image Stack)
    // -------------------------------------------------------------------------
    await page.locator('[data-run-id="demo-minimal"]').click();
    await page.locator('[data-testid="collapse-cards-trigger"]').waitFor();
    await page.locator('[data-testid="collapse-cards-trigger"]').click();
    await page.locator('[data-testid="activity-summary-row"]').first().waitFor();
    await page.locator('.markdown-image-stack').waitFor();
    // Wait for all workspace chart PNGs inside the stack to finish decoding.
    await page.waitForFunction(() => {
      const imgs = [...document.querySelectorAll('.markdown-image-stack img')];
      return imgs.length === 3 && imgs.every(img => img.complete && img.naturalWidth > 0);
    });
    // Move cursor off the image stack so the resting `1 / 3` deck badge renders cleanly.
    await page.mouse.move(10, 10);
    await page.waitForTimeout(250);
    // Ensure top of conversation is framed cleanly with zero clipped top rows and footer visible.
    await page.locator('.initial-query-scroll').evaluate(scroll => {
      scroll.dispatchEvent(new WheelEvent('wheel', { deltaY: -1200, bubbles: true }));
      scroll.scrollTop = 0;
    });
    await page.waitForTimeout(250);
    const collapseBtnPressed = await page.locator('[data-testid="collapse-cards-trigger"]').getAttribute('aria-pressed');
    assert.equal(collapseBtnPressed, 'true', 'Collapse cards minimalist mode must be active');
    const footerOverlap = await page.evaluate(() => {
      const btn = document.querySelector('[data-testid="collapse-cards-trigger"]')?.getBoundingClientRect();
      const box = document.querySelector('.pane-bottom-chat .prompt-box-container')?.getBoundingClientRect();
      return btn && box ? btn.bottom - box.top : 999;
    });
    assert.ok(footerOverlap <= 0, `Expand cards footer must sit cleanly above composer (overlap=${footerOverlap})`);
    await page.screenshot({ path: `assets/readme-minimal${zh ? '-zh' : ''}.png`, animations: 'disabled' });

    // -------------------------------------------------------------------------
    // Shot 3: Settings -> 4 Bundled Plugins (captured over clean centered backdrop)
    // -------------------------------------------------------------------------
    await page.locator('.sidebar-bottom-btn').click();
    await page.locator('.settings-modal').waitFor();
    await page.locator('.extension-settings .extension-settings-row').first().waitFor();
    // Wait for async Settings cards (ProviderSettings + ExtensionSettings) to finish layout before scrolling.
    await page.waitForTimeout(500);
    const alignExtensionsCard = () => page.locator('.settings-modal-content .settings-sections').evaluate(el => {
      const card = el.querySelector('.extension-settings');
      if (!card) return;
      const delta = card.getBoundingClientRect().top - el.getBoundingClientRect().top;
      el.scrollTop = Math.max(0, el.scrollTop + delta - 14);
    });
    await alignExtensionsCard();
    await page.waitForTimeout(200);
    await alignExtensionsCard();
    await page.waitForTimeout(150);
    const extTopOffset = await page.evaluate(() => {
      const scroller = document.querySelector('.settings-modal-content .settings-sections')?.getBoundingClientRect();
      const card = document.querySelector('.extension-settings')?.getBoundingClientRect();
      return scroller && card ? card.top - scroller.top : 999;
    });
    assert.ok(extTopOffset >= 10 && extTopOffset <= 20, `Global Pi extensions card must sit flush near modal top (offset=${extTopOffset})`);
    await page.screenshot({ path: `assets/readme-plugins${zh ? '-zh' : ''}.png`, animations: 'disabled' });
    await page.locator('.settings-modal-header .icon-button').click();
    await page.waitForTimeout(250);

    // -------------------------------------------------------------------------
    // Shot 4: Docked Workspace Terminal + Pi Slash Commands (clean collapsed backdrop)
    // -------------------------------------------------------------------------
    await page.locator('[data-run-id="demo-direct"]').click();
    await page.locator('[data-testid="activity-summary-row"]').first().waitFor();
    await page.waitForTimeout(300);
    const terminalBtn = page.locator('.pane-bottom-chat button[aria-label*="终端"], .pane-bottom-chat button[aria-label*="terminal" i]').first();
    await terminalBtn.click();
    await page.locator('.workspace-terminal-dock').waitFor();
    await page.locator('.xterm-rows').waitFor();
    await page.waitForTimeout(450);
    // Type `/c` to filter to 4 clean items (/compact, /copy, /scoped-models, /mcp) with zero clipped bottom row.
    const composerInput = page.locator('.pane-bottom-chat textarea').first();
    await composerInput.click();
    await composerInput.fill('/c');
    await page.locator('.prompt-box-suggestion-item').first().waitFor();
    await page.waitForTimeout(350);
    await page.locator('.initial-query-scroll').evaluate(el => { el.scrollTop = 0; });
    await page.waitForTimeout(150);
    await page.screenshot({ path: `assets/readme-terminal${zh ? '-zh' : ''}.png`, animations: 'disabled' });

    // Close slash menu and docked terminal before switching to Detailed Card + Diff mode.
    await composerInput.fill('');
    await composerInput.blur();
    const closeTermBtn = page.locator('.workspace-terminal-dock .terminal-traffic-btn.is-close').first();
    if (await closeTermBtn.count()) {
      await closeTermBtn.click();
      await page.waitForTimeout(300);
    }

    // -------------------------------------------------------------------------
    // Shot 5: Direct Detailed Card Mode + Inline Diff Inspector
    // -------------------------------------------------------------------------
    await page.locator('[data-testid="collapse-cards-trigger"]').click();
    await page.locator('.tool-call-card').first().waitFor();
    await page.locator('[data-testid="workspace-changes-trigger"]').click();
    await page.locator('[data-testid="workspace-changes-pane"]').waitFor();
    await page.locator('.changed-file-row').first().click();
    await page.locator('[data-testid="changed-file-diff"]').waitFor();
    await page.waitForTimeout(450);
    await page.locator('.initial-query-scroll').evaluate(el => { el.scrollTop = 0; });
    await page.waitForTimeout(150);
    await page.screenshot({ path: `assets/readme-direct${zh ? '-zh' : ''}.png`, animations: 'disabled' });

    // -------------------------------------------------------------------------
    // Shot 6: Compile Mode (Active 7-Node, 4-Batch Parallel Execution Graph)
    // -------------------------------------------------------------------------
    await page.locator('[data-run-id="demo-graph"]').click();
    await page.locator('.react-flow__node').first().waitFor();
    await page.locator('.tool-call-card').first().waitFor();
    await page.waitForTimeout(1000);

    assert.equal(await page.locator('.plan-summary-card').count(), 0);
    await page.locator('.initial-query-scroll').evaluate(scroll => {
      scroll.dispatchEvent(new WheelEvent('wheel', { deltaY: -1200, bubbles: true }));
      scroll.scrollTop = 0;
    });
    await page.waitForTimeout(200);
    assert.equal(await page.locator('.initial-query-scroll').evaluate(scroll => scroll.scrollTop), 0);
    assert.equal(await page.locator('.react-flow__node').count(), 7);
    const centerOffsets = await page.evaluate(() => {
      const center = selector => {
        const rect = document.querySelector(selector).getBoundingClientRect();
        return (rect.left + rect.right) / 2;
      };
      const axis = center('.initial-query-scroll');
      return ['.thinking-card', '.tool-call-card', '.pane-bottom-chat .prompt-box-container']
        .filter(selector => document.querySelector(selector))
        .map(selector => ({ selector, offset: center(selector) - axis }));
    });
    assert.ok(centerOffsets.every(({ offset }) => Math.abs(offset) < 0.75),
      `cards and composer share a centerline: ${JSON.stringify(centerOffsets)}`);
    assert.equal(await page.getByText('Non-contiguous transcript append').count(), 0);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: `assets/readme-graph${zh ? '-zh' : ''}.png`, animations: 'disabled' });
    console.log(`Captured ${lang}: home, plugins, minimal, terminal, direct, graph`);
    await context.close();
  }
} finally {
  await browser?.close();
  await server.close();
}
