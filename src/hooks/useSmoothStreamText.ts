import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useReducedMotion } from "motion/react";

/** 最小提交间隔（~30fps）：在保持字符速率不变的同时，避免 60–120Hz 逐帧重跑 Markdown + sanitize-html。 */
const FRAME_INTERVAL_MS = 32;
/** 流式积压时每次提交最多取出的字符数（按 32ms 折合 ~375 字/秒，与 60fps × 6 字/帧速率一致）。 */
const MAX_STREAM_PER_TICK = 12;
/** 后端结束后每次提交最多清空的积压字符数（按 32ms 折合 ~1250 字/秒，与 60fps × 20 字/帧速率一致）。 */
const DRAIN_PER_TICK = 40;

/**
 * 跨即时卸载/重挂（例如流式输出过程中切换「展开/收起卡片」）暂存未排空的打字机进度，
 * 避免文本跳变与流式状态闪烁。仅在极短切换窗口内且流式仍在进行时接续，
 * 防止收起缩略卡片条后思维链早已结束、再次展开时从旧进度重播打字机。
 */
const MAX_SMOOTH_STREAM_CACHE = 64;
const SMOOTH_STREAM_HANDOFF_MAX_AGE_MS = 250;

interface SmoothStreamCacheEntry {
  text: string;
  savedAt: number;
}

const smoothStreamCache = new Map<string, SmoothStreamCacheEntry>();

function nowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function saveSmoothStreamProgress(key: string, text: string) {
  smoothStreamCache.delete(key);
  smoothStreamCache.set(key, { text, savedAt: nowMs() });
  if (smoothStreamCache.size > MAX_SMOOTH_STREAM_CACHE) {
    const oldest = smoothStreamCache.keys().next().value;
    if (oldest !== undefined) smoothStreamCache.delete(oldest);
  }
}

/**
 * 打字机式逐字揭示流式模型输出：生产者-消费者模型。
 *
 * 生产者：`targetText` 增长时，把新增字符按码点拆开压入队列。
 * 消费者：requestAnimationFrame 循环，按队列积压量弹性调速取字；
 * 队列为空或页面隐藏时立即停帧，杜绝空转 CPU 消耗。
 */
