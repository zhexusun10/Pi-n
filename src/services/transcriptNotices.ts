import type { TranscriptItem, TranscriptNoticeInfo } from "../types";

/** Mirrors Pi's prompt-cache TTL (5 minutes) and cache-miss thresholds. */
export const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MISS_NOISE_FLOOR_TOKENS = 1024;
const CACHE_MISS_NOTICE_MIN_TOKENS = 20_000;
const CACHE_MISS_NOTICE_MIN_COST = 0.1;

interface ReasoningDropKind {
  provider: string;
  droppedType: string;
  noun: "thinking" | "reasoning";
}

const REASONING_DROP_DIAGNOSTICS: Readonly<Record<string, ReasoningDropKind>> = {
  anthropic_input_transformations: {
    provider: "Anthropic",
    droppedType: "thinking_dropped",
    noun: "thinking",
  },
  openai_input_transformations: {
    provider: "OpenAI",
    droppedType: "reasoning",
    noun: "reasoning",
  },
};

export interface NoticePreviousRequest {
  promptTokens: number;
  modelKey: string;
  timestamp: number;
  reportedCache: boolean;
}

/** Plain JSON-serializable state so transcriptParseCache's structuredClone works seamlessly. */
export interface NoticeTrackerState {
  prevRequest?: NoticePreviousRequest;
  lastReasoningDrop?: {
    provider: string;
    count: number;
  };
}

function finiteNonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function parseTimestampMs(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 0;
}

/** Extract billed tokens and USD cost from a Pi Usage object on compaction events. */
export function extractCompactionUsage(usage: unknown): { billedTokens?: number; billedCost?: number } {
  if (!usage || typeof usage !== "object") return {};
  const u = usage as Record<string, any>;
  const input = finiteNonNegative(u.input);
  const output = finiteNonNegative(u.output);
  const cacheRead = finiteNonNegative(u.cacheRead);
  const cacheWrite = finiteNonNegative(u.cacheWrite);
  const billedTokens = Math.round(input + output + cacheRead + cacheWrite);
  const rawCost = u.cost && typeof u.cost === "object" ? finiteNonNegative(u.cost.total) : 0;
  if (billedTokens <= 0 && rawCost <= 0) return {};
  return {
    ...(billedTokens > 0 ? { billedTokens } : {}),
    ...(rawCost > 0 ? { billedCost: rawCost } : {}),
  };
}

/** Reset prompt-cache tracking after context compaction or branch summary. */
export function resetNoticeCacheTracking(tracker: NoticeTrackerState): void {
  tracker.prevRequest = undefined;
}

/** Extract provider-reported dropped reasoning/thinking diagnostics from an assistant message. */
export function extractDroppedReasoningNotice(message: any): TranscriptNoticeInfo | null {
  const diagnostics = message?.diagnostics;
  if (!Array.isArray(diagnostics)) return null;
  for (const diagnostic of diagnostics) {
    if (!diagnostic || typeof diagnostic !== "object" || typeof diagnostic.type !== "string") continue;
    const kind = Object.hasOwn(REASONING_DROP_DIAGNOSTICS, diagnostic.type)
      ? REASONING_DROP_DIAGNOSTICS[diagnostic.type]
      : undefined;
    if (!kind) continue;
    const transformations = diagnostic.details?.transformations;
    if (!Array.isArray(transformations)) continue;
    const dropped = transformations.filter(
      (entry: unknown): entry is Record<string, unknown> =>
        typeof entry === "object" && entry !== null && (entry as Record<string, unknown>).type === kind.droppedType,
    );
    if (dropped.length === 0) continue;
    const reasons = new Set<string>();
    for (const entry of dropped) {
      if (typeof entry.reason === "string" && entry.reason.trim()) reasons.add(entry.reason.trim());
    }
    return {
      kind: "reasoning_drop",
      provider: kind.provider,
      droppedCount: dropped.length,
      droppedNoun: kind.noun,
      ...(reasons.size > 0 ? { reasons: [...reasons] } : {}),
    };
  }
  return null;
}

