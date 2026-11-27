import { THINKING_LEVEL_SCALE } from "../modelConfig";
import type { ProviderCatalog } from "./providerAuth";
import type { ThinkingLevel } from "../types";

export const MODEL_THINKING_MEMORY_KEY = "pi_n_model_thinking_levels_v1";

type ModelThinkingCapabilities = Pick<
  ProviderCatalog["models"][number],
  "provider" | "id" | "thinkingLevels" | "thinkingLevelFallbacks"
>;

type ReadableStorage = Pick<Storage, "getItem">;
type WritableStorage = Pick<Storage, "getItem" | "setItem">;

const VALID_THINKING_LEVELS = new Set<string>(THINKING_LEVEL_SCALE);
const memoryFallback = new Map<string, ThinkingLevel>();

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && VALID_THINKING_LEVELS.has(value);
}

function normalizeModelKey(modelKey: string): string {
  return modelKey.trim();
}

function getDefaultStorage(): Storage | null {
  try {
    if (typeof localStorage !== "undefined") return localStorage;
  } catch { }
  return null;
}

function parseStoredMap(raw: string | null): Record<string, ThinkingLevel> {
  try {
    const value: unknown = JSON.parse(raw ?? "null");
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const result: Record<string, ThinkingLevel> = {};
      for (const [key, level] of Object.entries(value)) {
        const normalizedKey = normalizeModelKey(key);
        if (normalizedKey && isThinkingLevel(level)) {
          result[normalizedKey] = level;
        }
      }
      return result;
    }
  } catch { }
  return {};
}

export function readRememberedModelThinkingLevel(
  modelKey: string,
  storage?: ReadableStorage,
): ThinkingLevel | null {
  const normalizedKey = normalizeModelKey(modelKey);
  if (!normalizedKey) return null;
  if (!storage && memoryFallback.has(normalizedKey)) {
    return memoryFallback.get(normalizedKey) ?? null;
  }
  const store = storage ?? getDefaultStorage();
  if (!store) return null;
  try {
    const map = parseStoredMap(store.getItem(MODEL_THINKING_MEMORY_KEY));
    return map[normalizedKey] ?? null;
  } catch {
    return null;
  }
}

export function rememberModelThinkingLevel(
  modelKey: string,
  thinkingLevel: ThinkingLevel,
  storage?: WritableStorage,
): void {
  const normalizedKey = normalizeModelKey(modelKey);
  if (!normalizedKey || !isThinkingLevel(thinkingLevel)) return;
  const store = storage ?? getDefaultStorage();
  if (!store) {
    if (!storage) memoryFallback.set(normalizedKey, thinkingLevel);
    return;
  }
  try {
    const map = parseStoredMap(store.getItem(MODEL_THINKING_MEMORY_KEY));
    map[normalizedKey] = thinkingLevel;
    store.setItem(MODEL_THINKING_MEMORY_KEY, JSON.stringify(map));
    if (!storage) memoryFallback.delete(normalizedKey);
  } catch {
    // Storage may be unavailable or full; keep the choice in memory for this session.
    if (!storage) memoryFallback.set(normalizedKey, thinkingLevel);
  }
}

export function defaultUnchosenThinkingLevel(
  model: Pick<ModelThinkingCapabilities, "thinkingLevels" | "thinkingLevelFallbacks">,
): ThinkingLevel {
  const levels = model.thinkingLevels ?? [];
  if (levels.length === 0) return "xhigh";
  if (levels.includes("xhigh")) return "xhigh";
  const fallback = model.thinkingLevelFallbacks?.xhigh;
  if (fallback && levels.includes(fallback)) return fallback;
  const xhighIndex = THINKING_LEVEL_SCALE.indexOf("xhigh");
  for (let index = xhighIndex - 1; index >= 0; index--) {
    const candidate = THINKING_LEVEL_SCALE[index];
    if (levels.includes(candidate)) return candidate;
  }
  return levels[levels.length - 1];
}

export function resolveRememberedThinkingLevel(
  model: ModelThinkingCapabilities,
  storage?: ReadableStorage,
): ThinkingLevel | null {
  const remembered = readRememberedModelThinkingLevel(`${model.provider}/${model.id}`, storage);
  if (!remembered) return null;
  const levels = model.thinkingLevels ?? [];
  if (levels.length === 0 || levels.includes(remembered)) return remembered;
  const fallback = model.thinkingLevelFallbacks?.[remembered];
  if (fallback && levels.includes(fallback)) return fallback;
  return null;
}

export function resolveComposerModelThinkingLevel(
  model: ModelThinkingCapabilities,
  storage?: ReadableStorage,
): ThinkingLevel {
  return resolveRememberedThinkingLevel(model, storage) ?? defaultUnchosenThinkingLevel(model);
}
