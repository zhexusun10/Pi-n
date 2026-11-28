import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { VirtualizedTranscript } from "../src/components/VirtualizedTranscript.tsx";
import { CompactedCard } from "../src/components/CompactedCard.tsx";
import { ActivitySummaryRow } from "../src/components/ActivitySummaryRow.tsx";
import { TranscriptNoticeCard } from "../src/components/TranscriptNoticeCard.tsx";
import { parseTranscriptChunkLines, type ParseTranscriptChunkState } from "../src/services/transcriptParser.ts";
import { visibleTranscriptRows } from "../src/services/transcriptLayout.ts";
import { translate } from "../src/i18n/index.ts";
import { summarizeActivityGroup } from "../src/services/activitySummary.ts";
import {
  applyPlannerAssistantMessageEnd,
  applyPlannerCompaction,
  applyPlannerEntryAppended,
  initialPlannerStream,
} from "../src/services/plannerStream.ts";

const line = (event: unknown) => JSON.stringify(event) + "\n";

const freshState = (): ParseTranscriptChunkState => ({
  source: "output",
  byteOffset: 0,
  leadingFragment: false,
  inTagThinking: false,
  inFinalResponse: false,
  finalResponseSuppressed: false,
  seenFirstUser: false,
  pendingUserStart: false,
  assistantStartIndex: 0,
  userMessageStarts: new Set<string>(),
  compacting: false,
});

const parse = (events: unknown[], state = freshState()) =>
  parseTranscriptChunkLines(
    events.map(line),
    [],
    new Map(),
    state,
    { showUserTurns: false, skipFirstUser: false },
  );

test("compaction_start marks the parse state and renders no chat rows", () => {
  const state = freshState();
  const result = parse([
    { type: "session", sessionId: "s1" },
    { type: "compaction_start", reason: "threshold" },
  ], state);
  assert.equal(state.compacting, true);
  assert.equal(result.currentItems.length, 0);
});

test("compaction_end clears the marker even when the result carries errors", () => {
  const state = freshState();
  parse([{ type: "compaction_start", reason: "overflow" }], state);
  assert.equal(state.compacting, true);
  parse([{ type: "compaction_end", reason: "overflow", aborted: false, willRetry: false }], state);
  assert.equal(state.compacting, false);
});

test("a compaction cycle between turns leaves the state cleared", () => {
  const state = freshState();
  parse([
    { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "before" }] } },
    { type: "compaction_start", reason: "threshold" },
    { type: "compaction_end", reason: "threshold", aborted: false, willRetry: false },
    { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "after" }] } },
  ], state);
  assert.equal(state.compacting, false);
  assert.equal(state.seenFirstUser, false);
});

test("process exit clears a compaction that never completed", () => {
  const state = freshState();
  parse([{ type: "compaction_start", reason: "threshold" }], state);
  assert.equal(state.compacting, true);
  parse([{ type: "pi_n_process_exited", success: false }], state);
  assert.equal(state.compacting, false);
});

test("compaction events alone render exactly like an empty transcript", () => {
  const render = (output: string) => renderToStaticMarkup(createElement(VirtualizedTranscript, {
    output, inline: true, emptyText: "",
  }));
  const empty = render("");
  const compaction = render([
    line({ type: "session", sessionId: "s1" }),
    line({ type: "compaction_start", reason: "threshold" }),
    line({ type: "compaction_end", reason: "threshold", aborted: false, willRetry: false }),
  ].join(""));
  assert.equal(compaction, empty);
});

