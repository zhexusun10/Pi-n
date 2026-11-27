#!/usr/bin/env node
import { spawn } from "node:child_process";
import { constants } from "node:os";
import { chromium } from "@playwright/test";
import { browserLaunchOptions } from "./fixtures/ui-browser.mjs";

const args = process.argv.slice(2);
if (!args.length || args.includes("--help")) {
  console.log("Usage: node scripts/run-ui-tests.mjs [node --test flags...] <test-files...>");
  console.log("Starts one shared Playwright Chromium server across all given UI test files.");
  process.exit(args.includes("--help") ? 0 : 2);
}

let server = null;
let child = null;

async function shutdown() {
  if (server) {
    const closing = server;
    server = null;
    await closing.close().catch(() => {});
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    child?.kill(signal);
    void shutdown().finally(() => process.exit(128 + (constants.signals[signal] ?? 1)));
  });
}

try {
  let wsEndpoint = process.env.PI_N_TEST_BROWSER_WS_ENDPOINT;
  if (!wsEndpoint) {
    server = await chromium.launchServer(browserLaunchOptions());
    wsEndpoint = server.wsEndpoint();
  }
  const env = { ...process.env, PI_N_TEST_BROWSER_WS_ENDPOINT: wsEndpoint };
  child = spawn(process.execPath, ["--test", ...args], { stdio: "inherit", env, shell: false });
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (signal) resolve(128 + (constants.signals[signal] ?? 1));
      else resolve(code ?? 1);
    });
  });
  process.exitCode = exitCode;
} finally {
  await shutdown();
}
