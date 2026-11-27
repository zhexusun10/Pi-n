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
          if (!req.url?.startsWith("/__audit")) return next();
          res.setHeader("Content-Type", "text/html");
          res.end(await viteServer.transformIndexHtml(
            req.url,
            '<html><body><div id="root" style="padding:160px 32px"></div><script type="module" src="/scripts/fixtures/frontend-audit.tsx"></script></body></html>',
          ));
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
