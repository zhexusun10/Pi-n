// Capture the real Pi^n frontend with synthetic API data; no backend or credentials required.
// Run from the repository root with Playwright Chromium (Edge on Windows),
// or select an installed browser with PI_N_BROWSER_CHANNEL.
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';

const repository = '/Users/alex/pulse-cloud';
const secondaryRepository = '/Users/alex/pulse-docs';
const dataPath = '/demo/.pi-n';
const scopedKey = (key) => `pi-n-format-1:${dataPath}:${key}`;

const config = {
  repository,
  model: 'openai-codex/gpt-6.2-astra',
  thinkingLevel: 'xhigh',
  roleModels: {
    planner: { model: 'openai-codex/gpt-6.2-astra', thinkingLevel: 'xhigh' },
    nodeAgent: { model: 'openai-codex/gpt-6.2-astra', thinkingLevel: 'xhigh' },
  },
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
const repoInfo = { path: repository, name: 'pulse-cloud', branch: 'main', head: '', clean: true };

/** Render crisp, retina-ready PNG benchmark charts in headless Chromium for MarkdownImageStack. */
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

  const latencySvg = `
<svg xmlns="http://www.w3.org/2000/svg" width="640" height="300" viewBox="0 0 640 300">
  <rect width="640" height="300" fill="#ffffff"/>
  <text x="34" y="34" font-size="16.5" font-weight="600" fill="#0f172a">${zh ? '/v1/events 压测对比：p99 响应延迟 (ms)' : '/v1/events Load Benchmark — p99 Latency (ms)'}</text>
  <text x="34" y="54" font-size="12" fill="#64748b">${zh ? '200 并发请求压测 · 联合索引 + LRU 缓存降低 91% 尾延迟' : '200 concurrent users · Composite index + LRU cache cuts tail latency by 91%'}</text>

  <!-- Legend -->
  <g transform="translate(34, 68)">
    <line x1="0" y1="6" x2="18" y2="6" stroke="#2563eb" stroke-width="3" stroke-linecap="round"/>
    <circle cx="9" cy="6" r="3.5" fill="#2563eb"/>
    <text x="26" y="10" font-size="11.5" font-weight="500" fill="#0f172a">${zh ? '联合索引 + LRU 缓存（优化后）' : 'Composite Index + LRU (After)'}</text>
    <line x1="232" y1="6" x2="250" y2="6" stroke="#94a3b8" stroke-width="2.5" stroke-dasharray="5 4" stroke-linecap="round"/>
    <text x="258" y="10" font-size="11.5" fill="#64748b">${zh ? '优化前基线' : 'Before (Baseline)'}</text>
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
    <text x="62" y="100">450</text>
    <text x="62" y="140">340</text>
    <text x="62" y="180">225</text>
    <text x="62" y="220">110</text>
    <text x="62" y="260">0 ms</text>
  </g>

  <!-- X axis labels -->
  <g font-size="11" fill="#64748b" text-anchor="middle">
    <text x="96" y="276">25 VU</text>
    <text x="214" y="276">50 VU</text>
    <text x="332" y="276">100 VU</text>
    <text x="450" y="276">150 VU</text>
    <text x="568" y="276" font-weight="600" fill="#0f172a">200 VU</text>
  </g>

  <!-- Highlight column at 200 VU -->
  <rect x="546" y="92" width="44" height="164" rx="6" fill="#eff6ff" opacity="0.9"/>

  <!-- Shaded area under optimized curve -->
  <path d="M 96 249 L 214 247 L 332 246 L 450 244 L 568 242 L 568 256 L 96 256 Z" fill="url(#blueGrad)"/>
  <defs>
    <linearGradient id="blueGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#2563eb" stop-opacity="0.18"/>
      <stop offset="100%" stop-color="#2563eb" stop-opacity="0.02"/>
    </linearGradient>
  </defs>

  <!-- Baseline curve (before: 64 -> 118 -> 212 -> 318 -> 412 ms) -->
  <polyline fill="none" stroke="#94a3b8" stroke-width="2.4" stroke-dasharray="6 4" points="96,233 214,214 332,181 450,143 568,109"/>
  <g fill="#ffffff" stroke="#94a3b8" stroke-width="2">
    <circle cx="96" cy="233" r="3.8"/>
    <circle cx="214" cy="214" r="3.8"/>
    <circle cx="332" cy="181" r="3.8"/>
    <circle cx="450" cy="143" r="3.8"/>
    <circle cx="568" cy="109" r="4.2"/>
  </g>

  <!-- Optimized curve (after: 18 -> 22 -> 27 -> 33 -> 38 ms) -->
  <polyline fill="none" stroke="#2563eb" stroke-width="2.8" stroke-linejoin="round" points="96,249 214,247 332,246 450,244 568,242"/>
  <g fill="#2563eb" stroke="#ffffff" stroke-width="2">
    <circle cx="96" cy="249" r="4.5"/>
    <circle cx="214" cy="247" r="4.5"/>
    <circle cx="332" cy="246" r="4.5"/>
    <circle cx="450" cy="244" r="4.5"/>
    <circle cx="568" cy="242" r="5.5"/>
  </g>

  <!-- Drop connector and callout at 200 VU -->
  <line x1="568" y1="116" x2="568" y2="234" stroke="#16a34a" stroke-width="2" stroke-dasharray="3 2"/>
  <rect x="404" y="164" width="134" height="44" rx="8" fill="#ffffff" stroke="#bfdbfe" stroke-width="1.2"/>
  <text x="415" y="182" font-size="11.5" font-weight="700" fill="#1d4ed8">38 ms p99</text>
  <text x="415" y="198" font-size="10.5" font-weight="600" fill="#16a34a">-91% vs 412 ms</text>
</svg>`;

  const throughputSvg = `
<svg xmlns="http://www.w3.org/2000/svg" width="640" height="300" viewBox="0 0 640 300">
  <rect width="640" height="300" fill="#ffffff"/>
  <text x="34" y="34" font-size="16.5" font-weight="600" fill="#0f172a">${zh ? '接口吞吐量扩展曲线 (req/s)' : 'API Throughput Scaling (req/s)'}</text>
  <text x="34" y="54" font-size="12" fill="#64748b">${zh ? '峰值吞吐由 1,180 req/s 提升至 4,260 req/s（3.6×）' : 'Peak throughput rose from 1,180 req/s to 4,260 req/s (3.6×)'}</text>
  <g stroke="#e2e8f0" stroke-width="1">
    <line x1="72" y1="84" x2="598" y2="84"/>
    <line x1="72" y1="128" x2="598" y2="128"/>
    <line x1="72" y1="172" x2="598" y2="172"/>
    <line x1="72" y1="216" x2="598" y2="216"/>
    <line x1="72" y1="260" x2="598" y2="260" stroke="#cbd5e1"/>
  </g>
  <path d="M 96 232 L 214 196 L 332 148 L 450 112 L 568 92 L 568 260 L 96 260 Z" fill="#2563eb" fill-opacity="0.1"/>
  <polyline fill="none" stroke="#2563eb" stroke-width="2.8" points="96,232 214,196 332,148 450,112 568,92"/>
  <polyline fill="none" stroke="#94a3b8" stroke-width="2.2" stroke-dasharray="5 4" points="96,240 214,226 332,216 450,212 568,210"/>
  <rect x="372" y="178" width="206" height="62" rx="10" fill="#f8fafc" stroke="#e2e8f0"/>
  <text x="388" y="203" font-size="12.5" font-weight="600" fill="#1d4ed8">After: 4,260 req/s (3.6×)</text>
  <text x="388" y="226" font-size="12" fill="#64748b">Before: 1,180 req/s</text>
</svg>`;

  const dbCpuSvg = `
<svg xmlns="http://www.w3.org/2000/svg" width="640" height="300" viewBox="0 0 640 300">
  <rect width="640" height="300" fill="#ffffff"/>
  <text x="34" y="34" font-size="16.5" font-weight="600" fill="#0f172a">${zh ? '缓存命中率与 Postgres CPU 占用' : 'LRU Cache Hit Rate & Postgres CPU'}</text>
  <text x="34" y="54" font-size="12" fill="#64748b">${zh ? '热组织查询命中率 94.2% · 数据库峰值 CPU 78% → 19%' : '94.2% hot-tenant cache hit rate · Peak Postgres CPU 78% → 19%'}</text>
  <g stroke="#e2e8f0" stroke-width="1">
    <line x1="72" y1="84" x2="598" y2="84"/>
    <line x1="72" y1="128" x2="598" y2="128"/>
    <line x1="72" y1="172" x2="598" y2="172"/>
    <line x1="72" y1="216" x2="598" y2="216"/>
    <line x1="72" y1="260" x2="598" y2="260" stroke="#cbd5e1"/>
  </g>
  <polyline fill="none" stroke="#16a34a" stroke-width="2.8" points="96,138 175,112 254,102 333,96 412,94 491,93 568,92"/>
  <polyline fill="none" stroke="#f97316" stroke-width="2.4" stroke-dasharray="5 4" points="96,120 175,168 254,196 333,214 412,222 491,226 568,228"/>
  <g fill="#16a34a" stroke="#ffffff" stroke-width="2">
    <circle cx="96" cy="138" r="4"/><circle cx="254" cy="102" r="4"/><circle cx="412" cy="94" r="4"/><circle cx="568" cy="92" r="4"/>
  </g>
</svg>`;

  const charts = {};
  for (const [key, svg] of [
    ['benchmarks/p99_latency.png', latencySvg],
    ['benchmarks/throughput.png', throughputSvg],
    ['benchmarks/cache_cpu.png', dbCpuSvg],
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

    const graphTitle = zh ? '交付全栈计费与用量系统' : 'Ship billing & usage system';
    const minimalTitle = zh ? '优化 /v1/events 接口 p99 延迟' : 'Cut /v1/events p99 latency';
    const directTitle = zh ? '修复 OAuth 令牌刷新竞态' : 'Fix OAuth token refresh race';
    const terminalTitle = zh ? '接入幂等 Webhook 队列' : 'Add idempotent webhook queue';

    const landingGoal = zh
      ? '修复 src/auth/session.ts 中的 OAuth 令牌刷新竞态，查阅最新 RFC 9700 轮换规范，补充单飞锁并用 vitest 验证回归用例。'
      : 'Fix the OAuth token refresh race in src/auth/session.ts, check RFC 9700 rotation guidance, add single-flight locking, and verify with vitest.';

    const minimalGoal = zh
      ? '排查 /v1/events 瓶颈，补充联合索引与 LRU 缓存并绘制压测对比图。'
      : 'Profile /v1/events, add a composite index + LRU cache, and plot benchmarks.';

    const terminalGoal = zh
      ? '为 Webhook 派发增加幂等键去重与指数退避重试，并确认测试套件全部通过。'
      : 'Add idempotency-key dedup and retry backoff to webhooks, then run tests.';

    const graphGoal = zh
      ? '在 pulse-cloud 中交付全栈计费与用量系统：先并行完成数据库迁移与 Stripe 客户端，再同时开发计费 API、用量计量 Worker 与 React 仪表盘，由全栈 E2E 与安全审计把关（挂载返回用量计量的有界反馈回路），最后生成接口文档与发布清单。'
      : 'Ship a full-stack billing & usage system in pulse-cloud. Migrate the schema and build the Stripe client in parallel, fan out the billing API, usage metering worker, and React dashboard concurrently, gate with E2E + security tests (with bounded feedback to usage metering), then generate docs and release notes.';

    // -------------------------------------------------------------------------
    // 1) Minimalist (collapsed-cards) fixture: 6 tool calls + thinking collapsed
    //    into a single whisper-quiet ActivitySummaryRow, concise prose, and a
    //    3-card MarkdownImageStack of latency/throughput benchmark plots.
    // -------------------------------------------------------------------------
    const minimalSummary = zh
      ? '已补充 `(org_id, created_at DESC)` 联合索引与有界 LRU 缓存：**p99 延迟由 412 ms → 38 ms（`-91%`）**，吞吐量提升 **3.6×**，`vitest` **24 / 24** 全部通过。\n\n![p99 响应延迟对比](benchmarks/p99_latency.png) ![吞吐量扩展曲线](benchmarks/throughput.png) ![缓存命中率与数据库 CPU](benchmarks/cache_cpu.png)'
      : 'Added a composite `(org_id, created_at DESC)` index and bounded LRU cache: **p99 latency dropped 412 ms → 38 ms (`-91%`)**, throughput rose **3.6×**, and `vitest` passed **24 / 24**.\n\n![p99 Latency vs. Concurrency](benchmarks/p99_latency.png) ![Throughput Scaling](benchmarks/throughput.png) ![Cache Hit Rate & DB CPU](benchmarks/cache_cpu.png)';

    const minimalEvents = [
      {
        type: 'message_end',
        message: { role: 'assistant', content: [{ type: 'thinking', thinking: zh ? '先检查 /v1/events 路由与 SQL 查询计划，定位全表排序瓶颈并补充索引与 LRU 缓存。' : 'Inspect the /v1/events route and Postgres EXPLAIN plan to remove the filesort bottleneck with a composite index and bounded LRU cache.' }] },
      },
      {
        type: 'tool_execution_start',
        toolCallId: 'min-read-1',
        toolName: 'read',
        args: { path: 'src/routes/events.ts' },
      },
      {
        type: 'tool_execution_end',
        toolCallId: 'min-read-1',
        toolName: 'read',
        isError: false,
        durationMs: 19,
        result: { content: [{ type: 'text', text: 'export async function listEvents(orgId: string, limit = 50) { ... }' }] },
      },
      {
        type: 'tool_execution_start',
        toolCallId: 'min-read-2',
        toolName: 'read',
        args: { path: 'db/migrations/004_events.sql' },
      },
      {
        type: 'tool_execution_end',
        toolCallId: 'min-read-2',
        toolName: 'read',
        isError: false,
        durationMs: 16,
        result: { content: [{ type: 'text', text: 'CREATE TABLE events (id uuid PRIMARY KEY, org_id text NOT NULL, created_at timestamptz NOT NULL);' }] },
      },
      {
        type: 'tool_execution_start',
        toolCallId: 'min-web',
        toolName: 'web_search',
        args: { query: 'PostgreSQL composite index DESC keyset pagination' },
      },
      {
        type: 'tool_execution_end',
        toolCallId: 'min-web',
        toolName: 'web_search',
        isError: false,
        durationMs: 490,
        result: { content: [{ type: 'text', text: 'CREATE INDEX CONCURRENTLY idx_events_org_created ON events (org_id, created_at DESC) enables index-only backward scans.' }] },
      },
      {
        type: 'tool_execution_start',
        toolCallId: 'min-edit-1',
        toolName: 'edit',
        args: { path: 'db/migrations/009_events_idx.sql', oldText: '', newText: 'CREATE INDEX CONCURRENTLY idx_events_org_created ON events (org_id, created_at DESC);' },
      },
      {
        type: 'tool_execution_end',
        toolCallId: 'min-edit-1',
        toolName: 'edit',
        isError: false,
        durationMs: 26,
        result: { content: [{ type: 'text', text: 'Updated db/migrations/009_events_idx.sql' }] },
      },
      {
        type: 'tool_execution_start',
        toolCallId: 'min-edit-2',
        toolName: 'edit',
        args: { path: 'src/routes/events.ts', oldText: 'return db.query(sql, [orgId, limit]);', newText: 'return eventsCache.getOrLoad(cacheKey, () => db.query(sql, [orgId, limit]));' },
      },
      {
        type: 'tool_execution_end',
        toolCallId: 'min-edit-2',
        toolName: 'edit',
        isError: false,
        durationMs: 24,
        result: { content: [{ type: 'text', text: 'Updated src/routes/events.ts' }] },
      },
      {
        type: 'tool_execution_start',
        toolCallId: 'min-bash',
        toolName: 'bash',
        args: { command: 'npx vitest run tests/events.test.ts && npm run bench:plot' },
      },
      {
        type: 'tool_execution_end',
        toolCallId: 'min-bash',
        toolName: 'bash',
        isError: false,
        durationMs: 1620,
        result: {
          content: [{ type: 'text', text: '24 passed (24)\nSaved benchmarks/p99_latency.png, benchmarks/throughput.png, benchmarks/cache_cpu.png' }],
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
        { path: 'db/migrations/009_events_idx.sql', status: 'added', additions: 12, deletions: 0, nodes: ['task'], executionIds: ['exec-min-1'], source: 'write' },
        { path: 'src/routes/events.ts', status: 'modified', additions: 28, deletions: 6, nodes: ['task'], executionIds: ['exec-min-1'], source: 'edit' },
      ],
      totalFiles: 2,
      addedCount: 1,
      modifiedCount: 1,
      deletedCount: 0,
      renamedCount: 0,
      totalAdditions: 40,
      totalDeletions: 6,
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
          completedAt: 1764000136200,
          output: '',
          outputBytes: minimalOutputBytes,
          pid: null,
          metrics: {
            model: config.model,
            durationSeconds: 36.2,
            assistantMessages: 2,
            tools: 6,
            toolErrors: 0,
            usage: { input: 22400, output: 2310, cacheRead: 16200, cacheWrite: 0, reasoning: 760, totalTokens: 41670 },
          },
          fileChanges: minimalFileChanges,
        },
      ],
      fileChanges: minimalFileChanges,
      events: [{ sequence: 1, timestamp: 1, type: 'created' }],
    };

    // -------------------------------------------------------------------------
    // 2) Direct (detailed card mode + inline diff inspector) fixture:
    //    short crisp tool headers, Compacted card with billing badge, and a
    //    super readable TypeScript single-flight OAuth refresh diff.
    // -------------------------------------------------------------------------
    const directThinking = zh
      ? '先查阅 RFC 9700 关于 Refresh Token 轮换与并发刷新的安全建议，随后在 `src/auth/singleFlight.ts` 实现按 `sessionId` 合并的单飞锁，更新 `src/auth/session.ts` 原子写入轮换后的令牌，最后运行 `vitest` 验证并发场景。'
      : 'Verify RFC 9700 refresh token rotation guidance, add a per-session single-flight lock in `src/auth/singleFlight.ts`, update `src/auth/session.ts` to persist rotated tokens atomically before waking waiters, and run the `vitest` suite.';

    const directSearchOutput = JSON.stringify({
      provider: 'keenable',
      results: [
        {
          title: 'RFC 9700 — OAuth 2.0 Security Best Current Practice (Refresh Token Rotation)',
          url: 'https://datatracker.ietf.org/doc/html/rfc9700#section-4.14',
          snippet: 'Serialize concurrent refresh requests per client session so rotated refresh tokens are never replayed.',
        },
      ],
    }, null, 2);

    const directCompactionSummary = zh
      ? '已完成 `src/auth/session.ts` 与 RFC 9700 规范研读，保留单飞锁与令牌轮换改动上下文以执行最终并发测试。'
      : 'Completed inspection of `src/auth/session.ts` and RFC 9700 rotation guidance; retained single-flight lock and session updates for final test verification.';

    const directSummary = zh
      ? '已修复 OAuth 并发刷新竞态并全部通过回归测试：\n\n- **单飞锁（`src/auth/singleFlight.ts`）**：按 `sessionId` 合并重叠刷新调用，确保同一会话只发起一次令牌轮换。\n- **原子轮换（`src/auth/session.ts`）**：先持久化新令牌再唤醒等待请求，杜绝旧 Refresh Token 被重复消费。\n- **回归验证（`tests/auth/session.test.ts`）**：`vitest` **18 / 18** 全部通过，含 10 路并发过期令牌压测。'
      : 'Fixed the concurrent OAuth refresh race and verified with tests:\n\n- **Single-flight lock (`src/auth/singleFlight.ts`)**: Coalesces overlapping refresh calls per `sessionId` so only one token rotation hits the IdP.\n- **Safe rotation (`src/auth/session.ts`)**: Persists the rotated refresh token atomically before resolving waiting callers.\n- **Regression suite (`tests/auth/session.test.ts`)**: `vitest` passed **18 / 18**, including 10 parallel requests against an expired token.';

    const directEvents = [
      {
        type: 'message_end',
        message: { role: 'assistant', content: [{ type: 'thinking', thinking: directThinking }] },
      },
      {
        type: 'tool_execution_start',
        toolCallId: 'direct-web-search',
        toolName: 'web_search',
        args: { query: 'RFC 9700 OAuth refresh token rotation' },
      },
      {
        type: 'tool_execution_end',
        toolCallId: 'direct-web-search',
        toolName: 'web_search',
        isError: false,
        durationMs: 580,
        result: { content: [{ type: 'text', text: directSearchOutput }] },
      },
      {
        type: 'tool_execution_start',
        toolCallId: 'direct-edit-session',
        toolName: 'edit',
        args: { path: 'src/auth/session.ts', oldText: 'export async function refreshAccessToken', newText: 'export async function refreshAccessToken' },
      },
      {
        type: 'tool_execution_end',
        toolCallId: 'direct-edit-session',
        toolName: 'edit',
        isError: false,
        durationMs: 34,
        result: { content: [{ type: 'text', text: 'Successfully updated src/auth/session.ts' }] },
      },
      {
        type: 'compaction',
        reason: 'threshold',
        tokensBefore: 124600,
        estimatedTokensAfter: 18400,
        usage: { input: 11200, output: 1900, cacheRead: 0, cacheWrite: 0, cost: { total: 0.04 } },
        summary: directCompactionSummary,
        details: {
          modifiedFiles: ['src/auth/session.ts', 'src/auth/singleFlight.ts', 'tests/auth/session.test.ts'],
          readFiles: ['src/auth/store.ts', 'src/config/oauth.ts'],
        },
      },
      {
        type: 'tool_execution_start',
        toolCallId: 'direct-vitest',
        toolName: 'bash',
        args: { command: 'vitest run tests/auth/session' },
      },
      {
        type: 'tool_execution_end',
        toolCallId: 'direct-vitest',
        toolName: 'bash',
        isError: false,
        durationMs: 312,
        result: {
          content: [{ type: 'text', text: ' ✓ tests/auth/session.test.ts (18 tests) 312ms\n Test Files  1 passed (1)\n      Tests  18 passed (18)' }],
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
          path: 'src/auth/session.ts',
          status: 'modified',
          additions: 29,
          deletions: 6,
          nodes: ['task'],
          executionIds: ['exec-direct-1'],
          source: 'edit',
        },
        {
          path: 'src/auth/singleFlight.ts',
          status: 'added',
          additions: 21,
          deletions: 0,
          nodes: ['task'],
          executionIds: ['exec-direct-1'],
          source: 'write',
        },
        {
          path: 'tests/auth/session.test.ts',
          status: 'modified',
          additions: 34,
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
      totalAdditions: 84,
      totalDeletions: 10,
    };

    const directDiffs = {
      'src/auth/session.ts': {
        runId: 'demo-direct',
        path: 'src/auth/session.ts',
        oldPath: null,
        binary: false,
        truncated: false,
        hiddenLines: 0,
        lines: [
          { kind: 'hunk', text: '@@ -12,12 +12,35 @@ import { requestTokenRotation } from "./oauth";' },
          { kind: 'context', text: 'import { sessionStore } from "./store";' },
          { kind: 'added', text: 'import { SingleFlight } from "./singleFlight";' },
          { kind: 'context', text: '' },
          { kind: 'added', text: 'const refreshFlight = new SingleFlight<SessionTokens>();' },
          { kind: 'added', text: 'const SKEW_MS = 30_000;' },
          { kind: 'context', text: '' },
          { kind: 'context', text: 'export async function getValidTokens(sessionId: string) {' },
          { kind: 'context', text: '  const current = await sessionStore.get(sessionId);' },
          { kind: 'removed', text: '  if (current.expiresAt > Date.now()) return current;' },
          { kind: 'removed', text: '  const rotated = await requestTokenRotation(current.refreshToken);' },
          { kind: 'removed', text: '  await sessionStore.save(sessionId, rotated);' },
          { kind: 'removed', text: '  return rotated;' },
          { kind: 'added', text: '  if (current.expiresAt > Date.now() + SKEW_MS) {' },
          { kind: 'added', text: '    return current;' },
          { kind: 'added', text: '  }' },
          { kind: 'added', text: '' },
          { kind: 'added', text: '  // Coalesce concurrent refreshes per session (RFC 9700 §4.14).' },
          { kind: 'added', text: '  return refreshFlight.run(sessionId, async () => {' },
          { kind: 'added', text: '    const latest = await sessionStore.get(sessionId);' },
          { kind: 'added', text: '    if (latest.expiresAt > Date.now() + SKEW_MS) {' },
          { kind: 'added', text: '      return latest;' },
          { kind: 'added', text: '    }' },
          { kind: 'added', text: '    const rotated = await requestTokenRotation(latest.refreshToken);' },
          { kind: 'added', text: '    await sessionStore.saveAtomic(sessionId, {' },
          { kind: 'added', text: '      ...rotated,' },
          { kind: 'added', text: '      expectedGeneration: latest.generation,' },
          { kind: 'added', text: '    });' },
          { kind: 'added', text: '    return rotated;' },
          { kind: 'added', text: '  });' },
          { kind: 'context', text: '}' },
        ],
      },
      'src/auth/singleFlight.ts': {
        runId: 'demo-direct',
        path: 'src/auth/singleFlight.ts',
        oldPath: null,
        binary: false,
        truncated: false,
        hiddenLines: 0,
        lines: [
          { kind: 'hunk', text: '@@ -0,0 +1,21 @@' },
          { kind: 'added', text: 'export class SingleFlight<T> {' },
          { kind: 'added', text: '  private readonly inFlight = new Map<string, Promise<T>>();' },
          { kind: 'added', text: '' },
          { kind: 'added', text: '  run(key: string, task: () => Promise<T>): Promise<T> {' },
          { kind: 'added', text: '    const existing = this.inFlight.get(key);' },
          { kind: 'added', text: '    if (existing) return existing;' },
          { kind: 'added', text: '' },
          { kind: 'added', text: '    const promise = task().finally(() => {' },
          { kind: 'added', text: '      if (this.inFlight.get(key) === promise) {' },
          { kind: 'added', text: '        this.inFlight.delete(key);' },
          { kind: 'added', text: '      }' },
          { kind: 'added', text: '    });' },
          { kind: 'added', text: '    this.inFlight.set(key, promise);' },
          { kind: 'added', text: '    return promise;' },
          { kind: 'added', text: '  }' },
          { kind: 'added', text: '}' },
        ],
      },
      'tests/auth/session.test.ts': {
        runId: 'demo-direct',
        path: 'tests/auth/session.test.ts',
        oldPath: null,
        binary: false,
        truncated: false,
        hiddenLines: 0,
        lines: [
          { kind: 'hunk', text: '@@ -40,6 +40,18 @@ describe("getValidTokens", () => {' },
          { kind: 'added', text: '  it("coalesces 10 parallel refreshes into one IdP rotation", async () => {' },
          { kind: 'added', text: '    const results = await Promise.all(' },
          { kind: 'added', text: '      Array.from({ length: 10 }, () => getValidTokens("sess_42")),' },
          { kind: 'added', text: '    );' },
          { kind: 'added', text: '    expect(rotationMock).toHaveBeenCalledTimes(1);' },
          { kind: 'added', text: '    expect(new Set(results.map(r => r.accessToken)).size).toBe(1);' },
          { kind: 'added', text: '  });' },
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
          completedAt: 1764000039400,
          output: '',
          outputBytes: directOutputBytes,
          pid: null,
          metrics: {
            model: config.model,
            durationSeconds: 39.4,
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
    // 3) Clean short conversation for Shot 4 (Docked Terminal + Slash Commands)
    //    so the `/c` command palette floats cleanly in open whitespace with
    //    zero awkward text collisions behind the popup!
    // -------------------------------------------------------------------------
    const terminalSummary = zh
      ? '已为 `src/webhooks/queue.ts` 接入 `Idempotency-Key` 唯一索引与指数退避重试，`vitest` 全部通过。'
      : 'Added `Idempotency-Key` dedup & retry backoff in `src/webhooks/queue.ts` — `vitest` passed **12 / 12**.';

    const terminalEvents = [
      {
        type: 'tool_execution_start',
        toolCallId: 'term-edit',
        toolName: 'edit',
        args: { path: 'src/webhooks/queue.ts', oldText: 'dispatch(event)', newText: 'dispatchIdempotent(event)' },
      },
      {
        type: 'tool_execution_end',
        toolCallId: 'term-edit',
        toolName: 'edit',
        isError: false,
        durationMs: 28,
        result: { content: [{ type: 'text', text: 'Updated src/webhooks/queue.ts' }] },
      },
      {
        type: 'tool_execution_start',
        toolCallId: 'term-bash',
        toolName: 'bash',
        args: { command: 'npx vitest run tests/webhooks/queue.test.ts' },
      },
      {
        type: 'tool_execution_end',
        toolCallId: 'term-bash',
        toolName: 'bash',
        isError: false,
        durationMs: 280,
        result: { content: [{ type: 'text', text: '12 passed (12)' }], details: { exitCode: 0 } },
      },
      {
        type: 'message_end',
        message: { role: 'assistant', content: [{ type: 'text', text: terminalSummary }] },
      },
    ];
    const terminalOutput = terminalEvents.map(item => JSON.stringify(item)).join('\n') + '\n';
    const terminalOutputBytes = Buffer.byteLength(terminalOutput);

    const terminalSnapshot = {
      ...empty,
      runId: 'demo-terminal',
      title: terminalTitle,
      config,
      planType: 'serial',
      approved: true,
      paused: false,
      phase: 'completed',
      graph: {
        originalGoal: terminalGoal,
        nodes: [{ id: 'task', task: terminalGoal }],
        edges: [],
      },
      nodes: {
        task: { status: 'completed', revision: 1, head: 'e12c890', instruction: '', error: null },
      },
      executions: [
        {
          id: 'exec-term-1',
          node: 'task',
          revision: 1,
          attempt: 1,
          sessionId: 'demo-term-session',
          worktree: repository,
          before: '8d1e40b',
          after: 'e12c890',
          workspaceLineage: [],
          input: { instruction: terminalGoal },
          result: { summary: terminalSummary },
          status: 'completed',
          startedAt: 1763999000000,
          completedAt: 1763999021000,
          output: '',
          outputBytes: terminalOutputBytes,
          pid: null,
          metrics: {
            model: config.model,
            durationSeconds: 21.0,
            assistantMessages: 1,
            tools: 2,
            toolErrors: 0,
            usage: { input: 14200, output: 1180, cacheRead: 9800, cacheWrite: 0, reasoning: 310, totalTokens: 25490 },
          },
          fileChanges: {
            files: [
              { path: 'src/webhooks/queue.ts', status: 'modified', additions: 24, deletions: 5, nodes: ['task'], executionIds: ['exec-term-1'], source: 'edit' },
            ],
            totalFiles: 1,
            addedCount: 0,
            modifiedCount: 1,
            deletedCount: 0,
            renamedCount: 0,
            totalAdditions: 24,
            totalDeletions: 5,
          },
        },
      ],
      fileChanges: {
        files: [
          { path: 'src/webhooks/queue.ts', status: 'modified', additions: 24, deletions: 5, nodes: ['task'], executionIds: ['exec-term-1'], source: 'edit' },
        ],
        totalFiles: 1,
        addedCount: 0,
        modifiedCount: 1,
        deletedCount: 0,
        renamedCount: 0,
        totalAdditions: 24,
        totalDeletions: 5,
      },
      events: [{ sequence: 1, timestamp: 1, type: 'created' }],
    };

    // -------------------------------------------------------------------------
    // 4) Compile (multi-agent graph) fixture: crisp, universally relatable
    //    7-node, 4-batch Full-Stack Billing & Usage execution graph with
    //    Completed + Running + Waiting lanes and a bounded Feedback loop.
    // -------------------------------------------------------------------------
    const nodeSpecs = [
      [
        '01_schema_migration',
        'Define Postgres subscriptions & usage_events tables, migrations, and shared TypeScript types.',
        '定义 Postgres subscriptions 与 usage_events 表结构、迁移脚本与共享 TypeScript 类型。',
        'completed',
      ],
      [
        '02_stripe_client',
        'Build typed Stripe SDK wrapper, webhook signature verifier, and idempotent event store.',
        '封装类型安全的 Stripe 客户端、Webhook 签名校验与幂等事件存储。',
        'completed',
      ],
      [
        '03_billing_api',
        'Implement /api/billing/* endpoints for checkout sessions, plan upgrades, and invoice history.',
        '实现 /api/billing/* 接口，覆盖订阅结账、套餐升降级与账单历史查询。',
        'completed',
      ],
      [
        '04_billing_ui',
        'Build React pricing table, live usage meter charts, and self-serve billing portal views.',
        '开发 React 套餐定价表、实时用量仪表盘图表与自助账单管理页。',
        'running',
      ],
      [
        '05_usage_metering',
        'Build async usage ingestion worker, hourly rollups, and real-time quota guard middleware.',
        '构建异步用量采集 Worker、按小时聚合任务与实时配额守卫中间件。',
        'running',
      ],
      [
        '06_e2e_security_audit',
        'Run Playwright E2E & quota edge tests; send <FEEDBACK> to 05_usage_metering on drift.',
        '运行 Playwright E2E 与配额边界压测；发现偏差向 05_usage_metering 发送反馈。',
        'waiting',
      ],
      [
        '07_docs_and_release',
        'Generate OpenAPI billing spec, migration runbook, and release verification checklist.',
        '生成计费模块 OpenAPI 规范、数据库迁移手册与发布验收清单。',
        'waiting',
      ],
    ];

    const nodes = nodeSpecs.map(([id, en, cn]) => ({ id, task: zh ? cn : en }));
    const names = nodes.map(node => node.id);
    assert.equal(new Set(names).size, 7, 'demo node names must be unique');

    const dependencies = [
      ['01_schema_migration', '03_billing_api'],
      ['02_stripe_client', '03_billing_api'],
      ['01_schema_migration', '04_billing_ui'],
      ['02_stripe_client', '04_billing_ui'],
      ['01_schema_migration', '05_usage_metering'],
      ['02_stripe_client', '05_usage_metering'],
      ['03_billing_api', '06_e2e_security_audit'],
      ['04_billing_ui', '06_e2e_security_audit'],
      ['05_usage_metering', '06_e2e_security_audit'],
      ['06_e2e_security_audit', '07_docs_and_release'],
    ].map(([from, to]) => ({ from, to, feedback: false }));

    const edges = [...dependencies, { from: '06_e2e_security_audit', to: '05_usage_metering', feedback: true }];
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
    assert.deepEqual(terminals, ['07_docs_and_release']);

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
            sessionStart: '2026-11-27T09:15:00Z',
            durationSeconds: 12.6,
            assistantMessages: 2,
            tools: 3,
            toolErrors: 0,
            usage: { input: 11800, output: 1540, cacheRead: 8200, cacheWrite: 0, reasoning: 490, totalTokens: 22030 },
          },
        },
        totalPlanningDuration: 12.6,
        modelDuration: 11.4,
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
      ? '先并行完成数据库表结构迁移与 Stripe 客户端封装；随后同时展开计费 API、React 前端仪表盘与用量计量 Worker 三条独立分支；由 `06_e2e_security_audit` 统一做全栈回归与配额边界审计（发现偏差向 `05_usage_metering` 触发有界 `<FEEDBACK>`），通过后由 `07_docs_and_release` 生成文档与发布清单。'
      : 'Start by running schema migration and the Stripe client in parallel, then fan out the billing API, React dashboard, and usage metering worker concurrently. Gate delivery with `06_e2e_security_audit` (wired with bounded `<FEEDBACK>` to `05_usage_metering` on quota drift) before generating OpenAPI docs and the release runbook.';

    const bashOut = [
      'package.json',
      'db/migrations/',
      'src/api/',
      'src/workers/',
      'src/web/pages/',
    ].join('\n');

    const archDoc = [
      '# Pulse Cloud Billing Architecture',
      '- Stack: TypeScript, Postgres 16, Stripe API, React 19, Playwright E2E',
      '- Requirements: idempotent webhook handling, hourly usage rollups, strict tenant quota isolation',
    ].join('\n');

    const summaryText = zh
      ? '已编译为 **7 个节点、4 个执行批次** 的并行执行图（含 1 条有界反馈回路）并启动调度：\n\n- **基础层（`01`–`02`）**：Postgres 迁移与 Stripe 客户端均已完成。\n- **三条并行功能线（`03`–`05`）**：计费 API 已完成，React 仪表盘与用量计量 Worker 正在隔离工作区并行开发中。\n- **全栈审计与交付（`06`–`07`）**：`06_e2e_security_audit` 挂载指向 `05_usage_metering` 的有界 `<FEEDBACK>` 回路，通过后由 `07_docs_and_release` 完成文档与发布打包。'
      : 'Compiled and launched a **7-node, 4-batch** parallel execution graph with one bounded feedback loop:\n\n- **Foundation (`01`–`02`)**: Postgres schema migration and Stripe client completed.\n- **Parallel feature lanes (`03`–`05`)**: Billing API completed; React UI and usage metering worker are running concurrently in isolated workspaces.\n- **Verification & release (`06`–`07`)**: `06_e2e_security_audit` gates delivery with bounded `<FEEDBACK>` to `05_usage_metering` before `07_docs_and_release` publishes docs and the runbook.';

    const plannerEvents = [
      {
        type: 'message_end',
        message: { role: 'assistant', content: [{ type: 'thinking', thinking: thinkingText }] },
      },
      {
        type: 'tool_execution_start',
        toolCallId: 'inspect-repo',
        toolName: 'bash',
        args: { command: 'ls -la src db' },
      },
      {
        type: 'tool_execution_end',
        toolCallId: 'inspect-repo',
        toolName: 'bash',
        isError: false,
        durationMs: 72,
        result: { content: [{ type: 'text', text: bashOut }], details: { exitCode: 0 } },
      },
      {
        type: 'tool_execution_start',
        toolCallId: 'read-spec',
        toolName: 'read',
        args: { path: 'docs/BILLING_SPEC.md' },
      },
      {
        type: 'tool_execution_end',
        toolCallId: 'read-spec',
        toolName: 'read',
        isError: false,
        result: { content: [{ type: 'text', text: archDoc }] },
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
    // 5) Bundled Pi extensions, providers & slash commands fixture
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
          id: '~/.pi/agent/extensions/pr-checklist.ts',
          name: 'pr-checklist.ts',
          source: 'local',
          path: '~/.pi/agent/extensions/pr-checklist.ts',
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
          configured: true,
          authType: 'oauth',
          methods: [
            { id: 'oauth', name: 'OAuth' },
            { id: 'api_key', name: 'API key' },
          ],
        },
        {
          id: 'openai-codex',
          name: 'OpenAI Codex',
          configured: true,
          authType: 'oauth',
          methods: [
            { id: 'oauth', name: 'OAuth' },
          ],
        },
      ],
      models: [
        {
          id: 'gpt-6.2-astra',
          provider: 'openai-codex',
          name: 'GPT-6.2 Astra',
          api: 'openai-codex-responses',
          contextWindow: 272000,
          available: true,
          thinkingLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
          thinkingLevelFallbacks: {},
        },
        {
          id: 'claude-sonnet-4-5',
          provider: 'anthropic',
          name: 'Claude Sonnet 4.5',
          api: 'anthropic-messages',
          contextWindow: 200000,
          available: true,
          thinkingLevels: ['off', 'low', 'medium', 'high', 'xhigh'],
          thinkingLevelFallbacks: {},
        },
      ],
      hiddenModels: [],
      warning: null,
    };

    const slashCommands = [
      { name: 'timeout', description: zh ? '设置 Bash 工具默认超时（默认 180s）' : 'Set default bash tool timeout (default 180s)', source: 'pi-simple-timeout' },
      { name: 'pi-trim', description: zh ? '查看或切换系统提示词精简模式（default / aggressive）' : 'Switch system-prompt trim mode (default / aggressive)', source: 'pi-trim' },
      { name: 'mcp', description: zh ? '查看、登录或重连 MCP 服务器' : 'Inspect, log in, or reconnect MCP servers', source: 'builtin:mcp' },
    ];

    const terminalOutputSample = [
      '\x1b[32m➜\x1b[0m \x1b[36mpulse-cloud\x1b[0m \x1b[90mgit:(\x1b[31mmain\x1b[90m)\x1b[0m git status -s\r\n',
      ' \x1b[33mM\x1b[0m src/webhooks/queue.ts\r\n',
      ' \x1b[33mM\x1b[0m tests/webhooks/queue.test.ts\r\n',
      '\x1b[32m➜\x1b[0m \x1b[36mpulse-cloud\x1b[0m \x1b[90mgit:(\x1b[31mmain\x1b[90m)\x1b[0m vitest run tests/webhooks/queue.test.ts\r\n',
      ' \x1b[32m✓\x1b[0m tests/webhooks/queue.test.ts \x1b[90m(12 tests)\x1b[0m \x1b[33m248ms\x1b[0m\r\n',
      ' \x1b[1;32mTest Files\x1b[0m  \x1b[1;32m1 passed\x1b[0m \x1b[90m(1)\x1b[0m   \x1b[1;32mTests\x1b[0m  \x1b[1;32m12 passed\x1b[0m \x1b[90m(12)\x1b[0m\r\n',
      '\x1b[32m➜\x1b[0m \x1b[36mpulse-cloud\x1b[0m \x1b[90mgit:(\x1b[31mmain\x1b[90m)\x1b[0m ',
    ].join('');

    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1.5,
      locale: zh ? 'zh-CN' : 'en-US',
      reducedMotion: 'reduce',
      colorScheme: 'light',
    });

    await context.addInitScript(({
      lang,
      repository,
      secondaryRepository,
      dataPath,
      config,
      graphTitle,
      minimalTitle,
      directTitle,
      terminalTitle,
      terminalOutputSample,
    }) => {
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

      const setScoped = (key, val) => {
        const json = JSON.stringify(val);
        localStorage.setItem(`pi-n-format-1:${dataPath}:${key}`, json);
        localStorage.setItem(`pi-n-format-1::${key}`, json);
        localStorage.setItem(key, json);
      };

      localStorage.setItem('pi_n_data_path', dataPath);
      localStorage.setItem('pi_n_language_v1', lang);
      localStorage.setItem('pi_n_plan_mode', 'serial');
      localStorage.setItem('pi_n_landing_background_v1', 'grid');
      localStorage.setItem('pi_n_collapse_cards_v1', '0');
      localStorage.setItem('pi_n_projects', JSON.stringify([
        {
          id: repository,
          path: repository,
          name: 'pulse-cloud',
          branch: 'main',
          clean: true,
          lastOpened: 2,
        },
        {
          id: secondaryRepository,
          path: secondaryRepository,
          name: 'pulse-docs',
          branch: 'main',
          clean: true,
          lastOpened: 1,
        },
      ]));
      setScoped('pi_n_workspace_runs', {
        [repository]: ['demo-graph', 'demo-minimal', 'demo-direct', 'demo-terminal'],
      });
      setScoped('pi_n_pinned_runs', {
        'demo-graph': 'coral',
        'demo-minimal': 'yellow',
      });
      setScoped('pi_n_run_labels', {
        'demo-graph': graphTitle,
        'demo-minimal': minimalTitle,
        'demo-direct': directTitle,
        'demo-terminal': terminalTitle,
      });
      setScoped('pi_n_config', config);
      localStorage.setItem('pi_n_workbench_split_ratio', '0.52');
      localStorage.setItem('pi_n_changes_split_ratio', '0.52');
    }, {
      lang,
      repository,
      secondaryRepository,
      dataPath,
      config,
      graphTitle,
      minimalTitle,
      directTitle,
      terminalTitle,
      terminalOutputSample,
    });

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
            runs: ['demo-graph', 'demo-minimal', 'demo-direct', 'demo-terminal'],
            conversations: [
              {
                runId: 'demo-graph',
                repository,
                title: graphTitle,
                planType: 'graph',
                phase: 'running',
                hasActiveExecutions: true,
              },
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
                runId: 'demo-terminal',
                repository,
                title: terminalTitle,
                planType: 'serial',
                phase: 'completed',
                hasActiveExecutions: false,
              },
            ],
            repositoryInfo: repoInfo,
            dataPath,
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
                : body.runId === 'demo-terminal'
                  ? terminalSnapshot
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
                  : body.runId === 'demo-terminal'
                    ? terminalSnapshot
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
          const isTerm = body.runId === 'demo-terminal' || body.executionId === 'exec-term-1';
          const out = isMin ? minimalOutput : isTerm ? terminalOutput : directOutput;
          const total = isMin ? minimalOutputBytes : isTerm ? terminalOutputBytes : directOutputBytes;
          result = {
            runId: body.runId || 'demo-direct',
            executionId: body.executionId || (isMin ? 'exec-min-1' : isTerm ? 'exec-term-1' : 'exec-direct-1'),
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
                : body.runId === 'demo-terminal'
                  ? terminalSnapshot.fileChanges
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
          result = { files: ['src/auth/session.ts', 'src/auth/singleFlight.ts', 'tests/auth/session.test.ts'] };
          break;
        case 'list_skills':
          result = { skills: [{ name: 'deploy-preview', description: zh ? '运行预发环境部署与冒烟验证' : 'Deploy preview build and run smoke tests' }] };
          break;
        case 'provider_auth':
          result = body.operation === 'model_visibility'
            ? { hiddenModels: [] }
            : providerCatalog;
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
    await page.locator('.landing-screen [data-testid="composer-model-selector"]').filter({ hasText: 'GPT-6.2 Astra' }).waitFor();
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
    await page.waitForFunction(() => {
      const imgs = [...document.querySelectorAll('.markdown-image-stack img')];
      return imgs.length === 3 && imgs.every(img => img.complete && img.naturalWidth > 0);
    });
    await page.mouse.move(10, 10);
    await page.waitForTimeout(250);
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
    // Shot 3: Settings -> 4 Bundled Plugins (over clean minimal workbench)
    // -------------------------------------------------------------------------
    await page.locator('[data-run-id="demo-terminal"]').click();
    await page.locator('[data-testid="activity-summary-row"]').first().waitFor();
    await page.waitForTimeout(250);
    await page.locator('.sidebar-bottom-btn').click();
    await page.locator('.settings-modal').waitFor();
    await page.locator('.extension-settings .extension-settings-row').first().waitFor();
    await page.waitForTimeout(500);
    const alignExtensionsCard = () => page.locator('.settings-modal-content .settings-sections').evaluate(el => {
      const card = el.querySelector('.extension-settings');
      if (!card) return;
      const scrollerRect = el.getBoundingClientRect();
      const cardRect = card.getBoundingClientRect();
      const centerPad = Math.max(14, Math.floor((scrollerRect.height - cardRect.height) / 2));
      const delta = cardRect.top - scrollerRect.top;
      el.scrollTop = Math.max(0, el.scrollTop + delta - centerPad);
    });
    await alignExtensionsCard();
    await page.waitForTimeout(200);
    await alignExtensionsCard();
    await page.waitForTimeout(150);
    await page.screenshot({ path: `assets/readme-plugins${zh ? '-zh' : ''}.png`, animations: 'disabled' });
    await page.locator('.settings-modal-header .icon-button').click();
    await page.waitForTimeout(250);

    // -------------------------------------------------------------------------
    // Shot 4: Docked Workspace Terminal + Pi Slash Commands (clean spacious view)
    // -------------------------------------------------------------------------
    await page.waitForTimeout(150);
    const terminalBtn = page.locator('.pane-bottom-chat button[aria-label*="终端"], .pane-bottom-chat button[aria-label*="terminal" i]').first();
    await terminalBtn.click();
    await page.locator('.workspace-terminal-dock').waitFor();
    await page.locator('.xterm-rows').waitFor();
    await page.waitForTimeout(450);
    const composerInput = page.locator('.pane-bottom-chat textarea').first();
    await composerInput.click();
    await composerInput.fill('/c');
    await page.locator('.prompt-box-suggestion-item').first().waitFor();
    await page.waitForTimeout(350);
    await page.locator('.initial-query-scroll').evaluate(el => { el.scrollTop = 0; });
    await page.waitForTimeout(150);
    await page.screenshot({ path: `assets/readme-terminal${zh ? '-zh' : ''}.png`, animations: 'disabled' });

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
    await page.locator('[data-run-id="demo-direct"]').click();
    await page.locator('[data-testid="collapse-cards-trigger"]').waitFor();
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
