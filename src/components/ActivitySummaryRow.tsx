import React, { memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useReducedMotion } from "motion/react";
import { TRANSCRIPT_SCROLL_ADJUSTED_EVENT } from "../services/transcriptScroll";
import {
  AlertCircle,
  ChevronRight,
  FileEdit,
  FileText,
  Folder,
  Globe,
  Loader2,
  Network,
  Search,
  Sparkles,
  SquareTerminal,
  Wrench,
} from "lucide-react";
import type { TranscriptItem } from "../types";
import { summarizeActivityGroup, type ActivitySummaryIcon } from "../services/activitySummary";
import { CollapsibleCardBody } from "./CollapsibleCardBody";
import { ToolCallCard } from "./ToolCallCard";
import { ThinkingCard } from "./ThinkingCard";
import { TranscriptErrorCard } from "./TranscriptErrorCard";

export type CardsTransitionPhase = "idle" | "collapsing" | "expanding";

interface ActivitySummaryRowProps {
  item: TranscriptItem;
  expanded?: boolean;
  transitionPhase?: CardsTransitionPhase;
  defaultThinkingExpanded?: boolean;
  getChildExpanded?: (id: string) => boolean | undefined;
  onExpandedChange?: (expanded: boolean, card?: HTMLElement) => void;
  onChildResize?: (expanded: boolean, card?: HTMLElement) => void;
  onChildExpandedChange?: (child: TranscriptItem, expanded: boolean, card?: HTMLElement) => void;
}

export const CARDS_TRANSITION_DURATION_MS = 260;
export const CARDS_TRANSITION_MAX_DURATION_MS = 320;
const VIEWPORT_BUDGET_MARGIN_PX = 28;

function resolveCardsTransitionDuration(totalAnimatedPx: number): number {
  if (totalAnimatedPx <= 260) return CARDS_TRANSITION_DURATION_MS;
  const ratio = Math.min(1, (totalAnimatedPx - 260) / 500);
  return Math.round(
    CARDS_TRANSITION_DURATION_MS +
    (CARDS_TRANSITION_MAX_DURATION_MS - CARDS_TRANSITION_DURATION_MS) * ratio,
  );
}

// Blend from crisp ease-out cubic (for compact reveals) toward a softer
// curve (for viewport-scale multi-card reveals) so expanding many cards never
// kicks a full screen of cards at 3x average velocity on frame 1.
function easeCardsTransition(t: number, softness = 0): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const inv = 1 - t;
  const cubicOut = 1 - inv * inv * inv;
  if (softness <= 0) return cubicOut;
  const quadOut = 1 - inv * inv;
  const sineInOut = 0.5 * (1 - Math.cos(Math.PI * t));
  const gentle = 0.45 * sineInOut + 0.55 * quadOut;
  return cubicOut + (gentle - cubicOut) * Math.min(1, softness);
}

type PendingTransitionRow = {
  headerTrack: HTMLDivElement;
  headerInner: HTMLDivElement;
  bodyTrack: HTMLDivElement;
  bodyInner: HTMLDivElement;
  collapsing: boolean;
  keepBodyOpen: boolean;
  active: ActiveTransitionRow | null;
};

type ActiveTransitionRow = {
  headerTrack: HTMLDivElement;
  headerInner: HTMLDivElement;
  bodyTrack: HTMLDivElement;
  bodyInner: HTMLDivElement;
  headerHeight: number;
  bodyHeight: number;
  maxBodyHeight: number;
  bottomAlign: boolean;
  skipHeaderCollapse: boolean;
  snapCollapsed: boolean;
  collapsing: boolean;
  keepBodyOpen: boolean;
  lastHeaderHeight: number;
  lastBodyHeight: number;
};

const pendingTransitionRows = new Set<PendingTransitionRow>();
const activeTransitionRows = new Set<ActiveTransitionRow>();
let pendingFlushScheduled = false;
let transitionRafId: number | null = null;
let transitionCompleteRafId: number | null = null;
let transitionStartedAt = 0;
let transitionDurationMs = CARDS_TRANSITION_DURATION_MS;
let transitionSoftness = 0;
let awaitingFirstPaint = false;
let lastAppliedEased = 0;
let transitionGeneration = 0;
let transitionOnComplete: (() => void) | null = null;

