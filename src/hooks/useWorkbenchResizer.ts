import { useCallback, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useStableCallback } from "./useStableCallback";

export const DEFAULT_SPLIT_RATIO = 0.6;
export const MIN_SPLIT_RATIO = 0.15;
export const MAX_SPLIT_RATIO = 0.85;
export const DEFAULT_CHANGES_SPLIT_RATIO = MAX_SPLIT_RATIO;
export const GRAPH_COLLAPSE_OVERSHOOT_PX = 48;
const MIN_GRAPH_PANE_WIDTH = 320;

export const SPLIT_RATIO_STORAGE_KEY = "pi_n_workbench_split_ratio";
export const CHANGES_SPLIT_RATIO_STORAGE_KEY = "pi_n_changes_split_ratio";

export function getStoredRatio(
  storage?: Pick<Storage, "getItem">,
  storageKey: string = SPLIT_RATIO_STORAGE_KEY,
  defaultRatio: number = DEFAULT_SPLIT_RATIO,
): number {
  try {
    const store = storage ?? (typeof localStorage === "undefined" ? undefined : localStorage);
    if (!store) return defaultRatio;
    const savedRatio = store.getItem(storageKey);
    if (savedRatio !== null) {
      const parsed = parseFloat(savedRatio);
      if (Number.isFinite(parsed) && parsed > 0 && parsed < 1) {
        return Math.max(MIN_SPLIT_RATIO, Math.min(MAX_SPLIT_RATIO, parsed));
      }
    }
  } catch {
    // ignore storage access errors
  }
  return defaultRatio;
}

export function persistRatio(
  ratio: number,
  storage?: Pick<Storage, "setItem">,
  storageKey: string = SPLIT_RATIO_STORAGE_KEY,
): void {
  try {
    const store = storage ?? (typeof localStorage === "undefined" ? undefined : localStorage);
    if (!store) return;
    store.setItem(storageKey, String(ratio));
  } catch {
    // ignore storage access errors
  }
}

export function clampSplitRatio(ratio: number, containerWidth?: number): number {
  if (containerWidth && containerWidth > 0) {
    const minLeftWidth = 280;
    const minRightWidth = MIN_GRAPH_PANE_WIDTH;
    const minRatio = Math.min(0.5, Math.max(MIN_SPLIT_RATIO, minLeftWidth / containerWidth));
    const maxRatio = Math.max(0.5, Math.min(MAX_SPLIT_RATIO, (containerWidth - minRightWidth) / containerWidth));
    return Math.max(minRatio, Math.min(maxRatio, ratio));
  }
  return Math.max(MIN_SPLIT_RATIO, Math.min(MAX_SPLIT_RATIO, ratio));
}

/** Require deliberate overshoot past the actual minimum graph width. */
export function shouldCollapseGraphPane(pointerX: number, containerWidth: number): boolean {
  if (!Number.isFinite(pointerX) || !Number.isFinite(containerWidth) || containerWidth <= 0) return false;
  // Match .conversation-pane.split's CSS max-width even in a narrow window,
  // where its 320px graph minimum takes precedence over a balanced 50/50 split.
  const boundary = Math.min(MAX_SPLIT_RATIO * containerWidth, Math.max(0, containerWidth - MIN_GRAPH_PANE_WIDTH));
  return pointerX >= boundary + GRAPH_COLLAPSE_OVERSHOOT_PX;
}