test("successful compaction_end emits a Compacted card with Pi summary, tokens, reason, and tracked files", () => {
  const state = freshState();
  const result = parse([
    { type: "compaction_start", reason: "threshold" },
    {
      type: "compaction_end",
      reason: "threshold",
      aborted: false,
      willRetry: false,
      result: {
        summary: "## Goal\nFinish refactor\n\n## Progress\n- Updated parser",
        firstKeptEntryId: "entry-42",
        tokensBefore: 128400,
        estimatedTokensAfter: 18200,
        details: {
          readFiles: ["src/types.ts"],
          modifiedFiles: ["src/services/transcriptParser.ts"],
        },
      },
    },
  ], state);
  assert.equal(state.compacting, false);
  assert.equal(result.currentItems.length, 1);
  const item = result.currentItems[0];
  assert.equal(item.type, "compaction");
  assert.deepEqual(item.compaction, {
    reason: "threshold",
    tokensBefore: 128400,
    tokensAfter: 18200,
    summary: "## Goal\nFinish refactor\n\n## Progress\n- Updated parser",
    firstKeptEntryId: "entry-42",
    readFiles: ["src/types.ts"],
    modifiedFiles: ["src/services/transcriptParser.ts"],
  });

  const collapsedHtml = renderToStaticMarkup(createElement(CompactedCard, { item }));
  assert.match(collapsedHtml, /compacted-card collapsed/);
  assert.match(collapsedHtml, /<span class="compacted-title">Compacted<\/span>/);
  assert.match(collapsedHtml, /128\.4k → 18\.2k tokens/);
  assert.doesNotMatch(collapsedHtml, /compacted-card-body/);
  assert.doesNotMatch(collapsedHtml, /data-transcript-id=/);
  assert.doesNotMatch(collapsedHtml, /\stitle=/);

  const expandedHtml = renderToStaticMarkup(createElement(CompactedCard, { item, defaultExpanded: true }));
  assert.match(expandedHtml, /compacted-card expanded/);
  assert.match(expandedHtml, /compacted-card-body/);
  assert.match(expandedHtml, /Finish refactor/);
  assert.match(expandedHtml, /src\/services\/transcriptParser\.ts/);
  assert.match(expandedHtml, /src\/types\.ts/);
});

test("aborted compaction_end clears compacting without emitting a Compacted card", () => {
  const state = freshState();
  const result = parse([
    { type: "compaction_start", reason: "manual" },
    {
      type: "compaction_end",
      reason: "manual",
      aborted: true,
      willRetry: false,
      result: { summary: "should not appear", firstKeptEntryId: "e1", tokensBefore: 50000 },
    },
  ], state);
  assert.equal(state.compacting, false);
  assert.equal(result.currentItems.length, 0);
});

