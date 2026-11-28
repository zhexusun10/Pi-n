import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { expect } from "@playwright/test";
import { connectOrLaunchBrowser } from "./fixtures/ui-browser.mjs";
import { createServer } from "vite";

let server, browser, origin;
before(async () => {
  server = await createServer({
    cacheDir: "node_modules/.vite-diff-cache-version",
    server: { host: "127.0.0.1", port: 0, strictPort: false, open: false, hmr: false, watch: null },
    plugins: [{
      name: "diff-cache-version-fixture",
      configureServer(vite) {
        vite.middlewares.use(async (req, res, next) => {
          if (!req.url.startsWith("/__changes")) return next();
          res.setHeader("Content-Type", "text/html");
          res.end(await vite.transformIndexHtml(
            req.url,
            '<html><body style="margin:0"><div id="root"></div><script type="module" src="/scripts/fixtures/workspace-changes.tsx"></script></body></html>',
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

async function openFixture(mode, handlers) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 850 }, locale: "en-US", reducedMotion: "reduce" });
  await context.addInitScript(() => localStorage.setItem("pi_n_language_v1", "en"));
  const errors = [];
  let page;
  await context.route("**/api/*", async route => {
    const command = new URL(route.request().url()).pathname.slice(5);
    const body = route.request().postDataJSON();
    if (command === "get_file_changes" && handlers.getFileChanges) {
      await route.fulfill({ json: { result: handlers.getFileChanges(body) } });
      return;
    }
    if (command === "get_file_diff" && handlers.getFileDiff) {
      await route.fulfill({ json: { result: handlers.getFileDiff(body) } });
      return;
    }
    if (command === "get_execution_output") {
      const current = await page.evaluate(() => ({ outputText: window.changesAudit.outputText, running: window.changesAudit.running }));
      const bytes = Buffer.from(current.outputText);
      const startOffset = body.tail ? 0 : Math.min(body.offset ?? 0, bytes.length);
      await route.fulfill({
        json: {
          result: {
            runId: body.runId,
            executionId: body.executionId,
            content: bytes.subarray(startOffset).toString(),
            startOffset,
            nextOffset: bytes.length,
            totalBytes: bytes.length,
            complete: true,
            status: current.running ? "running" : "completed",
          },
        },
      });
      return;
    }
    const defaults = { list_files: { files: [] }, list_skills: { skills: [] }, get_merger_prompt: { prompt: "Resolve." } };
    await route.fulfill({ json: { result: defaults[command] ?? {} } });
  });
  page = await context.newPage();
  page.on("pageerror", error => errors.push(String(error)));
  page.setDefaultTimeout(10_000);
  await page.goto(`${origin}/__changes?mode=${mode}`, { waitUntil: "networkidle" });
  await page.locator(".initial-query-scroll.conversation-ready").waitFor();
  return { page, context, errors };
}

test("same-line-count diff updates invalidate cache on contentVersion and completion", { timeout: 30_000 }, async () => {
  let stage = {
    contentVersion: "git:base..v1",
    isRunning: false,
    line: "first",
  };
  let diffRequests = 0;

  const { page, context, errors } = await openFixture("serial", {
    getFileChanges: (body) => ({
      runId: body.runId,
      executionId: null,
      executionIds: null,
      summary: {
        files: [{
          path: "src/note.ts",
          status: "modified",
          additions: 1,
          deletions: 1,
          isRunning: stage.isRunning,
          source: "git",
          ...(stage.contentVersion !== undefined ? { contentVersion: stage.contentVersion } : {}),
          nodes: ["worker"],
        }],
        totalFiles: 1,
        addedCount: 0,
        modifiedCount: 1,
        deletedCount: 0,
        renamedCount: 0,
        totalAdditions: 1,
        totalDeletions: 1,
        isRunning: stage.isRunning,
      },
    }),
    getFileDiff: (body) => {
      diffRequests += 1;
      return {
        runId: body.runId,
        path: body.path,
        oldPath: null,
        binary: false,
        truncated: false,
        hiddenLines: 0,
        lines: [
          { kind: "hunk", text: "@@ -1,1 +1,1 @@" },
          { kind: "removed", text: "base" },
          { kind: "added", text: stage.line },
        ],
      };
    },
  });

  try {
    await page.getByTestId("workspace-changes-trigger").click();
    await page.getByTestId("changed-file-item").locator(".changed-file-row").click();
    const diff = page.getByTestId("changed-file-diff");
    await expect(diff).toContainText("first");
    assert.equal(diffRequests, 1);

    // Same line counts (+1 -1), not running, but new contentVersion -> must re-fetch.
    stage = { contentVersion: "git:base..v2", isRunning: false, line: "second" };
    await page.evaluate(() => window.changesAudit.update());
    await expect(diff).toContainText("second");
    assert.equal(diffRequests, 2);

    // Transition into running with same content.
    stage = { contentVersion: "git:base..v2", isRunning: true, line: "second" };
    await page.evaluate(() => window.changesAudit.update());
    await expect(diff).toContainText("second");
    const runningRequests = diffRequests;

    // Completion with same line counts (+1 -1) and NO contentVersion must still
    // invalidate the cache and show "third" instead of resurrecting "first".
    stage = { contentVersion: undefined, isRunning: false, line: "third" };
    await page.evaluate(() => window.changesAudit.settle());
    await expect(diff).toContainText("third");
    assert.ok(diffRequests > runningRequests, "completion must re-fetch updated diff");
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

for (const scenario of ["stable", "changed", "legacy"]) test(
  `remote file-change pagination with ${scenario} order metadata`,
  { timeout: 30_000 }, async () => {
  const allFiles = Array.from({ length: 85 }, (_, i) => ({
    path: `src/page-${String(i).padStart(3, "0")}.ts`,
    status: "modified",
    additions: 1,
    deletions: 0,
    contentVersion: `v:${i}`,
  }));
  const seenOffsets = [];
  let orderVersion = scenario === "legacy" ? undefined : "initial";

  const { page, context, errors } = await openFixture("serial&settled=1", {
    getFileChanges: (body) => {
      const offset = body.offset ?? 0;
      const limit = body.limit ?? 60;
      seenOffsets.push({ offset, limit });
      return {
        runId: body.runId,
        executionId: null,
        executionIds: null,
        offset,
        limit,
        orderVersion,
        summary: {
          files: allFiles.slice(offset, offset + limit),
          totalFiles: allFiles.length,
          addedCount: 0,
          modifiedCount: allFiles.length,
          deletedCount: 0,
          renamedCount: 0,
          totalAdditions: allFiles.length,
          totalDeletions: 0,
          isRunning: false,
        },
      };
    },
  });

  try {
    await page.getByTestId("workspace-changes-trigger").click();
    const rows = page.getByTestId("changed-file-item");
    await expect(rows).toHaveCount(60);
    await expect(page.getByTestId("workspace-changes-load-more")).toContainText("Load 25 more");
    if (scenario === "changed") {
      const removed = allFiles.shift();
      allFiles.push({ ...removed, path: "src/page-new.ts" });
      orderVersion = "updated";
    }
    await page.getByTestId("workspace-changes-load-more").click();
    await expect(rows).toHaveCount(85);
    await expect(page.getByTestId("workspace-changes-truncated")).toHaveCount(0);
    if (scenario === "changed") {
      await expect(rows.filter({ hasText: "page-000.ts" })).toHaveCount(0);
      await expect(rows.filter({ hasText: "page-060.ts" })).toHaveCount(1);
      await expect(rows.filter({ hasText: "page-new.ts" })).toHaveCount(1);
    }
    if (scenario !== "stable") {
      assert.ok(seenOffsets.some(entry => entry.offset === 0 && entry.limit === 120));
    }
    if (scenario !== "legacy") {
      assert.ok(seenOffsets.some(entry => entry.offset === 60 && entry.limit === 60));
    }
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});