type CardsTransitionAnchor = {
  scroller: HTMLElement;
  trigger: HTMLElement | null;
  pinToBottom: boolean;
  targetTop: number;
  cleanup: () => void;
};
let activeTransitionAnchor: CardsTransitionAnchor | null = null;

function applyRowAt(row: ActiveTransitionRow, eased: number): boolean {
  let heightChanged = false;
  if (row.skipHeaderCollapse || row.snapCollapsed) {
    if (row.headerHeight !== row.lastHeaderHeight) {
      row.headerTrack.style.height = `${row.headerHeight}px`;
      row.lastHeaderHeight = row.headerHeight;
      heightChanged = true;
    }
    row.headerTrack.style.opacity = "1";
    if (!row.keepBodyOpen) {
      if (row.lastBodyHeight !== 0) {
        row.bodyTrack.style.height = "0px";
        row.lastBodyHeight = 0;
        heightChanged = true;
      }
      row.bodyTrack.style.opacity = "0";
    }
    return heightChanged;
  }

  const headerRatio = row.collapsing ? eased : 1 - eased;
  const nextHeaderH = Math.round(row.headerHeight * headerRatio);
  if (nextHeaderH !== row.lastHeaderHeight) {
    row.headerTrack.style.height = `${nextHeaderH}px`;
    row.lastHeaderHeight = nextHeaderH;
    heightChanged = true;
  }
  row.headerTrack.style.opacity = `${headerRatio}`;

  if (!row.keepBodyOpen) {
    const bodyRatio = row.collapsing ? 1 - eased : eased;
    const nextBodyH = Math.round(row.bodyHeight * bodyRatio);
    if (nextBodyH !== row.lastBodyHeight) {
      row.bodyTrack.style.height = `${nextBodyH}px`;
      row.lastBodyHeight = nextBodyH;
      heightChanged = true;
    }
    row.bodyTrack.style.opacity = `${bodyRatio}`;
  }
  return heightChanged;
}

function syncTransitionAnchorScroll(emitEvent = true) {
  const anchor = activeTransitionAnchor;
  if (!anchor || !anchor.scroller.isConnected) return;
  const { scroller, trigger, pinToBottom, targetTop } = anchor;
  if (pinToBottom) {
    const target = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    if (Math.abs(scroller.scrollTop - target) >= 0.5) {
      scroller.scrollTop = scroller.scrollHeight;
      if (emitEvent) scroller.dispatchEvent(new Event(TRANSCRIPT_SCROLL_ADJUSTED_EVENT));
    }
    return;
  }
  if (trigger && trigger.isConnected) {
    const delta = trigger.getBoundingClientRect().top - targetTop;
    if (Math.abs(delta) >= 0.5) {
      scroller.scrollTop += delta;
      if (emitEvent) scroller.dispatchEvent(new Event(TRANSCRIPT_SCROLL_ADJUSTED_EVENT));
    }
  }
}

