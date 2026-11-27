import assert from "node:assert/strict";
import { fixtureSummaries, fixtureFileChanges } from "./fixtures/current-api.mjs";
import { connectOrLaunchBrowser } from "./fixtures/ui-browser.mjs";
import test, { before, after } from "node:test";
import { createServer } from "vite";

let server;
let browser;
let origin;

before(async () => {
  server = await createServer({ cacheDir: "node_modules/.vite-workspace-ui", server: { host: "127.0.0.1", port: 0, strictPort: false, open: false, hmr: false, watch: null } });
  await server.listen();
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await connectOrLaunchBrowser();
});

after(async () => {
  await browser?.close();
  server?.httpServer?.closeAllConnections?.();
  await server?.close();
});

// Observe the full transition, not just its final rectangle: a position projection
// can otherwise hide a jump behind an eventually correct composer layout.
async function sampleHomeComposerToggle(page, expanded, collapsedHeight) {
  await page.waitForFunction(() => {
    const box = document.querySelector(".landing-screen .prompt-box-container");
    if (!box) return false;
    const t = getComputedStyle(box).transform;
    return (t === "none" || t === "matrix(1, 0, 0, 1, 0, 0)" || t === "matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)") && box.getAnimations().length === 0;
  });
  return page.evaluate(({ expanded, collapsedHeight }) => new Promise((resolve, reject) => {
    const box = document.querySelector(".landing-screen .prompt-box-container");
    const title = document.querySelector(".landing-title-copy");
    const samples = [];
    const started = performance.now();
    let settled = 0;
    const sample = () => {
      const rect = box.getBoundingClientRect();
      const style = getComputedStyle(title);
      const activeMode = box.querySelector(".prompt-box-mode-btn.active").getBoundingClientRect();
      const pill = box.querySelector(".prompt-box-mode-pill-indicator").getBoundingClientRect();
      const frame = { top: rect.top, bottom: rect.bottom, height: rect.height,
        opacity: Number(style.opacity), visibility: style.visibility,
        pillOffsetX: pill.left - activeMode.left, pillOffsetY: pill.top - activeMode.top,
        pillWidthError: pill.width - activeMode.width, pillHeightError: pill.height - activeMode.height };
      samples.push(frame);
      // Cursor updates cause React renders while height is animated, as in real editing.
      if (box.hasAttribute("data-resizing")) {
        const input = box.querySelector("textarea");
        const cursor = samples.length % input.value.length;
        input.setSelectionRange(cursor, cursor);
        input.dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowRight", bubbles: true }));
      }
      const targetHeight = expanded ? innerHeight * 0.8 : collapsedHeight;
      const atTarget = Math.abs(rect.height - targetHeight) < 1 && !box.hasAttribute("data-resizing") &&
        (expanded ? frame.visibility === "hidden" : frame.visibility === "visible" && frame.opacity === 1);
      settled = atTarget ? settled + 1 : 0;
      if (settled >= 4) return resolve(samples);
      if (performance.now() - started > 5000) return reject(new Error(`Composer did not settle: ${JSON.stringify(frame)}`));
      requestAnimationFrame(sample);
    };
    sample();
    box.querySelector(".prompt-box-expand-btn").click();
  }), { expanded, collapsedHeight });
}

