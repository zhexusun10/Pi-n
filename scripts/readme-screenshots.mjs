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
  autoApprove: false,
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
    const graphTitle = zh ? 'AI 视频检测工程流水线' : 'AI video detection pipeline';
    const directTitle = zh ? '压缩鲁棒性增强与重试回退' : 'H.264 compression augmentation & retry';
    const landingGoal = zh
      ? '为 src/forensics/augment.py 补充自适应 H.264 压缩数据增强，查阅最新 PyAV 编码器参数文档，添加带抖动的指数退避重试，并用 pytest 验证频域检测分支在 CRF 28 下的 AUROC。'
      : 'Add adaptive H.264 compression augmentation in src/forensics/augment.py. Check current PyAV codec flags, add jittered retry backoff for batch transcode workers, and verify frequency-branch AUROC at CRF 28 with pytest.';
    const graphGoal = zh
      ? '在 src/forensics/ 中构建可复现的 AI 生成视频检测流水线：按来源分组冻结 train/val/test 划分并验证无泄漏；并行开发空间伪影、光流时序与 FFT/小波频域分支；仅在验证集完成分支审计、消融校准与有界鲁棒性反馈；最终在留出集评估一次并交付 CLI 与模型卡。'
      : 'Build a reproducible AI-generated video detection pipeline in src/forensics/. Freeze source-grouped train/val/test splits with leakage tests, then build spatial, temporal, and FFT/wavelet branches in parallel. Run validation checks, ablations, and bounded compression feedback on val before one holdout eval and CLI packaging.';

    // -------------------------------------------------------------------------
    // 1) Direct (single-agent) fixture: showcases Pi^n as an out-of-the-box,
    //    upgraded Pi workbench with web_search, edit, bash, Compacted card,
    //    inline syntax-highlighted file diffs, slash commands, and terminal.
    // -------------------------------------------------------------------------
    const directThinking = zh
      ? '先查阅 PyAV 最新 libx264 编码选项确认 `crf` 与 `preset` 的传参规范，随后检查 `src/forensics/augment.py` 现有流水线，补充随机 CRF 压缩与指数退避重试逻辑，最后运行 `pytest` 回归测试确认所有用例通过。'
      : 'Check current PyAV `libx264` option handling for `crf` and `preset`, inspect `src/forensics/augment.py`, add deterministic-seeded CRF augmentation with jittered retry backoff, then run `pytest` to verify the full forensics suite.';

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
      ? '已完成 `src/forensics/augment.py` 与 `tests/test_augment.py` 的代码研读、PyAV 编码器文档检索与第一轮边界条件分析；保留修改后的压缩增强模块与测试契约以执行最终回归验证。'
      : 'Completed code inspection of `src/forensics/augment.py` and `tests/test_augment.py`, verified PyAV libx264 flags via web search, and retained modified augmentation and retry modules for final test verification.';

    const directSummary = zh
      ? '已完成自适应 H.264 压缩增强与重试回退，并全部通过回归测试：\n\n- **自适应压缩管线（`src/forensics/augment.py`）**：新增 `H264CompressionAugment`，按可复现随机种子采样 `CRF ∈ [23, 32]`，通过 PyAV `libx264` 在内存缓冲区完成转码，零临时文件落盘。\n- **抖动退避重试（`src/forensics/retry.py`）**：为批量转码 Worker 增加 `retry_with_backoff` 装饰器，处理瞬时解码超时与 I/O 抖动。\n- **验证结果（`tests/test_augment.py`）**：`pytest -q` 14 项测试全部通过，CRF 28 验证切片 AUROC 稳定在 **0.942**（+3.8%）。'
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
        args: { query: 'PyAV libx264 add_stream crf preset options documentation' },
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
        args: { command: 'pytest tests/test_augment.py tests/test_freq_branch.py -q' },
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
    // 2) Compile (multi-agent graph) fixture: 12-node, 6-batch demonstration plan
    // -------------------------------------------------------------------------
    const nodeSpecs = [
      [
        '01_package_scaffold',
        'Scaffold src/forensics/ package, YAML config schema, shared dataset loaders, and base pytest suite.',
        '搭建 src/forensics/ 包结构、YAML 配置规范、公共数据加载器与基础 pytest 测试套件。',
      ],
      [
        '02_data_audit_splits',
        'Deduplicate clip manifests, freeze source-grouped train/val/test splits, and enforce leakage tests.',
        '清洗去重样本清单，按来源分组冻结 train/val/test 划分并编写防泄漏校验测试。',
      ],
      [
        '03_spatial_branch',
        'Build RGB & noise-residual feature pipeline and train spatial CNN detector on train; save val logits.',
        '实现 RGB 与噪声残差特征管线并在训练集训练空间 CNN 检测器，保存验证集预测概率。',
      ],
      [
        '04_temporal_branch',
        'Extract optical-flow & flicker consistency signals and train compact GRU detector on train; log val.',
        '提取光流与帧间闪烁一致性特征，在训练集训练轻量 GRU 时序检测器并记录验证集结果。',
      ],
      [
        '05_freq_branch',
        'Build 2D-FFT radial & wavelet extractors and train spectral detector with augmentations on train.',
        '构建 2D-FFT 径向频谱与小波提取器，结合数据增强在训练集训练频域检测模型。',
      ],
      [
        '06_spatial_eval',
        'Calibrate spatial detector on val, audit lighting/codec error slices, and profile frame latency.',
        '在验证集校准空间模型概率，审计光照与编码分片误报率并测量单帧推理延迟。',
      ],
      [
        '07_temporal_eval',
        'Run val clip-length & FPS ablations on temporal detector and measure sequence memory footprint.',
        '在验证集开展片段长度与帧率消融实验，统计时序分支推理显存与吞吐耗时。',
      ],
      [
        '08_freq_robustness',
        'Stress-test frequency branch under H.264 CRF, resize & blur on val; send <FEEDBACK> if AUROC drops >5%.',
        '在验证集执行 H.264 压缩、缩放与模糊压力测试；若 AUROC 降幅 >5% 则向频域分支发送 <FEEDBACK>。',
      ],
      [
        '09_ensemble_selection',
        'Run cross-branch val ablations, fit late-fusion weights & threshold, and freeze configs/selected_model.json.',
        '基于验证集开展跨模态消融与融合权重校准，锁定阈值并冻结 configs/selected_model.json。',
      ],
      [
        '10_holdout_eval',
        'Run single locked evaluation on test split, plot ROC/PR & calibration curves, and log failure slices.',
        '在锁定留出测试集执行唯一一次评估，生成 ROC/PR 与校准曲线并汇总错误案例分片。',
      ],
      [
        '11_inference_bundle',
        'Export ONNX/TorchScript weights, build forensics-detect CLI, and add end-to-end CLI smoke tests.',
        '导出 ONNX/TorchScript 权重，封装 forensics-detect 命令行推理工具并补充端到端冒烟测试。',
      ],
      [
        '12_final_report',
        'Compile MODEL_CARD.md, ablation tables & reproducibility guide; run full pytest & CLI verification.',
        '汇总留出集指标、消融表与复现指南生成 MODEL_CARD.md，并运行全量 pytest 与 CLI 校验。',
      ],
    ];

    const nodes = nodeSpecs.map(([id, en, cn]) => ({ id, task: zh ? cn : en }));
    const names = nodes.map(node => node.id);
    assert.equal(new Set(names).size, 12, 'demo node names must be unique');

    const dependencies = [
      ['01_package_scaffold', '03_spatial_branch'],
      ['02_data_audit_splits', '03_spatial_branch'],
      ['01_package_scaffold', '04_temporal_branch'],
      ['02_data_audit_splits', '04_temporal_branch'],
      ['01_package_scaffold', '05_freq_branch'],
      ['02_data_audit_splits', '05_freq_branch'],
      ['03_spatial_branch', '06_spatial_eval'],
      ['04_temporal_branch', '07_temporal_eval'],
      ['05_freq_branch', '08_freq_robustness'],
      ['06_spatial_eval', '09_ensemble_selection'],
      ['07_temporal_eval', '09_ensemble_selection'],
      ['08_freq_robustness', '09_ensemble_selection'],
      ['09_ensemble_selection', '10_holdout_eval'],
      ['09_ensemble_selection', '11_inference_bundle'],
      ['10_holdout_eval', '12_final_report'],
      ['11_inference_bundle', '12_final_report'],
    ].map(([from, to]) => ({ from, to, feedback: false }));

    const edges = [...dependencies, { from: '08_freq_robustness', to: '05_freq_branch', feedback: true }];
    assert.equal(edges.length, 17);
    assert.equal(new Set(edges.map(edge => `${edge.from}:${edge.to}`)).size, edges.length, 'edges must be unique');
    assert.ok(edges.every(edge => names.includes(edge.from) && names.includes(edge.to) && edge.from !== edge.to));

    const canReachWithout = (start, target, skipFrom, skipTo) => {
      const seen = new Set([start]);
      const queue = [start];
      while (queue.length) {
        const current = queue.shift();
        for (const edge of dependencies) {
          if (edge.from !== current) continue;
          if (edge.from === skipFrom && edge.to === skipTo) continue;
          if (edge.to === target) return true;
          if (!seen.has(edge.to)) {
            seen.add(edge.to);
            queue.push(edge.to);
          }
        }
      }
      return false;
    };
    for (const edge of dependencies) {
      assert.equal(canReachWithout(edge.from, edge.to, edge.from, edge.to), false,
        `Redundant edge ${edge.from} -> ${edge.to}`);
    }

    const remaining = new Set(names);
    const executionBatches = [];
    while (remaining.size) {
      const ready = [...remaining].filter(name =>
        dependencies.every(edge => edge.to !== name || !remaining.has(edge.from))).sort();
      assert.ok(ready.length, 'demo dependencies must be acyclic');
      executionBatches.push(ready);
      for (const name of ready) remaining.delete(name);
    }
    assert.deepEqual(executionBatches.map(batch => batch.length), [2, 3, 3, 1, 2, 1]);

    const terminals = names.filter(name => !dependencies.some(edge => edge.from === name)).sort();
    assert.deepEqual(terminals, ['12_final_report']);

    const invalidated = new Set(['05_freq_branch']);
    for (const batch of executionBatches) {
      for (const name of batch) {
        if (dependencies.some(edge => edge.to === name && invalidated.has(edge.from))) invalidated.add(name);
      }
    }
    const warning = `W303: If <FEEDBACK> is sent from 08_freq_robustness to 05_freq_branch, these nodes will rerun: ${[...invalidated].sort().join(', ')}.`;

    const graphSnapshot = {
      ...empty,
      runId: 'demo-graph',
      title: graphTitle,
      config,
      planType: 'graph',
      planningId: 'demo-plan',
      planning: {
        planningId: 'demo-plan',
        roles: {
          planner: {
            model: config.model,
            sessionId: 'demo-planner-session',
            sessionStart: '2026-11-18T09:15:00Z',
            durationSeconds: 18.4,
            assistantMessages: 2,
            tools: 3,
            toolErrors: 0,
            usage: { input: 14200, output: 1850, cacheRead: 9600, cacheWrite: 0, reasoning: 640, totalTokens: 26290 },
          },
        },
        totalPlanningDuration: 18.4,
        modelDuration: 16.9,
        status: 'completed',
        planType: 'graph',
        goal: graphGoal,
        runId: 'demo-graph',
      },
      phase: 'awaiting_approval',
      graph: { originalGoal: graphGoal, nodes, edges },
      nodes: Object.fromEntries(names.map(name => [name, { status: 'waiting', revision: 0, head: null, instruction: '', error: null }])),
      plan: { executionBatches, rootNodes: executionBatches[0], terminals, warnings: [warning] },
      events: [{ sequence: 1, timestamp: 1, type: 'created', planning_id: 'demo-plan' }],
    };

    const thinkingText = zh
      ? '首先需隔离数据划分与包脚手架：先完成包接口与按来源分组的防泄漏划分，再展开空间、时序与频域三条相互独立的分支。\n\n为了严格遵守验证集选型原则，各分支在完成训练集拟合后先并行开展验证集切片审计与压缩鲁棒性压力测试，其中仅频域分支挂载返回 `05_freq_branch` 的有界 `<FEEDBACK>` 回路，确保返工不波及空间与时序分支。全部验证审计通过后再统一执行 `09_ensemble_selection` 冻结阈值，随后并行完成唯一一次留出集评估与 CLI 打包，最后汇总交付。'
      : 'Start by separating repository scaffolding and leakage-safe split freezing so all downstream feature pipelines consume identical manifest contracts.\n\nKeep the spatial, temporal, and frequency lanes decoupled (`03`/`06`, `04`/`07`, `05`/`08`) before merging into `09_ensemble_selection`. Placing `08_freq_robustness -> 05_freq_branch` as a bounded feedback edge lets compression-hardening rework rerun only the frequency lane and downstream fusion, leaving spatial and temporal results untouched. After `09_ensemble_selection` freezes `configs/selected_model.json`, holdout evaluation and CLI/ONNX packaging run in parallel before `12_final_report` verifies the complete suite.';

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
      ? '已检查仓库与数据集规范，并将流水线编译为 **12 个节点、6 个执行批次** 的有向图（含 1 条有界反馈回路）：\n\n- **基础与防泄漏（`01`–`02`）**：并行搭建 `src/forensics/` 工程与测试基线，同时按来源冻结 `train/val/test` 划分。\n- **三条独立分支（`03`–`08`）**：空间、时序、频域各自隔离研发与验证评估；`08_freq_robustness` 压测不达标时通过 `<FEEDBACK>` 仅驱动 `05_freq_branch` 返工。\n- **冻结与单次留出评估（`09`–`12`）**：`09_ensemble_selection` 锁定融合权重后，并行完成留出集评估（`10`）与 `forensics-detect` CLI 打包（`11`），由 `12_final_report` 汇总验证交付。'
      : 'Compiled a **12-node, 6-batch** graph with one bounded feedback loop:\n\n- **Foundation & leakage gate (`01`–`02`)**: Scaffold `src/forensics/` and `pytest` alongside source-grouped split freezing.\n- **Parallel modality lanes (`03`–`08`)**: Spatial, temporal, and frequency branches train and audit in isolation; `08_freq_robustness` sends bounded `<FEEDBACK>` to `05_freq_branch` only.\n- **Freeze, holdout & delivery (`09`–`12`)**: `09_ensemble_selection` locks val weights, fanning out to holdout eval (`10`) and CLI bundle (`11`) before `12_final_report`.';

    const plannerEvents = [
      {
        type: 'message_end',
        message: { role: 'assistant', content: [{ type: 'thinking', thinking: thinkingText }] },
      },
      {
        type: 'tool_execution_start',
        toolCallId: 'inspect-repo',
        toolName: 'bash',
        args: { command: 'ls -la && find src configs -maxdepth 2' },
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
    // 3) Bundled Pi extensions, providers & slash commands fixture
    // -------------------------------------------------------------------------
    const extensionCatalog = {
      globalDirectory: '~/.pi/agent',
      webSearch: { keenablePublic: true, hasDedicatedApi: false },
      extensions: [
        {
          id: 'npm:pi-trim',
          name: 'pi-trim',
          source: 'bundled',
          path: 'bundled/pi-trim',
          enabled: true,
          bundled: true,
          required: true,
        },
        {
          id: 'npm:pi-continuity',
          name: 'pi-continuity',
          source: 'bundled',
          path: 'bundled/pi-continuity',
          enabled: true,
          bundled: true,
          required: false,
        },
        {
          id: 'npm:pi-simple-timeout',
          name: 'pi-simple-timeout',
          source: 'bundled',
          path: 'bundled/pi-simple-timeout',
          enabled: true,
          bundled: true,
          required: false,
        },
        {
          id: 'npm:pi-better-web-search',
          name: 'pi-better-web-search',
          source: 'bundled',
          path: 'bundled/pi-better-web-search',
          enabled: true,
          bundled: true,
          required: false,
        },
        {
          id: 'builtin:mcp',
          name: 'mcp',
          source: 'builtin',
          path: 'builtin:mcp',
          enabled: true,
          bundled: false,
          required: false,
        },
        {
          id: 'builtin:tool-search',
          name: 'tool-search',
          source: 'builtin',
          path: 'builtin:tool-search',
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
      { name: 'timeout', description: zh ? '设置 Bash 工具默认超时（默认 180s）' : 'Configure default bash tool timeout (default 180s)', source: 'pi-simple-timeout' },
      { name: 'pi-trim', description: zh ? '查看或切换系统提示词精简模式（default / aggressive）' : 'Inspect or switch system-prompt trimming mode (default / aggressive)', source: 'pi-trim' },
      { name: 'mcp', description: zh ? '查看、登录或重连 MCP 服务器' : 'Inspect, authenticate, or reconnect MCP servers', source: 'builtin:mcp' },
      { name: 'skill:video-eval', description: zh ? '运行标准视频检测验证集评估流程' : 'Run standardized video-forensics validation workflow', source: 'skill' },
    ];

    const terminalOutputSample = [
      '\x1b[32m➜\x1b[0m \x1b[36mvideo-forensics\x1b[0m \x1b[90mgit:(\x1b[31mmain\x1b[90m)\x1b[0m git status -s\r\n',
      ' \x1b[33mM\x1b[0m src/forensics/augment.py\r\n',
      ' \x1b[32m??\x1b[0m src/forensics/retry.py\r\n',
      ' \x1b[33mM\x1b[0m tests/test_augment.py\r\n',
      '\x1b[32m➜\x1b[0m \x1b[36mvideo-forensics\x1b[0m \x1b[90mgit:(\x1b[31mmain\x1b[90m)\x1b[0m pytest tests/test_augment.py tests/test_freq_branch.py -q\r\n',
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

    await context.addInitScript(({ lang, repository, config, directTitle, graphTitle, terminalOutputSample }) => {
      // Simulate the native macOS Tauri desktop shell so README screenshots
      // showcase the current macOS desktop UI (overlay titlebar + native PTY).
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
      localStorage.setItem('pi_n_projects', JSON.stringify([{
        id: repository,
        path: repository,
        name: 'video-forensics',
        branch: 'main',
        clean: true,
        lastOpened: 1,
      }]));
      localStorage.setItem('pi_n_workspace_runs', JSON.stringify({ [repository]: ['demo-direct', 'demo-graph'] }));
      localStorage.setItem('pi_n_run_labels', JSON.stringify({
        'demo-direct': directTitle,
        'demo-graph': graphTitle,
      }));
      localStorage.setItem('pi_n_config', JSON.stringify(config));
      localStorage.setItem('pi_n_workbench_split_ratio', '0.50');
    }, { lang, repository, config, directTitle, graphTitle, terminalOutputSample });

    const errors = [];
    await context.route('**/api/*', async route => {
      const command = new URL(route.request().url()).pathname.slice(5);
      const body = route.request().postDataJSON() || {};
      let result;
      switch (command) {
        case 'bootstrap':
        case 'save_config':
          result = {
            config,
            snapshot: empty,
            runs: ['demo-direct', 'demo-graph'],
            conversations: [
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
                phase: 'awaiting_approval',
                hasActiveExecutions: false,
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
            : body.runId === 'demo-direct'
              ? directSnapshot
              : empty;
          break;
        case 'snapshot_if_changed':
          result = {
            version: 'demo',
            snapshot: body.runId === 'demo-graph'
              ? graphSnapshot
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
          result = {
            runId: body.runId || 'demo-direct',
            executionId: body.executionId || 'exec-direct-1',
            content: offset ? '' : directOutput,
            startOffset: offset,
            nextOffset: directOutputBytes,
            totalBytes: directOutputBytes,
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
          result = { skills: [{ name: 'video-eval', description: 'Run standardized validation workflow' }] };
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
    // Shot 1: Home / Landing screen (Direct default + Compile mode)
    // -------------------------------------------------------------------------
    await page.locator('.landing-screen').waitFor();
    await page.locator('.landing-screen textarea').fill(landingGoal);
    await page.locator('.landing-screen textarea').blur();
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(450);
    assert.deepEqual(await page.locator('.landing-screen .prompt-box-mode-btn').allTextContents(), ['Direct', 'Compile']);
    await page.screenshot({ path: `assets/readme-home${zh ? '-zh' : ''}.png`, animations: 'disabled' });

    // -------------------------------------------------------------------------
    // Shot 2: Direct Mode (Single-Agent Workbench) + Inline Diff Inspector
    // -------------------------------------------------------------------------
    await page.locator('[data-run-id="demo-direct"]').click();
    await page.locator('.tool-call-card').first().waitFor();
    await page.locator('[data-testid="workspace-changes-trigger"]').waitFor();
    await page.waitForTimeout(350);
    // Open the inline Changes panel and expand the first changed file's diff.
    await page.locator('[data-testid="workspace-changes-trigger"]').click();
    await page.locator('[data-testid="workspace-changes-pane"]').waitFor();
    await page.locator('.changed-file-row').first().click();
    await page.locator('[data-testid="changed-file-diff"]').waitFor();
    await page.waitForTimeout(450);
    await page.screenshot({ path: `assets/readme-direct${zh ? '-zh' : ''}.png`, animations: 'disabled' });

    // -------------------------------------------------------------------------
    // Shot 3: Integrated Workspace Terminal + Pi Slash Commands (`/`)
    // -------------------------------------------------------------------------
    // Close Changes panel so full-width Direct + Docked Terminal + Slash palette breathe cleanly.
    await page.locator('[data-testid="workspace-changes-trigger"]').click();
    await page.waitForTimeout(250);
    // Click the terminal toggle button beside attachments in the composer.
    const terminalBtn = page.locator('.pane-bottom-chat button[aria-label*="终端"], .pane-bottom-chat button[aria-label*="terminal" i]').first();
    await terminalBtn.click();
    await page.locator('.workspace-terminal-dock').waitFor();
    await page.locator('.xterm-rows').waitFor();
    await page.waitForTimeout(450);
    // Type `/` into the composer to open the Pi slash command palette.
    const composerInput = page.locator('.pane-bottom-chat textarea').first();
    await composerInput.click();
    await composerInput.fill('/');
    await page.locator('.prompt-box-suggestion-item').first().waitFor();
    await page.waitForTimeout(350);
    await page.screenshot({ path: `assets/readme-terminal${zh ? '-zh' : ''}.png`, animations: 'disabled' });

    // Close slash menu and close terminal before switching to Compile view.
    await composerInput.fill('');
    await composerInput.blur();
    const closeTermBtn = page.locator('.workspace-terminal-dock .terminal-traffic-btn.is-close').first();
    if (await closeTermBtn.count()) {
      await closeTermBtn.click();
      await page.waitForTimeout(300);
    }

    // -------------------------------------------------------------------------
    // Shot 4: Built-in 4 Plugins & Settings Modal
    // -------------------------------------------------------------------------
    await page.locator('.sidebar-bottom-btn').click();
    await page.locator('.settings-modal').waitFor();
    await page.locator('.extension-settings').waitFor();
    await page.locator('.extension-settings').scrollIntoViewIfNeeded();
    await page.locator('.settings-modal-content').evaluate(el => {
      const card = el.querySelector('.extension-settings');
      if (card) el.scrollTop = Math.max(0, card.offsetTop - 16);
    });
    await page.waitForTimeout(350);
    await page.screenshot({ path: `assets/readme-plugins${zh ? '-zh' : ''}.png`, animations: 'disabled' });
    await page.locator('.settings-modal-header .icon-button').click();
    await page.waitForTimeout(250);

    // -------------------------------------------------------------------------
    // Shot 5: Compile Mode (Multi-Agent Execution Graph Workbench)
    // -------------------------------------------------------------------------
    await page.locator('[data-run-id="demo-graph"]').click();
    await page.locator('.react-flow__node').first().waitFor();
    await page.getByRole('button', { name: zh ? '批准' : 'Approve', exact: true }).waitFor();
    await page.locator('.tool-call-card').first().waitFor();
    await page.waitForTimeout(1000);

    assert.equal(await page.locator('.plan-summary-card').count(), 0);
    await page.locator('.initial-query-scroll').evaluate(scroll => {
      scroll.dispatchEvent(new WheelEvent('wheel', { deltaY: -1200, bubbles: true }));
      scroll.scrollTop = 0;
    });
    await page.waitForTimeout(200);
    assert.equal(await page.locator('.initial-query-scroll').evaluate(scroll => scroll.scrollTop), 0);
    assert.equal(await page.locator('.react-flow__node').count(), 12);
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
    console.log(`Captured ${lang}: home, direct, terminal, plugins, graph`);
    await context.close();
  }
} finally {
  await browser?.close();
  await server.close();
}