function flushPendingTransitionRows(syncAnchor = true) {
  if (pendingTransitionRows.size === 0) return;
  const batch = [...pendingTransitionRows];
  pendingTransitionRows.clear();

  const anchor = activeTransitionAnchor;
  const scroller = anchor?.scroller?.isConnected ? anchor.scroller : null;
  const scrollerRect = scroller ? scroller.getBoundingClientRect() : null;
  const viewTop = scroller && scrollerRect ? scrollerRect.top + scroller.clientTop : 0;
  const viewHeight = scroller ? (scroller.clientHeight || 600) : 0;
  const viewBottom = viewTop + viewHeight;
  const scrollContentBottom = scroller ? viewTop - scroller.scrollTop + scroller.scrollHeight : 0;
  const anchorY = anchor && scroller
    ? (anchor.pinToBottom
      ? viewBottom
      : (anchor.trigger?.isConnected
        ? Math.min(viewBottom, Math.max(viewTop, anchor.trigger.getBoundingClientRect().top))
        : viewBottom))
    : 0;

  // Pass 1 (READ ONLY): measure all intrinsic track heights and positions in a
  // single layout pass instead of alternating read/write/scrollTop per row.
  type MeasuredRow = {
    entry: PendingTransitionRow;
    headerHeight: number;
    fullBodyHeight: number;
    rowTop: number;
    rowBottom: number;
    maxBodyHeight: number;
    bottomAlign: boolean;
    skipHeaderCollapse: boolean;
    snapCollapsed: boolean;
  };
  const measured: MeasuredRow[] = [];
  for (const entry of batch) {
    const headerHeight = Math.round(entry.headerInner.offsetHeight || entry.headerInner.getBoundingClientRect().height);
    const fullBodyHeight = Math.round(entry.bodyInner.offsetHeight || entry.bodyInner.getBoundingClientRect().height);
    const headerRect = entry.headerTrack.getBoundingClientRect();
    const bodyRect = entry.bodyTrack.getBoundingClientRect();
    measured.push({
      entry,
      headerHeight,
      fullBodyHeight,
      rowTop: headerRect.top,
      rowBottom: bodyRect.bottom,
      maxBodyHeight: Infinity,
      bottomAlign: false,
      skipHeaderCollapse: false,
      snapCollapsed: false,
    });
  }
  measured.sort((a, b) => a.rowTop - b.rowTop);

  // Allocate a viewport-bounded animation height budget outward from the scroll
  // anchor so expanding/collapsing dozens of cards animates only the portion
  // that can actually enter or leave the viewport, bottom-aligned above a
  // bottom anchor so final visible cards unfurl in place with zero handoff snap.
  if (scroller && anchor && viewHeight > 0) {
    const aboveAnchor: MeasuredRow[] = [];
    const belowAnchor: MeasuredRow[] = [];
    for (const item of measured) {
      if (anchor.pinToBottom || item.rowBottom <= anchorY + 2) {
        aboveAnchor.push(item);
      } else {
        belowAnchor.push(item);
      }
    }

    if (aboveAnchor.length > 0) {
      const last = aboveAnchor[aboveAnchor.length - 1];
      const fixedBelowLast = anchor.pinToBottom
        ? Math.max(0, scrollContentBottom - last.rowBottom)
        : Math.max(0, anchorY - last.rowBottom);
      const availableAbove = anchor.pinToBottom ? viewHeight : Math.max(0, anchorY - viewTop);
      let budget = Math.max(0, availableAbove - fixedBelowLast) + VIEWPORT_BUDGET_MARGIN_PX;

      for (let i = aboveAnchor.length - 1; i >= 0; i--) {
        if (i < aboveAnchor.length - 1) {
          const fixedBetween = Math.max(0, aboveAnchor[i + 1].rowTop - aboveAnchor[i].rowBottom);
          budget = Math.max(0, budget - fixedBetween);
        }
        const item = aboveAnchor[i];
        if (item.entry.keepBodyOpen) {
          budget = Math.max(0, budget - item.fullBodyHeight);
        } else if (budget <= 0) {
          item.maxBodyHeight = 0;
          if (!item.entry.collapsing) {
            item.skipHeaderCollapse = true;
          } else {
            item.snapCollapsed = true;
          }
        } else {
          const capped = Math.min(item.fullBodyHeight, Math.ceil(budget));
          if (capped < item.fullBodyHeight) {
            item.maxBodyHeight = capped;
            item.bottomAlign = true;
          }
          budget = Math.max(0, budget - capped);
        }
      }
    }

    if (belowAnchor.length > 0) {
      const first = belowAnchor[0];
      const fixedAboveFirst = Math.max(0, first.rowTop - anchorY);
      let budget = Math.max(0, (viewBottom - anchorY) - fixedAboveFirst) + VIEWPORT_BUDGET_MARGIN_PX;

      for (let i = 0; i < belowAnchor.length; i++) {
        if (i > 0) {
          const fixedBetween = Math.max(0, belowAnchor[i].rowTop - belowAnchor[i - 1].rowBottom);
          budget = Math.max(0, budget - fixedBetween);
        }
        const item = belowAnchor[i];
        if (item.entry.keepBodyOpen) {
          budget = Math.max(0, budget - item.fullBodyHeight);
        } else if (budget <= 0) {
          item.maxBodyHeight = 0;
          if (!item.entry.collapsing) {
            item.skipHeaderCollapse = true;
          } else {
            item.snapCollapsed = true;
          }
        } else {
          const capped = Math.min(item.fullBodyHeight, Math.ceil(budget));
          if (capped < item.fullBodyHeight) {
            item.maxBodyHeight = capped;
          }
          budget = Math.max(0, budget - capped);
        }
      }
    }
  }

  // Pass 2 (WRITE ONLY): apply initial frame heights/opacities for every row together.
  const initialEased = lastAppliedEased;
  for (const item of measured) {
    const bodyHeight = item.maxBodyHeight === Infinity
      ? item.fullBodyHeight
      : Math.min(item.fullBodyHeight, item.maxBodyHeight);
    const active: ActiveTransitionRow = {
      headerTrack: item.entry.headerTrack,
      headerInner: item.entry.headerInner,
      bodyTrack: item.entry.bodyTrack,
      bodyInner: item.entry.bodyInner,
      headerHeight: item.headerHeight,
      bodyHeight,
      maxBodyHeight: item.maxBodyHeight,
      bottomAlign: item.bottomAlign,
      skipHeaderCollapse: item.skipHeaderCollapse,
      snapCollapsed: item.snapCollapsed,
      collapsing: item.entry.collapsing,
      keepBodyOpen: item.entry.keepBodyOpen,
      lastHeaderHeight: -1,
      lastBodyHeight: -1,
    };
    if (active.bottomAlign && !active.keepBodyOpen) {
      active.bodyTrack.style.display = "flex";
      active.bodyTrack.style.flexDirection = "column";
      active.bodyTrack.style.justifyContent = "flex-end";
    } else {
      active.bodyTrack.style.display = "";
      active.bodyTrack.style.flexDirection = "";
      active.bodyTrack.style.justifyContent = "";
    }
    if (active.keepBodyOpen) {
      active.bodyTrack.style.height = "";
      active.bodyTrack.style.opacity = "1";
    }
    applyRowAt(active, initialEased);
    item.entry.active = active;
    activeTransitionRows.add(active);
  }

  if (transitionStartedAt === 0) {
    let totalAnimatedPx = 0;
    for (const row of activeTransitionRows) {
      if (!row.keepBodyOpen && !row.skipHeaderCollapse && !row.snapCollapsed) {
        totalAnimatedPx += row.bodyHeight;
      }
    }
    transitionDurationMs = resolveCardsTransitionDuration(totalAnimatedPx);
    transitionSoftness = totalAnimatedPx <= 220 ? 0 : Math.min(1, (totalAnimatedPx - 220) / 380);
  }

  if (syncAnchor) {
    syncTransitionAnchorScroll(false);
  }
  if (activeTransitionRows.size > 0 && transitionRafId === null) {
    transitionRafId = requestAnimationFrame(tickCardsTransition);
  }
}