// Mocked API only: no backend, credentials, or real workspace files are touched.
test("workspace isolation, accessible home and delayed planning ownership", { timeout: 120_000 }, async () => {
  const repositoryA = "C:\\Projects\\Alpha";
  const repositoryB = "C:\\Projects\\Beta";
  const config = { repository: repositoryA, model: "test/model", thinkingLevel: "medium", maxParallel: 2, maxFeedback: 3, autoApprove: false };
  const makeSnapshot = (runId, repository, goal) => ({
    runId, config: { ...config, repository }, planType: "graph",
    graph: { originalGoal: goal, nodes: [], edges: [] }, nodes: {},
    plan: null, executions: [], events: [], approved: false, paused: false,
    phase: "completed", base: "", feedbackCounts: {},
  });
  const snapshots = {
    "run-a": makeSnapshot("run-a", "\\\\?\\C:\\Projects\\Alpha", "Alpha conversation"),
    "run-b": makeSnapshot("run-b", repositoryB, "Beta conversation"),
    "new-a": makeSnapshot("new-a", repositoryA, "Detached Alpha conversation"),
  };
  const empty = { ...makeSnapshot("", repositoryA, ""), config: null, phase: "draft" };
  const info = repository => ({ path: repository, name: repository.includes("Beta") ? "Beta" : "Alpha", branch: "main", head: "", clean: true });
  const bootstrap = { config, snapshot: empty, runs: ["run-a", "run-b"], conversations: fixtureSummaries([snapshots["run-a"], snapshots["run-b"]]), repositoryInfo: info(repositoryA), dataPath: "/mock/.pi-n" };
  const errors = [];
  let releasePlanning;
  let planningRequested = false;
  const planningGate = new Promise(resolve => { releasePlanning = resolve; });
  let context;
  try {
    context = await browser.newContext({ viewport: { width: 1280, height: 768 }, locale: "en-US", reducedMotion: "no-preference" });
    await context.addInitScript(({ repositoryA, repositoryB, config }) => {
      localStorage.setItem("pi_n_language_v1", "en");
      localStorage.setItem("pi_n_projects", JSON.stringify([
        { id: repositoryA, path: repositoryA, name: "Alpha", branch: "main", clean: true, lastOpened: 2 },
        { id: repositoryB, path: repositoryB, name: "Beta", branch: "main", clean: true, lastOpened: 1 },
      ]));
      // Unversioned hints are ignored; the current index supplies ownership.
      localStorage.setItem("pi_n_workspace_runs", JSON.stringify({
        [repositoryA]: ["run-a", "run-b", "pending-stale"],
        [repositoryB]: ["run-b", "run-a"],
        "\\\\?\\C:\\Projects\\Alpha": ["run-a"],
      }));
      localStorage.setItem("pi_n_run_labels", JSON.stringify({ "run-a": "Alpha conversation", "run-b": "Beta conversation" }));
      localStorage.setItem("pi_n_config", JSON.stringify(config));
    }, { repositoryA, repositoryB, config });
    await context.route("**/api/*", async route => {
      const command = new URL(route.request().url()).pathname.slice(5);
      const body = route.request().postDataJSON();
      let result;
      switch (command) {
        case "bootstrap": case "save_config": result = bootstrap; break;
        case "get_file_changes": result = fixtureFileChanges(body); break;
        case "extension_command": result = { instance: "standalone", commands: [] }; break;
        case "load_run": case "history": case "snapshot": result = snapshots[body.runId] || empty; break;
        case "snapshot_if_changed": result = { version: "mock-1", snapshot: snapshots[body.runId] || null }; break;
        case "repository_status": result = { repository: body.repository, valid: true, error: null }; break;
        case "detect_repository":
          await new Promise(resolve => setTimeout(resolve, 120));
          result = info(body.path || body.repository); break;
        case "list_plannings": result = []; break;
        case "list_files": result = { files: [] }; break;
        case "list_skills": result = { skills: [] }; break;
        case "provider_auth": result = { providers: [{ id: "test", name: "Test", methods: [], configured: true }], models: [], warning: null }; break;
        case "pi_extensions": result = { globalDirectory: "mock", extensions: [] }; break;
        case "environment_capabilities": result = { platform: "windows", arch: "x86_64", nativeWorkspace: true }; break;
        case "plan_goal_stream":
          assert.equal(body.config.repository, repositoryA);
          planningRequested = true;
          await planningGate;
          await route.fulfill({ contentType: "text/event-stream", body:
            `event: run_started\ndata: ${JSON.stringify({ runId: "new-a" })}\n\nevent: complete\ndata: ${JSON.stringify({ snapshot: snapshots["new-a"] })}\n\n` });
          return;
        default:
          errors.push(`Unexpected API: ${command}`);
          return route.fulfill({ status: 400, json: { error: `Unexpected API: ${command}` } });
      }
      await route.fulfill({ json: { result } });
    });
    const page = await context.newPage();
    page.on("pageerror", error => errors.push(String(error)));
    await page.goto(origin, { waitUntil: "networkidle" });
    await page.waitForFunction(() => {
      const index = JSON.parse(localStorage.getItem("pi-n-format-1:/mock/.pi-n:pi_n_workspace_runs"));
      return index?.["c:/projects/alpha"]?.join() === "run-a" && index?.["c:/projects/beta"]?.join() === "run-b";
    });
    assert.deepEqual(await page.locator(".runs-list [data-run-id]").evaluateAll(cards => cards.map(card => card.dataset.runId)), ["run-a"]);

    // Home is viewport-bound even on shorter screens; wheel must not move it.
    for (const height of [900, 768, 480, 360]) {
      await page.setViewportSize({ width: 1280, height });
      await page.locator(".landing-screen").waitFor();
      const metrics = await page.evaluate(() => {
        const home = document.querySelector(".landing-screen");
        const shell = document.querySelector(".app-shell");
        const prompt = home.querySelector(".prompt-box-container").getBoundingClientRect();
        return { shellOverflow: getComputedStyle(shell).overflowY,
          shellScrollTop: shell.scrollTop, shellScrollLeft: shell.scrollLeft,
          documentHeight: document.documentElement.scrollHeight, viewport: innerHeight, promptTop: prompt.top, promptBottom: prompt.bottom };
      });
      // The dot background deliberately paints outside the landing screen (under
      // the sidebar), so the landing box itself is no longer the clipping
      // boundary. The app shell clips to the viewport without scrolling.
      assert.ok(metrics.shellOverflow === "hidden" || metrics.shellOverflow === "clip", `expected hidden/clip overflowY, got ${metrics.shellOverflow}`);
      assert.equal(metrics.shellScrollTop, 0);
      assert.equal(metrics.shellScrollLeft, 0);
      assert.equal(metrics.documentHeight, metrics.viewport);
      assert.ok(metrics.promptTop >= 0 && metrics.promptBottom <= height, "composer remains visible");
      // The dot layer is the only element allowed to paint outside the landing
      // box. With that decoration removed, the home layout itself must still be
      // exactly viewport-bound on short screens.
      const layout = await page.evaluate(() => {
        const dots = document.querySelector(".landing-title-dot-pattern");
        const home = document.querySelector(".landing-screen");
        const previous = dots ? dots.style.display : "";
        if (dots) dots.style.display = "none";
        const result = { client: home.clientHeight, scroll: home.scrollHeight };
        if (dots) dots.style.display = previous;
        return result;
      });
      assert.equal(layout.client, layout.scroll, "non-decorative home content stays viewport-bound");
      await page.mouse.move(1200, 100);
      await page.mouse.wheel(0, 600);
      assert.equal(await page.evaluate(() => document.querySelector(".landing-screen").scrollTop), 0);
      assert.equal(await page.evaluate(() => document.querySelector(".app-shell").scrollTop), 0);
      assert.equal(await page.evaluate(() => document.documentElement.scrollTop), 0);
    }
    await page.setViewportSize({ width: 1280, height: 768 });

    // Expanded editing stays inside the real home layout without welcome-copy overlap.
    const homeInput = page.locator(".landing-screen textarea");
    const defaultTextareaHeight = (await homeInput.boundingBox()).height;
    await page.waitForFunction(() => {
      const box = document.querySelector(".landing-screen .prompt-box-container");
      if (!box) return false;
      const t = getComputedStyle(box).transform;
      return (t === "none" || t === "matrix(1, 0, 0, 1, 0, 0)" || t === "matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)") && box.getAnimations().length === 0;
    });
    await page.evaluate(() => {
      window.autosizeFrames = [];
      window.sampleAutosize = true;
      const sample = () => {
        const box = document.querySelector(".landing-screen .prompt-box-container");
        const bounds = box.getBoundingClientRect();
        const actions = box.querySelector(".prompt-box-actions-row").getBoundingClientRect();
        const mode = box.querySelector(".prompt-box-mode-btn.active").getBoundingClientRect();
        const pill = box.querySelector(".prompt-box-mode-pill-indicator").getBoundingClientRect();
        const textarea = box.querySelector("textarea");
        const input = textarea.getBoundingClientRect();
        window.autosizeFrames.push({ height: bounds.height, bottom: bounds.bottom, actionsBottom: actions.bottom,
          inputInset: input.top - bounds.top, inputWidth: input.width, text: textarea.value,
          scrollbarVisible: getComputedStyle(textarea).overflowY !== "hidden" && textarea.scrollHeight > textarea.clientHeight,
          inputBottomGap: textarea.scrollHeight - textarea.clientHeight - textarea.scrollTop,
          caretAtEnd: textarea.selectionStart === textarea.value.length && textarea.selectionEnd === textarea.value.length,
          focused: document.activeElement === textarea,
          pillX: pill.left - mode.left, pillY: pill.top - mode.top,
          pillWidth: pill.width - mode.width, pillHeight: pill.height - mode.height });
        if (window.sampleAutosize) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    for (const text of ["Short draft", "Two\nlines", "More lines\n".repeat(5), "Scrollable draft\n".repeat(40), "Two\nlines", ""]) {
      const first = await page.evaluate(() => window.autosizeFrames.length);
      const before = (await page.locator(".landing-screen .prompt-box-container").boundingBox()).height;
      await homeInput.fill(text);
      await page.waitForFunction(() => !document.querySelector(".landing-screen .prompt-box-container").hasAttribute("data-resizing"));
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const step = await page.evaluate(({ first, text }) => window.autosizeFrames.slice(first).filter(frame => frame.text === text), { first, text });
      const after = step.at(-1).height;
      if (!step.at(-1).scrollbarVisible) {
        assert.ok(step.every(frame => !frame.scrollbarVisible), "text that fits its final height must not flash a scrollbar while growing");
      }
      if (Math.abs(after - before) > 2) {
        assert.ok(step.some(frame => frame.height > Math.min(before, after) + 1 && frame.height < Math.max(before, after) - 1),
          "ordinary textarea growth and shrinking animate through intermediate heights");
      }
    }
    // Native insertion into the real controlled home composer must keep its
    // final line visible while the shared-anchor box grows and afterwards.
    const pastedDraft = "超长粘贴段落 with wrapping content ".repeat(1200) + "\nLAST_LINE\n";
    await homeInput.focus();
    const pasteStart = await page.evaluate(() => window.autosizeFrames.length);
    await page.keyboard.insertText(pastedDraft);
    await page.waitForFunction(() => !document.querySelector(".landing-screen .prompt-box-container").hasAttribute("data-resizing"));
    await page.waitForTimeout(100);
    const pastedFrames = await page.evaluate(({ pasteStart, pastedDraft }) =>
      window.autosizeFrames.slice(pasteStart).filter(frame => frame.text === pastedDraft), { pasteStart, pastedDraft });
    assert.ok(pastedFrames.length > 0);
    for (const frame of pastedFrames) {
      assert.ok(frame.focused && frame.caretAtEnd && frame.inputBottomGap <= 2,
        `pasting must not scroll away from the last line: ${JSON.stringify(frame)}`);
    }
    await homeInput.fill("");
    await page.waitForFunction(() => !document.querySelector(".landing-screen .prompt-box-container").hasAttribute("data-resizing"));
    const autosizeFrames = await page.evaluate(() => { window.sampleAutosize = false; return window.autosizeFrames; });
    const initialFrame = autosizeFrames[0];
    assert.ok(autosizeFrames.length > 0);
    for (const frame of autosizeFrames) {
      assert.ok(Math.abs(frame.bottom - initialFrame.bottom) < 1 && Math.abs(frame.actionsBottom - initialFrame.actionsBottom) < 1,
        `ordinary auto-growing and shrinking keep the input and controls bottom-anchored: ${JSON.stringify(frame)}`);
      assert.ok(Math.abs(frame.inputInset - initialFrame.inputInset) < 1 && Math.abs(frame.inputWidth - initialFrame.inputWidth) < 1,
        "ordinary text edits do not project or stretch the textarea");
      assert.ok(Math.abs(frame.pillX) < 1 && Math.abs(frame.pillY) < 1 && Math.abs(frame.pillWidth) < 1 && Math.abs(frame.pillHeight) < 1,
        `mode pill does not move independently during ordinary autosizing: ${JSON.stringify(frame)}`);
    }
    const longDraft = "Editable home draft\n".repeat(40);
    await homeInput.fill(longDraft);
    await page.waitForFunction(() => !document.querySelector(".landing-screen .prompt-box-container").hasAttribute("data-resizing"));
    const collapsedHeight = (await page.locator(".landing-screen .prompt-box-container").boundingBox()).height;
    const expanding = await sampleHomeComposerToggle(page, true, collapsedHeight);
    assert.ok(expanding.some(frame => frame.opacity > 0 && frame.opacity < 1 && Math.abs(frame.height - collapsedHeight) < 1),
      "welcome copy fades out before the composer grows");
    assert.ok(expanding.some(frame => frame.height > collapsedHeight + 2 && frame.height < 768 * 0.8 - 2),
      "expansion animates through intermediate heights");
    for (const frame of expanding) {
      assert.ok(Math.abs(frame.bottom - expanding[0].bottom) < 1, `expansion keeps the composer's bottom anchored: ${JSON.stringify(expanding)}`);
      if (frame.height > collapsedHeight + 2) assert.ok(frame.opacity < 0.01, "copy is gone before expansion");
      assert.ok(Math.abs(frame.pillOffsetX) < 1 && Math.abs(frame.pillOffsetY) < 1 &&
        Math.abs(frame.pillWidthError) < 1 && Math.abs(frame.pillHeightError) < 1,
        `mode pill stays attached to its selected button while expanding: ${JSON.stringify(frame)}`);
    }
    for (const height of [900, 768, 480, 360]) {
      await page.setViewportSize({ width: 1280, height });
      const metrics = await page.evaluate(() => {
        const prompt = document.querySelector(".landing-screen .prompt-box-container").getBoundingClientRect();
        const title = document.querySelector(".landing-title-copy");
        const titleRect = title.getBoundingClientRect();
        return { top: prompt.top, bottom: prompt.bottom, height: prompt.height,
          titleOverlaps: title.checkVisibility({ checkVisibilityCSS: true }) && titleRect.bottom > prompt.top && titleRect.top < prompt.bottom,
          documentHeight: document.documentElement.scrollHeight };
      });
      assert.ok(Math.abs(metrics.height - height * 0.8) < 2);
      assert.ok(metrics.top >= 0 && metrics.bottom <= height, `expanded editor remains in the viewport: ${JSON.stringify(metrics)}`);
      assert.equal(metrics.documentHeight, height);
      assert.equal(metrics.titleOverlaps, false);
      assert.equal(await homeInput.inputValue(), longDraft);
    }
    await page.setViewportSize({ width: 1280, height: 768 });
    const collapsing = await sampleHomeComposerToggle(page, false, collapsedHeight);
    assert.ok(collapsing.some(frame => frame.height > collapsedHeight + 2 && frame.height < 768 * 0.8 - 2),
      "collapse animates through intermediate heights instead of snapping");
    assert.ok(collapsing.some(frame => frame.height > collapsedHeight + 2 && frame.opacity > 0.05 && frame.visibility === "visible"),
      "welcome copy returns during collapse rather than waiting for the height animation to finish");
    for (const frame of collapsing) {
      assert.ok(Math.abs(frame.bottom - collapsing[0].bottom) < 1, `collapse keeps the composer's bottom anchored without a jump: ${JSON.stringify(collapsing)}`);
      assert.ok(Math.abs(frame.pillOffsetX) < 1 && Math.abs(frame.pillOffsetY) < 1 &&
        Math.abs(frame.pillWidthError) < 1 && Math.abs(frame.pillHeightError) < 1,
        `mode pill stays attached to its selected button while collapsing: ${JSON.stringify(frame)}`);
    }
    assert.equal(await homeInput.inputValue(), longDraft);

    // Escape can reverse expansion, including while the copy is still fading.
    await page.getByRole("button", { name: "Expand input", exact: true }).evaluate(button => button.click());
    await homeInput.press("Escape");
    await page.waitForFunction(() => {
      const box = document.querySelector(".landing-screen .prompt-box-container");
      const title = document.querySelector(".landing-title-copy");
      return !box.classList.contains("expanded") && !box.hasAttribute("data-resizing") && getComputedStyle(title).opacity === "1";
    });
    assert.ok(Math.abs((await page.locator(".landing-screen .prompt-box-container").boundingBox()).height - collapsedHeight) < 1);
    assert.equal(await homeInput.inputValue(), longDraft);
    await homeInput.fill("");
    await page.waitForFunction(() => !document.querySelector(".landing-screen .prompt-box-container").hasAttribute("data-resizing"));
    assert.ok(Math.abs((await homeInput.boundingBox()).height - defaultTextareaHeight) < 0.1, "the default textarea height is unchanged");

    // Landing input box draft persists when switching to other pages (conversations) and across reloads.
    const persistentDraft = "Draft that must survive switching to other pages and reload";
    await homeInput.fill(persistentDraft);
    await page.locator('[data-run-id="run-a"]').click();
    await page.locator(".chat-messages-stream", { hasText: "Alpha conversation" }).waitFor();
    await page.getByRole("button", { name: "New conversation", exact: true }).click();
    await page.locator(".landing-screen textarea").waitFor();
    assert.equal(await page.locator(".landing-screen textarea").inputValue(), persistentDraft,
      "landing draft survives switching to conversation page and returning via New conversation");
    await page.reload({ waitUntil: "networkidle" });
    await page.locator(".landing-screen textarea").waitFor();
    assert.equal(await page.locator(".landing-screen textarea").inputValue(), persistentDraft,
      "landing draft survives full page reload");
    await page.locator(".landing-screen textarea").fill("");

    await page.locator('[data-run-id="run-a"]').click();
    await page.locator(".chat-messages-stream", { hasText: "Alpha conversation" }).waitFor();

    // Keyboard selection follows the same workspace switching path. Switching
    // while repository detection yields cannot bind Alpha to Beta, and always
    // lands on home instead of opening the newest conversation.
    await page.locator(".project-workspace-item", { hasText: "Beta" }).focus();
    await page.keyboard.press("Enter");
    await page.locator(".landing-screen").waitFor();
    await page.waitForFunction(() => !document.querySelector(".chat-messages-stream"));
    assert.equal(await page.locator(".run-item.chosen").count(), 0);
    await page.locator('[data-run-id="run-b"]').waitFor();
    assert.equal(await page.locator('.runs-list [data-run-id="run-a"]').count(), 0);
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem("pi-n-format-1:/mock/.pi-n:pi_n_workspace_runs"))), {
      "c:/projects/alpha": ["run-a"], "c:/projects/beta": ["run-b"],
    });

    // Opening a conversation remains an explicit action inside the workspace.
    await page.locator('[data-run-id="run-b"]').click();
    await page.locator(".chat-messages-stream", { hasText: "Beta conversation" }).waitFor();

    // Space also activates workspace cards without a mouse.
    // Start Alpha planning, navigate away, then release its delayed SSE result.
    await page.locator(".project-workspace-item", { hasText: "Alpha" }).focus();
    await page.keyboard.press("Space");
    await page.locator(".landing-screen").waitFor();
    await page.waitForFunction(() => !document.querySelector(".chat-messages-stream"));
    assert.equal(await page.locator(".run-item.chosen").count(), 0);
    await page.locator(".landing-screen textarea").fill("Detached Alpha conversation");
    await page.locator(".landing-screen textarea").press("Enter");
    await page.waitForFunction(() => !!document.querySelector('.run-item[data-run-id^="pending-"]'));
    await page.locator('.run-item[data-run-id^="pending-"]').click({ button: "right" });
    assert.equal(await page.locator(".context-menu-item.danger").isDisabled(), true);
    await page.locator(".main-view-stage").click({ position: { x: 10, y: 10 } });
    for (let i = 0; !planningRequested && i < 250; i++) await page.waitForTimeout(20);
    assert.equal(planningRequested, true, "detached planning request should start");
    await page.locator(".project-workspace-item", { hasText: "Beta" }).click();
    await page.locator(".landing-screen").waitFor();
    await page.waitForFunction(() => !document.querySelector(".chat-messages-stream"));
    await page.locator('[data-run-id="run-b"]').click();
    await page.locator(".chat-messages-stream", { hasText: "Beta conversation" }).waitFor();
    releasePlanning();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem("pi-n-format-1:/mock/.pi-n:pi_n_workspace_runs"))["c:/projects/alpha"]?.includes("new-a"));
    assert.deepEqual(await page.locator(".runs-list [data-run-id]").evaluateAll(cards => cards.map(card => card.dataset.runId)), ["run-b"]);
    assert.ok((await page.locator(".chat-messages-stream").innerText()).includes("Beta conversation"));
    assert.ok(!(await page.locator(".chat-messages-stream").innerText()).includes("Detached Alpha"));

    assert.deepEqual(errors, []);
  } finally {
    releasePlanning();
    await context?.close();
  }
});

