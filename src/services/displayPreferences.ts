import { useSyncExternalStore } from "react";

/** Browser-local UI preferences: never part of the Run snapshot or backend config. */
export const AUTO_EXPAND_COT_KEY = "pi_n_auto_expand_cot_v1";
export const EXECUTION_OVERVIEW_KEY = "pi_n_execution_overview_v1";
export const LANDING_BACKGROUND_KEY = "pi_n_landing_background_v1";
export const ACCENT_COLOR_KEY = "pi_n_accent_color_v1";
export const COLLAPSE_CARDS_KEY = "pi_n_collapse_cards_v1";
export const COMPLETION_NOTIFICATIONS_KEY = "pi_n_completion_notifications_v1";
export const COMPLETION_NOTIFICATION_SOUND_KEY = "pi_n_completion_notification_sound_v1";
export type LandingBackground = "paths" | "dots" | "grid";
export type AccentColor = "black" | "blue";

type ReadableStorage = Pick<Storage, "getItem">;
type WritableStorage = Pick<Storage, "setItem" | "removeItem">;

function readableStorage(storage?: ReadableStorage): ReadableStorage | null {
  if (storage) return storage;
  try {
    if (typeof localStorage !== "undefined") return localStorage;
  } catch { }
  return null;
}

function writableStorage(storage?: WritableStorage): WritableStorage | null {
  if (storage) return storage;
  try {
    if (typeof localStorage !== "undefined") return localStorage;
  } catch { }
  return null;
}

/** Watching an execution auto-expands reasoning blocks by default. Opt-out via stored preference. */
export function readAutoExpandCot(storage?: ReadableStorage): boolean {
  try {
    const store = readableStorage(storage);
    if (!store) return true;
    const value = store.getItem(AUTO_EXPAND_COT_KEY);
    if (value === null) return true;
    return value !== "0" && value !== "false";
  } catch {
    return true;
  }
}

let autoExpandCot = readAutoExpandCot();
const listeners = new Set<() => void>();

export function autoExpandCotEnabled(): boolean {
  return autoExpandCot;
}