export function hasActiveCardsTransitionAnchor() {
  return activeTransitionAnchor !== null;
}

function detachCardsTransitionAnchor() {
  if (!activeTransitionAnchor) return;
  activeTransitionAnchor.cleanup();
  activeTransitionAnchor = null;
}

export function cancelCardsTransitionAnchor() {
  if (transitionRafId !== null) {
    cancelAnimationFrame(transitionRafId);
    transitionRafId = null;
  }
  if (transitionCompleteRafId !== null) {
    cancelAnimationFrame(transitionCompleteRafId);
    transitionCompleteRafId = null;
  }
  transitionOnComplete = null;
  transitionGeneration += 1;
  transitionStartedAt = 0;
  transitionDurationMs = CARDS_TRANSITION_DURATION_MS;
  transitionSoftness = 0;
  awaitingFirstPaint = false;
  lastAppliedEased = 0;
  detachCardsTransitionAnchor();
}

export function syncCardsTransitionAnchorScroll() {
  flushPendingTransitionRows(false);
  syncTransitionAnchorScroll(false);
}

export function finishCardsTransitionAnchor() {
  const anchor = activeTransitionAnchor;
  if (!anchor) return;
  syncTransitionAnchorScroll(true);
  queueMicrotask(() => {
    if (activeTransitionAnchor !== anchor) return;
    syncTransitionAnchorScroll(true);
  });
  requestAnimationFrame(() => {
    if (activeTransitionAnchor !== anchor) return;
    syncTransitionAnchorScroll(true);
    requestAnimationFrame(() => {
      if (activeTransitionAnchor !== anchor) return;
      syncTransitionAnchorScroll(true);
      cancelCardsTransitionAnchor();
    });
  });
}

