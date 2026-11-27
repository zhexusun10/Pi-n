import { chromium } from "@playwright/test";

export function browserLaunchOptions(extra = {}) {
  return {
    channel: process.env.PI_N_BROWSER_CHANNEL || (process.platform === "win32" ? "msedge" : "chromium"),
    headless: true,
    ...extra,
  };
}

/**
 * Reuses the shared Playwright browser server started by `scripts/run-ui-tests.mjs`
 * when running multi-file UI suites (so Chromium is woken up once total), and falls
 * back to launching a single local browser when a test file is run directly or needs
 * custom Chromium launch flags.
 */
export async function connectOrLaunchBrowser(extra = {}) {
  const wsEndpoint = process.env.PI_N_TEST_BROWSER_WS_ENDPOINT;
  if (wsEndpoint && Object.keys(extra).length === 0) {
    return chromium.connect(wsEndpoint);
  }
  return chromium.launch(browserLaunchOptions(extra));
}
