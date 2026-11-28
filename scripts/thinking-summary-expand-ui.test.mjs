import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { createServer } from "vite";
import { connectOrLaunchBrowser } from "./fixtures/ui-browser.mjs";

let server, browser, origin;

before(async () => {
  server = await createServer({
    cacheDir: "node_modules/.vite-thinking-summary-expand",
    server: { host: "127.0.0.1", port: 0, strictPort: false, open: false, hmr: false, watch: null },
    plugins: [{
      name: "thinking-summary-expand-fixture",
      configureServer(viteServer) {
        viteServer.middlewares.use(async (req, res, next) => {
          if (req.url?.startsWith("/__audit")) {
            res.setHeader("Content-Type", "text/html");
            res.end(await viteServer.transformIndexHtml(
              req.url,
              '<html><body><div id="root" style="padding:160px 32px"></div><script type="module" src="/scripts/fixtures/frontend-audit.tsx"></script></body></html>',
            ));
            return;
          }
          if (req.url?.startsWith("/__changes")) {
            res.setHeader("Content-Type", "text/html");
            res.end(await viteServer.transformIndexHtml(
              req.url,
              '<html><body style="margin:0"><div id="root"></div><script type="module" src="/scripts/fixtures/workspace-changes.tsx"></script></body></html>',
            ));
            return;
          }
          return next();
        });
      },
    }],
  });
  await server.listen();
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await connectOrLaunchBrowser();
});

after(async () => {
  await browser?.close();
  server?.httpServer?.closeAllConnections?.();
  await server?.close();
});

async function openThinkingFixture() {
  const context = await browser.newContext({
    viewport: { width: 1200, height: 800 },
    locale: "en-US",
    reducedMotion: "no-preference",
  });
  await context.addInitScript(() => {
    localStorage.setItem("pi_n_language_v1", "en");
    localStorage.setItem("pi_n_auto_expand_cot_v1", "1");
  });
  const errors = [];
  const page = await context.newPage();
  page.setDefaultTimeout(8_000);
  page.on("pageerror", error => errors.push(String(error)));
  await page.goto(`${origin}/__audit?case=thinking`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof window.audit?.append === "function");
  return { context, page, errors };
}