export function useSmoothStreamText(
  targetText: string,
  isStreaming: boolean,
  enabled = true,
  initialBackfillSnapChars = 0,
  streamKey?: string,
): string {
  const reduceMotion = useReducedMotion();
  const initialDisplayedRef = useRef<string | null>(null);
  if (initialDisplayedRef.current === null) {
    const cached = streamKey ? smoothStreamCache.get(streamKey) : undefined;
    const isFreshHandoff =
      cached !== undefined &&
      nowMs() - cached.savedAt <= SMOOTH_STREAM_HANDOFF_MAX_AGE_MS;
    if (cached !== undefined && (!isStreaming || !isFreshHandoff)) {
      smoothStreamCache.delete(streamKey!);
    }
    initialDisplayedRef.current =
      isStreaming &&
      isFreshHandoff &&
      enabled &&
      !reduceMotion &&
      targetText.startsWith(cached.text) &&
      cached.text.length < targetText.length
        ? cached.text
        : targetText;
  }
  const initialDisplayed = initialDisplayedRef.current;
  const [displayedText, setDisplayedText] = useState(initialDisplayed);
  const [prevEnabled, setPrevEnabled] = useState(enabled);
  if (enabled !== prevEnabled) {
    setPrevEnabled(enabled);
    if (enabled && displayedText !== targetText) {
      setDisplayedText(targetText);
    }
  }

  const displayedRef = useRef(initialDisplayed);
  const queueRef = useRef<string[]>([]);
  const queueIndexRef = useRef(0);
  const enqueuedRef = useRef(initialDisplayed);
  const targetRef = useRef(targetText);
  const streamingRef = useRef(isStreaming);
  const everStreamedRef = useRef(isStreaming);
  const enabledRef = useRef(enabled);
  const wasEnabledRef = useRef(enabled);
  const reduceMotionRef = useRef(Boolean(reduceMotion));
  const streamKeyRef = useRef(streamKey);
  const initialBackfillSnapCharsRef = useRef(initialBackfillSnapChars);
  const rafRef = useRef<number | null>(null);
  const lastTickRef = useRef(0);

  targetRef.current = targetText;
  streamingRef.current = isStreaming;
  if (isStreaming) everStreamedRef.current = true;
  enabledRef.current = enabled;
  reduceMotionRef.current = Boolean(reduceMotion);
  streamKeyRef.current = streamKey;
  initialBackfillSnapCharsRef.current = initialBackfillSnapChars;

  const stopLoop = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  const snapToTarget = useCallback((target: string, updateState = true) => {
    queueRef.current = [];
    queueIndexRef.current = 0;
    enqueuedRef.current = target;
    displayedRef.current = target;
    stopLoop();
    if (updateState) setDisplayedText(target);
  }, [stopLoop]);

  const tick = useCallback((now: number) => {
    rafRef.current = null;
    if (!enabledRef.current || reduceMotionRef.current) return;
    if (typeof document !== "undefined" && document.hidden) return;

    const queue = queueRef.current;
    let pending = queue.length - queueIndexRef.current;
    // 队列为空时立即停止 rAF，等生产者入队新字符时再唤醒，避免 60–120fps 空转。
    if (pending <= 0) return;

    const backendDone = !streamingRef.current;
    let charsToPop = 0;
    if (backendDone) {
      charsToPop = Math.min(pending, DRAIN_PER_TICK);
    } else if (pending > 100) {
      charsToPop = MAX_STREAM_PER_TICK;
    } else if (pending > 50) {
      charsToPop = 10;
    } else if (pending > 20) {
      charsToPop = 6;
    } else if (pending >= 5) {
      charsToPop = 3;
    } else {
      charsToPop = 2;
    }

    const elapsed = now - lastTickRef.current;
    if (charsToPop > 0 && elapsed >= FRAME_INTERVAL_MS) {
      lastTickRef.current = now;
      const start = queueIndexRef.current;
      const end = Math.min(queue.length, start + charsToPop);
      displayedRef.current += queue.slice(start, end).join("");
      queueIndexRef.current = end;
      pending = queue.length - end;
      setDisplayedText(displayedRef.current);
      if (end === queue.length) {
        queueRef.current = [];
        queueIndexRef.current = 0;
        if (streamKeyRef.current) {
          smoothStreamCache.delete(streamKeyRef.current);
        }
      } else if (streamingRef.current && streamKeyRef.current) {
        saveSmoothStreamProgress(streamKeyRef.current, displayedRef.current);
      }
    }

    if (pending > 0) {
      rafRef.current = requestAnimationFrame(tick);
    }
  }, []);

  const ensureLoop = useCallback(() => {
    if (rafRef.current !== null) return;
    if (!enabledRef.current || reduceMotionRef.current) return;
    if (typeof document !== "undefined" && document.hidden) return;
    if (queueRef.current.length <= queueIndexRef.current) return;
    // 首次启动时允许下一帧立即输出，且不依赖 performance.now 与 rAF 时钟完全同源。
    lastTickRef.current = -Infinity;
    rafRef.current = requestAnimationFrame(tick);
  }, [tick]);

  // 折叠态切换时立刻把队列与游标对齐到当前完整文本，避免折叠期间积压的旧字符在展开后重播打字机。
  useLayoutEffect(() => {
    const wasEnabled = wasEnabledRef.current;
    wasEnabledRef.current = enabled;
    if (enabled !== wasEnabled) {
      snapToTarget(targetRef.current, enabled);
      if (!enabled && streamKeyRef.current) {
        smoothStreamCache.delete(streamKeyRef.current);
      }
    }
  }, [enabled, snapToTarget]);

  // 生产者：目标文本增长时把增量字符入队。
  useEffect(() => {
    const target = targetText;
    if (reduceMotionRef.current) {
      if (
        displayedRef.current !== target ||
        enqueuedRef.current !== target ||
        queueRef.current.length > queueIndexRef.current
      ) {
        snapToTarget(target, true);
      }
      return;
    }
    if (!enabledRef.current) {
      snapToTarget(target, false);
      return;
    }
    const isSettledBackfill =
      initialBackfillSnapChars > 0 && !streamingRef.current && !everStreamedRef.current;
    const isLargeInitialBackfill =
      initialBackfillSnapChars > 0 &&
      enqueuedRef.current.length === 0 &&
      target.length >= initialBackfillSnapChars;
    if (!target.startsWith(enqueuedRef.current) || isSettledBackfill || isLargeInitialBackfill) {
      // 内容被替换、已结束卡片延迟水合回填，或从空摘要一次性回填大段已有内容时直接展示，
      // 避免已结束的思维链重新打出或从 shimmer 骤缩成单行引起卡片高度反复抖动。
      snapToTarget(target, true);
      return;
    }
    if (target.length > enqueuedRef.current.length) {
      // for...of 按码点迭代，避免大块内容用展开运算符 push 时超出调用栈上限。
      for (const char of target.slice(enqueuedRef.current.length)) queueRef.current.push(char);
      enqueuedRef.current = target;
      if (
        streamingRef.current &&
        streamKeyRef.current &&
        displayedRef.current.length > 0 &&
        displayedRef.current.length < target.length
      ) {
        saveSmoothStreamProgress(streamKeyRef.current, displayedRef.current);
      }
      ensureLoop();
    }
  }, [targetText, ensureLoop, snapToTarget, initialBackfillSnapChars]);

  // 后端结束时清理跨挂载缓存；若当前可见且仍有未消费积压，唤醒消费以收尾档清空。
  useEffect(() => {
    if (!isStreaming) {
      if (streamKeyRef.current) smoothStreamCache.delete(streamKeyRef.current);
      if (!enabledRef.current) {
        snapToTarget(targetRef.current, false);
      } else if (typeof document !== "undefined" && document.hidden && initialBackfillSnapCharsRef.current > 0) {
        snapToTarget(targetRef.current, true);
      } else if (queueRef.current.length > queueIndexRef.current) {
        ensureLoop();
      }
    }
  }, [isStreaming, ensureLoop, snapToTarget]);

  // 减少动态效果开关。
  useEffect(() => {
    if (reduceMotion) {
      snapToTarget(targetRef.current, true);
      return;
    }
    if (enabled) ensureLoop();
  }, [enabled, reduceMotion, ensureLoop, snapToTarget]);

  // 页面隐藏时暂停打字循环，恢复可见时继续排空积压字符（已结束的思维链直接对齐完整内容）。
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onVisibility = () => {
      if (document.hidden) {
        stopLoop();
      } else if (
        !streamingRef.current &&
        initialBackfillSnapCharsRef.current > 0 &&
        queueRef.current.length > queueIndexRef.current
      ) {
        snapToTarget(targetRef.current, true);
      } else {
        ensureLoop();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [ensureLoop, snapToTarget, stopLoop]);

  useEffect(() => () => {
    stopLoop();
    const key = streamKeyRef.current;
    if (!key) return;
    if (
      streamingRef.current &&
      enabledRef.current &&
      displayedRef.current.length > 0 &&
      displayedRef.current.length < targetRef.current.length
    ) {
      saveSmoothStreamProgress(key, displayedRef.current);
    } else {
      smoothStreamCache.delete(key);
    }
  }, [stopLoop]);

  const isSettledBackfill =
    initialBackfillSnapChars > 0 && !isStreaming && !everStreamedRef.current;
  const isLargeInitialBackfill =
    initialBackfillSnapChars > 0 &&
    enqueuedRef.current.length === 0 &&
    targetText.length >= initialBackfillSnapChars;

  return reduceMotion || !enabled || isSettledBackfill || isLargeInitialBackfill
    ? targetText
    : displayedText;
}

export default useSmoothStreamText;