export function beginCardsTransitionAnchor(
  scroller: HTMLElement | null,
  trigger: HTMLElement | null,
  pinToBottom: boolean,
  onComplete?: () => void,
  onUserInterrupt?: () => void,
) {
  cancelCardsTransitionAnchor();
  transitionStartedAt = 0;
  awaitingFirstPaint = true;
  lastAppliedEased = 0;
  transitionOnComplete = onComplete ?? null;
  transitionGeneration += 1;
  if (scroller) {
    // User scroll/touch/pointer interrupts only the scroll anchor so the user
    // immediately regains scroll control while the 260ms row transition still
    // finishes cleanly instead of freezing half-open until the fallback timer.
    const cancel = () => {
      detachCardsTransitionAnchor();
      onUserInterrupt?.();
    };
    scroller.addEventListener("wheel", cancel, { passive: true, once: true });
    scroller.addEventListener("touchstart", cancel, { passive: true, once: true });
    scroller.addEventListener("pointerdown", cancel, { passive: true, once: true });
    // Live streaming output (assistant text wraps, new rows, growing cards) can
    // resize the conversation between animation frames while GraphWorkbench's
    // own auto-scroll is suppressed. Compensate synchronously before paint so
    // the anchored footer/trigger never drops for a frame and snaps back.
    const observer = typeof ResizeObserver === "function"
      ? new ResizeObserver(() => syncTransitionAnchorScroll(true))
      : null;
    if (observer) {
      observer.observe(scroller);
      if (scroller.firstElementChild) observer.observe(scroller.firstElementChild);
    }
    activeTransitionAnchor = {
      scroller,
      trigger,
      pinToBottom,
      targetTop: trigger?.getBoundingClientRect().top ?? 0,
      cleanup: () => {
        observer?.disconnect();
        scroller.removeEventListener("wheel", cancel);
        scroller.removeEventListener("touchstart", cancel);
        scroller.removeEventListener("pointerdown", cancel);
      },
    };
  }
  // Always schedule a tick so even transitions with zero visible summary rows
  // complete promptly instead of waiting for a fallback timeout.
  if (transitionRafId === null) {
    transitionRafId = requestAnimationFrame(tickCardsTransition);
  }
}