test("expanding a collapsed activity summary strip after thinking ended renders settled full text without replaying typewriter", { timeout: 25_000 }, async () => {
  const { context, page, errors } = await openThinkingFixture();
  try {
    const initialDelta = "Initial thought fragment. ".repeat(12);
    const tailDelta = "Finished reasoning step. ".repeat(60) + "FINAL_SETTLED_MARKER";

    // 1. Stream thinking while expanded so ThinkingCard mounts and starts typing.
    await page.evaluate(delta => {
      window.audit.append({ type: "message_start", message: { role: "assistant", content: [] } });
      window.audit.append({ type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } });
      window.audit.append({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta } });
    }, initialDelta);

    const historyView = page.locator('[data-thinking-view="history"]');
    await historyView.locator(".thinking-card.streaming .thinking-card-body").waitFor();

    // 2. Collapse into an ActivitySummaryRow while still streaming (unmounts ThinkingCard).
    await page.evaluate(() => window.audit.setCardsCollapsed(true));
    const summaryTrigger = historyView.getByTestId("activity-summary-trigger").first();
    await summaryTrigger.waitFor();

    // 3. Complete the thinking block while it is hidden inside the collapsed summary strip.
    await page.evaluate(({ initial, tail }) => {
      window.audit.append({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: tail } });
      window.audit.append({ type: "message_update", assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: initial + tail } });
      window.audit.append({ type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking: initial + tail }] } });
    }, { initial: initialDelta, tail: tailDelta });
    await page.waitForTimeout(120);

    // 4. Expand the summary strip long after thinking finished.
    await summaryTrigger.click();
    const card = historyView.locator('[data-testid="activity-summary-cards"] .thinking-card').first();
    await card.waitFor();
    if (!(await card.locator(".thinking-card-body").count())) {
      await card.locator(".thinking-card-header").click();
      await card.locator(".thinking-card-body").waitFor();
    }

    const state = await card.evaluate(el => ({
      className: el.className,
      hasPulse: Boolean(el.querySelector(".thinking-icon-box.pulse")),
      hasStatus: Boolean(el.querySelector(".thinking-status.streaming")),
      hasCursor: Boolean(el.querySelector(".thinking-streaming-cursor")),
      hasFinal: (el.querySelector(".thinking-card-body")?.textContent ?? "").includes("FINAL_SETTLED_MARKER"),
    }));
    assert.equal(state.hasFinal, true, `expected complete thinking text immediately on expand: ${JSON.stringify(state)}`);
    assert.match(state.className, /\bsettled\b/, `settled thinking card must not re-enter streaming: ${JSON.stringify(state)}`);
    assert.doesNotMatch(state.className, /\bstreaming\b/, `settled thinking card must not carry streaming class: ${JSON.stringify(state)}`);
    assert.equal(state.hasPulse, false, "settled thinking card must not pulse");
    assert.equal(state.hasStatus, false, "settled thinking card must not show Thinking... pill");
    assert.equal(state.hasCursor, false, "settled thinking card must not show typing cursor");
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("expanding a folded ThinkingCard or hydrating a short settled thinking block never replays streaming output", { timeout: 25_000 }, async () => {
  const { context, page, errors } = await openThinkingFixture();
  try {
    // Part A: folded mounted ThinkingCard finishes streaming, then user expands it.
    const longTail = "Queued while folded. ".repeat(55) + "FOLDED_FINAL_MARKER";
    await page.evaluate(() => {
      window.audit.append({ type: "message_start", message: { role: "assistant", content: [] } });
      window.audit.append({ type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 0, content: "Start. " } });
    });
    const liveCard = page.locator('[data-thinking-view="live"] .thinking-card').first();
    await liveCard.locator(".thinking-card-body").waitFor();
    // Fold the live card while still streaming.
    await liveCard.locator(".thinking-card-header").click();
    await page.waitForFunction(() => document.querySelector('[data-thinking-view="live"] .thinking-card')?.classList.contains("collapsed"));

    await page.evaluate(tail => {
      window.audit.append({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: tail } });
      window.audit.append({ type: "message_update", assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "Start. " + tail } });
      window.audit.append({ type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking: "Start. " + tail }] } });
    }, longTail);
    await page.waitForTimeout(80);

    await liveCard.locator(".thinking-card-header").click();
    await liveCard.locator(".thinking-card-body").waitFor();
    const liveState = await liveCard.evaluate(el => ({
      className: el.className,
      hasCursor: Boolean(el.querySelector(".thinking-streaming-cursor")),
      hasStatus: Boolean(el.querySelector(".thinking-status.streaming")),
      hasFinal: (el.querySelector(".thinking-card-body")?.textContent ?? "").includes("FOLDED_FINAL_MARKER"),
    }));
    assert.equal(liveState.hasFinal, true, `folded finished card should snap to full text on expand: ${JSON.stringify(liveState)}`);
    assert.doesNotMatch(liveState.className, /\bstreaming\b/);
    assert.equal(liveState.hasCursor, false);
    assert.equal(liveState.hasStatus, false);

    // Part B: settled omitted thinking (< 160 chars) inside summary strip hydrates without typewriter replay.
    await page.evaluate(() => {
      window.audit.setCardsCollapsed(true);
      window.audit.append({
        type: "message_end",
        piNRawRange: [100, 240],
        message: {
          role: "assistant",
          content: [{ type: "thinking", thinking: "", piNBodyOmitted: true, piNThinkingChars: 42 }],
        },
      });
    });
    const historyView = page.locator('[data-thinking-view="history"]');
    const trigger = historyView.getByTestId("activity-summary-trigger").last();
    await trigger.waitFor();
    await trigger.click();
    const hydratedCard = historyView.locator('[data-testid="activity-summary-cards"] .thinking-card').last();
    await hydratedCard.waitFor();
    if (!(await hydratedCard.locator(".thinking-card-body").count())) {
      await hydratedCard.locator(".thinking-card-header").click();
      await hydratedCard.locator(".thinking-card-body").waitFor();
    }

    await page.evaluate(() => {
      window.audit.setHydratedCards([["output:think:100:240:0", { content: "Short hydrated reasoning.", bodyOmitted: false }]]);
    });
    await hydratedCard.locator(".thinking-card-body", { hasText: "Short hydrated reasoning." }).waitFor();
    const hydratedState = await hydratedCard.evaluate(el => ({
      className: el.className,
      hasCursor: Boolean(el.querySelector(".thinking-streaming-cursor")),
      hasStatus: Boolean(el.querySelector(".thinking-status.streaming")),
      text: el.querySelector(".thinking-card-body")?.textContent ?? "",
    }));
    assert.doesNotMatch(hydratedState.className, /\bstreaming\b/, `hydrated settled card must stay settled: ${JSON.stringify(hydratedState)}`);
    assert.equal(hydratedState.hasCursor, false);
    assert.equal(hydratedState.hasStatus, false);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("reasoning notices, thinking, tools, compaction billing and errors share the footer card transition", { timeout: 15_000 }, async () => {
  const reasoningDrop = (count, content = []) => ({
    type: "message_end",
    message: { role: "assistant", provider: "openai", content, diagnostics: [{
      type: "openai_input_transformations",
      details: { transformations: Array.from({ length: count }, () => ({ type: "reasoning", reason: "prefix_mismatch" })) },
    }] },
  });
  const log = [
    { type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "echo ready" } },
    { type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result: { content: [{ type: "text", text: "ready" }] } },
    reasoningDrop(1),
    { type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking: "Checked the result." }] } },
    { type: "tool_execution_start", toolCallId: "t2", toolName: "bash", args: { command: "echo done" } },
    { type: "tool_execution_end", toolCallId: "t2", toolName: "bash", result: { content: [{ type: "text", text: "done" }] } },
    { type: "compaction_end", reason: "threshold", result: {
      summary: "Compacted earlier history.", tokensBefore: 128_000, estimatedTokensAfter: 18_000,
      usage: { input: 32_000, output: 300, cost: { total: 0.12 } },
    } },
    { type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "Temporary failure.", content: [] } },
    reasoningDrop(2, [{ type: "text", text: "Done." }]),
  ].map(event => JSON.stringify(event)).join("\n") + "\n";
  const totalBytes = Buffer.byteLength(log);
  const context = await browser.newContext({ reducedMotion: "no-preference" });
  await context.addInitScript(() => localStorage.setItem("pi_n_collapse_cards_v1", "1"));
  try {
    await context.route("**/api/*", route => {
      const body = route.request().postDataJSON() ?? {};
      const result = route.request().url().endsWith("/get_execution_output") ? {
        runId: body.runId, executionId: body.executionId,
        content: body.offset ? "" : log, startOffset: body.offset ?? 0, nextOffset: totalBytes,
        totalBytes, complete: true, status: "completed",
      } : {};
      return route.fulfill({ json: { result } });
    });
    const page = await context.newPage();
    await page.goto(`${origin}/__changes?mode=serial&settled=1&bytes=${totalBytes}`);
    await page.locator(".initial-query-scroll.conversation-ready").waitFor();
    const toggle = page.getByTestId("collapse-cards-trigger");
    const notices = page.locator('[data-notice-kind="reasoning_drop"]');
    const summary = page.getByTestId("activity-summary-row");
    const billing = page.getByTestId("compacted-billing");
    await summary.waitFor();
    assert.equal(await notices.count(), 0);
    assert.equal(await billing.count(), 0);

    for (const expanding of [true, false]) {
      await toggle.evaluate(button => {
        const frames = window.cardFrames = [];
        const start = performance.now();
        function sample() {
          const notice = [...document.querySelectorAll('[data-notice-kind="reasoning_drop"]')].at(-1);
          const noticeHeight = notice?.closest("[data-transcript-id]")?.getBoundingClientRect().height;
          const tracks = document.querySelectorAll(".activity-summary-body-track");
          const track = tracks[0];
          const trackHeight = track?.getBoundingClientRect().height;
          if (noticeHeight > 0 && noticeHeight < notice.offsetHeight && trackHeight > 0 && trackHeight < track.firstElementChild.offsetHeight) {
            frames.push({
              groups: tracks.length,
              order: [...track.querySelectorAll('[data-testid="tool-call-card"], [data-notice-kind], .thinking-card, .compacted-card, .transcript-error-card')]
                .map(card => card.dataset.noticeKind ?? (card.dataset.testid || card.classList[0])),
              billing: track.querySelector('[data-testid="compacted-billing"]')?.textContent ?? null,
            });
          }
          if (performance.now() - start < 800) requestAnimationFrame(sample);
        }
        button.click();
        requestAnimationFrame(sample);
      });
      if (expanding) await summary.waitFor({ state: "detached" });
      else await notices.first().waitFor({ state: "detached" });
      const frames = await page.evaluate(() => window.cardFrames);
      assert.ok(frames.length > 0, `standalone notice must ${expanding ? "expand" : "collapse"} with the other cards`);
      for (const frame of frames) {
        assert.equal(frame.groups, 1);
        assert.deepEqual(frame.order, ["tool-call-card", "reasoning_drop", "thinking-card", "tool-call-card", "compacted-card", "transcript-error-card"]);
        assert.match(frame.billing ?? "", /\$0\.12/, "the billing badge must be present during the card animation");
      }
      assert.equal(await notices.count(), expanding ? 2 : 0);
      assert.equal(await billing.count(), expanding ? 1 : 0);
    }
  } finally {
    await context.close();
  }
});