test("persisted session JSONL compaction entry renders a Compacted card in transcript replay", () => {
  const output = [
    line({ type: "session", version: 3, id: "sess-1" }),
    line({
      type: "compaction",
      id: "cmp-1",
      parentId: "m-10",
      timestamp: "2026-04-01T00:00:00.000Z",
      summary: "Compacted earlier history.",
      firstKeptEntryId: "m-11",
      tokensBefore: 95000,
      details: { modifiedFiles: ["src/App.tsx"] },
    }),
  ].join("");
  const html = renderToStaticMarkup(createElement(VirtualizedTranscript, {
    output, inline: true, settled: true, emptyText: "",
  }));
  assert.match(html, /compacted-card collapsed/);
  assert.match(html, /Compacted/);
  assert.match(html, /95k tokens/);
  assert.equal((html.match(/data-transcript-id="/g) ?? []).length, 1);
});

test("compaction file lists deduplicate repeated paths while preserving order", () => {
  const state = freshState();
  const result = parse([
    {
      type: "compaction",
      summary: "Deduped files",
      tokensBefore: 12000,
      details: {
        readFiles: ["src/a.ts", " src/b.ts ", "src/a.ts", ""],
        modifiedFiles: ["src/m.ts", "src/m.ts", "src/n.ts"],
      },
    },
  ], state);
  assert.deepEqual(result.currentItems[0].compaction?.readFiles, ["src/a.ts", "src/b.ts"]);
  assert.deepEqual(result.currentItems[0].compaction?.modifiedFiles, ["src/m.ts", "src/n.ts"]);
});

test("applyPlannerCompaction toggles compacting and appends a live Compacted card", () => {
  const started = applyPlannerCompaction(initialPlannerStream, { type: "compaction_start", reason: "overflow" });
  assert.equal(started.compacting, true);
  assert.equal(started.items.length, 0);

  const ended = applyPlannerCompaction(started, {
    type: "compaction_end",
    reason: "overflow",
    aborted: false,
    willRetry: true,
    result: {
      summary: "Recovered from overflow.",
      firstKeptEntryId: "p-3",
      tokensBefore: 190000,
    },
  });
  assert.equal(ended.compacting, false);
  assert.equal(ended.items.length, 1);
  assert.equal(ended.items[0].type, "compaction");
  assert.equal(ended.items[0].animateAppear, true);
  assert.equal(ended.items[0].compaction?.reason, "overflow");
  assert.equal(ended.items[0].compaction?.tokensBefore, 190000);
});

test("compaction billing folds into CompactedCard and honors showCost", () => {
  const state = freshState();
  const result = parse([
    {
      type: "compaction_end",
      reason: "threshold",
      aborted: false,
      willRetry: false,
      result: {
        summary: "Compacted history with usage.",
        firstKeptEntryId: "entry-9",
        tokensBefore: 128400,
        estimatedTokensAfter: 18200,
        usage: {
          input: 28000,
          output: 2200,
          cacheRead: 4000,
          cacheWrite: 0,
          cost: { input: 0.11, output: 0.03, cacheRead: 0.002, cacheWrite: 0, total: 0.142 },
        },
      },
    },
  ], state);
  assert.equal(result.currentItems.length, 1);
  assert.equal(result.currentItems[0].compaction?.billedTokens, 34200);
  assert.equal(result.currentItems[0].compaction?.billedCost, 0.142);

  const shownHtml = renderToStaticMarkup(createElement(CompactedCard, { item: result.currentItems[0], showCost: true }));
  assert.match(shownHtml, /compacted-billing/);
  assert.match(shownHtml, /34\.2k/);
  assert.match(shownHtml, /~\$0\.14/);

  const hiddenHtml = renderToStaticMarkup(createElement(CompactedCard, { item: result.currentItems[0], showCost: false }));
  assert.doesNotMatch(hiddenHtml, /compacted-billing/);
});

test("cache miss, reasoning drop (deduped), and collapsed cache warming notices render separately from errors", () => {
  const t0 = Date.parse("2026-11-26T06:00:00.000Z");
  const t1 = Date.parse("2026-11-26T06:08:00.000Z");
  const output = [
    line({
      type: "message_end",
      message: {
        role: "assistant",
        provider: "openai",
        model: "gpt-6.2-sol",
        timestamp: t0,
        content: [{ type: "text", text: "Turn 1 answer." }],
        usage: {
          input: 10000,
          output: 400,
          cacheRead: 50000,
          cacheWrite: 0,
          cost: { input: 0.02, output: 0.004, cacheRead: 0.005, cacheWrite: 0, total: 0.029 },
        },
      },
    }),
    line({
      type: "message_end",
      message: {
        role: "assistant",
        provider: "openai",
        model: "gpt-6.2-sol",
        timestamp: t1,
        content: [{ type: "text", text: "Turn 2 answer after idle." }],
        diagnostics: [
          {
            type: "openai_input_transformations",
            details: {
              transformations: [
                { type: "reasoning", reason: "prefix_mismatch" },
                { type: "reasoning", reason: "prefix_mismatch" },
              ],
            },
          },
        ],
        usage: {
          input: 64000,
          output: 500,
          cacheRead: 0,
          cacheWrite: 0,
          cost: { input: 0.16, output: 0.005, cacheRead: 0, cacheWrite: 0, total: 0.165 },
        },
      },
    }),
    line({
      type: "message_end",
      message: {
        role: "assistant",
        provider: "openai",
        model: "gpt-6.2-sol",
        timestamp: t1 + 30_000,
        content: [{ type: "text", text: "Turn 3 answer." }],
        diagnostics: [
          {
            type: "openai_input_transformations",
            details: {
              transformations: [
                { type: "reasoning", reason: "prefix_mismatch" },
                { type: "reasoning", reason: "prefix_mismatch" },
              ],
            },
          },
        ],
        usage: {
          input: 1000,
          output: 200,
          cacheRead: 64000,
          cacheWrite: 0,
          cost: { input: 0.002, output: 0.002, cacheRead: 0.006, cacheWrite: 0, total: 0.01 },
        },
      },
    }),
    line({
      type: "entry_appended",
      entry: {
        type: "usage",
        kind: "cache_warm",
        provider: "anthropic",
        model: "claude-sonnet-5-5",
        timestamp: "2026-11-26T06:12:00.000Z",
        note: "idle keep-alive",
        usage: { input: 200, output: 1, cacheRead: 40000, cacheWrite: 0, cost: { total: 0.012 } },
      },
    }),
    line({
      type: "entry_appended",
      entry: {
        type: "usage",
        kind: "cache_warm",
        provider: "anthropic",
        model: "claude-sonnet-5-5",
        timestamp: "2026-11-26T06:16:00.000Z",
        note: "idle keep-alive",
        usage: { input: 200, output: 1, cacheRead: 40000, cacheWrite: 0, cost: { total: 0.013 } },
      },
    }),
  ].join("");

  // Shown directly by default when cards are expanded.
  const shownHtml = renderToStaticMarkup(createElement(VirtualizedTranscript, {
    output, inline: true, settled: true, emptyText: "", cardsCollapsed: false,
  }));
  assert.doesNotMatch(shownHtml, /transcript-error-card/);
  assert.equal((shownHtml.match(/data-notice-kind="reasoning_drop"/g) ?? []).length, 1, "deduped repeated drop");
  assert.equal((shownHtml.match(/data-notice-kind="cache_miss"/g) ?? []).length, 1);
  assert.equal((shownHtml.match(/data-notice-kind="cache_warming"/g) ?? []).length, 1, "merged adjacent warmings");
  assert.match(shownHtml, /prefix_mismatch/);
  assert.match(shownHtml, /60k/);
  assert.match(shownHtml, /~\$0\.15/);
  assert.match(shownHtml, /~\$0\.03/);

  // Hidden automatically when cards are collapsed ("收起卡片").
  const collapsedHtml = renderToStaticMarkup(createElement(VirtualizedTranscript, {
    output, inline: true, settled: true, emptyText: "", cardsCollapsed: true,
  }));
  assert.doesNotMatch(collapsedHtml, /transcript-notice-card/);
  assert.doesNotMatch(collapsedHtml, /transcript-error-card/);

  const expandedNoticeHtml = renderToStaticMarkup(createElement(TranscriptNoticeCard, {
    expanded: true,
    item: {
      id: "n1",
      type: "notice",
      role: "system",
      notice: { kind: "reasoning_drop", provider: "OpenAI", droppedCount: 2, droppedNoun: "reasoning", reasons: ["prefix_mismatch"] },
    },
  }));
  assert.match(expandedNoticeHtml, /transcript-notice-body/);
  assert.match(expandedNoticeHtml, /prefix_mismatch/);
});

test("live Planner stream collects reasoning drop, cache miss, and cache warm notices without creating errors", () => {
  const s1 = applyPlannerAssistantMessageEnd(initialPlannerStream, {
    role: "assistant",
    provider: "anthropic",
    model: "claude-sonnet-5-5",
    timestamp: 1_000_000,
    content: [{ type: "text", text: "Step 1" }],
    usage: { input: 5000, output: 100, cacheRead: 45000, cacheWrite: 0, cost: { input: 0.015, output: 0.001, cacheRead: 0.0135, cacheWrite: 0, total: 0.03 } },
  });
  const s2 = applyPlannerAssistantMessageEnd(s1, {
    role: "assistant",
    provider: "openai",
    model: "gpt-6.2-sol",
    timestamp: 1_060_000,
    content: [{ type: "text", text: "Step 2" }],
    diagnostics: [{ type: "openai_input_transformations", details: { transformations: [{ type: "reasoning", reason: "prefix_mismatch" }] } }],
    usage: { input: 50000, output: 100, cacheRead: 0, cacheWrite: 0, cost: { input: 0.15, output: 0.001, cacheRead: 0, cacheWrite: 0, total: 0.151 } },
  });
  const s3 = applyPlannerEntryAppended(s2, {
    type: "entry_appended",
    entry: { type: "usage", kind: "cache_warm", provider: "openai", model: "gpt-6.2-sol", timestamp: "2026-11-26T06:20:00.000Z", usage: { input: 100, output: 0, cacheRead: 50000, cacheWrite: 0, cost: { total: 0.02 } } },
  });
  const notices = s3.items.filter(item => item.type === "notice");
  assert.deepEqual(notices.map(n => n.notice?.kind), ["reasoning_drop", "cache_miss", "cache_warming"]);
  assert.equal(notices[1].notice?.modelChanged, true);
  assert.equal(s3.items.some(item => item.isError || item.status === "error"), false);
});

test("compaction strips Pi-appended read-files/modified-files XML blocks without duplicating them in CompactedCard", () => {
  const state = freshState();
  const result = parse([
    {
      type: "compaction_end",
      reason: "threshold",
      aborted: false,
      willRetry: false,
      result: {
        summary: [
          "No prior history.",
          "",
          "---",
          "",
          "**Turn Context (split turn):**",
          "",
          "## Original Request",
          "Inspect repository structure.",
          "",
          "<read-files>",
          "CHANGELOG.md",
          "src/App.tsx",
          "</read-files>",
          "",
          "<modified-files>",
          "src/services/compactionEvent.ts",
          "</modified-files>",
        ].join("\n"),
        firstKeptEntryId: "entry-99",
        tokensBefore: 160000,
        details: {
          readFiles: ["CHANGELOG.md", "src/App.tsx"],
          modifiedFiles: ["src/services/compactionEvent.ts"],
        },
      },
    },
  ], state);

  assert.equal(result.currentItems.length, 1);
  const item = result.currentItems[0];
  assert.doesNotMatch(item.compaction?.summary ?? "", /<read-files>|<modified-files>|CHANGELOG\.md/);
  assert.match(item.compaction?.summary ?? "", /Inspect repository structure\./);

  const expandedHtml = renderToStaticMarkup(createElement(CompactedCard, { item, defaultExpanded: true }));
  assert.equal((expandedHtml.match(/CHANGELOG\.md/g) ?? []).length, 1);
  assert.equal((expandedHtml.match(/src\/App\.tsx/g) ?? []).length, 1);
  assert.equal((expandedHtml.match(/src\/services\/compactionEvent\.ts/g) ?? []).length, 1);
});

test("compaction file-section stripping handles split-turn mid-summary blocks, missing details fallback, and fenced code examples", () => {
  const state = freshState();
  const result = parse([
    {
      type: "compaction",
      summary: [
        "Earlier summary.",
        "",
        "<read-files>",
        "old-only.ts",
        "</read-files>",
        "",
        "---",
        "",
        "Example inside code fence:",
        "```xml",
        "<read-files>",
        "docs/example.md",
        "</read-files>",
        "```",
        "",
        "<read-files>",
        "a.ts",
        "b.ts",
        "</read-files>",
        "",
        "<modified-files>",
        "b.ts",
        "</modified-files>",
      ].join("\n"),
      tokensBefore: 42000,
    },
  ], state);

  const compaction = result.currentItems[0].compaction;
  assert.ok(compaction);
  assert.match(compaction.summary, /docs\/example\.md/);
  assert.doesNotMatch(compaction.summary, /old-only\.ts/);
  assert.doesNotMatch(compaction.summary, /\ba\.ts\b/);
  assert.deepEqual(compaction.modifiedFiles, ["b.ts"]);
  assert.deepEqual(compaction.readFiles, ["old-only.ts", "a.ts"]);

  // Explicit empty details.readFiles stays authoritative even when summary had a stale tag.
  const authoritative = parse([
    {
      type: "compaction",
      summary: "Summary text\n\n<read-files>\nstale.ts\n</read-files>",
      tokensBefore: 10000,
      details: { readFiles: [], modifiedFiles: ["stale.ts"] },
    },
  ], freshState());
  assert.equal(authoritative.currentItems[0].compaction?.summary, "Summary text");
  assert.equal(authoritative.currentItems[0].compaction?.readFiles, undefined);
  assert.deepEqual(authoritative.currentItems[0].compaction?.modifiedFiles, ["stale.ts"]);
});

test("collapsed-cards mode folds compaction cards into ActivitySummaryRow and renders CompactedCard inside", () => {
  const compactionItem = parse([
    {
      type: "compaction_end",
      reason: "threshold",
      aborted: false,
      willRetry: false,
      result: {
        summary: "Earlier history compacted.",
        firstKeptEntryId: "entry-12",
        tokensBefore: 120000,
        estimatedTokensAfter: 20000,
        usage: {
          input: 10000,
          output: 1000,
          cacheRead: 0,
          cacheWrite: 0,
          cost: { input: 0.03, output: 0.01, cacheRead: 0, cacheWrite: 0, total: 0.04 },
        },
      },
    },
  ], freshState()).currentItems[0];

  const rows = [
    { id: "tool_1", type: "tool_call" as const, role: "assistant" as const, toolCallId: "tc-1", toolName: "read", args: { path: "src/a.ts" }, status: "success" as const },
    compactionItem,
    { id: "tool_2", type: "tool_call" as const, role: "assistant" as const, toolCallId: "tc-2", toolName: "read", args: { path: "src/b.ts" }, status: "success" as const },
    { id: "text_1", type: "text" as const, role: "assistant" as const, content: "Done.", status: "success" as const },
  ];

  const collapsed = visibleTranscriptRows(rows, undefined, { collapseCards: true, live: false, canPrepend: false });
  assert.equal(collapsed.rows.length, 2);
  assert.equal(collapsed.rows[0].type, "activity_summary");
  assert.equal(collapsed.rows[1].id, "text_1");
  assert.deepEqual(collapsed.rows[0].summaryItems?.map(item => item.type), ["tool_call", "compaction", "tool_call"]);

  const zh = (key: string, ...values: unknown[]) => key.replace(/\{(\d+)\}/g, (_, i) => String(values[Number(i)] ?? ""));
  const en = (key: string, ...values: unknown[]) => translate("en", key, ...values);
  const mixedSummary = summarizeActivityGroup(collapsed.rows[0].summaryItems ?? [], zh);
  assert.equal(mixedSummary.text, "已浏览 2 个文件 · 已压缩上下文");
  assert.equal(summarizeActivityGroup(collapsed.rows[0].summaryItems ?? [], en).text, "Viewed 2 files · Compacted context");

  const soloSummary = summarizeActivityGroup([compactionItem], zh);
  assert.equal(soloSummary.icon, "compaction");
  assert.equal(soloSummary.text, "已压缩上下文");
  assert.equal(summarizeActivityGroup([compactionItem], en).text, "Compacted context");

  const expandedHiddenCost = renderToStaticMarkup(createElement(ActivitySummaryRow, {
    item: collapsed.rows[0],
    expanded: true,
    showNotices: false,
  }));
  assert.match(expandedHiddenCost, /compacted-card/);
  assert.match(expandedHiddenCost, /120k → 20k tokens/);
  assert.doesNotMatch(expandedHiddenCost, /compacted-billing/);

  const expandedShownCost = renderToStaticMarkup(createElement(ActivitySummaryRow, {
    item: collapsed.rows[0],
    expanded: true,
    showNotices: true,
  }));
  assert.match(expandedShownCost, /compacted-billing/);
});
