import React, { useCallback, useEffect, useRef } from "react";
import { useStableCallback } from "./useStableCallback";

const DRAG_THRESHOLD_PX = 5;
const AUTO_SCROLL_EDGE_PX = 26;
const AUTO_SCROLL_MAX_STEP_PX = 8;
const DROP_SETTLE_MS = 140;
const DROP_SETTLE_EASING = "cubic-bezier(0.22, 1, 0.36, 1)";

interface CardSnapshot {
  el: HTMLButtonElement;
  top: number;
  height: number;
  pitch: number;
}

export interface SidebarCardDragBounds {
  minIndex: number;
  maxIndex: number;
}

interface UseSidebarCardDragOptions {
  listRef: React.RefObject<HTMLDivElement | null>;
  viewSelector: string;
  cardSelector: string;
  reduceMotion: boolean;
  onDragStart?: () => void;
  onCommit: (fromIndex: number, toIndex: number) => void;
}

export function useSidebarCardDrag({
  listRef,
  viewSelector,
  cardSelector,
  reduceMotion,
  onDragStart,
  onCommit,
}: UseSidebarCardDragOptions) {
  const suppressClickRef = useRef(false);
  const suppressClickTimerRef = useRef<number | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const pendingSettleRef = useRef<{ el: HTMLButtonElement; deltaY: number } | null>(null);
  const settleAnimRef = useRef<Animation | null>(null);

  const stableOnDragStart = useStableCallback(() => onDragStart?.());
  const stableOnCommit = useStableCallback(onCommit);

  const armClickSuppression = useCallback(() => {
    suppressClickRef.current = true;
    if (suppressClickTimerRef.current !== null) {
      window.clearTimeout(suppressClickTimerRef.current);
    }
    suppressClickTimerRef.current = window.setTimeout(() => {
      suppressClickRef.current = false;
      suppressClickTimerRef.current = null;
    }, 0);
  }, []);

  const onListClickCapture = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (!suppressClickRef.current) return;
    suppressClickRef.current = false;
    if (suppressClickTimerRef.current !== null) {
      window.clearTimeout(suppressClickTimerRef.current);
      suppressClickTimerRef.current = null;
    }
    event.preventDefault();
    event.stopPropagation();
  }, []);

  const flushDropSettle = useCallback(() => {
    const pending = pendingSettleRef.current;
    if (!pending) return;
    pendingSettleRef.current = null;
    if (reduceMotion || Math.abs(pending.deltaY) < 1 || !pending.el.isConnected || typeof pending.el.animate !== "function") {
      return;
    }
    settleAnimRef.current?.cancel();
    const anim = pending.el.animate(
      [
        { transform: `translate3d(0, ${pending.deltaY}px, 0)`, zIndex: 10 },
        { transform: "translate3d(0, 0px, 0)", zIndex: 10 },
      ],
      {
        duration: DROP_SETTLE_MS,
        easing: DROP_SETTLE_EASING,
      },
    );
    settleAnimRef.current = anim;
    anim.onfinish = () => {
      if (settleAnimRef.current === anim) settleAnimRef.current = null;
    };
    anim.oncancel = () => {
      if (settleAnimRef.current === anim) settleAnimRef.current = null;
    };
  }, [reduceMotion]);

  useEffect(() => () => {
    cleanupRef.current?.();
    cleanupRef.current = null;
    settleAnimRef.current?.cancel();
    settleAnimRef.current = null;
    if (suppressClickTimerRef.current !== null) {
      window.clearTimeout(suppressClickTimerRef.current);
      suppressClickTimerRef.current = null;
    }
  }, []);

  const startDrag = useCallback((
    event: React.PointerEvent<HTMLButtonElement>,
    originIndex: number,
    bounds: SidebarCardDragBounds,
  ) => {
    if (event.button !== 0 || !event.isPrimary) return;
    if (bounds.minIndex >= bounds.maxIndex) return;
    const list = listRef.current;
    if (!list) return;

    cleanupRef.current?.();
    cleanupRef.current = null;

    const pointerId = event.pointerId;
    const startClientX = event.clientX;
    const startClientY = event.clientY;
    const startScrollTop = list.scrollTop;
    let lastClientY = startClientY;
    let active = false;
    let cards: CardSnapshot[] = [];
    let targetIndex = originIndex;
    let lastClampedDeltaY = 0;
    let autoScrollRaf = 0;
    let prevBodyCursor = "";

    const applyPositions = () => {
      const dragged = cards[originIndex];
      if (!dragged) return;
      const rawDeltaY = (lastClientY - startClientY) + (list.scrollTop - startScrollTop);
      const minCard = cards[bounds.minIndex];
      const maxCard = cards[bounds.maxIndex];
      const minDeltaY = minCard.top - dragged.top;
      const maxDeltaY = (maxCard.top + maxCard.height - dragged.height) - dragged.top;
      const clampedDeltaY = Math.max(minDeltaY, Math.min(maxDeltaY, rawDeltaY));
      lastClampedDeltaY = clampedDeltaY;

      const dragTop = dragged.top + clampedDeltaY;
      const dragBottom = dragTop + dragged.height;
      let nextTarget = originIndex;
      if (clampedDeltaY > 0) {
        for (let i = originIndex + 1; i <= bounds.maxIndex; i++) {
          if (dragBottom > cards[i].top + cards[i].height / 2) nextTarget = i;
          else break;
        }
      } else if (clampedDeltaY < 0) {
        for (let i = originIndex - 1; i >= bounds.minIndex; i--) {
          if (dragTop < cards[i].top + cards[i].height / 2) nextTarget = i;
          else break;
        }
      }
      targetIndex = nextTarget;

      dragged.el.style.transform = `translate3d(0, ${clampedDeltaY}px, 0)`;
      for (let i = 0; i < cards.length; i++) {
        if (i === originIndex) continue;
        let shift = 0;
        if (targetIndex > originIndex && i > originIndex && i <= targetIndex) {
          shift = -dragged.pitch;
        } else if (targetIndex < originIndex && i >= targetIndex && i < originIndex) {
          shift = dragged.pitch;
        }
        cards[i].el.style.transform = shift === 0 ? "" : `translate3d(0, ${shift}px, 0)`;
      }
    };

    const stepAutoScroll = () => {
      autoScrollRaf = 0;
      if (!active) return;
      const rect = list.getBoundingClientRect();
      let scrollDelta = 0;
      if (lastClientY < rect.top + AUTO_SCROLL_EDGE_PX && list.scrollTop > 0) {
        const ratio = Math.min(1, (rect.top + AUTO_SCROLL_EDGE_PX - lastClientY) / AUTO_SCROLL_EDGE_PX);
        scrollDelta = -Math.ceil(ratio * AUTO_SCROLL_MAX_STEP_PX);
      } else if (
        lastClientY > rect.bottom - AUTO_SCROLL_EDGE_PX &&
        list.scrollTop + list.clientHeight < list.scrollHeight
      ) {
        const ratio = Math.min(1, (lastClientY - (rect.bottom - AUTO_SCROLL_EDGE_PX)) / AUTO_SCROLL_EDGE_PX);
        scrollDelta = Math.ceil(ratio * AUTO_SCROLL_MAX_STEP_PX);
      }
      if (scrollDelta !== 0) {
        const prev = list.scrollTop;
        list.scrollTop = prev + scrollDelta;
        if (list.scrollTop !== prev) {
          applyPositions();
          autoScrollRaf = window.requestAnimationFrame(stepAutoScroll);
        }
      }
    };

    const ensureAutoScroll = () => {
      if (!active || autoScrollRaf !== 0) return;
      if (list.scrollHeight <= list.clientHeight) return;
      const rect = list.getBoundingClientRect();
      if (
        (lastClientY < rect.top + AUTO_SCROLL_EDGE_PX && list.scrollTop > 0) ||
        (lastClientY > rect.bottom - AUTO_SCROLL_EDGE_PX && list.scrollTop + list.clientHeight < list.scrollHeight)
      ) {
        autoScrollRaf = window.requestAnimationFrame(stepAutoScroll);
      }
    };

    const activate = () => {
      const view = list.querySelector<HTMLElement>(viewSelector) ?? list;
      const elements = Array.from(view.querySelectorAll<HTMLButtonElement>(cardSelector));
      if (originIndex < 0 || originIndex >= elements.length) return false;
      if (bounds.maxIndex >= elements.length || bounds.minIndex < 0) return false;

      settleAnimRef.current?.cancel();
      settleAnimRef.current = null;
      for (const el of elements) {
        if (typeof el.getAnimations === "function") {
          for (const anim of el.getAnimations()) anim.cancel();
        }
      }

      const rawSnapshots = elements.map((el) => ({
        el,
        top: el.offsetParent === view ? el.offsetTop : el.offsetTop - view.offsetTop,
        height: el.offsetHeight,
      }));
      cards = rawSnapshots.map((item, idx) => {
        let pitch = item.height;
        if (idx < rawSnapshots.length - 1) {
          pitch = rawSnapshots[idx + 1].top - item.top;
        } else if (idx > 0) {
          const gap = item.top - (rawSnapshots[idx - 1].top + rawSnapshots[idx - 1].height);
          pitch = item.height + Math.max(0, gap);
        }
        return { ...item, pitch };
      });

      active = true;
      prevBodyCursor = document.body.style.cursor;
      document.body.style.cursor = "grabbing";
      list.classList.add("is-dragging");
      list.dataset.dragging = "true";
      cards[originIndex].el.classList.add("is-drag-source");
      stableOnDragStart();
      return true;
    };

    const finish = (commit: boolean) => {
      if (autoScrollRaf !== 0) {
        window.cancelAnimationFrame(autoScrollRaf);
        autoScrollRaf = 0;
      }
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerCancel);
      window.removeEventListener("blur", onWindowBlur);
      window.removeEventListener("keydown", onKeyDown, true);
      if (cleanupRef.current === cancelCleanup) cleanupRef.current = null;

      if (!active) return;
      active = false;
      armClickSuppression();
      document.body.style.cursor = prevBodyCursor;
      list.classList.remove("is-dragging");
      delete list.dataset.dragging;

      const dragged = cards[originIndex];
      for (const item of cards) {
        item.el.style.transform = "";
        item.el.classList.remove("is-drag-source");
      }

      if (commit && dragged && targetIndex !== originIndex) {
        const targetCard = cards[targetIndex];
        const targetTop = targetIndex < originIndex
          ? targetCard.top
          : targetCard.top + targetCard.height - dragged.height;
        const settleDeltaY = (dragged.top + lastClampedDeltaY) - targetTop;
        pendingSettleRef.current = { el: dragged.el, deltaY: settleDeltaY };
        stableOnCommit(originIndex, targetIndex);
      } else if (dragged && !reduceMotion && Math.abs(lastClampedDeltaY) > 1 && typeof dragged.el.animate === "function") {
        settleAnimRef.current?.cancel();
        const anim = dragged.el.animate(
          [
            { transform: `translate3d(0, ${lastClampedDeltaY}px, 0)`, zIndex: 10 },
            { transform: "translate3d(0, 0px, 0)", zIndex: 10 },
          ],
          { duration: DROP_SETTLE_MS, easing: DROP_SETTLE_EASING },
        );
        settleAnimRef.current = anim;
        anim.onfinish = () => {
          if (settleAnimRef.current === anim) settleAnimRef.current = null;
        };
        anim.oncancel = () => {
          if (settleAnimRef.current === anim) settleAnimRef.current = null;
        };
      }
    };

    const onPointerMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      lastClientY = moveEvent.clientY;
      if (!active) {
        const dist = Math.hypot(moveEvent.clientX - startClientX, moveEvent.clientY - startClientY);
        if (dist < DRAG_THRESHOLD_PX) return;
        if (!activate()) {
          finish(false);
          return;
        }
      }
      moveEvent.preventDefault();
      applyPositions();
      ensureAutoScroll();
    };

    const onPointerUp = (upEvent: PointerEvent) => {
      if (upEvent.pointerId !== pointerId) return;
      if (active) {
        lastClientY = upEvent.clientY;
        applyPositions();
      }
      finish(true);
    };

    const onPointerCancel = (cancelEvent: PointerEvent) => {
      if (cancelEvent.pointerId !== pointerId) return;
      finish(false);
    };

    const onKeyDown = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key !== "Escape") return;
      if (!active) return;
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      finish(false);
    };

    const onWindowBlur = () => {
      finish(false);
    };

    const cancelCleanup = () => finish(false);
    cleanupRef.current = cancelCleanup;

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerCancel);
    window.addEventListener("blur", onWindowBlur);
    window.addEventListener("keydown", onKeyDown, true);
  }, [armClickSuppression, cardSelector, listRef, reduceMotion, stableOnCommit, stableOnDragStart, viewSelector]);

  return {
    startDrag,
    onListClickCapture,
    flushDropSettle,
  };
}