/** Resize via CSS variable percentage so dragging does not trigger React re-renders, while maintaining split ratio across container resizing. */
export function useWorkbenchResizer({
  onCollapse,
  collapsed = false,
  storageKey = SPLIT_RATIO_STORAGE_KEY,
  defaultRatio = DEFAULT_SPLIT_RATIO,
}: {
  onCollapse?: () => void;
  collapsed?: boolean;
  storageKey?: string;
  defaultRatio?: number;
} = {}) {
  const collapse = useStableCallback(() => onCollapse?.());
  const workbenchRef = useRef<HTMLDivElement>(null);
  const [ratiosByKey, setRatiosByKey] = useState<Record<string, number>>(() => ({
    [storageKey]: getStoredRatio(undefined, storageKey, defaultRatio),
  }));
  const splitRatio = ratiosByKey[storageKey] ?? getStoredRatio(undefined, storageKey, defaultRatio);
  const currentRatioRef = useRef(splitRatio);
  const activeKeyRef = useRef(storageKey);
  const [isResizing, setIsResizing] = useState(false);
  const removeDragListenersRef = useRef<(() => void) | null>(null);

  if (activeKeyRef.current !== storageKey) {
    activeKeyRef.current = storageKey;
    currentRatioRef.current = splitRatio;
  }

  useLayoutEffect(() => {
    currentRatioRef.current = splitRatio;
    if (workbenchRef.current) {
      workbenchRef.current.style.setProperty("--workbench-split-ratio", String(splitRatio));
      workbenchRef.current.style.setProperty("--workbench-left-width", `${splitRatio * 100}%`);
    }
  }, [storageKey, splitRatio]);

  useLayoutEffect(() => () => removeDragListenersRef.current?.(), []);

  const applyRatio = useCallback((ratio: number) => {
    currentRatioRef.current = ratio;
    workbenchRef.current?.style.setProperty("--workbench-split-ratio", String(ratio));
    workbenchRef.current?.style.setProperty("--workbench-left-width", `${ratio * 100}%`);
  }, []);

  // Restore the pre-drag split only after the full-width class has committed.
  // Restoring it while the drag is still visible makes the divider jump back
  // before starting its collapse animation.
  useLayoutEffect(() => {
    if (collapsed) applyRatio(currentRatioRef.current);
  }, [collapsed, applyRatio]);

  const handleStartResize = useCallback((e: ReactPointerEvent) => {
    if (e.button !== 0 || !e.isPrimary) return;
    e.preventDefault();
    removeDragListenersRef.current?.();
    const dragStorageKey = storageKey;
    const startRatio = currentRatioRef.current;
    const pointerId = e.pointerId;
    setIsResizing(true);

    const finish = (restore: boolean, collapsing = false) => {
      removeListeners();
      setIsResizing(false);
      // Collapsing is not a saved resize: reopening restores the useful width
      // from before this gesture rather than leaving the graph at its minimum.
      if (restore) {
        if (collapsing) currentRatioRef.current = startRatio;
        else applyRatio(startRatio);
      }
      const finalRatio = currentRatioRef.current;
      setRatiosByKey(prev => (prev[dragStorageKey] === finalRatio ? prev : { ...prev, [dragStorageKey]: finalRatio }));
      if (!restore) persistRatio(finalRatio, undefined, dragStorageKey);
    };
    const onPointerMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId || !workbenchRef.current) return;
      const rect = workbenchRef.current.getBoundingClientRect();
      if (rect.width <= 0) return;
      const pointerX = moveEvent.clientX - rect.left;
      if (onCollapse && shouldCollapseGraphPane(pointerX, rect.width)) {
        collapse();
        finish(true, true);
        return;
      }
      applyRatio(clampSplitRatio(pointerX / rect.width, rect.width));
    };
    const onPointerUp = (event: PointerEvent) => {
      if (event.pointerId === pointerId) finish(false);
    };
    const onPointerCancel = (event: PointerEvent) => {
      if (event.pointerId === pointerId) finish(true);
    };
    const onBlur = () => finish(false);
    const removeListeners = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerCancel);
      window.removeEventListener("blur", onBlur);
      removeDragListenersRef.current = null;
    };

    removeDragListenersRef.current = removeListeners;
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerCancel);
    window.addEventListener("blur", onBlur);
  }, [applyRatio, collapse, onCollapse, storageKey]);

  const handleResizeKeyDown = useCallback((event: ReactKeyboardEvent) => {
    const width = workbenchRef.current?.getBoundingClientRect().width;
    if (!width) return;
    if (event.key === "Enter" && onCollapse) {
      event.preventDefault();
      collapse();
      return;
    }
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const baseRatio = clampSplitRatio(currentRatioRef.current, width);
    const ratio = event.key === "Home" ? 0 : event.key === "End" ? 1
      : baseRatio + (event.key === "ArrowRight" ? 24 : -24) / width;
    const next = clampSplitRatio(ratio, width);
    applyRatio(next);
    setRatiosByKey(prev => ({ ...prev, [storageKey]: next }));
    persistRatio(next, undefined, storageKey);
  }, [applyRatio, collapse, onCollapse, storageKey]);

  const handleResetResizer = useCallback(() => {
    currentRatioRef.current = defaultRatio;
    setRatiosByKey(prev => ({ ...prev, [storageKey]: defaultRatio }));
    if (workbenchRef.current) {
      workbenchRef.current.style.setProperty("--workbench-split-ratio", String(defaultRatio));
      workbenchRef.current.style.setProperty("--workbench-left-width", `${defaultRatio * 100}%`);
    }
    persistRatio(defaultRatio, undefined, storageKey);
  }, [defaultRatio, storageKey]);

  return {
    workbenchRef,
    isResizing,
    splitRatio,
    handleStartResize,
    handleResizeKeyDown,
    handleResetResizer,
  };
}