test("workspace removal commits backend deletion before pruning indexes and survives failure, navigation and reload", { timeout: 90_000 }, async () => {
  const repositoryA = "C:\\Projects\\Alpha";
  const repositoryB = "C:\\Projects\\Beta";
  const config = { repository: repositoryA, model: "test/model", maxParallel: 1, maxFeedback: 3 };
  const makeSnapshot = (runId, repository, goal) => ({
    runId, config: { ...config, repository }, planType: "graph", phase: "completed",
    graph: { originalGoal: goal, nodes: [], edges: [] }, nodes: {}, plan: null,
    executions: [], mergers: [], events: [], approved: false, paused: false, base: "", feedbackCounts: {},
  });
  const snapshots = {
    "run-a": makeSnapshot("run-a", repositoryA, "Alpha conversation"),
    "run-b": makeSnapshot("run-b", repositoryB, "Beta conversation"),
  };
  const empty = { ...makeSnapshot("", repositoryA, ""), config: null, phase: "draft" };
  const info = repository => ({ path: repository, name: repository.includes("Beta") ? "Beta" : "Alpha", branch: "main", head: "", clean: true });
  const errors = [];
  const removals = [];
  let rejectDeletion = true;
  let releaseDeletion;
  const deletionGate = new Promise(resolve => { releaseDeletion = resolve; });
  let context;
  try {
    context = await browser.newContext({ locale: "en-US", reducedMotion: "no-preference" });
    await context.addInitScript(({ repositoryA, repositoryB, config }) => {
      if (localStorage.getItem("deletion-fixture-seeded")) return;
      localStorage.setItem("deletion-fixture-seeded", "true");
      localStorage.setItem("pi_n_language_v1", "en");
      localStorage.setItem("pi_n_projects", JSON.stringify([
        { id: repositoryA, path: repositoryA, name: "Alpha", branch: "main", clean: true, lastOpened: 2 },
        { id: repositoryB, path: repositoryB, name: "Beta", branch: "main", clean: true, lastOpened: 1 },
      ]));
      localStorage.setItem("pi_n_workspace_runs", JSON.stringify({ [repositoryA]: ["run-a"], [repositoryB]: ["run-b"] }));
      localStorage.setItem("pi_n_run_labels", JSON.stringify({ "run-a": "Alpha conversation", "run-b": "Beta conversation", "server-only-a": "old hidden label" }));
      localStorage.setItem("pi_n_run_modes", JSON.stringify({ "run-a": "graph", "run-b": "graph", "server-only-a": "graph" }));
      localStorage.setItem("pi_n_config", JSON.stringify(config));
    }, { repositoryA, repositoryB, config });
    await context.route("**/api/*", async route => {
      const command = new URL(route.request().url()).pathname.slice(5);
      const body = route.request().postDataJSON();
      let result;
      switch (command) {
        case "bootstrap": case "save_config":
          // Keep a stale backend default after removing the final entry: an
          // explicitly empty browser workspace list must not be repopulated.
          result = { config, snapshot: empty, runs: Object.keys(snapshots), conversations: fixtureSummaries(Object.values(snapshots)), repositoryInfo: info(repositoryA), dataPath: "/mock/.pi-n" }; break;
        case "get_file_changes": result = fixtureFileChanges(body); break;
        case "extension_command": result = { instance: "standalone", commands: [] }; break;
        case "load_run": case "history": case "snapshot": result = snapshots[body.runId] || empty; break;
        case "snapshot_if_changed": result = { version: "mock-1", snapshot: snapshots[body.runId] || null }; break;
        case "repository_status": result = { repository: body.repository, valid: true, error: null }; break;
        case "detect_repository": result = info(body.path || body.repository); break;
        case "list_plannings": result = []; break;
        case "list_files": result = { files: [] }; break;
        case "list_skills": result = { skills: [] }; break;
        case "provider_auth": result = { providers: [{ id: "test", name: "Test", methods: [], configured: true }], models: [], warning: null }; break;
        case "pi_extensions": result = { globalDirectory: "mock", extensions: [] }; break;
        case "environment_capabilities": result = { platform: "windows", arch: "x86_64", nativeWorkspace: true }; break;
        case "delete_workspace":
          removals.push(body.repository);
          if (rejectDeletion) return route.fulfill({ status: 400, json: { error: "Cannot remove workspace while tasks are active" } });
          if (body.repository === repositoryA) {
            await deletionGate;
            delete snapshots["run-a"];
            result = ["run-a", "server-only-a"];
          } else {
            assert.equal(body.repository, repositoryB);
            delete snapshots["run-b"];
            result = ["run-b"];
          }
          break;
        default:
          errors.push(`Unexpected API: ${command}`);
          return route.fulfill({ status: 400, json: { error: `Unexpected API: ${command}` } });
      }
      await route.fulfill({ json: { result } });
    });
    const page = await context.newPage();
    page.on("pageerror", error => errors.push(String(error)));
    await page.goto(origin, { waitUntil: "networkidle" });
    await page.locator('[data-run-id="run-a"]').waitFor();
    const remove = async name => {
      await page.locator(".project-workspace-item", { hasText: name }).click({ button: "right" });
      await page.locator(".context-menu-item.danger").click();
      const dialog = page.getByRole("alertdialog");
      await dialog.getByText(/All conversations, logs, and private caches/).waitFor();
      await dialog.getByRole("button", { name: "Remove workspace", exact: true }).click();
    };
    await remove("Alpha");
    await page.getByText("Cannot remove workspace while tasks are active", { exact: true }).waitFor();
    assert.equal(await page.locator(".project-workspace-item").count(), 2);
    assert.equal(await page.locator('[data-run-id="run-a"]').count(), 1);
    rejectDeletion = false;
    await remove("Alpha");
    for (let i = 0; removals.length < 2 && i < 500; i++) await page.waitForTimeout(10);
    assert.equal(removals.length, 2, "second workspace removal request should start");
    assert.equal(await page.locator(".project-workspace-item").count(), 2, "pending deletion must not hide the workspace");
    await page.locator(".project-workspace-item", { hasText: "Beta" }).click();
    await page.locator(".landing-screen").waitFor();
    await page.locator('[data-run-id="run-b"]').click();
    await page.locator(".chat-messages-stream", { hasText: "Beta conversation" }).waitFor();
    releaseDeletion();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem("pi_n_projects")).length === 1);
    assert.ok((await page.locator(".chat-messages-stream").innerText()).includes("Beta conversation"));
    for (const key of ["pi-n-format-1:/mock/.pi-n:pi_n_run_labels", "pi-n-format-1:/mock/.pi-n:pi_n_run_modes"]) {
      const saved = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), key);
      assert.deepEqual(Object.keys(saved), ["run-b"]);
    }
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem("pi-n-format-1:/mock/.pi-n:pi_n_workspace_runs"))), { "c:/projects/beta": ["run-b"] });
    await page.evaluate(() => {
      window.workspaceScrollbarFrames = [];
      window.sampleWorkspaceScrollbar = true;
      const sample = () => {
        const list = document.querySelector(".projects-list");
        if (list) window.workspaceScrollbarFrames.push({
          scrollable: list.scrollHeight > list.clientHeight,
          scrollHeight: list.scrollHeight,
          clientHeight: list.clientHeight,
          overflowY: getComputedStyle(list).overflowY,
          removing: list.classList.contains("is-removing"),
        });
        if (window.sampleWorkspaceScrollbar) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    await remove("Beta");
    await page.waitForFunction(() => JSON.parse(localStorage.getItem("pi_n_projects")).length === 0);
    await page.waitForTimeout(300);
    const workspaceScrollbarFrames = await page.evaluate(() => {
      window.sampleWorkspaceScrollbar = false;
      return window.workspaceScrollbarFrames;
    });
    assert.ok(workspaceScrollbarFrames.length > 0);
    assert.ok(workspaceScrollbarFrames.every(frame => !frame.scrollable || frame.overflowY === "hidden"),
      `workspace removal must not flash a scrollbar: ${JSON.stringify(workspaceScrollbarFrames)}`);
    await page.reload({ waitUntil: "networkidle" });
    assert.equal(await page.locator(".project-workspace-item").count(), 0);
    assert.equal(await page.locator(".runs-list [data-run-id]").count(), 0);
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem("pi-n-format-1:/mock/.pi-n:pi_n_workspace_runs"))), {});
    assert.deepEqual(errors, []);
  } finally {
    releaseDeletion();
    await context?.close();
  }
});