function tickCardsTransition(now: number) {
  transitionRafId = null;
  flushPendingTransitionRows(false);
  if (activeTransitionRows.size === 0) {
    if (transitionOnComplete) {
      const done = transitionOnComplete;
      transitionOnComplete = null;
      done();
    }
    return;
  }
  if (awaitingFirstPaint) {
    // Frame 0 (eased = 0) was applied in useLayoutEffect and has not painted yet.
    // Let the browser finish Frame 0's style/layout/paint before starting the
    // animation clock so newly mounted cards never skip the start of the curve.
    awaitingFirstPaint = false;
    syncTransitionAnchorScroll(false);
    transitionRafId = requestAnimationFrame(tickCardsTransition);
    return;
  }
  if (transitionStartedAt === 0) {
    transitionStartedAt = now - 16;
  }
  const elapsed = Math.max(0, now - transitionStartedAt);
  const progress = Math.min(1, elapsed / transitionDurationMs);
  const eased = easeCardsTransition(progress, transitionSoftness);
  lastAppliedEased = eased;

  // Pass 1 (READ ONLY): refresh live target heights so a streaming thinking
  // card or newly arrived tool call mid-expand never snaps at idle handoff.
  // Keep collapsing body heights fixed so shrinking cards never bounce larger.
  for (const row of activeTransitionRows) {
    if (row.skipHeaderCollapse || row.snapCollapsed) continue;
    if (!row.collapsing && !row.keepBodyOpen) {
      const liveBodyH = Math.round(row.bodyInner.offsetHeight || row.bodyInner.getBoundingClientRect().height);
      const boundedBodyH = row.maxBodyHeight === Infinity ? liveBodyH : Math.min(liveBodyH, row.maxBodyHeight);
      if (boundedBodyH > 0) row.bodyHeight = boundedBodyH;
    } else if (row.collapsing) {
      const liveHeaderH = Math.round(row.headerInner.offsetHeight || row.headerInner.getBoundingClientRect().height);
      if (liveHeaderH > 0) row.headerHeight = liveHeaderH;
    }
  }

  // Pass 2 (WRITE ONLY): update every animated track together, then sync scroll.
  for (const row of activeTransitionRows) {
    applyRowAt(row, eased);
  }
  syncTransitionAnchorScroll(false);

  if (progress < 1 && activeTransitionRows.size > 0) {
    transitionRafId = requestAnimationFrame(tickCardsTransition);
  } else if (progress >= 1 && transitionOnComplete) {
    const done = transitionOnComplete;
    const gen = transitionGeneration;
    transitionOnComplete = null;
    // Let the final `eased = 1` frame paint before switching to `"idle"`.
    transitionCompleteRafId = requestAnimationFrame(() => {
      transitionCompleteRafId = null;
      if (transitionGeneration === gen) done();
    });
  }
}

function registerCardsTransitionRow(entry: PendingTransitionRow): () => void {
  pendingTransitionRows.add(entry);
  if (!pendingFlushScheduled) {
    pendingFlushScheduled = true;
    queueMicrotask(() => {
      pendingFlushScheduled = false;
      flushPendingTransitionRows(true);
    });
  }
  if (transitionRafId === null) {
    transitionRafId = requestAnimationFrame(tickCardsTransition);
  }
  return () => {
    pendingTransitionRows.delete(entry);
    if (entry.active) {
      activeTransitionRows.delete(entry.active);
      entry.active = null;
    }
    if (activeTransitionRows.size === 0 && pendingTransitionRows.size === 0 && transitionRafId !== null && !transitionOnComplete) {
      cancelAnimationFrame(transitionRafId);
      transitionRafId = null;
    }
  };
}

function renderSummaryIcon(icon: ActivitySummaryIcon, isRunning: boolean) {
  if (isRunning) return <Loader2 size={14} strokeWidth={1.9} className="activity-summary-icon spin" />;
  switch (icon) {
    case "folder":
      return <Folder size={14} strokeWidth={1.85} className="activity-summary-icon" />;
    case "search":
      return <Search size={14} strokeWidth={1.85} className="activity-summary-icon" />;
    case "read":
      return <FileText size={14} strokeWidth={1.85} className="activity-summary-icon" />;
    case "edit":
      return <FileEdit size={14} strokeWidth={1.85} className="activity-summary-icon" />;
    case "terminal":
      return <SquareTerminal size={14} strokeWidth={1.85} className="activity-summary-icon" />;
    case "web":
      return <Globe size={14} strokeWidth={1.85} className="activity-summary-icon" />;
    case "graph":
      return <Network size={14} strokeWidth={1.85} className="activity-summary-icon" />;
    case "error":
      return <AlertCircle size={14} strokeWidth={1.85} className="activity-summary-icon" />;
    case "thinking":
      return <Sparkles size={14} strokeWidth={1.85} className="activity-summary-icon" />;
    default:
      return <Wrench size={14} strokeWidth={1.85} className="activity-summary-icon" />;
  }
}

