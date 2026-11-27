import assert from "node:assert/strict";
import test from "node:test";
import {
  LANDING_BACKGROUND_KEY,
  ACCENT_COLOR_KEY,
  EXECUTION_OVERVIEW_KEY,
  COLLAPSE_CARDS_KEY,
  COMPLETION_NOTIFICATIONS_KEY,
  COMPLETION_NOTIFICATION_SOUND_KEY,
  executionOverviewEnabled,
  readExecutionOverview,
  setExecutionOverview,
  currentLandingBackground,
  readLandingBackground,
  setLandingBackground,
  currentAccentColor,
  readAccentColor,
  setAccentColor,
  collapseCardsEnabled,
  readCollapseCards,
  setCollapseCards,
  completionNotificationsEnabled,
  readCompletionNotifications,
  setCompletionNotifications,
  completionNotificationSoundEnabled,
  readCompletionNotificationSound,
  setCompletionNotificationSound,
} from "../src/services/displayPreferences.ts";

test("Execution graph overview is hidden by default and explicit opt-ins enable it", () => {
  for (const value of [null, "0", "false", "unknown", ""]) {
    assert.equal(readExecutionOverview({ getItem: key => key === EXECUTION_OVERVIEW_KEY ? value : null }), false);
  }
  for (const value of ["1", "true"]) {
    assert.equal(readExecutionOverview({ getItem: key => key === EXECUTION_OVERVIEW_KEY ? value : null }), true);
  }
  assert.equal(readExecutionOverview(), false, "unavailable storage uses the default");
  assert.equal(readExecutionOverview({ getItem: () => { throw new Error("blocked"); } }), false);
});

test("Execution graph overview persists locally and remains usable when storage writes fail", () => {
  const original = executionOverviewEnabled();
  const writes: string[][] = [];
  const storage = { setItem: (key: string, value: string) => { writes.push([key, value]); }, removeItem: () => {} };
  try {
    setExecutionOverview(true, storage);
    assert.equal(executionOverviewEnabled(), true);
    setExecutionOverview(false, storage);
    assert.equal(executionOverviewEnabled(), false);
    assert.deepEqual(writes, [[EXECUTION_OVERVIEW_KEY, "1"], [EXECUTION_OVERVIEW_KEY, "0"]]);
    setExecutionOverview(true, { setItem: () => { throw new Error("blocked"); }, removeItem: () => {} });
    assert.equal(executionOverviewEnabled(), true);
  } finally {
    setExecutionOverview(original, storage);
  }
});

test("home background defaults to the tri-color grid and handles unavailable or invalid storage", () => {
  assert.equal(readLandingBackground({ getItem: () => null }), "grid");
  assert.equal(readLandingBackground({ getItem: () => "grid" }), "grid");
  assert.equal(readLandingBackground({ getItem: () => "paths" }), "paths");
  assert.equal(readLandingBackground({ getItem: () => "dots" }), "dots");
  assert.equal(readLandingBackground({ getItem: () => "unknown" }), "grid");
  assert.equal(readLandingBackground({ getItem: () => "warp" }), "grid", "a removed background falls back to the default");
  assert.equal(readLandingBackground({ getItem: () => { throw new Error("blocked"); } }), "grid");
});

test("home background persists locally and remains usable when storage writes fail", () => {
  const writes: string[][] = [];
  const storage = {
    setItem: (key: string, value: string) => { writes.push([key, value]); },
    removeItem: () => {},
  };
  try {
    setLandingBackground("dots", storage);
    assert.equal(currentLandingBackground(), "dots");
    setLandingBackground("grid", storage);
    assert.equal(currentLandingBackground(), "grid");
    setLandingBackground("paths", storage);
    assert.equal(currentLandingBackground(), "paths");
    assert.deepEqual(writes, [[LANDING_BACKGROUND_KEY, "dots"], [LANDING_BACKGROUND_KEY, "grid"], [LANDING_BACKGROUND_KEY, "paths"]]);
    setLandingBackground("dots", { setItem: () => { throw new Error("blocked"); }, removeItem: () => {} });
    assert.equal(currentLandingBackground(), "dots");
  } finally {
    setLandingBackground("paths");
  }
});

test("accent color defaults to blue and handles unavailable or invalid storage", () => {
  assert.equal(readAccentColor({ getItem: () => null }), "blue");
  assert.equal(readAccentColor({ getItem: () => "blue" }), "blue");
  assert.equal(readAccentColor({ getItem: () => "black" }), "black");
  assert.equal(readAccentColor({ getItem: () => "unknown" }), "blue");
  assert.equal(readAccentColor({ getItem: () => "" }), "blue");
  assert.equal(readAccentColor(), "blue", "unavailable storage uses the default");
  assert.equal(readAccentColor({ getItem: () => { throw new Error("blocked"); } }), "blue");
});

