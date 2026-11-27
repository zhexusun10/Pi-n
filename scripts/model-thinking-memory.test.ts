import assert from "node:assert/strict";
import test from "node:test";
import {
  MODEL_THINKING_MEMORY_KEY,
  defaultUnchosenThinkingLevel,
  readRememberedModelThinkingLevel,
  rememberModelThinkingLevel,
  resolveComposerModelThinkingLevel,
  resolveRememberedThinkingLevel,
} from "../src/services/modelThinkingMemory";

class MemoryStorage implements Storage {
  private data = new Map<string, string>();
  get length(): number { return this.data.size; }
  clear(): void { this.data.clear(); }
  getItem(key: string): string | null { return this.data.get(key) ?? null; }
  key(index: number): string | null { return Array.from(this.data.keys())[index] ?? null; }
  removeItem(key: string): void { this.data.delete(key); }
  setItem(key: string, value: string): void { this.data.set(key, String(value)); }
}

test("remembers and updates thinking levels independently per model", () => {
  const store = new MemoryStorage();
  assert.equal(readRememberedModelThinkingLevel("openai/gpt-5", store), null);

  rememberModelThinkingLevel("openai/gpt-5", "medium", store);
  rememberModelThinkingLevel("anthropic/claude-opus", "max", store);
  assert.equal(readRememberedModelThinkingLevel("openai/gpt-5", store), "medium");
  assert.equal(readRememberedModelThinkingLevel("anthropic/claude-opus", store), "max");

  rememberModelThinkingLevel("openai/gpt-5", "low", store);
  assert.equal(readRememberedModelThinkingLevel("openai/gpt-5", store), "low");
  assert.equal(readRememberedModelThinkingLevel("anthropic/claude-opus", store), "max");
});

test("resolveComposerModelThinkingLevel prefers remembered level and falls back cleanly", () => {
  const store = new MemoryStorage();
  const fullModel = {
    provider: "test",
    id: "full",
    thinkingLevels: ["off", "low", "medium", "high", "xhigh", "max"] as const,
    thinkingLevelFallbacks: {},
  };
  const cappedModel = {
    provider: "test",
    id: "capped",
    thinkingLevels: ["off", "low", "high"] as const,
    thinkingLevelFallbacks: { xhigh: "high", max: "high" } as const,
  };
  const restrictedModel = {
    provider: "test",
    id: "restricted",
    thinkingLevels: ["low", "medium"] as const,
    thinkingLevelFallbacks: {},
  };

  // Unchosen models default to xhigh (or closest supported below xhigh).
  assert.equal(defaultUnchosenThinkingLevel({ ...fullModel, thinkingLevels: [...fullModel.thinkingLevels] }), "xhigh");
  assert.equal(resolveComposerModelThinkingLevel({ ...fullModel, thinkingLevels: [...fullModel.thinkingLevels] }, store), "xhigh");
  assert.equal(resolveComposerModelThinkingLevel({ ...cappedModel, thinkingLevels: [...cappedModel.thinkingLevels], thinkingLevelFallbacks: { ...cappedModel.thinkingLevelFallbacks } }, store), "high");

  // Remembered level takes priority when supported.
  rememberModelThinkingLevel("test/full", "medium", store);
  assert.equal(resolveComposerModelThinkingLevel({ ...fullModel, thinkingLevels: [...fullModel.thinkingLevels] }, store), "medium");

  // Unsupported remembered level uses model fallback when available, else default.
  rememberModelThinkingLevel("test/capped", "max", store);
  assert.equal(
    resolveRememberedThinkingLevel({ ...cappedModel, thinkingLevels: [...cappedModel.thinkingLevels], thinkingLevelFallbacks: { ...cappedModel.thinkingLevelFallbacks } }, store),
    "high",
  );
  rememberModelThinkingLevel("test/restricted", "max", store);
  assert.equal(
    resolveRememberedThinkingLevel({ ...restrictedModel, thinkingLevels: [...restrictedModel.thinkingLevels] }, store),
    null,
  );
  assert.equal(
    resolveComposerModelThinkingLevel({ ...restrictedModel, thinkingLevels: [...restrictedModel.thinkingLevels] }, store),
    "medium",
  );
});

test("ignores corrupt storage payloads and preserves valid entries", () => {
  for (const raw of ["{broken", "null", "[]", '"bad"', "42"]) {
    const store = new MemoryStorage();
    store.setItem(MODEL_THINKING_MEMORY_KEY, raw);
    assert.equal(readRememberedModelThinkingLevel("test/one", store), null);
    rememberModelThinkingLevel("test/one", "high", store);
    assert.equal(readRememberedModelThinkingLevel("test/one", store), "high");
  }

  const store = new MemoryStorage();
  store.setItem(MODEL_THINKING_MEMORY_KEY, JSON.stringify({
    "test/valid": "minimal",
    "test/invalid-level": "ultra",
    "": "high",
    "test/number": 3,
  }));
  assert.equal(readRememberedModelThinkingLevel("test/valid", store), "minimal");
  assert.equal(readRememberedModelThinkingLevel("test/invalid-level", store), null);
  assert.equal(readRememberedModelThinkingLevel("test/number", store), null);
});

test("failed storage reads do not overwrite previously stored entries", () => {
  const store = new MemoryStorage();
  rememberModelThinkingLevel("test/keep", "high", store);
  const originalGet = store.getItem.bind(store);
  store.getItem = () => { throw new Error("Blocked"); };
  rememberModelThinkingLevel("test/new", "low", store);
  store.getItem = originalGet;
  assert.equal(readRememberedModelThinkingLevel("test/keep", store), "high");
  assert.equal(readRememberedModelThinkingLevel("test/new", store), null);
});