const SummaryChildCard = memo(function SummaryChildCard({
  item,
  expanded,
  defaultThinkingExpanded = false,
  onExpandedChange,
}: {
  item: TranscriptItem;
  expanded?: boolean;
  defaultThinkingExpanded?: boolean;
  onExpandedChange: (id: string, expanded: boolean, card?: HTMLElement) => void;
}) {
  const expand = useCallback(
    (value: boolean, card?: HTMLElement) => onExpandedChange(item.id, value, card),
    [item.id, onExpandedChange],
  );
  if (item.type === "tool_call") {
    return <ToolCallCard item={item} expanded={expanded} onExpandedChange={expand} animateAppear={false} />;
  }
  if (item.type === "thinking") {
    return (
      <ThinkingCard
        item={item}
        isStreaming={item.status === "running"}
        title="Chain of Thought"
        defaultExpanded={item.defaultExpanded ?? (defaultThinkingExpanded || item.status === "running")}
        autoExpandWhileStreaming={true}
        expanded={expanded}
        onExpandedChange={expand}
        animateAppear={false}
      />
    );
  }
  if (item.errorItems || ((item.type === "text" || item.type === "system") && (item.isError || item.status === "error"))) {
    return <TranscriptErrorCard item={item} expanded={expanded} onExpandedChange={expand} />;
  }
  return null;
});