test("accent color persists locally and remains usable when storage writes fail", () => {
  const original = currentAccentColor();
  const writes: string[][] = [];
  const storage = {
    setItem: (key: string, value: string) => { writes.push([key, value]); },
    removeItem: () => {},
  };
  try {
    setAccentColor("blue", storage);
    assert.equal(currentAccentColor(), "blue");
    setAccentColor("black", storage);
    assert.equal(currentAccentColor(), "black");
    assert.deepEqual(writes, [[ACCENT_COLOR_KEY, "blue"], [ACCENT_COLOR_KEY, "black"]]);
    setAccentColor("blue", { setItem: () => { throw new Error("blocked"); }, removeItem: () => {} });
    assert.equal(currentAccentColor(), "blue");
  } finally {
    setAccentColor(original, storage);
  }
});

test("collapse cards defaults to expanded and remembers explicit choices", () => {
  for (const value of [null, "0", "false", "unknown", ""]) {
    assert.equal(readCollapseCards({ getItem: key => key === COLLAPSE_CARDS_KEY ? value : null }), false);
  }
  for (const value of ["1", "true"]) {
    assert.equal(readCollapseCards({ getItem: key => key === COLLAPSE_CARDS_KEY ? value : null }), true);
  }
  assert.equal(readCollapseCards(), false, "unavailable storage uses the default");
  assert.equal(readCollapseCards({ getItem: () => { throw new Error("blocked"); } }), false);
});

test("collapse cards persists locally and remains usable when storage writes fail", () => {
  const original = collapseCardsEnabled();
  const writes: string[][] = [];
  const storage = { setItem: (key: string, value: string) => { writes.push([key, value]); }, removeItem: () => {} };
  try {
    setCollapseCards(true, storage);
    assert.equal(collapseCardsEnabled(), true);
    setCollapseCards(false, storage);
    assert.equal(collapseCardsEnabled(), false);
    assert.deepEqual(writes, [[COLLAPSE_CARDS_KEY, "1"], [COLLAPSE_CARDS_KEY, "0"]]);
    setCollapseCards(true, { setItem: () => { throw new Error("blocked"); }, removeItem: () => {} });
    assert.equal(collapseCardsEnabled(), true);
  } finally {
    setCollapseCards(original, storage);
  }
});

test("completion notifications are enabled by default and explicit opt-outs disable them", () => {
  for (const value of [null, "1", "true", "unknown", ""]) {
    assert.equal(readCompletionNotifications({ getItem: key => key === COMPLETION_NOTIFICATIONS_KEY ? value : null }), true);
  }
  for (const value of ["0", "false"]) {
    assert.equal(readCompletionNotifications({ getItem: key => key === COMPLETION_NOTIFICATIONS_KEY ? value : null }), false);
  }
  assert.equal(readCompletionNotifications(), true, "unavailable storage uses the default");
  assert.equal(readCompletionNotifications({ getItem: () => { throw new Error("blocked"); } }), true);
});

test("completion notifications persist locally and remain usable when storage writes fail", () => {
  const original = completionNotificationsEnabled();
  const writes: string[][] = [];
  const storage = { setItem: (key: string, value: string) => { writes.push([key, value]); }, removeItem: () => {} };
  try {
    setCompletionNotifications(false, storage);
    assert.equal(completionNotificationsEnabled(), false);
    setCompletionNotifications(true, storage);
    assert.equal(completionNotificationsEnabled(), true);
    assert.deepEqual(writes, [[COMPLETION_NOTIFICATIONS_KEY, "0"], [COMPLETION_NOTIFICATIONS_KEY, "1"]]);
    setCompletionNotifications(false, { setItem: () => { throw new Error("blocked"); }, removeItem: () => {} });
    assert.equal(completionNotificationsEnabled(), false);
  } finally {
    setCompletionNotifications(original, storage);
  }
});

test("completion notification sound defaults to on and explicit opt-outs disable it", () => {
  for (const value of [null, "1", "true", "unknown", ""]) {
    assert.equal(readCompletionNotificationSound({ getItem: key => key === COMPLETION_NOTIFICATION_SOUND_KEY ? value : null }), true);
  }
  for (const value of ["0", "false"]) {
    assert.equal(readCompletionNotificationSound({ getItem: key => key === COMPLETION_NOTIFICATION_SOUND_KEY ? value : null }), false);
  }
  assert.equal(readCompletionNotificationSound(), true, "unavailable storage uses the default");
  assert.equal(readCompletionNotificationSound({ getItem: () => { throw new Error("blocked"); } }), true);
});

test("completion notification sound persists locally and remains usable when storage writes fail", () => {
  const original = completionNotificationSoundEnabled();
  const writes: string[][] = [];
  const storage = { setItem: (key: string, value: string) => { writes.push([key, value]); }, removeItem: () => {} };
  try {
    setCompletionNotificationSound(false, storage);
    assert.equal(completionNotificationSoundEnabled(), false);
    setCompletionNotificationSound(true, storage);
    assert.equal(completionNotificationSoundEnabled(), true);
    assert.deepEqual(writes, [[COMPLETION_NOTIFICATION_SOUND_KEY, "0"], [COMPLETION_NOTIFICATION_SOUND_KEY, "1"]]);
    setCompletionNotificationSound(false, { setItem: () => { throw new Error("blocked"); }, removeItem: () => {} });
    assert.equal(completionNotificationSoundEnabled(), false);
  } finally {
    setCompletionNotificationSound(original, storage);
  }
});