export function setAutoExpandCot(enabled: boolean, storage?: WritableStorage): void {
  autoExpandCot = enabled;
  try {
    const store = writableStorage(storage);
    if (enabled) store?.setItem(AUTO_EXPAND_COT_KEY, "1");
    else store?.setItem(AUTO_EXPAND_COT_KEY, "0");
  } catch {
    // Storage may be blocked; the in-memory preference still applies this session.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Re-renders the mounted cards when the Settings toggle changes. */
export function useAutoExpandCot(): boolean {
  return useSyncExternalStore(subscribe, autoExpandCotEnabled, autoExpandCotEnabled);
}

/** Execution graph overview is hidden by default; an explicit opt-in enables it in Settings. */
export function readExecutionOverview(storage?: ReadableStorage): boolean {
  try {
    const value = readableStorage(storage)?.getItem(EXECUTION_OVERVIEW_KEY);
    return value === "1" || value === "true";
  } catch {
    return false;
  }
}

let executionOverview = readExecutionOverview();
const executionOverviewListeners = new Set<() => void>();

export function executionOverviewEnabled(): boolean {
  return executionOverview;
}

export function setExecutionOverview(enabled: boolean, storage?: WritableStorage): void {
  executionOverview = enabled;
  try {
    writableStorage(storage)?.setItem(EXECUTION_OVERVIEW_KEY, enabled ? "1" : "0");
  } catch {
    // Keep the choice for this session even if browser storage is blocked.
  }
  for (const listener of executionOverviewListeners) listener();
}

function subscribeToExecutionOverview(listener: () => void): () => void {
  executionOverviewListeners.add(listener);
  return () => { executionOverviewListeners.delete(listener); };
}

export function useExecutionOverview(): boolean {
  return useSyncExternalStore(subscribeToExecutionOverview, executionOverviewEnabled, executionOverviewEnabled);
}

/** The tri-colour grid is the default for new or invalid preferences. */
export function readLandingBackground(storage?: ReadableStorage): LandingBackground {
  try {
    const value = readableStorage(storage)?.getItem(LANDING_BACKGROUND_KEY);
    return value === "paths" || value === "dots" ? value : "grid";
  } catch {
    return "grid";
  }
}

let landingBackground = readLandingBackground();
const backgroundListeners = new Set<() => void>();

export function currentLandingBackground(): LandingBackground {
  return landingBackground;
}

export function setLandingBackground(background: LandingBackground, storage?: WritableStorage): void {
  landingBackground = background;
  try {
    writableStorage(storage)?.setItem(LANDING_BACKGROUND_KEY, background);
  } catch {
    // Keep the choice for this session even if browser storage is blocked.
  }
  for (const listener of backgroundListeners) listener();
}

function subscribeToBackground(listener: () => void): () => void {
  backgroundListeners.add(listener);
  return () => { backgroundListeners.delete(listener); };
}

export function useLandingBackground(): LandingBackground {
  return useSyncExternalStore(subscribeToBackground, currentLandingBackground, currentLandingBackground);
}

/** Blue accent (classic light-blue cards + blue accents) is the default; black switches to gray cards + black accents. */
export function readAccentColor(storage?: ReadableStorage): AccentColor {
  try {
    const value = readableStorage(storage)?.getItem(ACCENT_COLOR_KEY);
    return value === "black" ? "black" : "blue";
  } catch {
    return "blue";
  }
}

export function applyAccentColor(accent: AccentColor): void {
  if (typeof document !== "undefined") {
    document.documentElement.dataset.accentColor = accent;
  }
}

let accentColor = readAccentColor();
applyAccentColor(accentColor);
const accentColorListeners = new Set<() => void>();

export function currentAccentColor(): AccentColor {
  return accentColor;
}

export function setAccentColor(accent: AccentColor, storage?: WritableStorage): void {
  accentColor = accent;
  applyAccentColor(accent);
  try {
    writableStorage(storage)?.setItem(ACCENT_COLOR_KEY, accent);
  } catch {
    // Keep the choice for this session even if browser storage is blocked.
  }
  for (const listener of accentColorListeners) listener();
}

function subscribeToAccentColor(listener: () => void): () => void {
  accentColorListeners.add(listener);
  return () => { accentColorListeners.delete(listener); };
}

export function useAccentColor(): AccentColor {
  return useSyncExternalStore(subscribeToAccentColor, currentAccentColor, currentAccentColor);
}

/** Transcript cards are expanded by default; collapsing is remembered across all conversations. */
export function readCollapseCards(storage?: ReadableStorage): boolean {
  try {
    const value = readableStorage(storage)?.getItem(COLLAPSE_CARDS_KEY);
    return value === "1" || value === "true";
  } catch {
    return false;
  }
}

let collapseCards = readCollapseCards();
const collapseCardsListeners = new Set<() => void>();

export function collapseCardsEnabled(): boolean {
  return collapseCards;
}

export function setCollapseCards(collapsed: boolean, storage?: WritableStorage): void {
  collapseCards = collapsed;
  try {
    writableStorage(storage)?.setItem(COLLAPSE_CARDS_KEY, collapsed ? "1" : "0");
  } catch {
    // Keep the choice for this session even if browser storage is blocked.
  }
  for (const listener of collapseCardsListeners) listener();
}

function subscribeToCollapseCards(listener: () => void): () => void {
  collapseCardsListeners.add(listener);
  return () => { collapseCardsListeners.delete(listener); };
}

export function useCollapseCards(): boolean {
  return useSyncExternalStore(subscribeToCollapseCards, collapseCardsEnabled, collapseCardsEnabled);
}

/** Background conversation completion notifications are enabled by default; opt-out via Settings. */
export function readCompletionNotifications(storage?: ReadableStorage): boolean {
  try {
    const value = readableStorage(storage)?.getItem(COMPLETION_NOTIFICATIONS_KEY);
    if (value === null || value === undefined) return true;
    return value !== "0" && value !== "false";
  } catch {
    return true;
  }
}

let completionNotifications = readCompletionNotifications();
const completionNotificationsListeners = new Set<() => void>();

export function completionNotificationsEnabled(): boolean {
  return completionNotifications;
}

export function setCompletionNotifications(enabled: boolean, storage?: WritableStorage): void {
  completionNotifications = enabled;
  try {
    writableStorage(storage)?.setItem(COMPLETION_NOTIFICATIONS_KEY, enabled ? "1" : "0");
  } catch {
    // Keep the choice for this session even if browser storage is blocked.
  }
  for (const listener of completionNotificationsListeners) listener();
}

function subscribeToCompletionNotifications(listener: () => void): () => void {
  completionNotificationsListeners.add(listener);
  return () => { completionNotificationsListeners.delete(listener); };
}

export function useCompletionNotifications(): boolean {
  return useSyncExternalStore(
    subscribeToCompletionNotifications,
    completionNotificationsEnabled,
    completionNotificationsEnabled,
  );
}

/** Completion notification sound is enabled by default; opt-out via Settings. */
export function readCompletionNotificationSound(storage?: ReadableStorage): boolean {
  try {
    const value = readableStorage(storage)?.getItem(COMPLETION_NOTIFICATION_SOUND_KEY);
    if (value === null || value === undefined) return true;
    return value !== "0" && value !== "false";
  } catch {
    return true;
  }
}

let completionNotificationSound = readCompletionNotificationSound();
const completionNotificationSoundListeners = new Set<() => void>();

export function completionNotificationSoundEnabled(): boolean {
  return completionNotificationSound;
}

export function setCompletionNotificationSound(enabled: boolean, storage?: WritableStorage): void {
  completionNotificationSound = enabled;
  try {
    writableStorage(storage)?.setItem(COMPLETION_NOTIFICATION_SOUND_KEY, enabled ? "1" : "0");
  } catch {
    // Keep the choice for this session even if browser storage is blocked.
  }
  for (const listener of completionNotificationSoundListeners) listener();
}

function subscribeToCompletionNotificationSound(listener: () => void): () => void {
  completionNotificationSoundListeners.add(listener);
  return () => { completionNotificationSoundListeners.delete(listener); };
}

export function useCompletionNotificationSound(): boolean {
  return useSyncExternalStore(
    subscribeToCompletionNotificationSound,
    completionNotificationSoundEnabled,
    completionNotificationSoundEnabled,
  );
}