test("clicking bottom Expand cards while a live CoT card is streaming in summary mode reveals content cleanly without shimmer or blank flicker", { timeout: 30_000 }, async () => {
  const fullLog = [
    JSON.stringify({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "echo " + "x".repeat(300) } }),
    JSON.stringify({ type: "tool_execution_end", toolCallId: "t1", toolName: "bash", isError: false, result: { content: [{ type: "text", text: "output ".repeat(150) }] } }),
    JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Finished step 1." }] } }),
    JSON.stringify({ type: "message_start", message: { role: "assistant", content: [] } }),
    JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } }),
    ...Array.from({ length: 16 }, (_, i) => JSON.stringify({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: `Step ${i + 1}: Analyzing live reasoning smoothly.\n\n` },
    })),
  ].join("\n") + "\n";
  const summaryLog = [
    JSON.stringify({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "echo short" } }),
    JSON.stringify({ type: "tool_execution_end", toolCallId: "t1", toolName: "bash", isError: false, result: { content: [{ type: "text", text: "" }], piNBodyOmitted: true } }),
    JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Finished step 1." }] } }),
    JSON.stringify({ type: "message_start", message: { role: "assistant", content: [] } }),
    JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } }),
  ].join("\n") + "\n";
  const fullBuf = Buffer.from(fullLog);

  const runCase = async (fullDelayMs) => {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      locale: "en-US",
      reducedMotion: "no-preference",
    });
    await context.addInitScript(() => {
      localStorage.setItem("pi_n_language_v1", "en");
      localStorage.setItem("pi_n_collapse_cards_v1", "1");
      localStorage.setItem("pi_n_auto_expand_cot_v1", "1");
    });
    const errors = [];
    let fullFetches = 0;
    await context.route("**/api/*", async route => {
      const command = new URL(route.request().url()).pathname.slice(5);
      const body = route.request().postDataJSON() ?? {};
      if (command === "get_execution_output") {
        if (body.projection === "summary" || body.summaryOnly === true) {
          await route.fulfill({ json: { result: {
            runId: body.runId, executionId: body.executionId,
            content: body.offset ? "" : summaryLog,
            startOffset: 0, nextOffset: fullBuf.length, totalBytes: fullBuf.length,
            complete: true, status: "running", projection: "summary", summaryOnly: true,
          } } });
          return;
        }
        if (!body.offset) {
          fullFetches += 1;
          if (fullDelayMs > 0) await new Promise(resolve => setTimeout(resolve, fullDelayMs));
        }
        const offset = body.offset ?? 0;
        await route.fulfill({ json: { result: {
          runId: body.runId, executionId: body.executionId,
          content: fullBuf.subarray(offset).toString("utf8"),
          startOffset: offset, nextOffset: fullBuf.length, totalBytes: fullBuf.length,
          complete: true, status: "running",
        } } });
        return;
      }
      await route.fulfill({ json: { result: {} } });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(8_000);
    page.on("pageerror", error => errors.push(String(error)));
    try {
      await page.goto(`${origin}/__changes?mode=serial&settled=0&bytes=${fullBuf.length}`, { waitUntil: "domcontentloaded" });
      await page.locator(".initial-query-scroll.conversation-ready").waitFor();
      await page.getByTestId("activity-summary-row").last().waitFor();

      await page.evaluate(() => {
        window.__liveExpandFrames = [];
        const start = performance.now();
        function tick(now) {
          const rows = [...document.querySelectorAll('[data-testid="activity-summary-row"]')];
          const lastRow = rows.at(-1);
          const card = document.querySelector(".thinking-card");
          const track = lastRow?.querySelector(".activity-summary-body-track");
          const shimmer = Boolean(card?.querySelector(".thinking-shimmer"));
          const md = card?.querySelector(".thinking-markdown");
          window.__liveExpandFrames.push({
            rowDomId: lastRow?.parentElement?.getAttribute("data-transcript-id") ?? null,
            hasCard: Boolean(card),
            trackH: track ? Math.round(track.getBoundingClientRect().height) : null,
            shimmer,
            textLen: md ? md.textContent.length : 0,
          });
          if (now - start < 720) requestAnimationFrame(tick);
        }
        requestAnimationFrame(tick);
      });

      await page.getByTestId("collapse-cards-trigger").click();
      await page.waitForTimeout(760);
      const frames = await page.evaluate(() => window.__liveExpandFrames);
      const finalText = await page.locator(".thinking-card .thinking-markdown").first().textContent();
      return { frames, finalText: finalText ?? "", fullFetches, errors };
    } finally {
      await context.close();
    }
  };

  // Normal local latency: pre-warm upgrades summary -> full before animation starts (zero shimmer, zero blank frames, monotonic track growth).
  const warm = await runCase(40);
  const warmBlank = warm.frames.filter(f => f.hasCard && !f.shimmer && f.textLen === 0);
  const warmShimmer = warm.frames.filter(f => f.shimmer);
  const warmRowIds = new Set(warm.frames.map(f => f.rowDomId).filter(Boolean));
  const warmTrackHeights = warm.frames.map(f => f.trackH).filter(h => h !== null);
  const warmTrackDrops = warmTrackHeights.slice(1).filter((h, i) => h < warmTrackHeights[i]);
  assert.equal(warm.fullFetches, 1, `expected single full upgrade fetch, got ${warm.fullFetches}`);
  assert.equal(warmBlank.length, 0, `expected zero blank CoT frames: ${JSON.stringify(warmBlank)}`);
  assert.equal(warmShimmer.length, 0, `expected zero shimmer frames when full output lands within pre-warm window: ${JSON.stringify(warmShimmer)}`);
  assert.equal(warmRowIds.size, 1, `running summary row ID must stay stable across summary->full upgrade: ${JSON.stringify([...warmRowIds])}`);
  assert.equal(warmTrackDrops.length, 0, `expand track height must never shrink mid-flight: ${JSON.stringify(warmTrackHeights)}`);
  assert.match(warm.finalText, /Step 16: Analyzing live reasoning smoothly\./);
  assert.deepEqual(warm.errors, []);

  // Slow backend (> pre-warm cap & > animation duration): in-flight upgrade is never aborted and never flashes blank.
  const slow = await runCase(320);
  const slowBlank = slow.frames.filter(f => f.hasCard && !f.shimmer && f.textLen === 0);
  assert.equal(slow.fullFetches, 1, `in-flight live upgrade must not be aborted and re-fetched at idle handoff (fetches=${slow.fullFetches})`);
  assert.equal(slowBlank.length, 0, `expected zero blank CoT frames on slow upgrade: ${JSON.stringify(slowBlank)}`);
  assert.match(slow.finalText, /Step 16: Analyzing live reasoning smoothly\./);
  assert.deepEqual(slow.errors, []);
});
