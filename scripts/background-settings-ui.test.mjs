import assert from "node:assert/strict";
import { fixtureSummaries, fixtureFileChanges } from "./fixtures/current-api.mjs";
import test, { before, after } from "node:test";
import { connectOrLaunchBrowser } from "./fixtures/ui-browser.mjs";
import { createServer } from "vite";

let server, browser, origin;
const repository = "/background-test";
const config = { repository, model: "test/model", thinkingLevel: "off", maxParallel: 2, maxFeedback: 3, autoApprove: false };
const empty = { runId: "", config: null, phase: "draft", graph: { originalGoal: "", nodes: [], edges: [] }, nodes: {},
  executions: [], events: [], mergers: [], plan: null, approved: false, paused: false, base: "", feedbackCounts: {} };
const conversation = { ...empty, runId: "saved", config, phase: "completed", graph: { ...empty.graph, originalGoal: "Saved conversation" } };
const bootstrap = { config, snapshot: empty, runs: ["saved"], conversations: fixtureSummaries([conversation]), repositoryInfo: { path: repository, name: "Background", branch: "main", clean: true, head: "" }, dataPath: "/mock", envOverrides: {} };
const catalog = { providers: [{ id: "test", name: "Test", methods: [], configured: true }], warning: null,
  models: [{ provider: "test", id: "model", name: "Model", api: "mock", available: true, contextWindow: 1000, thinkingLevels: ["off"], thinkingLevelFallbacks: {} }] };

before(async () => {
  server = await createServer({ cacheDir: "node_modules/.vite-background-settings", server: { host: "127.0.0.1", port: 0, strictPort: false, open: false, hmr: false, watch: null } });
  await server.listen();
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await connectOrLaunchBrowser();
});
after(async () => { await browser?.close(); server?.httpServer?.closeAllConnections?.(); await server?.close(); });

async function openSettings(page) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.locator(".settings-modal").waitFor();
  await page.waitForFunction(() => document.querySelector(".save-config-btn")?.disabled === false);
}

const paths = page => page.locator(".app-background-root > .relative > .absolute .floating-path");
const grid = page => page.locator(".app-background-root .landing-page-grid");