export const ActivitySummaryRow: React.FC<ActivitySummaryRowProps> = memo(({
  item,
  expanded,
  transitionPhase = "idle",
  defaultThinkingExpanded = false,
  getChildExpanded,
  onExpandedChange,
  onChildResize,
  onChildExpandedChange,
}) => {
  const rowRef = useRef<HTMLDivElement>(null);
  const headerTrackRef = useRef<HTMLDivElement>(null);
  const headerInnerRef = useRef<HTMLDivElement>(null);
  const bodyTrackRef = useRef<HTMLDivElement>(null);
  const bodyInnerRef = useRef<HTMLDivElement>(null);
  const reduceMotion = useReducedMotion();
  const [localExpanded, setLocalExpanded] = useState(false);
  const [childExpanded, setChildExpanded] = useState<Map<string, boolean>>(() => new Map());
  const isExpanded = expanded ?? localExpanded;

  const items = item.summaryItems ?? [];
  const summary = useMemo(
    () => summarizeActivityGroup(items, undefined, { isOpen: item.summaryOpen }),
    [items, item.summaryOpen],
  );
  const isGlobalTransition = !reduceMotion && (transitionPhase === "collapsing" || transitionPhase === "expanding");
  const isCollapsingTransition = transitionPhase === "collapsing";
  const keepBodyExpanded = !reduceMotion && transitionPhase === "expanding" && isExpanded;
  // Read the previous commit's value during render but only advance it in a
  // layout effect: mutating a ref while rendering makes React StrictMode's
  // second render see `wasGlobalTransition === false`, so the settled body
  // would replay its own collapse animation after the global one finished.
  const prevGlobalTransitionRef = useRef(isGlobalTransition);
  const wasGlobalTransition = prevGlobalTransitionRef.current;
  useLayoutEffect(() => {
    prevGlobalTransitionRef.current = isGlobalTransition;
  });

  useLayoutEffect(() => {
    if (transitionPhase === "collapsing") setLocalExpanded(false);
  }, [transitionPhase]);

  useLayoutEffect(() => {
    const headerTrack = headerTrackRef.current;
    const headerInner = headerInnerRef.current;
    const bodyTrack = bodyTrackRef.current;
    const bodyInner = bodyInnerRef.current;
    if (!isGlobalTransition) {
      if (headerTrack) {
        headerTrack.style.height = "";
        headerTrack.style.opacity = "";
      }
      if (bodyTrack) {
        bodyTrack.style.height = "";
        bodyTrack.style.opacity = "";
        bodyTrack.style.display = "";
        bodyTrack.style.flexDirection = "";
        bodyTrack.style.justifyContent = "";
      }
      return;
    }
    if (!headerTrack || !headerInner || !bodyTrack || !bodyInner) return;

    return registerCardsTransitionRow({
      headerTrack,
      headerInner,
      bodyTrack,
      bodyInner,
      collapsing: isCollapsingTransition,
      keepBodyOpen: keepBodyExpanded,
      active: null,
    });
  }, [isGlobalTransition, isCollapsingTransition, keepBodyExpanded]);

  const toggleExpanded = useCallback(() => {
    if (isGlobalTransition) return;
    const next = !isExpanded;
    setLocalExpanded(next);
    onExpandedChange?.(next, rowRef.current ?? undefined);
  }, [isExpanded, isGlobalTransition, onExpandedChange]);

  const handleChildExpanded = useCallback((id: string, next: boolean, card?: HTMLElement) => {
    setChildExpanded(previous => {
      const updated = new Map(previous);
      updated.set(id, next);
      return updated;
    });
    const child = items.find(entry => entry.id === id);
    if (child) onChildExpandedChange?.(child, next, card);
    onChildResize?.(next, card);
  }, [items, onChildExpandedChange, onChildResize]);

  const headerButton = (
    <button
      type="button"
      className="activity-summary-trigger"
      data-testid="activity-summary-trigger"
      onClick={toggleExpanded}
      onMouseDown={(event) => {
        // Match ThinkingCard / ToolCallCard: clicking a summary toggle must not steal composer focus.
        event.preventDefault();
      }}
      aria-expanded={isExpanded}
    >
      <span className="activity-summary-icon-wrap" aria-hidden="true">
        {renderSummaryIcon(summary.icon, summary.isRunning)}
      </span>
      <span className="activity-summary-text">{summary.text}</span>
      <ChevronRight
        size={13}
        className={`activity-summary-chevron${isExpanded ? " open" : ""}`}
        aria-hidden="true"
      />
    </button>
  );

  const cardsList = (
    <div className="activity-summary-cards" data-testid="activity-summary-cards">
      {items.map((child) => (
        <SummaryChildCard
          key={child.id}
          item={child}
          expanded={childExpanded.get(child.id) ?? getChildExpanded?.(child.id)}
          defaultThinkingExpanded={defaultThinkingExpanded}
          onExpandedChange={handleChildExpanded}
        />
      ))}
    </div>
  );

  return (
    <div
      ref={rowRef}
      className={`activity-summary-row${isExpanded ? " expanded" : ""}${summary.isRunning ? " running" : ""}${summary.icon === "error" ? " has-error" : ""}${transitionPhase !== "idle" ? ` ${transitionPhase}` : ""}`}
      data-testid="activity-summary-row"
      data-transition={transitionPhase !== "idle" ? transitionPhase : undefined}
    >
      <div
        ref={headerTrackRef}
        className={isGlobalTransition ? "activity-summary-header-track" : undefined}
        style={isGlobalTransition
          ? { width: "100%", minWidth: 0, overflow: "hidden", contain: "layout style", pointerEvents: "none" }
          : { width: "100%", minWidth: 0 }}
      >
        <div
          ref={headerInnerRef}
          style={{
            width: "100%",
            minWidth: 0,
            display: "flex",
            ...(keepBodyExpanded ? { paddingBottom: 8 } : {}),
          }}
        >
          {headerButton}
        </div>
      </div>
      <div
        ref={bodyTrackRef}
        className={isGlobalTransition ? "activity-summary-body-track" : undefined}
        style={isGlobalTransition
          ? { width: "100%", minWidth: 0, overflow: "hidden", contain: "layout style" }
          : { width: "100%", minWidth: 0 }}
      >
        <div ref={bodyInnerRef} style={{ width: "100%", minWidth: 0, flexShrink: 0 }}>
          <CollapsibleCardBody
            expanded={isGlobalTransition ? true : isExpanded}
            durationMs={isGlobalTransition || wasGlobalTransition ? 0 : CARDS_TRANSITION_DURATION_MS}
            clampToViewport={true}
          >
            {() => cardsList}
          </CollapsibleCardBody>
        </div>
      </div>
    </div>
  );
});

ActivitySummaryRow.displayName = "ActivitySummaryRow";
export default ActivitySummaryRow;