/** Inspect a finalized assistant message for reasoning-drop and significant prompt cache-miss notices. */
export function collectAssistantMessageNotices(
  tracker: NoticeTrackerState,
  message: any,
): TranscriptNoticeInfo[] {
  if (!message || typeof message !== "object" || message.role !== "assistant") return [];
  const notices: TranscriptNoticeInfo[] = [];

  // 1. Reasoning drops (deduplicated across replayed turns unless count increases).
  const dropped = extractDroppedReasoningNotice(message);
  if (dropped && dropped.provider && dropped.droppedCount) {
    const prevDrop = tracker.lastReasoningDrop;
    const isRepeat = prevDrop?.provider === dropped.provider && dropped.droppedCount <= prevDrop.count;
    tracker.lastReasoningDrop = { provider: dropped.provider, count: dropped.droppedCount };
    if (!isRepeat) {
      notices.push(dropped);
    }
  } else {
    tracker.lastReasoningDrop = undefined;
  }

  // 2. Significant prompt cache misses (mirrors Pi's detectCacheMiss + InteractiveMode thresholds).
  const usage = message.usage;
  if (usage && typeof usage === "object") {
    const input = finiteNonNegative(usage.input);
    const cacheRead = finiteNonNegative(usage.cacheRead);
    const cacheWrite = finiteNonNegative(usage.cacheWrite);
    const promptTokens = input + cacheRead + cacheWrite;
    const provider = typeof message.provider === "string" ? message.provider : "";
    const model = typeof message.model === "string" ? message.model : "";
    const modelKey = provider || model ? `${provider}/${model}` : "";
    const ts = parseTimestampMs(message.timestamp);
    const prev = tracker.prevRequest;

    if (
      prev &&
      promptTokens > 0 &&
      (cacheRead + cacheWrite > 0 || prev.reportedCache)
    ) {
      const missedTokens = Math.round(Math.min(prev.promptTokens, promptTokens) - cacheRead);
      if (missedTokens > CACHE_MISS_NOISE_FLOOR_TOKENS) {
        const paidTokens = input + cacheWrite;
        const costObj = usage.cost && typeof usage.cost === "object" ? usage.cost : undefined;
        const paidPerToken = paidTokens > 0 && costObj
          ? (finiteNonNegative(costObj.input) + finiteNonNegative(costObj.cacheWrite)) / paidTokens
          : 0;
        const readPerToken = cacheRead > 0 && costObj
          ? finiteNonNegative(costObj.cacheRead) / cacheRead
          : 0;
        const missedCost = missedTokens * Math.max(0, paidPerToken - readPerToken);
        if (missedTokens >= CACHE_MISS_NOTICE_MIN_TOKENS || missedCost >= CACHE_MISS_NOTICE_MIN_COST) {
          const idleMs = ts > 0 && prev.timestamp > 0 ? Math.max(0, ts - prev.timestamp) : 0;
          const idleMinutes = idleMs >= CACHE_TTL_MS ? Math.round(idleMs / 60_000) : undefined;
          const modelChanged = Boolean(modelKey && prev.modelKey && modelKey !== prev.modelKey);
          notices.push({
            kind: "cache_miss",
            missedTokens,
            ...(missedCost > 0 ? { missedCost } : {}),
            ...(idleMinutes !== undefined ? { idleMinutes } : {}),
            ...(modelChanged ? { modelChanged: true } : {}),
          });
        }
      }
    }

    if (promptTokens > 0) {
      tracker.prevRequest = {
        promptTokens,
        modelKey: modelKey || prev?.modelKey || "",
        timestamp: ts || prev?.timestamp || 0,
        reportedCache: Boolean(prev?.reportedCache) || (cacheRead + cacheWrite > 0),
      };
    }
  }

  return notices;
}

/** Extract a cache-warming notice from a Pi `usage` entry (`kind === "cache_warm"`). */
export function collectCacheWarmNotice(
  tracker: NoticeTrackerState,
  entry: any,
): TranscriptNoticeInfo | null {
  if (!entry || typeof entry !== "object" || entry.type !== "usage" || entry.kind !== "cache_warm") {
    return null;
  }
  const usage = entry.usage;
  if (!usage || typeof usage !== "object") return null;
  const input = finiteNonNegative(usage.input);
  const cacheRead = finiteNonNegative(usage.cacheRead);
  const cacheWrite = finiteNonNegative(usage.cacheWrite);
  const promptTokens = input + cacheRead + cacheWrite;
  if (promptTokens > 0) {
    const provider = typeof entry.provider === "string" ? entry.provider : "";
    const model = typeof entry.model === "string" ? entry.model : "";
    tracker.prevRequest = {
      promptTokens,
      modelKey: provider || model ? `${provider}/${model}` : "",
      timestamp: parseTimestampMs(entry.timestamp),
      reportedCache: true,
    };
  }
  const warmingCost = usage.cost && typeof usage.cost === "object" ? finiteNonNegative(usage.cost.total) : 0;
  const warmingNote = typeof entry.note === "string" && entry.note.trim() ? entry.note.trim() : undefined;
  return {
    kind: "cache_warming",
    warmingCost,
    ...(warmingNote ? { warmingNote } : {}),
    warmingCount: 1,
  };
}

/** Append a notice item, collapsing consecutive cache_warming notices with the same note. */
export function appendOrMergeNoticeItem(
  items: TranscriptItem[],
  id: string,
  notice: TranscriptNoticeInfo,
  timestamp: number,
  animateAppear?: boolean,
): TranscriptItem[] {
  if (notice.kind === "cache_warming" && items.length > 0) {
    const last = items[items.length - 1];
    if (
      last.type === "notice" &&
      last.notice?.kind === "cache_warming" &&
      (last.notice.warmingNote ?? "") === (notice.warmingNote ?? "")
    ) {
      const merged: TranscriptItem = {
        ...last,
        notice: {
          ...last.notice,
          warmingCost: (last.notice.warmingCost ?? 0) + (notice.warmingCost ?? 0),
          warmingCount: (last.notice.warmingCount ?? 1) + (notice.warmingCount ?? 1),
        },
        timestamp,
      };
      return [...items.slice(0, -1), merged];
    }
  }
  return [
    ...items,
    {
      id,
      type: "notice",
      role: "system",
      status: "success",
      notice,
      timestamp,
      ...(animateAppear !== undefined ? { animateAppear } : {}),
    },
  ];
}

export function formatNoticeUsd(cost: number | undefined, includeSmall = false): string | null {
  if (typeof cost !== "number" || !Number.isFinite(cost) || cost <= 0) return null;
  if (cost >= 0.01) return `~$${cost.toFixed(2)}`;
  if (!includeSmall) return null;
  if (cost >= 0.001) return `~$${cost.toFixed(3)}`;
  return "<$0.001";
}