test("Harness defaults keep Feedback opt-in and saved choices survive reload", { timeout: 90_000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US", reducedMotion: "reduce" });
  let savedConfig = { ...config, maxParallel: 0, maxFeedback: 0 };
  delete savedConfig.autoApprove;
  const errors = [], saves = [];
  await context.addInitScript(({ repository }) => {
    localStorage.setItem("pi_n_language_v1", "en");
    localStorage.setItem("pi_n_projects", JSON.stringify([{ id: repository, path: repository, name: "Harness defaults", lastOpened: 1 }]));
  }, { repository });
  await context.route("**/api/*", async route => {
    const command = new URL(route.request().url()).pathname.slice(5);
    const body = route.request().postDataJSON();
    if (command === "save_config") {
      savedConfig = body.config;
      saves.push(savedConfig);
      return route.fulfill({ json: { result: { ...bootstrap, config: savedConfig } } });
    }
    const defaults = { bootstrap: { ...bootstrap, config: savedConfig }, history: conversation, snapshot: conversation, load_run: conversation,
      get_file_changes: fixtureFileChanges(body), extension_command: { instance: "standalone", commands: [] },
      snapshot_if_changed: { version: "fixed", snapshot: null }, repository_status: { repository, valid: true, error: null },
      list_plannings: [], list_files: { files: [] }, list_skills: { skills: [] }, provider_auth: catalog,
      pi_extensions: { globalDirectory: "mock", extensions: [] }, environment_capabilities: { platform: "windows", arch: "x86_64", nativeWorkspace: true } };
    if (!(command in defaults)) errors.push(`Unexpected API: ${command}`);
    return route.fulfill({ json: { result: defaults[command] ?? null } });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  page.on("pageerror", error => errors.push(String(error)));
  const modes = page.locator(".landing-screen .prompt-box-mode-btn");
  const harnessCard = page.getByRole("region", { name: "Compile mode settings", exact: true });
  const uiCard = page.getByRole("region", { name: "UI settings", exact: true });
  const defaultOnHarnessLabels = ["Auto approve Planner graphs", "Post-task Planner review",
    "Isolate parallel node workspaces", "Mount Planner write and edit tools"];
  const checkbox = name => harnessCard.getByRole("checkbox", { name, exact: true });
  const feedback = checkbox("Enable Feedback");
  const maxParallelInput = harnessCard.getByRole("spinbutton", { name: "Parallel agents", exact: true });
  const maxFeedbackInput = harnessCard.getByRole("spinbutton", { name: "Feedback budget", exact: true });
  try {
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    await modes.filter({ hasText: "Compile" }).waitFor();
    assert.deepEqual(await modes.allTextContents(), ["Direct", "Compile"]);
    await openSettings(page);
    for (const label of defaultOnHarnessLabels) assert.equal(await checkbox(label).isChecked(), true, label);
    assert.equal(await uiCard.getByRole("checkbox", { name: "Hide Auto mode", exact: true }).count(), 0);
    assert.equal(await feedback.isChecked(), false, "Feedback is opt-in when absent from saved settings");
    assert.equal(await maxFeedbackInput.isDisabled(), true);
    assert.equal(await maxParallelInput.inputValue(), "20", "legacy maxParallel=0 defaults to 20");
    assert.equal(await maxParallelInput.getAttribute("min"), "2");
    assert.equal(await maxParallelInput.getAttribute("max"), "40");
    assert.equal(await maxFeedbackInput.inputValue(), "4", "legacy maxFeedback=0 defaults to 4");
    assert.equal(await maxFeedbackInput.getAttribute("min"), "2");
    assert.equal(await maxFeedbackInput.getAttribute("max"), "40");
    assert.equal(await page.locator(".role-model-group").count(), 2);
    await page.locator(".save-config-btn").click();
    await page.locator(".settings-modal").waitFor({ state: "detached" });
    for (const key of ["autoApprove", "postTaskReview", "plannerWriteTools", "isolateParallelNodes"]) {
      assert.equal(saves[0][key], true, `${key} saves the enabled default`);
    }
    assert.equal(saves[0].maxParallel, 20);
    assert.equal(saves[0].maxFeedback, 4);
    assert.equal(saves[0].feedbackEnabled, false);

    await openSettings(page);
    for (const label of defaultOnHarnessLabels) await checkbox(label).uncheck();
    await feedback.check();
    assert.equal(await maxFeedbackInput.isEnabled(), true);
    await maxParallelInput.fill("1");
    await maxParallelInput.blur();
    assert.equal(await maxParallelInput.inputValue(), "2", "values below 2 clamp to minimum 2");
    await maxParallelInput.fill("99");
    await maxParallelInput.blur();
    assert.equal(await maxParallelInput.inputValue(), "40", "values above 40 clamp to maximum 40");
    await maxParallelInput.fill("24");
    await maxFeedbackInput.fill("1");
    await maxFeedbackInput.blur();
    assert.equal(await maxFeedbackInput.inputValue(), "2", "feedback budget below 2 clamps to minimum 2");
    await maxFeedbackInput.fill("99");
    await maxFeedbackInput.blur();
    assert.equal(await maxFeedbackInput.inputValue(), "40", "feedback budget above 40 clamps to maximum 40");
    await maxFeedbackInput.fill("16");
    await page.locator(".save-config-btn").click();
    await page.locator(".settings-modal").waitFor({ state: "detached" });
    for (const key of ["autoApprove", "postTaskReview", "plannerWriteTools", "isolateParallelNodes"]) {
      assert.equal(saves[1][key], false, `${key} saves an explicit opt-out`);
    }
    assert.equal(saves[1].maxParallel, 24);
    assert.equal(saves[1].maxFeedback, 16);
    assert.equal(saves[1].feedbackEnabled, true);
    await page.reload({ waitUntil: "domcontentloaded" });
    await modes.filter({ hasText: "Compile" }).waitFor();
    await openSettings(page);
    for (const label of defaultOnHarnessLabels) assert.equal(await checkbox(label).isChecked(), false, label);
    assert.equal(await feedback.isChecked(), true);
    assert.equal(await maxFeedbackInput.isEnabled(), true);
    assert.equal(await maxParallelInput.inputValue(), "24");
    assert.equal(await maxFeedbackInput.inputValue(), "16");
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("retired Auto mode falls back to Direct and Settings groups execution and UI cards cleanly", { timeout: 90_000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US", reducedMotion: "reduce" });
  let savedConfig = { ...config };
  const errors = [], saves = [];
  await context.addInitScript(({ repository }) => {
    localStorage.setItem("pi_n_language_v1", "en");
    localStorage.setItem("pi_n_projects", JSON.stringify([{ id: repository, path: repository, name: "Mode fallback", lastOpened: 1 }]));
    if (!localStorage.getItem("pi_n_plan_mode")) localStorage.setItem("pi_n_plan_mode", "auto");
  }, { repository });
  await context.route("**/api/*", async route => {
    const command = new URL(route.request().url()).pathname.slice(5), body = route.request().postDataJSON();
    if (command === "save_config") {
      saves.push(body.config);
      savedConfig = body.config;
      return route.fulfill({ json: { result: { ...bootstrap, config: savedConfig } } });
    }
    if (command === "plan_goal_stream") return route.fulfill({ status: 500, json: { error: "Mock planning rejected" } });
    const defaults = { bootstrap: { ...bootstrap, config: savedConfig }, history: conversation, snapshot: conversation, load_run: conversation,
      get_file_changes: fixtureFileChanges(body), extension_command: { instance: "standalone", commands: [] },
      snapshot_if_changed: { version: "fixed", snapshot: null }, repository_status: { repository, valid: true, error: null },
      list_plannings: [], list_files: { files: [] }, list_skills: { skills: [] }, provider_auth: catalog,
      pi_extensions: { globalDirectory: "mock", extensions: [] }, environment_capabilities: { platform: "windows", arch: "x86_64", nativeWorkspace: true } };
    if (!(command in defaults)) errors.push(`Unexpected API: ${command}`);
    return route.fulfill({ json: { result: defaults[command] ?? null } });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  page.on("pageerror", error => errors.push(String(error)));
  const modes = page.locator(".landing-screen .prompt-box-mode-btn");
  const uiCard = page.getByRole("region", { name: "UI settings", exact: true });
  try {
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    await modes.filter({ hasText: "Direct" }).waitFor();
    assert.deepEqual(await modes.allTextContents(), ["Direct", "Compile"]);
    assert.equal(await modes.filter({ hasText: "Direct" }).getAttribute("aria-pressed"), "true");
    await openSettings(page);
    const planningCard = page.getByRole("region", { name: "Compile mode settings", exact: true });
    assert.deepEqual(await planningCard.getByRole("checkbox").evaluateAll(inputs => inputs.map(input => input.getAttribute("aria-label"))), [
      "Auto approve Planner graphs", "Post-task Planner review",
      "Isolate parallel node workspaces", "Mount Planner write and edit tools", "Enable Feedback",
    ], "planning, approval, workspace and Planner file-tool options share one card");
    assert.deepEqual(await uiCard.getByRole("checkbox").evaluateAll(inputs => inputs.map(input => input.getAttribute("aria-label"))), [
      "Auto-expand chain of thought while running", "Show execution graph overview", "Completion notifications", "Notification sound",
    ], "UI settings omits the removed Hide Auto mode toggle");
    assert.equal(await planningCard.locator(".role-model-settings").count(), 0, "execution settings remain separate from model settings");
    assert.equal(await page.locator(".role-model-group").count(), 2);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.locator(".settings-modal").waitFor({ state: "detached" });
    const request = page.waitForRequest("**/api/plan_goal_stream");
    const response = page.waitForResponse("**/api/plan_goal_stream");
    await page.locator(".landing-screen textarea").fill("Use the visible Direct mode");
    await page.locator(".landing-screen textarea").press("Enter");
    assert.equal((await request).postDataJSON().mode, "serial", "a stale stored Auto mode must not reach the backend");
    await response;
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("home background saves only after acceptance, persists, and preserves the app shell", { timeout: 90_000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US", reducedMotion: "reduce" });
  let failSave = true;
  const errors = [], saves = [];
  await context.addInitScript(({ repository, config }) => {
    localStorage.setItem("pi_n_language_v1", "en");
    localStorage.setItem("pi_n_projects", JSON.stringify([{ id: repository, path: repository, name: "Background", lastOpened: 1 }]));
    localStorage.setItem("pi_n_data_path", "/mock");
    localStorage.setItem("pi-n-format-1:/mock:pi_n_config", JSON.stringify(config));
  }, { repository, config });
  await context.route("**/api/*", async route => {
    const command = new URL(route.request().url()).pathname.slice(5);
    const body = route.request().postDataJSON();
    if (command === "save_config") {
      saves.push(body.config);
      if (failSave) return route.fulfill({ status: 500, json: { error: "Mock save failed" } });
      return route.fulfill({ json: { result: { ...bootstrap, config: body.config } } });
    }
    const defaults = { bootstrap, history: conversation, snapshot: conversation, load_run: conversation,
      get_file_changes: fixtureFileChanges(body), extension_command: { instance: "standalone", commands: [] },
      snapshot_if_changed: { version: "fixed", snapshot: null }, repository_status: { repository, valid: true, error: null },
      list_plannings: [], list_files: { files: [] }, list_skills: { skills: [] }, provider_auth: catalog,
      pi_extensions: { globalDirectory: "mock", extensions: [] }, environment_capabilities: { platform: "windows", arch: "x86_64", nativeWorkspace: true } };
    if (!(command in defaults)) errors.push(`Unexpected API: ${command}`);
    return route.fulfill({ json: { result: defaults[command] ?? null } });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  page.on("pageerror", error => errors.push(String(error)));
  try {
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    await page.locator(".landing-screen textarea").fill("Keep this draft");
    await grid(page).waitFor();
    assert.equal(await paths(page).count(), 0);
    assert.equal(await grid(page).count(), 1, "the tri-color grid is the default");
    await page.evaluate(() => { window.originalComposer = document.querySelector(".landing-screen textarea"); });

    await openSettings(page);
    const uiCard = page.getByRole("region", { name: "UI settings", exact: true });
    assert.equal(await uiCard.getByRole("checkbox", { name: "Auto-expand chain of thought while running", exact: true }).count(), 1,
      "reasoning display and home background share the UI settings card");
    const backgroundOptions = uiCard.getByRole("group", { name: "Home background", exact: true });
    const animated = backgroundOptions.getByRole("radio", { name: /Animated paths/ });
    const pattern = backgroundOptions.getByRole("radio", { name: /Tri-color grid/ });
    const dotOption = backgroundOptions.getByRole("radio", { name: /Dot pattern/ });
    assert.equal(await pattern.isChecked(), true);
    assert.deepEqual(await page.locator('input[name="landing-background"]').evaluateAll(inputs => inputs.map(input => input.value)), ["grid", "dots", "paths"], "the default option appears first");
    const optionTops = await page.locator(".settings-background-option").evaluateAll(items => items.map(item => Math.round(item.getBoundingClientRect().top)));
    assert.equal(new Set(optionTops).size, 1, "the three background options share one row");
    const radioBorder = radio => radio.evaluate(input => getComputedStyle(input).borderColor);
    const originalBorder = await radioBorder(pattern);
    assert.equal(originalBorder, await radioBorder(animated), "selected and unselected radio outlines match");
    assert.equal(await pattern.evaluate(input => {
      const probe = document.createElement("span");
      probe.style.color = "var(--brand-default)";
      input.parentElement.append(probe);
      const hasBlueDot = getComputedStyle(input).backgroundImage.includes(getComputedStyle(probe).color);
      probe.remove();
      return hasBlueDot;
    }), true, "the selected radio keeps its blue dot");
    await animated.check();
    assert.equal(await radioBorder(animated), originalBorder, "the outline stays unchanged after selection");
    assert.equal(await grid(page).count(), 1, "a draft does not change the live background");
    assert.equal(await paths(page).count(), 0);
    assert.equal(await page.evaluate(() => localStorage.getItem("pi_n_landing_background_v1")), null);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.locator(".settings-modal").waitFor({ state: "detached" });
    await openSettings(page);
    assert.equal(await pattern.isChecked(), true, "cancel discards the draft");
    await animated.check();
    await page.locator(".save-config-btn").click();
    await page.getByRole("alert").filter({ hasText: "Mock save failed" }).waitFor();
    assert.equal(await animated.isChecked(), true, "a failed save keeps the draft for retry");
    assert.equal(await grid(page).count(), 1);
    assert.equal(await paths(page).count(), 0);
    assert.equal(await page.evaluate(() => localStorage.getItem("pi_n_landing_background_v1")), null);

    failSave = false;
    await pattern.check();
    await page.locator(".save-config-btn").click();
    await page.locator(".settings-modal").waitFor({ state: "detached" });
    await grid(page).waitFor();
    assert.equal(await paths(page).count(), 0);
    assert.equal(await page.evaluate(() => localStorage.getItem("pi_n_landing_background_v1")), "grid");
    assert.ok(saves.every(saved => !("landingBackground" in saved)), "display preferences stay out of backend configuration");
    assert.equal(await page.evaluate(() => window.originalComposer === document.querySelector(".landing-screen textarea")), true);
    assert.equal(await page.locator(".landing-screen textarea").inputValue(), "Keep this draft");

    await page.locator('[data-run-id="saved"]').click();
    await page.waitForFunction(() => !document.querySelector(".app-background-root").classList.contains("landing-active"));
    await page.waitForFunction(() => getComputedStyle(document.querySelector(".landing-page-grid").parentElement).opacity === "0");
    assert.equal(await page.locator(".main").evaluate(element => getComputedStyle(element).overflow), "hidden", "the workbench retains its clipping");
    await page.getByRole("button", { name: "New conversation", exact: true }).click();
    await page.waitForFunction(() => document.querySelector(".app-background-root").classList.contains("landing-active"));
    await page.waitForFunction(() => getComputedStyle(document.querySelector(".landing-page-grid").parentElement).opacity === "1");

    await page.reload({ waitUntil: "domcontentloaded" });
    await grid(page).waitFor();
    await openSettings(page);
    assert.equal(await pattern.isChecked(), true, "the selection survives a reload");
    await page.setViewportSize({ width: 390, height: 844 });
    await pattern.scrollIntoViewIfNeeded();
    const radioBox = await pattern.boundingBox();
    assert.ok(radioBox && radioBox.x >= 0 && radioBox.x + radioBox.width <= 390, "options remain reachable on narrow screens");
    await pattern.focus();
    await page.keyboard.press("ArrowRight");
    assert.equal(await dotOption.isChecked(), true, "native radio options support keyboard navigation");
    await page.keyboard.press("ArrowRight");
    assert.equal(await animated.isChecked(), true, "native radio options support keyboard navigation");
    await page.locator(".save-config-btn").click();
    await page.locator(".settings-modal").waitFor({ state: "detached" });
    await paths(page).first().waitFor();
    assert.equal(await page.evaluate(() => localStorage.getItem("pi_n_landing_background_v1")), "paths");

    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("execution graph overview defaults off, sits between UI sections, and commits only on save", { timeout: 90_000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US", reducedMotion: "reduce" });
  const graphSnapshot = {
    ...conversation,
    runId: "graph-overview",
    planType: "graph",
    graph: {
      originalGoal: "Graph overview test",
      nodes: [{ id: "step_one", task: "Do step one" }],
      edges: [],
    },
    nodes: { step_one: { status: "completed", revision: 1, instruction: "", error: null } },
    plan: { executionBatches: [["step_one"]], rootNodes: ["step_one"], terminals: ["step_one"], warnings: [] },
    publication: { repository, heads: ["step_one"], status: "completed", head: null, error: null, startedAt: 1, completedAt: 2 },
  };
  let failSave = true;
  const errors = [], saves = [];
  await context.addInitScript(({ repository, config }) => {
    localStorage.setItem("pi_n_language_v1", "en");
    localStorage.setItem("pi_n_projects", JSON.stringify([{ id: repository, path: repository, name: "Overview", lastOpened: 1 }]));
    localStorage.setItem("pi_n_data_path", "/mock");
    localStorage.setItem("pi-n-format-1:/mock:pi_n_config", JSON.stringify(config));
  }, { repository, config });
  await context.route("**/api/*", async route => {
    const command = new URL(route.request().url()).pathname.slice(5);
    const body = route.request().postDataJSON();
    if (command === "save_config") {
      saves.push(body.config);
      if (failSave) return route.fulfill({ status: 500, json: { error: "Mock save failed" } });
      return route.fulfill({ json: { result: { ...bootstrap, config: body.config } } });
    }
    const defaults = {
      bootstrap: { ...bootstrap, runs: [graphSnapshot.runId], conversations: fixtureSummaries([graphSnapshot]) },
      history: body?.runId === graphSnapshot.runId ? graphSnapshot : empty,
      snapshot: body?.runId === graphSnapshot.runId ? graphSnapshot : empty,
      load_run: body?.runId === graphSnapshot.runId ? graphSnapshot : empty,
      get_file_changes: fixtureFileChanges(body), extension_command: { instance: "standalone", commands: [] },
      snapshot_if_changed: { version: "fixed", snapshot: null },
      repository_status: { repository, valid: true, error: null },
      list_plannings: [], list_files: { files: [] }, list_skills: { skills: [] }, provider_auth: catalog,
      pi_extensions: { globalDirectory: "mock", extensions: [] },
      environment_capabilities: { platform: "windows", arch: "x86_64", nativeWorkspace: true },
    };
    if (!(command in defaults)) errors.push(`Unexpected API: ${command}`);
    return route.fulfill({ json: { result: defaults[command] ?? null } });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  page.on("pageerror", error => errors.push(String(error)));
  try {
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    await page.locator(`[data-run-id="${graphSnapshot.runId}"]`).click();
    await page.locator(".react-flow__node").first().waitFor();
    assert.equal(await page.locator(".plan-summary-card").count(), 0, "execution graph overview is hidden by default");

    await openSettings(page);
    const uiCard = page.getByRole("region", { name: "UI settings", exact: true });
    const cotToggle = uiCard.getByRole("checkbox", { name: "Auto-expand chain of thought while running", exact: true });
    const overviewToggle = uiCard.getByRole("checkbox", { name: "Show execution graph overview", exact: true });
    const backgroundGroup = uiCard.getByRole("group", { name: "Home background", exact: true });
    assert.equal(await overviewToggle.isChecked(), false, "the overview toggle defaults off");
    const [cotBox, overviewBox, backgroundBox] = await Promise.all([
      cotToggle.boundingBox(),
      overviewToggle.boundingBox(),
      backgroundGroup.boundingBox(),
    ]);
    assert.ok(cotBox && overviewBox && backgroundBox, "all UI settings sections render with bounds");
    assert.ok(cotBox.y < overviewBox.y && overviewBox.y < backgroundBox.y,
      "the overview toggle sits between reasoning auto-expand and home background");

    await overviewToggle.check();
    assert.equal(await page.locator(".plan-summary-card").count(), 0, "staging the toggle does not show the overview before save");
    assert.equal(await page.evaluate(() => localStorage.getItem("pi_n_execution_overview_v1")), null);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.locator(".settings-modal").waitFor({ state: "detached" });
    await openSettings(page);
    assert.equal(await overviewToggle.isChecked(), false, "Cancel discards the overview draft");

    await overviewToggle.check();
    await page.locator(".save-config-btn").click();
    await page.getByRole("alert").filter({ hasText: "Mock save failed" }).waitFor();
    assert.equal(await overviewToggle.isChecked(), true, "a failed save keeps the draft for retry");
    assert.equal(await page.locator(".plan-summary-card").count(), 0);
    assert.equal(await page.evaluate(() => localStorage.getItem("pi_n_execution_overview_v1")), null);

    failSave = false;
    await page.locator(".save-config-btn").click();
    await page.locator(".settings-modal").waitFor({ state: "detached" });
    await page.locator(".plan-summary-card").waitFor();
    assert.equal(await page.evaluate(() => localStorage.getItem("pi_n_execution_overview_v1")), "1");
    assert.ok(saves.every(saved => !("executionOverview" in saved)), "display preferences stay out of backend configuration");

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator(`[data-run-id="${graphSnapshot.runId}"]`).click();
    await page.locator(".plan-summary-card").waitFor();
    await openSettings(page);
    assert.equal(await overviewToggle.isChecked(), true, "the enabled preference survives reload");
    await overviewToggle.uncheck();
    await page.locator(".save-config-btn").click();
    await page.locator(".settings-modal").waitFor({ state: "detached" });
    await page.locator(".plan-summary-card").waitFor({ state: "detached" });
    assert.equal(await page.evaluate(() => localStorage.getItem("pi_n_execution_overview_v1")), "0");
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("completion notifications default to on, notify with agent final output when unfocused, and can be disabled in UI settings", { timeout: 90_000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US", reducedMotion: "reduce" });
  const otherRepository = "/mock/other";
  const errors = [];
  let runPhase = "running";
  let snapshotVersion = "v1";
  let execStatus = "running";
  const makeLiveSnapshot = () => ({
    ...empty,
    runId: "notify-run",
    title: "Refactor parser",
    planType: "serial",
    approved: true,
    config,
    phase: runPhase,
    graph: { originalGoal: "Refactor parser", nodes: [{ id: "task", task: "Refactor parser" }], edges: [] },
    nodes: { task: { status: execStatus, revision: 1, head: null, instruction: "Refactor parser", error: null } },
    executions: [{
      id: "exec-notify-1",
      node: "task",
      revision: 1,
      attempt: 1,
      sessionId: "sess-notify",
      worktree: repository,
      before: "a",
      after: execStatus === "completed" ? "b" : null,
      workspaceLineage: [],
      input: null,
      result: null,
      status: execStatus,
      startedAt: 1000,
      completedAt: execStatus === "completed" ? 2000 : null,
      output: "",
      outputBytes: 120,
      pid: null,
      metrics: null,
    }],
    events: [{ sequence: execStatus === "completed" ? 2 : 1, timestamp: 2000, type: "status" }],
  });
  const finalAssistantJsonl = JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Parser refactor is complete. Would you like me to run benchmarks next?" }],
    },
  }) + "\n";

  await context.addInitScript(({ repository, otherRepository }) => {
    localStorage.setItem("pi_n_language_v1", "en");
    localStorage.setItem("pi_n_projects", JSON.stringify([
      { id: repository, path: repository, name: "Notify", lastOpened: 1 },
      { id: otherRepository, path: otherRepository, name: "Other", lastOpened: 0 },
    ]));
    localStorage.setItem("pi_n_workspace_runs", JSON.stringify({ [repository]: ["notify-run"] }));
    localStorage.setItem("pi_n_run_labels", JSON.stringify({ "notify-run": "Refactor parser" }));
    window.__sentNotifications = [];
    window.__notificationInstances = [];
    window.__unfocused = false;
    document.hasFocus = () => !window.__unfocused;
    class MockNotification {
      static permission = "granted";
      static async requestPermission() { return "granted"; }
      constructor(title, options) {
        window.__sentNotifications.push({
          title,
          body: options?.body ?? "",
          silent: Boolean(options?.silent),
        });
        window.__notificationInstances.push(this);
      }
      close() {}
    }
    window.Notification = MockNotification;
  }, { repository, otherRepository });

  await context.route("**/api/*", async route => {
    const command = new URL(route.request().url()).pathname.slice(5);
    const body = route.request().postDataJSON();
    if (command === "save_config") {
      return route.fulfill({ json: { result: { ...bootstrap, config: body.config, runs: ["notify-run"], conversations: fixtureSummaries([makeLiveSnapshot()]) } } });
    }
    if (command === "bootstrap") {
      return route.fulfill({ json: { result: { ...bootstrap, snapshot: empty, runs: ["notify-run"], conversations: fixtureSummaries([makeLiveSnapshot()]) } } });
    }
    if (command === "snapshot_if_changed") {
      const snap = body.runId === "notify-run" ? makeLiveSnapshot() : null;
      return route.fulfill({ json: { result: { version: snapshotVersion, snapshot: snap, activity: [] } } });
    }
    if (command === "get_execution_output") {
      return route.fulfill({
        json: {
          result: {
            runId: "notify-run",
            executionId: "exec-notify-1",
            content: finalAssistantJsonl,
            startOffset: 0,
            nextOffset: finalAssistantJsonl.length,
            totalBytes: finalAssistantJsonl.length,
            complete: true,
            status: "completed",
          },
        },
      });
    }
    const defaults = {
      history: makeLiveSnapshot(),
      snapshot: makeLiveSnapshot(),
      load_run: makeLiveSnapshot(),
      get_file_changes: fixtureFileChanges(body),
      extension_command: { instance: "standalone", commands: [] },
      repository_status: { repository, valid: true, error: null },
      list_plannings: [],
      list_files: { files: [] },
      list_skills: { skills: [] },
      provider_auth: catalog,
      pi_extensions: { globalDirectory: "mock", extensions: [] },
      environment_capabilities: { platform: "macos", arch: "arm64", nativeWorkspace: true },
    };
    if (!(command in defaults)) errors.push(`Unexpected API: ${command}`);
    return route.fulfill({ json: { result: defaults[command] ?? null } });
  });

  const page = await context.newPage();
  page.setDefaultTimeout(12_000);
  page.on("pageerror", error => errors.push(String(error)));
  try {
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    // Wait until the sidebar card shows the active working dot.
    await page.locator('[data-run-id="notify-run"] .run-dot.running-pulse').waitFor();

    // Mark window unfocused and complete the conversation card in the background.
    await page.evaluate(() => { window.__unfocused = true; });
    runPhase = "completed";
    execStatus = "completed";
    snapshotVersion = "v2";

    await page.waitForFunction(() => window.__sentNotifications.length === 1);
    const first = await page.evaluate(() => window.__sentNotifications[0]);
    assert.deepEqual(first, {
      title: "Refactor parser",
      body: "Parser refactor is complete. Would you like me to run benchmarks next?",
      silent: false,
    });

    // Clicking the notification switches back from another workspace and opens
    // its conversation without waiting for repository detection.
    await page.getByRole("button", { name: `Other\n${otherRepository}`, exact: true }).click();
    assert.equal(await page.locator('.project-workspace-item[aria-current="true"]').getAttribute("aria-label"), `Other\n${otherRepository}`);
    await page.evaluate(() => {
      window.__unfocused = false;
      window.__notificationInstances[0]?.onclick?.();
    });
    await page.locator('[data-run-id="notify-run"][aria-current="true"]').waitFor();

    // Open UI settings: verify Notification sound defaults to enabled, disable sound only, and verify silent notification.
    await openSettings(page);
    const uiCard = page.getByRole("region", { name: "UI settings", exact: true });
    const notifyToggle = uiCard.getByRole("checkbox", { name: "Completion notifications", exact: true });
    const soundToggle = uiCard.getByRole("checkbox", { name: "Notification sound", exact: true });
    assert.equal(await notifyToggle.isChecked(), true, "completion notifications default to enabled");
    assert.equal(await soundToggle.isChecked(), true, "notification sound defaults to enabled");
    await soundToggle.uncheck();
    await page.locator(".save-config-btn").click();
    await page.locator(".settings-modal").waitFor({ state: "detached" });
    assert.equal(await page.evaluate(() => localStorage.getItem("pi_n_completion_notification_sound_v1")), "0");

    // Complete another running turn while unfocused: notification should now be silent.
    runPhase = "running";
    execStatus = "running";
    snapshotVersion = "v2b";
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator('[data-run-id="notify-run"] .run-dot.running-pulse').waitFor();
    await page.evaluate(() => { window.__unfocused = true; });
    runPhase = "completed";
    execStatus = "completed";
    snapshotVersion = "v2c";
    await page.waitForFunction(() => window.__sentNotifications.length === 1);
    const silentNotif = await page.evaluate(() => window.__sentNotifications[0]);
    assert.equal(silentNotif.silent, true, "disabling notification sound sends silent notifications");

    // Now disable completion notifications altogether and verify sound toggle disables with it.
    await page.evaluate(() => { window.__unfocused = false; });
    await openSettings(page);
    assert.equal(await soundToggle.isChecked(), false, "disabled sound preference persists across reload");
    await notifyToggle.uncheck();
    assert.equal(await soundToggle.isDisabled(), true, "sound toggle disables when notifications are off");
    await page.locator(".save-config-btn").click();
    await page.locator(".settings-modal").waitFor({ state: "detached" });
    assert.equal(await page.evaluate(() => localStorage.getItem("pi_n_completion_notifications_v1")), "0");

    // Reload with the disabled preference persisted, then complete another running turn while unfocused.
    runPhase = "running";
    execStatus = "running";
    snapshotVersion = "v3";
    await page.reload({ waitUntil: "domcontentloaded" });
    await openSettings(page);
    assert.equal(await notifyToggle.isChecked(), false, "disabled preference persists across reload");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.locator(".settings-modal").waitFor({ state: "detached" });

    await page.locator('[data-run-id="notify-run"] .run-dot.running-pulse').waitFor();
    await page.evaluate(() => { window.__unfocused = true; });
    runPhase = "completed";
    execStatus = "completed";
    snapshotVersion = "v4";
    await page.locator('[data-run-id="notify-run"] .run-dot.running-pulse').waitFor({ state: "detached" });
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => window.__sentNotifications.length), 0, "no notification after reload when disabled in UI settings");
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("completion notification fires for the currently viewed conversation when hidden", { timeout: 90_000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US", reducedMotion: "reduce" });
  const errors = [];
  let runPhase = "running";
  let execStatus = "running";
  let snapshotVersion = "v1";
  const hiddenPollVersions = [];
  const makeLiveSnapshot = () => ({
    ...empty,
    runId: "viewed-notify-run",
    title: "Hidden active run",
    planType: "serial",
    approved: true,
    config,
    phase: runPhase,
    graph: { originalGoal: "Hidden active run", nodes: [{ id: "task", task: "Hidden active run" }], edges: [] },
    nodes: { task: { status: execStatus, revision: 1, head: null, instruction: "Hidden active run", error: null } },
    executions: [{
      id: "exec-viewed-1",
      node: "task",
      revision: 1,
      attempt: 1,
      sessionId: "sess-viewed",
      worktree: repository,
      before: "a",
      after: execStatus === "completed" ? "b" : null,
      workspaceLineage: [],
      input: null,
      result: null,
      status: execStatus,
      startedAt: 1000,
      completedAt: execStatus === "completed" ? 2000 : null,
      output: "",
      outputBytes: 120,
      pid: null,
      metrics: null,
    }],
    events: [{ sequence: execStatus === "completed" ? 2 : 1, timestamp: 2000, type: "status" }],
  });
  const finalAssistantJsonl = JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Finished while window was hidden." }],
    },
  }) + "\n";

  await context.addInitScript(({ repository }) => {
    localStorage.setItem("pi_n_language_v1", "en");
    localStorage.setItem("pi_n_projects", JSON.stringify([{ id: repository, path: repository, name: "HiddenNotify", lastOpened: 1 }]));
    localStorage.setItem("pi_n_workspace_runs", JSON.stringify({ [repository]: ["viewed-notify-run"] }));
    localStorage.setItem("pi_n_run_labels", JSON.stringify({ "viewed-notify-run": "Hidden active run" }));
    window.__sentNotifications = [];
    window.__docHidden = false;
    Object.defineProperty(document, "hidden", { configurable: true, get: () => window.__docHidden });
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (window.__docHidden ? "hidden" : "visible") });
    document.hasFocus = () => !window.__docHidden;
    class MockNotification {
      static permission = "granted";
      static async requestPermission() { return "granted"; }
      constructor(title, options) {
        window.__sentNotifications.push({ title, body: options?.body ?? "" });
      }
      close() {}
    }
    window.Notification = MockNotification;
  }, { repository });

  await context.route("**/api/*", async route => {
    const command = new URL(route.request().url()).pathname.slice(5);
    const body = route.request().postDataJSON();
    if (command === "bootstrap") {
      const snap = makeLiveSnapshot();
      return route.fulfill({ json: { result: { ...bootstrap, snapshot: snap, runs: ["viewed-notify-run"], conversations: fixtureSummaries([snap]) } } });
    }
    if (command === "snapshot_if_changed") {
      if (body.runId === "viewed-notify-run") {
        hiddenPollVersions.push(body.version ?? null);
        const unchanged = body.version === snapshotVersion;
        return route.fulfill({ json: { result: { version: snapshotVersion, snapshot: unchanged ? null : makeLiveSnapshot(), activity: [] } } });
      }
      return route.fulfill({ json: { result: { version: "idle", snapshot: null, activity: [] } } });
    }
    if (command === "get_execution_output") {
      return route.fulfill({
        json: {
          result: {
            runId: "viewed-notify-run",
            executionId: "exec-viewed-1",
            content: finalAssistantJsonl,
            startOffset: 0,
            nextOffset: finalAssistantJsonl.length,
            totalBytes: finalAssistantJsonl.length,
            complete: true,
            status: execStatus,
          },
        },
      });
    }
    const defaults = {
      history: makeLiveSnapshot(),
      snapshot: makeLiveSnapshot(),
      load_run: makeLiveSnapshot(),
      get_file_changes: fixtureFileChanges(body),
      extension_command: { instance: "standalone", commands: [] },
      repository_status: { repository, valid: true, error: null },
      list_plannings: [],
      list_files: { files: [] },
      list_skills: { skills: [] },
      provider_auth: catalog,
      pi_extensions: { globalDirectory: "mock", extensions: [] },
      environment_capabilities: { platform: "macos", arch: "arm64", nativeWorkspace: true },
    };
    if (!(command in defaults)) errors.push(`Unexpected API: ${command}`);
    return route.fulfill({ json: { result: defaults[command] ?? null } });
  });

  const page = await context.newPage();
  page.setDefaultTimeout(12_000);
  page.on("pageerror", error => errors.push(String(error)));
  try {
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    // Confirm the active conversation is open in the foreground and working.
    await page.locator('[data-run-id="viewed-notify-run"] .run-dot.running-pulse').waitFor();

    // Hide the window (e.g. macOS close-to-hide / minimize), then settle the run.
    await page.evaluate(() => {
      window.__docHidden = true;
      document.dispatchEvent(new Event("visibilitychange"));
    });
    runPhase = "completed";
    execStatus = "completed";
    snapshotVersion = "v2";

    await page.waitForFunction(() => window.__sentNotifications.length === 1, null, { timeout: 10_000 });
    const received = await page.evaluate(() => window.__sentNotifications[0]);
    assert.deepEqual(received, {
      title: "Hidden active run",
      body: "Finished while window was hidden.",
    });
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("accent color stages with Settings, updates cards/composer/pulse together and persists across reload", { timeout: 90_000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US", reducedMotion: "reduce" });
  let savedConfig = { ...config }, failSave = true;
  const errors = [], saves = [];
  const runningToolJsonl = `${JSON.stringify({
    type: "tool_execution_start",
    toolCallId: "tool-accent-1",
    toolName: "bash",
    args: { command: "echo running" },
  })}\n`;
  const activeRun = {
    ...empty,
    runId: "accent-run",
    title: "Accent test prompt",
    planType: "serial",
    approved: true,
    config,
    phase: "running",
    graph: {
      originalGoal: "Accent test prompt",
      nodes: [{ id: "task", task: "Accent test prompt" }],
      edges: [],
    },
    nodes: {
      task: {
        status: "running",
        revision: 1,
        head: null,
        instruction: "Accent test prompt",
        error: null,
      },
    },
    executions: [{
      id: "exec-accent-1",
      node: "task",
      revision: 1,
      attempt: 1,
      sessionId: "sess-accent",
      worktree: repository,
      before: "a",
      after: null,
      workspaceLineage: [],
      input: null,
      result: null,
      status: "running",
      startedAt: 1000,
      completedAt: null,
      output: "",
      outputBytes: runningToolJsonl.length,
      pid: null,
      metrics: null,
    }],
    events: [{ sequence: 1, timestamp: 1000, type: "status" }],
  };
  const accentBootstrap = {
    ...bootstrap,
    snapshot: empty,
    runs: ["accent-run"],
    conversations: fixtureSummaries([activeRun]),
  };
  await context.addInitScript(({ repository }) => {
    localStorage.setItem("pi_n_language_v1", "en");
    localStorage.setItem("pi_n_projects", JSON.stringify([{ id: repository, path: repository, name: "Accent workspace", lastOpened: 1 }]));
  }, { repository });
  await context.route("**/api/*", async route => {
    const command = new URL(route.request().url()).pathname.slice(5);
    const body = route.request().postDataJSON();
    if (command === "save_config") {
      if (failSave) return route.fulfill({ status: 500, json: { error: "save rejected" } });
      savedConfig = body.config;
      saves.push(savedConfig);
      return route.fulfill({ json: { result: { ...accentBootstrap, config: savedConfig } } });
    }
    if (command === "get_execution_output") {
      return route.fulfill({
        json: {
          result: {
            runId: "accent-run",
            executionId: "exec-accent-1",
            content: runningToolJsonl,
            startOffset: 0,
            nextOffset: runningToolJsonl.length,
            totalBytes: runningToolJsonl.length,
            complete: false,
            status: "running",
          },
        },
      });
    }
    const defaults = {
      bootstrap: { ...accentBootstrap, config: savedConfig },
      history: activeRun,
      snapshot: activeRun,
      load_run: activeRun,
      get_file_changes: fixtureFileChanges(body),
      extension_command: { instance: "standalone", commands: [] },
      snapshot_if_changed: { version: "accent-v1", snapshot: null, activity: [] },
      repository_status: { repository, valid: true, error: null },
      list_plannings: [],
      list_files: { files: [] },
      list_skills: { skills: [] },
      provider_auth: catalog,
      pi_extensions: { globalDirectory: "mock", extensions: [] },
      environment_capabilities: { platform: "macos", arch: "arm64", nativeWorkspace: true },
    };
    if (!(command in defaults)) errors.push(`Unexpected API: ${command}`);
    return route.fulfill({ json: { result: defaults[command] ?? null } });
  });

  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  page.on("pageerror", error => errors.push(String(error)));

  const readHomeAccentStyles = () => page.evaluate(() => {
    const ws = document.querySelector(".project-workspace-item.active");
    const pulse = document.querySelector(".run-dot.running-pulse");
    const pill = document.querySelector(".landing-screen .prompt-box-mode-pill-indicator");
    const send = document.querySelector(".landing-screen .prompt-box-send-btn.active");
    return {
      attr: document.documentElement.dataset.accentColor,
      wsBg: ws ? getComputedStyle(ws).backgroundColor : null,
      pulseBg: pulse ? getComputedStyle(pulse).backgroundColor : null,
      pillBg: pill ? getComputedStyle(pill).backgroundColor : null,
      sendBg: send ? getComputedStyle(send).backgroundColor : null,
    };
  });

  try {
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    await page.locator(".project-workspace-item.active").waitFor();
    await page.locator(".run-dot.running-pulse").waitFor();
    await page.locator(".landing-screen textarea").fill("Hello accent");
    await page.locator(".landing-screen .prompt-box-send-btn.active").waitFor();

    // Default is blue accent: light-blue sidebar card + blue composer controls and running pulse.
    await page.waitForFunction(() => {
      const send = document.querySelector(".landing-screen .prompt-box-send-btn.active");
      return send && getComputedStyle(send).backgroundColor === "rgb(37, 99, 235)";
    });
    const defaultStyles = await readHomeAccentStyles();
    assert.equal(defaultStyles.attr, "blue");
    assert.equal(defaultStyles.wsBg, "rgb(239, 246, 255)");
    assert.equal(defaultStyles.pulseBg, "rgb(37, 99, 235)");
    assert.equal(defaultStyles.pillBg, "rgb(37, 99, 235)");
    assert.equal(defaultStyles.sendBg, "rgb(37, 99, 235)");

    // Staging Black in Settings and cancelling leaves the live accent untouched.
    await openSettings(page);
    const accentGroup = page.getByRole("group", { name: "Accent color", exact: true });
    assert.equal(await accentGroup.getByRole("radio", { name: /Blue/ }).isChecked(), true);
    assert.deepEqual(
      await page.locator('input[name="accent-color"]').evaluateAll(inputs => inputs.map(input => input.value)),
      ["blue", "black"],
      "the default option appears first",
    );
    const accentTops = await page.locator(".settings-accent-option").evaluateAll(items => items.map(item => Math.round(item.getBoundingClientRect().top)));
    assert.equal(new Set(accentTops).size, 1, "the two accent options share one row");
    await accentGroup.getByRole("radio", { name: /Black/ }).check();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.locator(".settings-modal").waitFor({ state: "detached" });
    assert.equal((await readHomeAccentStyles()).attr, "blue");

    // Failed save also leaves live accent untouched; retrying once backend accepts commits Black.
    await openSettings(page);
    await accentGroup.getByRole("radio", { name: /Black/ }).check();
    await page.locator(".save-config-btn").click();
    await page.locator(".settings-save-error").waitFor();
    assert.equal((await readHomeAccentStyles()).attr, "blue");

    failSave = false;
    await page.locator(".save-config-btn").click();
    await page.locator(".settings-modal").waitFor({ state: "detached" });
    assert.ok(saves.every(saved => !("accentColor" in saved)), "accent color stays out of backend config");

    await page.waitForFunction(() => {
      const ws = document.querySelector(".project-workspace-item.active");
      const send = document.querySelector(".landing-screen .prompt-box-send-btn.active");
      const pill = document.querySelector(".landing-screen .prompt-box-mode-pill-indicator");
      const pulse = document.querySelector(".run-dot.running-pulse");
      return ws && send && pill && pulse
        && getComputedStyle(ws).backgroundColor === "rgba(15, 23, 42, 0.055)"
        && getComputedStyle(send).backgroundColor === "rgb(24, 24, 27)"
        && getComputedStyle(pill).backgroundColor === "rgb(24, 24, 27)"
        && getComputedStyle(pulse).backgroundColor === "rgb(24, 24, 27)";
    });
    const blackStyles = await readHomeAccentStyles();
    assert.equal(blackStyles.attr, "black");
    assert.equal(blackStyles.wsBg, "rgba(15, 23, 42, 0.055)");
    assert.equal(blackStyles.pulseBg, "rgb(24, 24, 27)");
    assert.equal(blackStyles.pillBg, "rgb(24, 24, 27)");
    assert.equal(blackStyles.sendBg, "rgb(24, 24, 27)");

    // Open conversation and verify user bubble, chosen sidebar card, Latest button, and running tool card match Black, then survive reload.
    await page.locator('.run-item[data-run-id="accent-run"]').click();
    await page.locator(".chat-bubble-user").waitFor();
    await page.locator(".tool-call-card.running").waitFor();
    await page.waitForFunction(() => {
      const chosen = document.querySelector(".run-item.chosen");
      return chosen && getComputedStyle(chosen).backgroundColor === "rgba(15, 23, 42, 0.055)";
    });
    const blackConv = await page.evaluate(() => {
      const bubble = document.querySelector(".chat-bubble-user");
      const chosen = document.querySelector(".run-item.chosen");
      const latest = document.querySelector(".scroll-to-bottom-btn");
      const runningTool = document.querySelector(".tool-call-card.running");
      const runningStatus = document.querySelector(".tool-status.running");
      return {
        bubbleBg: bubble ? getComputedStyle(bubble).backgroundColor : null,
        chosenBg: chosen ? getComputedStyle(chosen).backgroundColor : null,
        latestBg: latest ? getComputedStyle(latest).backgroundColor : null,
        runningToolBorder: runningTool ? getComputedStyle(runningTool).borderTopColor : null,
        runningStatusColor: runningStatus ? getComputedStyle(runningStatus).color : null,
      };
    });
    assert.equal(blackConv.bubbleBg, "rgba(15, 23, 42, 0.055)");
    assert.equal(blackConv.chosenBg, "rgba(15, 23, 42, 0.055)");
    assert.equal(blackConv.latestBg, "rgb(24, 24, 27)");
    assert.equal(blackConv.runningToolBorder, "rgba(24, 24, 27, 0.42)");
    assert.equal(blackConv.runningStatusColor, "rgb(24, 24, 27)");

    // Reload preserves Black, and switching back to Blue restores light-blue cards + blue controls/outlines.
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator(".project-workspace-item.active").waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.accentColor), "black");
    assert.equal(await page.evaluate(() => localStorage.getItem("pi_n_accent_color_v1")), "black");

    await openSettings(page);
    assert.equal(await accentGroup.getByRole("radio", { name: /Black/ }).isChecked(), true);
    await accentGroup.getByRole("radio", { name: /Blue/ }).check();
    await page.locator(".save-config-btn").click();
    await page.locator(".settings-modal").waitFor({ state: "detached" });
    await page.locator('.run-item[data-run-id="accent-run"]').click();
    await page.locator(".chat-bubble-user").waitFor();
    await page.locator(".tool-call-card.running").waitFor();
    await page.waitForFunction(() => {
      const chosen = document.querySelector(".run-item.chosen");
      return chosen && getComputedStyle(chosen).backgroundColor === "rgb(239, 246, 255)";
    });
    const blueConv = await page.evaluate(() => {
      const bubble = document.querySelector(".chat-bubble-user");
      const chosen = document.querySelector(".run-item.chosen");
      const latest = document.querySelector(".scroll-to-bottom-btn");
      const runningTool = document.querySelector(".tool-call-card.running");
      const runningStatus = document.querySelector(".tool-status.running");
      return {
        attr: document.documentElement.dataset.accentColor,
        bubbleBg: bubble ? getComputedStyle(bubble).backgroundColor : null,
        bubbleBorder: bubble ? getComputedStyle(bubble).borderTopColor : null,
        chosenBg: chosen ? getComputedStyle(chosen).backgroundColor : null,
        chosenBorder: chosen ? getComputedStyle(chosen).borderTopColor : null,
        latestBg: latest ? getComputedStyle(latest).backgroundColor : null,
        runningToolBorder: runningTool ? getComputedStyle(runningTool).borderTopColor : null,
        runningStatusColor: runningStatus ? getComputedStyle(runningStatus).color : null,
      };
    });
    assert.equal(blueConv.attr, "blue");
    assert.equal(blueConv.bubbleBg, "rgb(239, 246, 255)");
    assert.equal(blueConv.bubbleBorder, "rgb(191, 219, 254)");
    assert.equal(blueConv.chosenBg, "rgb(239, 246, 255)");
    assert.equal(blueConv.chosenBorder, "rgb(191, 219, 254)");
    assert.equal(blueConv.latestBg, "rgb(37, 99, 235)");
    assert.equal(blueConv.runningToolBorder, "rgba(59, 130, 246, 0.65)");
    assert.equal(blueConv.runningStatusColor, "rgb(59, 130, 246)");
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});
