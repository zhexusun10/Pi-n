#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
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
let interruptedSignal = null;
let forceKillTimer = null;

function terminateChild(signal, force = false) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {}
  } else {
    try {
      process.kill(-child.pid, force ? "SIGKILL" : signal);
    } catch {
      try {
        child.kill(force ? "SIGKILL" : signal);
      } catch {}
    }
  }
}

async function shutdown() {
  clearTimeout(forceKillTimer);
  forceKillTimer = null;
  if (server) {
    const closing = server;
    server = null;
    await closing.close().catch(() => {});
  }
}

const signalHandlers = new Map(
  ["SIGINT", "SIGTERM"].map(signal => [
    signal,
    () => {
      if (!interruptedSignal) interruptedSignal = signal;
      if (child && child.exitCode === null && child.signalCode === null) {
        terminateChild(signal);
        forceKillTimer ??= setTimeout(() => terminateChild(signal, true), 5000).unref();
      } else {
        void shutdown().finally(() => process.exit(128 + (constants.signals[signal] ?? 1)));
      }
    },
  ]),
);

for (const [signal, handler] of signalHandlers) {
  process.on(signal, handler);
}

try {
  let wsEndpoint = process.env.PI_N_TEST_BROWSER_WS_ENDPOINT;
  if (!wsEndpoint) {
    const launched = await chromium.launchServer(browserLaunchOptions());
    if (interruptedSignal) {
      await launched.close().catch(() => {});
      process.exitCode = 128 + (constants.signals[interruptedSignal] ?? 1);
      process.exit(process.exitCode);
    }
    server = launched;
    wsEndpoint = server.wsEndpoint();
  }
  const env = { ...process.env, PI_N_TEST_BROWSER_WS_ENDPOINT: wsEndpoint };
  child = spawn(process.execPath, ["--test", ...args], {
    stdio: "inherit",
    env,
    shell: false,
    detached: process.platform !== "win32",
  });
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      const effectiveSignal = interruptedSignal ?? signal;
      if (effectiveSignal) resolve(128 + (constants.signals[effectiveSignal] ?? 1));
      else resolve(code ?? 1);
    });
  });
  process.exitCode = exitCode;
} finally {
  for (const [signal, handler] of signalHandlers) {
    process.off(signal, handler);
  }
  await shutdown();
}