test("workspace size warning appears only when sending Compile with isolated parallel workspaces enabled", { timeout: 30_000 }, async () => {
  const repository = "C:\\Projects\\Alpha";
  let config = { repository, model: "test/model", maxParallel: 1, maxFeedback: 3, isolateParallelNodes: true };
  const sizeError = "工作区体积超过 15GB 限制。请将大型文件（例如数据集、模型权重或构建缓存）移至目录外，或进入更里层的子文件夹建立工作区。\n也可以在设置中关闭「并行节点独立工作区」以解决此问题。";
  const empty = {
    runId: "", config, planType: "undecided", phase: "draft",
    graph: { originalGoal: "", nodes: [], edges: [] }, nodes: {}, plan: null,
    executions: [], mergers: [], events: [], approved: false, paused: false, base: "", feedbackCounts: {},
  };
  let current = empty;
  const info = { path: repository, name: "Alpha", branch: "main", head: "", clean: true };
  const errors = [];
  const planRequests = [];
  let context;
  try {
    context = await browser.newContext({ locale: "en-US", reducedMotion: "reduce" });
    await context.addInitScript(({ repository, config }) => {
      localStorage.setItem("pi_n_language_v1", "en");
      localStorage.setItem("pi_n_plan_mode", "graph");
      localStorage.setItem("pi_n_projects", JSON.stringify([{ id: repository, path: repository, name: "Alpha", lastOpened: 1 }]));
      localStorage.setItem("pi_n_config", JSON.stringify(config));
    }, { repository, config });
    await context.route("**/api/*", async route => {
      const command = new URL(route.request().url()).pathname.slice(5);
      const body = route.request().postDataJSON();
      if (command === "plan_goal_stream") {
        planRequests.push(body);
        if (body.mode === "graph" && body.config?.isolateParallelNodes !== false) {
          await route.fulfill({
            status: 200,
            contentType: "text/event-stream",
            body: `event: error\ndata: ${JSON.stringify({ error: sizeError })}\n\n`,
          });
          return;
        }
        current = {
          ...empty,
          runId: "admitted-shared-run",
          config: body.config,
          planType: "graph",
          phase: "awaiting_approval",
          graph: { originalGoal: body.goal, nodes: [{ id: "task", task: body.goal }], edges: [] },
          plan: { executionBatches: [["task"]], rootNodes: ["task"], terminals: ["task"], warnings: [] },
          nodes: { task: { status: "waiting", revision: 0, head: null, instruction: "", error: null } },
        };
        await route.fulfill({
          status: 200,
          contentType: "text/event-stream",
          body: [
            `event: run_started\ndata: ${JSON.stringify({ runId: current.runId })}\n\n`,
            `event: route_decision\ndata: ${JSON.stringify({ planType: "graph" })}\n\n`,
            `event: complete\ndata: ${JSON.stringify({ snapshot: current })}\n\n`,
          ].join(""),
        });
        return;
      }
      let result;
      switch (command) {
        case "bootstrap": result = { config, snapshot: current, runs: current.runId ? [current.runId] : [], conversations: current.runId ? fixtureSummaries([current]) : [], repositoryInfo: info, dataPath: "/mock/.pi-n" }; break;
        case "save_config": config = { ...config, ...body.config }; result = { config, snapshot: current, runs: [], conversations: [], repositoryInfo: info, dataPath: "/mock/.pi-n" }; break;
        case "host_preflight": result = { gitAvailable: true, gitError: null }; break;
        case "extension_command": result = { instance: "standalone", commands: [] }; break;
        case "snapshot": case "history": case "load_run": result = current; break;
        case "snapshot_if_changed": result = { version: current.runId || "draft", snapshot: current }; break;
        case "get_file_changes": result = fixtureFileChanges(body); break;
        case "repository_status": result = { repository: body.repository, valid: true, error: null, sizeLimitExceeded: false }; break;
        case "detect_repository": result = info; break;
        case "list_plannings": result = []; break;
        case "list_files": result = { files: [] }; break;
        case "list_skills": result = { skills: [] }; break;
        case "provider_auth": result = { providers: [{ id: "test", name: "Test", methods: [], configured: true }], models: [{ id: "model", provider: "test", name: "Model", api: "mock", contextWindow: 1000, available: true, thinkingLevels: ["off", "low"], thinkingLevelFallbacks: { minimal: "low", medium: "low", high: "low", xhigh: "low", max: "low" } }], warning: null }; break;
        case "pi_extensions": result = { globalDirectory: "mock", extensions: [] }; break;
        case "environment_capabilities": result = { platform: "windows", arch: "x86_64", nativeWorkspace: true }; break;
        default: errors.push(`Unexpected API: ${command}`); result = null;
      }
      await route.fulfill({ json: { result } });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    page.on("pageerror", error => errors.push(String(error)));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`, { waitUntil: "networkidle" });
    const alert = page.locator(".floating-error-banner");
    assert.equal(await alert.count(), 0, "joining or selecting a workspace must not show a size warning");

    const composer = page.locator("textarea").first();
    await composer.waitFor();
    await composer.fill("Plan a multi-node build");
    await composer.press("Enter");
    await alert.waitFor();
    const bannerText = await alert.textContent();
    assert.match(bannerText || "", /15GB/);
    assert.match(bannerText || "", /Isolate parallel node workspaces/);
    assert.equal(planRequests.length, 1);
    assert.equal(planRequests[0].mode, "graph");
    assert.equal(planRequests[0].config.isolateParallelNodes, true);

    // Following the warning's suggestion to disable parallel workspace isolation
    // in Settings lets the next Compile submission succeed without warning.
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const isolateToggle = page.getByLabel("Isolate parallel node workspaces", { exact: true });
    await isolateToggle.waitFor();
    await isolateToggle.uncheck();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.locator(".settings-modal").waitFor({ state: "detached" });
    assert.equal(await alert.count(), 0);

    const retryComposer = page.locator("textarea").first();
    await retryComposer.fill("Retry with shared workspace");
    const retryResponse = page.waitForResponse("**/api/plan_goal_stream");
    await retryComposer.press("Enter");
    await retryResponse;
    await page.locator('[data-run-id="admitted-shared-run"]').waitFor();
    await page.locator('.task-node[data-node-id="task"]').waitFor();
    assert.equal(planRequests.length, 2);
    assert.equal(planRequests[1].mode, "graph");
    assert.equal(planRequests[1].config.isolateParallelNodes, false);
    assert.equal(await alert.count(), 0);
    assert.deepEqual(errors, []);
  } finally {
    await context?.close();
  }
});

test("removing active workspace returns to home landing page instead of switching to remaining workspace conversation", { timeout: 90_000 }, async () => {
  const repositoryA = "C:\\Projects\\Alpha";
  const repositoryB = "C:\\Projects\\Beta";
  const config = { repository: repositoryA, model: "test/model", maxParallel: 1, maxFeedback: 3 };
  const makeSnapshot = (runId, repository, goal) => ({
    runId, config: { ...config, repository }, planType: "graph", phase: "completed",
    graph: { originalGoal: goal, nodes: [], edges: [] }, nodes: {}, plan: null,
    executions: [], mergers: [], events: [], approved: false, paused: false, base: "", feedbackCounts: {},
  });
  const snapshots = {
    "run-a": makeSnapshot("run-a", repositoryA, "Alpha conversation"),
    "run-b": makeSnapshot("run-b", repositoryB, "Beta conversation"),
  };
  const empty = { ...makeSnapshot("", repositoryA, ""), config: null, phase: "draft" };
  const info = repository => ({ path: repository, name: repository.includes("Beta") ? "Beta" : "Alpha", branch: "main", head: "", clean: true });
  const errors = [];
  let context;
  try {
    context = await browser.newContext({ locale: "en-US", reducedMotion: "reduce" });
    await context.addInitScript(({ repositoryA, repositoryB, config }) => {
      localStorage.setItem("pi_n_language_v1", "en");
      localStorage.setItem("pi_n_projects", JSON.stringify([
        { id: repositoryA, path: repositoryA, name: "Alpha", branch: "main", clean: true, lastOpened: 2 },
        { id: repositoryB, path: repositoryB, name: "Beta", branch: "main", clean: true, lastOpened: 1 },
      ]));
      localStorage.setItem("pi_n_workspace_runs", JSON.stringify({ [repositoryA]: ["run-a"], [repositoryB]: ["run-b"] }));
      localStorage.setItem("pi_n_run_labels", JSON.stringify({ "run-a": "Alpha conversation", "run-b": "Beta conversation" }));
      localStorage.setItem("pi_n_run_modes", JSON.stringify({ "run-a": "graph", "run-b": "graph" }));
      localStorage.setItem("pi_n_config", JSON.stringify(config));
    }, { repositoryA, repositoryB, config });
    await context.route("**/api/*", async route => {
      const command = new URL(route.request().url()).pathname.slice(5);
      const body = route.request().postDataJSON();
      let result;
      switch (command) {
        case "bootstrap": case "save_config":
          result = { config, snapshot: empty, runs: Object.keys(snapshots), conversations: fixtureSummaries(Object.values(snapshots)), repositoryInfo: info(repositoryA), dataPath: "/mock/.pi-n" }; break;
        case "get_file_changes": result = fixtureFileChanges(body); break;
        case "extension_command": result = { instance: "standalone", commands: [] }; break;
        case "load_run": case "history": case "snapshot": result = snapshots[body.runId] || empty; break;
        case "snapshot_if_changed": result = { version: "mock-1", snapshot: snapshots[body.runId] || null }; break;
        case "repository_status": result = { repository: body.repository, valid: true, error: null }; break;
        case "detect_repository": result = info(body.path || body.repository); break;
        case "list_plannings": result = []; break;
        case "list_files": result = { files: [] }; break;
        case "list_skills": result = { skills: [] }; break;
        case "provider_auth": result = { providers: [{ id: "test", name: "Test", methods: [], configured: true }], models: [], warning: null }; break;
        case "pi_extensions": result = { globalDirectory: "mock", extensions: [] }; break;
        case "environment_capabilities": result = { platform: "windows", arch: "x86_64", nativeWorkspace: true }; break;
        case "delete_workspace":
          assert.equal(body.repository, repositoryA);
          delete snapshots["run-a"];
          result = ["run-a"];
          break;
        default:
          errors.push(`Unexpected API: ${command}`);
          return route.fulfill({ status: 400, json: { error: `Unexpected API: ${command}` } });
      }
      await route.fulfill({ json: { result } });
    });
    const page = await context.newPage();
    page.on("pageerror", error => errors.push(String(error)));
    await page.goto(origin, { waitUntil: "networkidle" });
    await page.locator('[data-run-id="run-a"]').waitFor();
    await page.locator('[data-run-id="run-a"]').click();
    await page.locator(".chat-messages-stream", { hasText: "Alpha conversation" }).waitFor();

    // Remove active workspace Alpha
    await page.locator(".project-workspace-item", { hasText: "Alpha" }).click({ button: "right" });
    await page.locator(".context-menu-item.danger").click();
    const dialog = page.getByRole("alertdialog");
    await dialog.getByRole("button", { name: "Remove workspace", exact: true }).click();

    // Verify it returns to home landing screen rather than navigating into Beta conversation
    await page.locator(".landing-screen").waitFor();
    await page.waitForFunction(() => !document.querySelector(".chat-messages-stream"));
    assert.equal(await page.locator(".chat-messages-stream").count(), 0);
    await page.waitForFunction(() => document.querySelectorAll(".project-workspace-item").length === 1);
    assert.equal(await page.locator(".project-workspace-item").count(), 1);
    assert.equal(await page.locator(".project-workspace-item.active").count(), 0);
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem("pi_n_projects")).map(p => p.name)), ["Beta"]);
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem("pi-n-format-1:/mock/.pi-n:pi_n_config")).repository), "");

    // Switching to Beta still starts at home; the user opens its conversation explicitly.
    await page.locator(".project-workspace-item", { hasText: "Beta" }).click();
    await page.locator(".landing-screen").waitFor();
    await page.waitForFunction(() => !document.querySelector(".chat-messages-stream"));
    assert.equal(await page.locator(".run-item.chosen").count(), 0);
    await page.locator('[data-run-id="run-b"]').click();
    await page.locator(".chat-messages-stream", { hasText: "Beta conversation" }).waitFor();
    assert.deepEqual(errors, []);
  } finally {
    await context?.close();
  }
});

test("home composer accepts dragged image attachments and preserves them across history navigation", { timeout: 60_000 }, async () => {
  const repositoryA = "/projects/alpha";
  const repositoryB = "/projects/beta";
  const config = { repository: repositoryA, model: "test/model", thinkingLevel: "medium", maxParallel: 2, maxFeedback: 3, autoApprove: false };
  const makeSnapshot = (runId, repository, goal) => ({
    runId, config: { ...config, repository }, planType: "graph",
    graph: { originalGoal: goal, nodes: [], edges: [] }, nodes: {},
    plan: null, executions: [], events: [], approved: false, paused: false,
    phase: "completed", base: "", feedbackCounts: {},
  });
  const snapshots = {
    "run-a": makeSnapshot("run-a", repositoryA, "Alpha history conversation"),
    "run-b": makeSnapshot("run-b", repositoryB, "Beta history conversation"),
  };
  const empty = { ...makeSnapshot("", repositoryA, ""), config: null, phase: "draft" };
  const info = repository => ({ path: repository, name: repository.includes("beta") ? "Beta" : "Alpha", branch: "main", head: "", clean: true });
  const errors = [];
  let context;
  try {
    context = await browser.newContext({ viewport: { width: 1280, height: 768 }, locale: "en-US", reducedMotion: "reduce" });
    await context.addInitScript(({ repositoryA, repositoryB, config }) => {
      localStorage.setItem("pi_n_language_v1", "en");
      localStorage.setItem("pi_n_projects", JSON.stringify([
        { id: repositoryA, path: repositoryA, name: "Alpha", branch: "main", clean: true, lastOpened: 2 },
        { id: repositoryB, path: repositoryB, name: "Beta", branch: "main", clean: true, lastOpened: 1 },
      ]));
      localStorage.setItem("pi_n_workspace_runs", JSON.stringify({
        [repositoryA]: ["run-a"],
        [repositoryB]: ["run-b"],
      }));
      localStorage.setItem("pi_n_run_labels", JSON.stringify({
        "run-a": "Alpha history conversation",
        "run-b": "Beta history conversation",
      }));
      localStorage.setItem("pi_n_run_modes", JSON.stringify({ "run-a": "graph", "run-b": "graph" }));
      localStorage.setItem("pi_n_config", JSON.stringify(config));
    }, { repositoryA, repositoryB, config });
    await context.route("**/api/*", async route => {
      const command = new URL(route.request().url()).pathname.slice(5);
      const body = route.request().postDataJSON();
      let result;
      switch (command) {
        case "bootstrap": case "save_config":
          result = { config, snapshot: empty, runs: Object.keys(snapshots), conversations: fixtureSummaries(Object.values(snapshots)), repositoryInfo: info(repositoryA), dataPath: "/mock/.pi-n" }; break;
        case "get_file_changes": result = fixtureFileChanges(body); break;
        case "extension_command": result = { instance: "standalone", commands: [] }; break;
        case "load_run": case "history": case "snapshot": result = snapshots[body.runId] || empty; break;
        case "snapshot_if_changed": result = { version: "mock-1", snapshot: snapshots[body.runId] || null }; break;
        case "repository_status": result = { repository: body.repository, valid: true, error: null }; break;
        case "detect_repository": result = info(body.path || body.repository); break;
        case "list_plannings": result = []; break;
        case "list_files": result = { files: [] }; break;
        case "list_skills": result = { skills: [] }; break;
        case "provider_auth": result = { providers: [{ id: "test", name: "Test", methods: [], configured: true }], models: [], warning: null }; break;
        case "pi_extensions": result = { globalDirectory: "mock", extensions: [] }; break;
        case "environment_capabilities": result = { platform: "macos", arch: "arm64", nativeWorkspace: true }; break;
        default:
          errors.push(`Unexpected API: ${command}`);
          return route.fulfill({ status: 400, json: { error: `Unexpected API: ${command}` } });
      }
      await route.fulfill({ json: { result } });
    });

    const page = await context.newPage();
    page.on("pageerror", error => errors.push(String(error)));
    await page.goto(origin, { waitUntil: "networkidle" });
    await page.locator(".landing-screen .prompt-box-container").waitFor();

    // Drag a PNG image into the home composer via HTML5 drag-and-drop.
    await page.evaluate(() => {
      const target = document.querySelector(".landing-screen .prompt-box-container");
      const pngBytes = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), c => c.charCodeAt(0));
      const file = new File([pngBytes], "dropped-shot.png", { type: "image/png" });
      const dt = new DataTransfer();
      dt.items.add(file);
      target.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer: dt }));
      target.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }));
      target.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
    });
    const previewImg = page.locator('.landing-screen .prompt-box-preview-img[alt="dropped-shot.png"]');
    await previewImg.waitFor();
    await previewImg.evaluate(image => image.decode());

    // Navigate into a historical conversation (unmounts LandingView).
    await page.locator('[data-run-id="run-a"]').click();
    await page.locator(".chat-messages-stream", { hasText: "Alpha history conversation" }).waitFor();
    assert.equal(await page.locator(".landing-screen").count(), 0);

    // Return to home via New Conversation and verify the image attachment is still present.
    await page.getByRole("button", { name: "New conversation", exact: true }).click();
    await page.locator(".landing-screen").waitFor();
    await previewImg.waitFor();
    await previewImg.evaluate(image => image.decode());

    // Workspace isolation: switching to Beta hides Alpha's attachment; returning to Alpha restores it.
    await page.locator(".project-workspace-item", { hasText: "Beta" }).click();
    await page.locator(".project-workspace-item.active", { hasText: "Beta" }).waitFor();
    await previewImg.waitFor({ state: "detached" });
    assert.equal(await page.locator(".landing-screen .prompt-box-preview-img").count(), 0);

    await page.locator(".project-workspace-item", { hasText: "Alpha" }).click();
    await page.locator(".project-workspace-item.active", { hasText: "Alpha" }).waitFor();
    await previewImg.waitFor();
    await previewImg.evaluate(image => image.decode());

    // Window-level file drop guard prevents default browser navigation outside the composer.
    const dropPrevented = await page.evaluate(() => {
      const outside = document.querySelector(".landing-title-space");
      const dt = new DataTransfer();
      dt.items.add(new File(["hello"], "outside.txt", { type: "text/plain" }));
      const event = new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt });
      outside.dispatchEvent(event);
      return event.defaultPrevented;
    });
    assert.equal(dropPrevented, true);
    assert.deepEqual(errors, []);
  } finally {
    await context?.close();
  }
});
