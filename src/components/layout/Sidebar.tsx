import { formatManagedAttachmentDisplayLabel } from "../../utils/attachmentPath";
import { t } from "../../i18n";
import React, { useState } from "react";
import { AnimatePresence, motion, useIsPresent, useReducedMotion } from "motion/react";
import { Plus, Settings2, Trash2, Copy, PanelLeftClose, PanelLeftOpen, Loader2, Inbox, RotateCcw, Search, Pin, PinOff, Check } from "lucide-react";
import { DEFAULT_PIN_DOT_COLOR, PIN_DOT_COLORS, type PinDotColor, type ProjectItem } from "../../types";
import type { RunIndicator } from "../../hooks/useRunIndicators";
import { useSidebarCardDrag } from "../../hooks/useSidebarCardDrag";
import { normalizeWorkspacePath, workspaceKey } from "../../services/workspaceConversations";
import { copyTextToClipboard } from "../../services/externalLink";
import { workspacePathDisplay } from "./workspacePathDisplay";
import { ContextMenu, ContextMenuSubmenu, contextMenuAnchor, type ContextMenuAnchor } from "../ui/context-menu";
import { PiBrandMark } from "../ui/PiBrandMark";

export { normalizeWorkspacePath } from "../../services/workspaceConversations";

// Match the previous CSS entrance while giving cards a real exit, so removing a
// workspace or conversation fades out before the list closes the gap.
const CARD_EASE: [number, number, number, number] = [0.16, 1, 0.3, 1];
// The entrance can snap into place; the removal cannot. The collapse moves the
// cards below, so it uses a gentler curve that spreads the same distance over
// more frames instead of clearing most of it in the first few.
const CARD_COLLAPSE_EASE: [number, number, number, number] = [0.25, 0.46, 0.45, 0.94];
const LIST_VIEW_EXIT_EASE: [number, number, number, number] = [0.4, 0, 1, 1];

// Directional fade+slide when toggling between active and archived lists.
// Pure horizontal transform inside overflow-x: hidden never alters vertical
// scrollHeight, avoiding transient scrollbar flashes.
const LIST_VIEW_VARIANTS = {
  enter: (direction: number) => ({
    opacity: 0,
    x: direction * 10,
  }),
  center: {
    opacity: 1,
    x: 0,
    transition: {
      duration: 0.18,
      ease: CARD_EASE,
    },
  },
  exit: (direction: number) => ({
    opacity: 0,
    x: direction * -10,
    transition: {
      duration: 0.12,
      ease: LIST_VIEW_EXIT_EASE,
    },
  }),
};

// `.projects-list` separates its cards with a flex `gap`; `.runs-list` spaces
// them with a card margin instead.
const PROJECT_LIST_GAP = 4;

// AnimatePresence keeps an exiting card in the flow until its exit finishes, so
// the exit also closes the card's own box: height, padding, border and spacing
// shrink. Without that, the cards below hold their place for the whole exit and
// then snap upward the moment the card is removed, which reads as a jerk instead
// of a removal.
function cardExit(listGap: number) {
  return {
    opacity: 0,
    height: 0,
    minHeight: 0,
    paddingTop: 0,
    paddingBottom: 0,
    // Only the vertical box closes; the horizontal borders stay so the card's
    // content does not reflow sideways while it fades.
    borderTopWidth: 0,
    borderBottomWidth: 0,
    // A `gap` list keeps the space on both sides while the exiting card is still
    // mounted, so pull the trailing gap back out with a negative margin.
    marginBottom: listGap > 0 ? -listGap : 0,
    overflow: "hidden",
    // The card fades in place first and only then gives its space back. The
    // fading card is a clipping box: collapsing it while its label still has
    // visible alpha leaves the middle of the glyphs behind as a smudge inside a
    // card that already reads as gone, which looks like the text outliving the
    // card. No `y`/`scale` here either, so the removal is one motion (the space
    // closing) instead of the content drifting away from its own box.
    transition: {
      opacity: { duration: 0.13, ease: CARD_COLLAPSE_EASE },
      default: { duration: 0.18, ease: CARD_COLLAPSE_EASE, delay: 0.08 },
    },
  };
}

const PROJECT_CARD_EXIT = cardExit(PROJECT_LIST_GAP);
const RUN_CARD_EXIT = cardExit(0);

type CardEntranceMode = "none" | "expand" | "placeholder" | "fade" | "fade-delayed" | "stagger";

// Matches the CSS overlay breakpoint below which the sidebar would otherwise
// take a large share of the width from the single-pane workbench.
const NARROW_SIDEBAR_QUERY = "(max-width: 720px)";

function startsCollapsed(): boolean {
  return typeof window !== "undefined" && window.matchMedia(NARROW_SIDEBAR_QUERY).matches;
}

function cardMotion(reduceMotion: boolean, listGap = 0) {
  if (reduceMotion) {
    return {
      initial: false as const,
      animate: { opacity: 1, y: 0 },
      exit: { opacity: 0 },
    };
  }
  return {
    initial: false as const,
    exit: listGap > 0 ? PROJECT_CARD_EXIT : RUN_CARD_EXIT,
  };
}

/**
 * Animate card entrance via WAAPI using the card's settled CSS box so newly
 * inserted cards open their vertical space smoothly (avoiding a 1-frame jump
 * of cards below, an empty-slot flash, or a transient scrollbar overflow) and
 * leave zero inline style overrides once finished.
 */
function useCardEntrance(
  ref: React.RefObject<HTMLButtonElement | null>,
  mode: CardEntranceMode,
  index: number,
  reduceMotion: boolean,
  listGap = 0,
  placeholderHeight?: number,
) {
  const isPresent = useIsPresent();
  const initialModeRef = React.useRef(mode);
  const initialIndexRef = React.useRef(index);
  const initialGapRef = React.useRef(listGap);
  const initialPlaceholderHeightRef = React.useRef(placeholderHeight);
  const animationsRef = React.useRef<Animation[]>([]);

  React.useLayoutEffect(() => {
    const el = ref.current;
    const entrance = initialModeRef.current;
    if (reduceMotion || entrance === "none" || !el || typeof el.animate !== "function") return;

    const animations: Animation[] = [];
    if (entrance === "stagger") {
      const anim = el.animate(
        [
          { opacity: 0 },
          { opacity: 1 },
        ],
        {
          duration: 200,
          delay: Math.min(initialIndexRef.current, 6) * 18,
          easing: "cubic-bezier(0.16, 1, 0.3, 1)",
          fill: "backwards",
        },
      );
      animations.push(anim);
    } else if (entrance === "fade" || entrance === "fade-delayed") {
      const anim = el.animate(
        [{ opacity: 0 }, { opacity: 1 }],
        {
          duration: entrance === "fade-delayed" ? 160 : 180,
          delay: entrance === "fade-delayed" ? 35 : 0,
          easing: "cubic-bezier(0.16, 1, 0.3, 1)",
          fill: "backwards",
        },
      );
      animations.push(anim);
    } else {
      const cs = getComputedStyle(el);
      const targetHeight = el.getBoundingClientRect().height;
      const targetMinHeight = parseFloat(cs.minHeight) || 0;
      const targetPadTop = parseFloat(cs.paddingTop) || 0;
      const targetPadBottom = parseFloat(cs.paddingBottom) || 0;
      const targetBorderTop = parseFloat(cs.borderTopWidth) || 0;
      const targetBorderBottom = parseFloat(cs.borderBottomWidth) || 0;
      const targetMarginBottom = parseFloat(cs.marginBottom) || 0;
      const gap = initialGapRef.current;
      const fromPlaceholder = entrance === "placeholder";
      const startHeight = fromPlaceholder
        ? Math.min(initialPlaceholderHeightRef.current ?? targetHeight, targetHeight)
        : 0;

      el.style.overflow = "hidden";
      const boxAnim = el.animate(
        [
          fromPlaceholder
            ? {
                height: `${startHeight}px`,
                minHeight: "0px",
              }
            : {
                height: "0px",
                minHeight: "0px",
                paddingTop: "0px",
                paddingBottom: "0px",
                borderTopWidth: "0px",
                borderBottomWidth: "0px",
                marginBottom: `${gap > 0 ? -gap : 0}px`,
              },
          {
            height: `${targetHeight}px`,
            minHeight: `${targetMinHeight}px`,
            paddingTop: `${targetPadTop}px`,
            paddingBottom: `${targetPadBottom}px`,
            borderTopWidth: `${targetBorderTop}px`,
            borderBottomWidth: `${targetBorderBottom}px`,
            marginBottom: `${targetMarginBottom}px`,
          },
        ],
        {
          duration: fromPlaceholder ? 200 : 220,
          easing: "cubic-bezier(0.22, 1, 0.36, 1)",
        },
      );
      const clearOverflow = () => {
        if (el.style.overflow === "hidden") el.style.overflow = "";
      };
      boxAnim.onfinish = clearOverflow;
      boxAnim.oncancel = clearOverflow;

      const opacityAnim = el.animate(
        [{ opacity: 0 }, { opacity: 1 }],
        {
          duration: 160,
          delay: fromPlaceholder ? 20 : 45,
          easing: "cubic-bezier(0.16, 1, 0.3, 1)",
          fill: "backwards",
        },
      );
      animations.push(boxAnim, opacityAnim);
    }

    animationsRef.current = animations;
    return () => {
      for (const anim of animations) anim.cancel();
      animationsRef.current = [];
      if (el.style.overflow === "hidden") el.style.overflow = "";
    };
  }, [reduceMotion, ref]);

  React.useLayoutEffect(() => {
    if (isPresent) return;
    const el = ref.current;
    const animations = animationsRef.current;
    if (!el || animations.length === 0) return;
    for (const anim of animations) {
      if (anim.playState === "running") {
        try {
          if (el.isConnected) anim.commitStyles();
        } catch {
          // Ignore commit errors if the element is detached before exit settles.
        }
      }
      anim.cancel();
    }
    animationsRef.current = [];
    if (el.style.overflow === "hidden") el.style.overflow = "";
  }, [isPresent, ref]);
}

function pinColorLabel(color: PinDotColor): string {
  switch (color) {
    case "black": return t("黑色");
    case "white": return t("白色");
    case "coral": return t("珊瑚红");
    case "blue": return t("蓝色");
    case "yellow": return t("黄色");
  }
}

const WorkspaceItem: React.FC<{
  project: ProjectItem;
  workspaceId: string;
  index: number;
  reduceMotion: boolean;
  entranceMode: CardEntranceMode;
  placeholderHeight?: number;
  isActive: boolean;
  menuOpen: boolean;
  onClick: () => void;
  onPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => void;
  onContextMenu: (event: React.MouseEvent<HTMLButtonElement> | React.KeyboardEvent<HTMLButtonElement>) => void;
  children: React.ReactNode;
}> = ({
  project,
  workspaceId,
  index,
  reduceMotion,
  entranceMode,
  placeholderHeight,
  isActive,
  menuOpen,
  onClick,
  onPointerDown,
  onContextMenu,
  children,
}) => {
  const ref = React.useRef<HTMLButtonElement | null>(null);
  useCardEntrance(ref, entranceMode, index, reduceMotion, PROJECT_LIST_GAP, placeholderHeight);
  return (
    <motion.button
      ref={ref}
      type="button"
      aria-label={`${project.name}\n${normalizeWorkspacePath(project.path)}`}
      aria-current={isActive ? "true" : undefined}
      aria-haspopup="menu"
      aria-expanded={menuOpen}
      data-workspace-key={workspaceId}
      className={`project-workspace-item ${isActive ? "active" : ""}`}
      onClick={onClick}
      onPointerDown={onPointerDown}
      onContextMenu={onContextMenu}
      onKeyDown={onContextMenu}
      {...cardMotion(reduceMotion, PROJECT_LIST_GAP)}
    >
      {children}
    </motion.button>
  );
};

/**
 * Conversation card. The caller keys it by a stable card key so adopting a
 * durable Run ID after the provisional card reuses the same node instead of
 * remounting it (which would replay the entrance and exit animations).
 */
const RunItem: React.FC<{
  runId: string;
  index: number;
  reduceMotion: boolean;
  entranceMode: CardEntranceMode;
  pinColor?: PinDotColor;
  className?: string;
  onClick: () => void;
  onPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => void;
  onContextMenu: (event: React.MouseEvent<HTMLButtonElement> | React.KeyboardEvent<HTMLButtonElement>) => void;
  selected: boolean;
  busy: boolean;
  menuOpen: boolean;
  children: React.ReactNode;
}> = ({ runId, index, reduceMotion, entranceMode, pinColor, className = "", onClick, onPointerDown, onContextMenu, selected, busy, menuOpen, children }) => {
  const ref = React.useRef<HTMLButtonElement | null>(null);
  useCardEntrance(ref, entranceMode, index, reduceMotion, 0);
  return (
    <motion.button
      ref={ref}
      type="button"
      aria-current={selected ? "true" : undefined}
      aria-busy={busy}
      aria-haspopup="menu"
      aria-expanded={menuOpen}
      data-run-id={runId}
      data-pinned={pinColor ? "true" : undefined}
      data-pin-color={pinColor}
      className={`run-item ${className}`.trim()}
      onClick={onClick}
      onPointerDown={onPointerDown}
      onContextMenu={onContextMenu}
      onKeyDown={onContextMenu}
      {...cardMotion(reduceMotion)}
    >
      {children}
    </motion.button>
  );
};

interface SidebarProps {
  projects: ProjectItem[];
  activeRepo: string;
  onSelectProject: (proj: ProjectItem) => void;
  onOpenProject: () => void;
  onRemoveProject: (project: ProjectItem) => void;
  onArchiveProject: (project: ProjectItem) => void;
  onUnarchiveProject: (project: ProjectItem) => void;
  onReorderProjects?: (visibleProjectPaths: string[], fromIndex: number, toIndex: number) => void;
  openedProjectSeq?: number;
  runs: string[];
  archivedRunIds?: ReadonlySet<string>;
  pinnedRuns?: Readonly<Record<string, PinDotColor>>;
  currentRunId: string;
  runIndicators: Record<string, RunIndicator>;
  onLoadRun: (runId: string) => void;
  onCopyRunPrompt: (runId: string, provisionalPrompt?: string) => void;
  onCancelPendingPromptCopy: () => void;
  onPinRun?: (runId: string, color: PinDotColor) => void;
  onUnpinRun?: (runId: string) => void;
  onReorderRuns?: (visibleRunIds: string[], fromIndex: number, toIndex: number) => void;
  onArchiveRun: (runId: string) => void;
  onUnarchiveRun: (runId: string) => void;
  onDeleteRun: (runId: string) => void;
  onNewConversation: () => void;
  onOpenSearch?: () => void;
  onOpenSettings: () => void;
  hasUpdateAvailable?: boolean;
  runLabels?: Record<string, string>;
  runCardKeys?: Record<string, string>;
  initialRunIds?: readonly string[];
  isReady?: boolean;
  isOpeningProject?: boolean;
  loadingRunId?: string | null;
}

export const Sidebar: React.FC<SidebarProps> = React.memo(({
  projects,
  activeRepo,
  onSelectProject,
  onOpenProject,
  onRemoveProject,
  onArchiveProject,
  onUnarchiveProject,
  onReorderProjects,
  openedProjectSeq = 0,
  runs,
  archivedRunIds,
  pinnedRuns = {},
  currentRunId,
  runIndicators,
  onLoadRun,
  onCopyRunPrompt,
  onCancelPendingPromptCopy,
  onPinRun,
  onUnpinRun,
  onReorderRuns,
  onArchiveRun,
  onUnarchiveRun,
  onDeleteRun,
  onNewConversation,
  onOpenSearch,
  onOpenSettings,
  hasUpdateAvailable = false,
  runLabels = {},
  runCardKeys = {},
  initialRunIds = [],
  isReady = true,
  isOpeningProject = false,
  loadingRunId = null,
}) => {
  // Wide launches start expanded; narrow windows start with the rail so the
  // composer keeps its room. Collapsing remains session-local.
  const [isCollapsed, setIsCollapsed] = useState(startsCollapsed);
  const [showArchivedProjects, setShowArchivedProjects] = useState(false);
  const [showArchivedRuns, setShowArchivedRuns] = useState(false);
  // Only undo a collapse we caused by resizing; a user's manual choice wins.
  const autoCollapsedRef = React.useRef(isCollapsed);
  const toggleCollapsed = () => {
    autoCollapsedRef.current = false;
    setIsCollapsed(!isCollapsed);
    setProjectContextMenu(null);
    setRunContextMenu(null);
  };

  const [projectContextMenu, setProjectContextMenu] = useState<(ContextMenuAnchor & { project: ProjectItem }) | null>(null);
  const [runContextMenu, setRunContextMenu] = useState<(ContextMenuAnchor & { runId: string; provisionalPrompt?: string }) | null>(null);
  const reduceMotion = useReducedMotion() ?? false;
  const [projectExitActive, setProjectExitActive] = useState(false);
  const projectsListRef = React.useRef<HTMLDivElement | null>(null);
  const runsListRef = React.useRef<HTMLDivElement | null>(null);
  const projectsPlaceholderRef = React.useRef<HTMLDivElement | null>(null);
  const projectsPlaceholderHeightRef = React.useRef<number>(34);
  const activeRepoKey = workspaceKey(activeRepo);

  const visibleProjects = React.useMemo(
    () => projects.filter((project) => Boolean(project.archived) === showArchivedProjects),
    [projects, showArchivedProjects],
  );
  const visibleRuns = React.useMemo(
    () => runs.filter((id) => Boolean(archivedRunIds?.has(id)) === showArchivedRuns),
    [runs, archivedRunIds, showArchivedRuns],
  );
  const pinnedVisibleCount = React.useMemo(() => {
    if (showArchivedRuns) return 0;
    let count = 0;
    for (const id of visibleRuns) {
      if (pinnedRuns[id]) count += 1;
      else break;
    }
    return count;
  }, [pinnedRuns, showArchivedRuns, visibleRuns]);

  const skipNextRunReorderAnimRef = React.useRef(false);

  const projectDrag = useSidebarCardDrag({
    listRef: projectsListRef,
    viewSelector: ".projects-list-view",
    cardSelector: ".project-workspace-item",
    reduceMotion,
    onDragStart: () => {
      setProjectContextMenu(null);
      setRunContextMenu(null);
    },
    onCommit: (fromIndex, toIndex) => {
      onReorderProjects?.(visibleProjects.map(p => p.path), fromIndex, toIndex);
    },
  });

  const runDrag = useSidebarCardDrag({
    listRef: runsListRef,
    viewSelector: ".runs-list-view",
    cardSelector: ".run-item[data-run-id]",
    reduceMotion,
    onDragStart: () => {
      setProjectContextMenu(null);
      setRunContextMenu(null);
    },
    onCommit: (fromIndex, toIndex) => {
      skipNextRunReorderAnimRef.current = true;
      onReorderRuns?.(visibleRuns, fromIndex, toIndex);
    },
  });

  const previousProjectsStateRef = React.useRef({
    showArchived: showArchivedProjects,
    keys: new Set(visibleProjects.map(project => workspaceKey(project.path))),
  });
  const previousRunsStateRef = React.useRef({
    activeRepo: activeRepoKey,
    showArchived: showArchivedRuns,
    wasReady: isReady,
    keys: new Set(isReady ? visibleRuns.map(id => runCardKeys[id] ?? id) : []),
    order: isReady ? visibleRuns.map(id => runCardKeys[id] ?? id) : [],
  });
  const previousRunTopsRef = React.useRef<Map<string, number>>(new Map());
  const runReorderAnimationsRef = React.useRef<Animation[]>([]);
  // The caller may remember current cache IDs solely for motion. Cards still
  // render only from the authoritative runs prop after bootstrap.
  const restoredKeysRef = React.useRef<{ projects: Set<string>; runs: Set<string> } | null>(null);
  if (restoredKeysRef.current === null) {
    restoredKeysRef.current = {
      projects: new Set(visibleProjects.map(proj => workspaceKey(proj.path))),
      runs: new Set([...initialRunIds, ...(isReady ? visibleRuns : [])].map(id => runCardKeys[id] ?? id)),
    };
  }
  const restoredProjectKeys = restoredKeysRef.current.projects;
  const restoredRunKeys = restoredKeysRef.current.runs;

  const lastOpenedProjectSeqRef = React.useRef(openedProjectSeq);
  React.useEffect(() => {
    if (openedProjectSeq === lastOpenedProjectSeqRef.current) return;
    lastOpenedProjectSeqRef.current = openedProjectSeq;
    setShowArchivedProjects(false);
    setProjectContextMenu(null);
  }, [openedProjectSeq]);

  const lastActiveRepoRef = React.useRef(activeRepoKey);
  React.useEffect(() => {
    if (activeRepoKey === lastActiveRepoRef.current) return;
    lastActiveRepoRef.current = activeRepoKey;
    setShowArchivedRuns(false);
    setRunContextMenu(null);
  }, [activeRepoKey]);

  const previousPendingRunsRef = React.useRef(new Set(runs.filter(id => id.startsWith("pending-"))));
  React.useEffect(() => {
    const nextPending = new Set(runs.filter(id => id.startsWith("pending-")));
    const addedPending = [...nextPending].some(id => !previousPendingRunsRef.current.has(id));
    previousPendingRunsRef.current = nextPending;
    if (addedPending) {
      setShowArchivedRuns(false);
      setRunContextMenu(null);
      if (runsListRef.current) runsListRef.current.scrollTop = 0;
    }
  }, [runs]);

  const toggleArchivedProjects = () => {
    setProjectContextMenu(null);
    setRunContextMenu(null);
    setShowArchivedProjects((prev) => !prev);
    if (projectsListRef.current) projectsListRef.current.scrollTop = 0;
  };

  const toggleArchivedRuns = () => {
    setProjectContextMenu(null);
    setRunContextMenu(null);
    setShowArchivedRuns((prev) => !prev);
    if (runsListRef.current) runsListRef.current.scrollTop = 0;
  };

  const handleNewConversationClick = () => {
    setRunContextMenu(null);
    setShowArchivedRuns(false);
    onNewConversation();
  };

  React.useLayoutEffect(() => {
    const nextKeys = new Set(visibleProjects.map(project => workspaceKey(project.path)));
    const prev = previousProjectsStateRef.current;
    if (prev.showArchived === showArchivedProjects) {
      const removed = [...prev.keys].some(key => !nextKeys.has(key));
      if (!reduceMotion && removed) setProjectExitActive(true);
      for (const key of prev.keys) {
        if (!nextKeys.has(key)) restoredProjectKeys.delete(key);
      }
    } else {
      setProjectExitActive(false);
    }
    if (visibleProjects.length === 0 && projectsPlaceholderRef.current) {
      const measured = projectsPlaceholderRef.current.getBoundingClientRect().height;
      if (measured > 0) projectsPlaceholderHeightRef.current = measured;
    }
    previousProjectsStateRef.current = {
      showArchived: showArchivedProjects,
      keys: nextKeys,
    };
    projectDrag.flushDropSettle();
  }, [visibleProjects, showArchivedProjects, reduceMotion, restoredProjectKeys, projectDrag.flushDropSettle]);

  React.useLayoutEffect(() => {
    const nextOrder = isReady ? visibleRuns.map(id => runCardKeys[id] ?? id) : [];
    const nextKeys = new Set(nextOrder);
    const prev = previousRunsStateRef.current;
    const sameList = isReady && prev.wasReady && prev.activeRepo === activeRepoKey && prev.showArchived === showArchivedRuns;

    const measureCardTops = () => {
      const list = runsListRef.current;
      const tops = new Map<string, number>();
      if (!list) return tops;
      const view = list.querySelector<HTMLElement>(".runs-list-view") ?? list;
      const cards = view.querySelectorAll<HTMLButtonElement>(".run-item[data-run-id]");
      for (const card of cards) {
        const id = card.dataset.runId;
        if (!id) continue;
        const cardKey = runCardKeys[id] ?? id;
        const top = card.offsetParent === view ? card.offsetTop : card.offsetTop - view.offsetTop;
        tops.set(cardKey, top);
      }
      return tops;
    };

    if (sameList) {
      for (const key of prev.keys) {
        if (!nextKeys.has(key)) restoredRunKeys.delete(key);
      }
    }

    const isPureReorder = sameList &&
      prev.order.length === nextOrder.length &&
      nextOrder.length > 1 &&
      prev.keys.size === nextKeys.size &&
      nextOrder.every((key) => prev.keys.has(key)) &&
      nextOrder.some((key, index) => key !== prev.order[index]);

    const isPureInsertion = sameList &&
      prev.order.length > 0 &&
      nextOrder.length > prev.order.length &&
      prev.order.every((key) => nextKeys.has(key));

    if (skipNextRunReorderAnimRef.current) {
      skipNextRunReorderAnimRef.current = false;
      for (const anim of runReorderAnimationsRef.current) anim.cancel();
      runReorderAnimationsRef.current = [];
      previousRunTopsRef.current = isReady ? measureCardTops() : new Map();
      runDrag.flushDropSettle();
    } else if (isPureReorder || isPureInsertion) {
      for (const anim of runReorderAnimationsRef.current) anim.cancel();
      runReorderAnimationsRef.current = [];
      const list = runsListRef.current;
      const prevScrollTop = list ? list.scrollTop : 0;
      const firstChanged = nextOrder[0] !== prev.order[0];
      if (firstChanged && list && list.scrollTop !== 0) {
        list.scrollTop = 0;
      }
      const nextScrollTop = list ? list.scrollTop : 0;
      const nextTops = measureCardTops();

      if (!reduceMotion && list) {
        const listHeight = list.clientHeight;
        const view = list.querySelector<HTMLElement>(".runs-list-view") ?? list;
        let promotedKey: string | null = null;
        if (isPureReorder) {
          if (firstChanged) {
            promotedKey = nextOrder[0];
          } else {
            const prevIndexByKey = new Map(prev.order.map((key, idx) => [key, idx]));
            let bestGain = 0;
            for (let idx = 0; idx < nextOrder.length; idx++) {
              const key = nextOrder[idx];
              const gain = (prevIndexByKey.get(key) ?? idx) - idx;
              if (gain > bestGain) {
                bestGain = gain;
                promotedKey = key;
              }
            }
          }
        }
        const scrolledToTopForInsert = isPureInsertion && prevScrollTop !== nextScrollTop;
        const animations: Animation[] = [];
        for (const card of view.querySelectorAll<HTMLButtonElement>(".run-item[data-run-id]")) {
          const id = card.dataset.runId;
          if (!id || typeof card.animate !== "function") continue;
          const cardKey = runCardKeys[id] ?? id;
          const oldTop = previousRunTopsRef.current.get(cardKey);
          const newTop = nextTops.get(cardKey);
          if (oldTop === undefined || newTop === undefined) continue;
          const oldVisualY = oldTop - prevScrollTop;
          const newVisualY = newTop - nextScrollTop;
          const cardHeight = card.offsetHeight || 40;
          if (listHeight > 0 &&
            (scrolledToTopForInsert
              ? (newVisualY + cardHeight < 0 || newVisualY > listHeight)
              : ((oldVisualY + cardHeight < 0 || oldVisualY > listHeight) &&
                (newVisualY + cardHeight < 0 || newVisualY > listHeight)))) {
            continue;
          }
          let deltaY = scrolledToTopForInsert ? oldTop - newTop : oldVisualY - newVisualY;
          if (Math.abs(deltaY) < 0.5) continue;
          if (listHeight > 0) deltaY = Math.max(-listHeight, Math.min(listHeight, deltaY));
          const isPromoted = cardKey === promotedKey;
          const anim = card.animate(
            [
              isPromoted ? { transform: `translateY(${deltaY}px)`, zIndex: 1 } : { transform: `translateY(${deltaY}px)` },
              isPromoted ? { transform: "translateY(0px)", zIndex: 1 } : { transform: "translateY(0px)" },
            ],
            {
              duration: 220,
              easing: "cubic-bezier(0.22, 1, 0.36, 1)",
            },
          );
          animations.push(anim);
        }
        runReorderAnimationsRef.current = animations;
      }
      previousRunTopsRef.current = nextTops;
    } else {
      previousRunTopsRef.current = isReady ? measureCardTops() : new Map();
    }

    previousRunsStateRef.current = {
      activeRepo: activeRepoKey,
      showArchived: showArchivedRuns,
      wasReady: isReady,
      keys: nextKeys,
      order: nextOrder,
    };
  }, [activeRepoKey, showArchivedRuns, isReady, visibleRuns, runCardKeys, runIndicators, runLabels, restoredRunKeys, reduceMotion, runDrag.flushDropSettle]);

  React.useEffect(() => () => {
    for (const anim of runReorderAnimationsRef.current) anim.cancel();
    runReorderAnimationsRef.current = [];
  }, []);

  React.useEffect(() => {
    const query = window.matchMedia(NARROW_SIDEBAR_QUERY);
    const sync = (narrow: boolean) => {
      if (narrow) {
        setIsCollapsed(previous => {
          if (!previous) autoCollapsedRef.current = true;
          return true;
        });
      } else if (autoCollapsedRef.current) {
        autoCollapsedRef.current = false;
        setIsCollapsed(false);
      }
    };
    sync(query.matches);
    const handleChange = (event: MediaQueryListEvent) => sync(event.matches);
    query.addEventListener("change", handleChange);
    return () => query.removeEventListener("change", handleChange);
  }, []);

  const prevProjectsState = previousProjectsStateRef.current;
  const isProjectViewSwitch = prevProjectsState.showArchived !== showArchivedProjects;
  const projectCards = visibleProjects.map((proj, index) => {
    const key = workspaceKey(proj.path);
    const isActive = activeRepoKey === key;
    const isNewProject = !isProjectViewSwitch && !restoredProjectKeys.has(key) && !prevProjectsState.keys.has(key);
    let entranceMode: CardEntranceMode = "none";
    if (!reduceMotion && isNewProject) {
      if (prevProjectsState.keys.size > 0) entranceMode = "expand";
      else if (visibleProjects.length === 1) entranceMode = "placeholder";
      else entranceMode = "stagger";
    }
    const openMenu = (event: React.MouseEvent<HTMLButtonElement> | React.KeyboardEvent<HTMLButtonElement>) => {
      const anchor = contextMenuAnchor(event);
      if (!anchor) return;
      setRunContextMenu(null);
      setProjectContextMenu({ ...anchor, project: proj });
    };
    return (
      <WorkspaceItem
        key={key}
        project={proj}
        workspaceId={key}
        index={index}
        reduceMotion={reduceMotion}
        entranceMode={entranceMode}
        placeholderHeight={projectsPlaceholderHeightRef.current}
        isActive={isActive}
        menuOpen={projectContextMenu?.project.path === proj.path}
        onClick={() => {
          if (key !== activeRepoKey) setShowArchivedRuns(false);
          onSelectProject(proj);
        }}
        onPointerDown={(event) => {
          if (!onReorderProjects) return;
          projectDrag.startDrag(event, index, { minIndex: 0, maxIndex: visibleProjects.length - 1 });
        }}
        onContextMenu={openMenu}
      >
        <span className="proj-details">
          <span className="proj-name-row">
            <strong>{proj.name}</strong>
          </span>
          <small className="proj-path-text">{workspacePathDisplay(proj.path)}</small>
        </span>
      </WorkspaceItem>
    );
  });

  const prevRunsState = previousRunsStateRef.current;
  const isRunViewSwitch = prevRunsState.showArchived !== showArchivedRuns;
  const runCards = visibleRuns.map((id, index) => {
    const cardKey = runCardKeys[id] ?? id;
    const isRestored = restoredRunKeys.has(cardKey);
    const isNewRun = isReady && !isRunViewSwitch && !isRestored &&
      (prevRunsState.activeRepo !== activeRepoKey || !prevRunsState.wasReady || !prevRunsState.keys.has(cardKey));
    let entranceMode: CardEntranceMode = "none";
    if (!reduceMotion && isNewRun) {
      if (prevRunsState.wasReady && prevRunsState.activeRepo === activeRepoKey) {
        if (prevRunsState.keys.size > 0) entranceMode = "fade-delayed";
        else if (visibleRuns.length === 1) entranceMode = "fade";
        else entranceMode = "stagger";
      } else {
        entranceMode = "stagger";
      }
    }
    const indicator = runIndicators[id];
    const isThisRunActive = Boolean(indicator?.working);
    const pinColor = !showArchivedRuns ? pinnedRuns[id] : undefined;
    const isChosen = (loadingRunId ?? currentRunId) === id;
    const isLoadingThisRun = loadingRunId === id && currentRunId !== id;
    let displayLabel = `Graph ${id.slice(0, 8)}`;
    const labelText = runLabels[id];
    const isResolvingLabel = labelText === undefined;
    if (labelText) {
      displayLabel = formatManagedAttachmentDisplayLabel(labelText);
    }
    const dragBounds = showArchivedRuns
      ? { minIndex: 0, maxIndex: visibleRuns.length - 1 }
      : (pinColor
        ? { minIndex: 0, maxIndex: Math.max(0, pinnedVisibleCount - 1) }
        : { minIndex: pinnedVisibleCount, maxIndex: visibleRuns.length - 1 });
    return (
      <RunItem
        // A provisional card keeps its key when the durable Run ID arrives so
        // the same node is reused instead of remounting.
        key={cardKey}
        runId={id}
        index={index}
        reduceMotion={reduceMotion}
        entranceMode={entranceMode}
        pinColor={pinColor}
        className={`${isChosen ? "chosen" : ""} ${isLoadingThisRun ? "is-loading" : ""}`}
        onClick={() => onLoadRun(id)}
        onPointerDown={(event) => {
          if (!onReorderRuns) return;
          runDrag.startDrag(event, index, dragBounds);
        }}
        selected={isChosen}
        busy={isLoadingThisRun}
        menuOpen={runContextMenu?.runId === id}
        onContextMenu={(e) => {
          const anchor = contextMenuAnchor(e);
          if (!anchor) return;
          setProjectContextMenu(null);
          setRunContextMenu({
            ...anchor, runId: id,
            // The durable ID may replace a pending card while its menu is open.
            provisionalPrompt: id.startsWith("pending-") ? runLabels[id] : undefined,
          });
        }}
      >
        <AnimatePresence initial={false}>
          {pinColor ? (
            <motion.span
              key="pin-dot"
              className="run-pin-dot-slot"
              aria-hidden="true"
              initial={reduceMotion ? false : { width: 0, marginRight: 0, opacity: 0 }}
              animate={{ width: 12, marginRight: 8, opacity: 1 }}
              exit={reduceMotion ? { opacity: 0 } : { width: 0, marginRight: 0, opacity: 0 }}
              transition={reduceMotion ? { duration: 0 } : { duration: 0.2, ease: CARD_EASE }}
            >
              <motion.span
                className="run-pin-dot-scale"
                initial={reduceMotion ? false : { scale: 0 }}
                animate={{ scale: 1 }}
                exit={reduceMotion ? { scale: 1 } : { scale: 0 }}
                transition={reduceMotion ? { duration: 0 } : { duration: 0.2, ease: CARD_EASE }}
              >
                <span
                  className={`run-dot run-pin-dot is-color-${pinColor}${isThisRunActive ? " is-working" : ""}`}
                  data-pin-color={pinColor}
                />
              </motion.span>
            </motion.span>
          ) : null}
        </AnimatePresence>
        {!pinColor && isThisRunActive ? (
          <span
            className="run-dot running-pulse"
          />
        ) : null}
        <span className="run-title-slot">
          <span
            key={isThisRunActive ? "active" : "idle"}
            className={`run-title-text ${isResolvingLabel ? "is-resolving" : ""}`}
          >
            {displayLabel}
          </span>
        </span>
      </RunItem>
    );
  });

  const projectsViewDirection = showArchivedProjects ? 1 : -1;
  const runsViewDirection = showArchivedRuns ? 1 : -1;
  const projectsViewKey = showArchivedProjects ? "archived" : "active";
  const runsViewKey = showArchivedRuns ? "archived" : "active";

  const projectsListContent = (
    <>
      {reduceMotion ? projectCards : <AnimatePresence onExitComplete={() => setProjectExitActive(false)}>{projectCards}</AnimatePresence>}
      {visibleProjects.length === 0 && (
        <div ref={projectsPlaceholderRef} className="projects-placeholder">
          <span>{showArchivedProjects ? t("暂无已归档工作区") : t("暂无工作区")}</span>
        </div>
      )}
    </>
  );

  const runsListContent = (
    <>
      {reduceMotion
        ? runCards
        : <AnimatePresence key={activeRepoKey}>{runCards}</AnimatePresence>}
      {visibleRuns.length === 0 && (
        <div className="run-placeholder">
          <span>{showArchivedRuns ? t("暂无已归档对话") : t("暂无对话记录")}</span>
        </div>
      )}
    </>
  );

  const isMenuProjectArchived = Boolean(projectContextMenu?.project.archived);
  const isMenuRunArchived = Boolean(runContextMenu && archivedRunIds?.has(runContextMenu.runId));
  const isMenuRunPending = Boolean(runContextMenu?.runId.startsWith("pending-"));
  const menuRunPinColor = runContextMenu && !isMenuRunArchived ? pinnedRuns[runContextMenu.runId] : undefined;

  return (
    <aside className={`sidebar${isCollapsed ? " is-collapsed" : ""}`} aria-label={t("侧边栏")}>
      <div className="sidebar-brand-row">
        <div className="brand" aria-label="Pi^n">
          <PiBrandMark width={22} height={18} />
        </div>
        <button
          type="button"
          className="sidebar-toggle-btn"
          onClick={toggleCollapsed}
          aria-label={isCollapsed ? t("展开侧边栏") : t("收起侧边栏")}
          aria-expanded={!isCollapsed}
        >
          {isCollapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
        </button>
      </div>

      <div className="nav-section projects-label">
        <span>Workspace</span>
        <div className="section-actions">
          <button
            type="button"
            className={`sidebar-archive-btn${showArchivedProjects ? " is-active" : ""}`}
            aria-label={showArchivedProjects ? t("返回工作区列表") : t("查看已归档工作区")}
            aria-pressed={showArchivedProjects}
            aria-hidden={isCollapsed || undefined}
            tabIndex={isCollapsed ? -1 : undefined}
            onClick={toggleArchivedProjects}
          >
            <Inbox size={16} strokeWidth={1.75} />
          </button>
          <button
            type="button"
            className="sidebar-add-btn icon-tiny-btn"
            aria-label={t("添加或打开本地 Git 仓库")}
            onClick={onOpenProject}
            disabled={isOpeningProject}
            aria-busy={isOpeningProject}
          >
            {isOpeningProject ? <Loader2 size={16} className="sidebar-btn-spin" /> : <Plus size={18} />}
          </button>
        </div>
      </div>

      <div
        ref={projectsListRef}
        className={`projects-list${projectExitActive ? " is-removing" : ""}`}
        inert={isCollapsed}
        onClickCapture={projectDrag.onListClickCapture}
      >
        {reduceMotion ? (
          <div className="projects-list-view">{projectsListContent}</div>
        ) : (
          <AnimatePresence mode="wait" initial={false} custom={projectsViewDirection}>
            <motion.div
              key={projectsViewKey}
              className="projects-list-view"
              custom={projectsViewDirection}
              variants={LIST_VIEW_VARIANTS}
              initial="enter"
              animate="center"
              exit="exit"
            >
              {projectsListContent}
            </motion.div>
          </AnimatePresence>
        )}
      </div>

      <div className="nav-section runs-label">
        <span>Conversation</span>
        <div className="section-actions">
          {onOpenSearch && (
            <button
              type="button"
              className="sidebar-archive-btn"
              aria-label={t("搜索当前工作区对话 (⌘G / Ctrl+G)")}
              aria-hidden={isCollapsed || undefined}
              tabIndex={isCollapsed ? -1 : undefined}
              onClick={onOpenSearch}
            >
              <Search size={15} strokeWidth={1.85} />
            </button>
          )}
          <button
            type="button"
            className={`sidebar-archive-btn${showArchivedRuns ? " is-active" : ""}`}
            aria-label={showArchivedRuns ? t("返回对话列表") : t("查看已归档对话")}
            aria-pressed={showArchivedRuns}
            aria-hidden={isCollapsed || undefined}
            tabIndex={isCollapsed ? -1 : undefined}
            onClick={toggleArchivedRuns}
          >
            <Inbox size={16} strokeWidth={1.75} />
          </button>
          <button
            type="button"
            className="sidebar-add-btn icon-tiny-btn"
            aria-label={t("新建对话")}
            onClick={handleNewConversationClick}
          >
            <Plus size={18} />
          </button>
        </div>
      </div>

      <div
        ref={runsListRef}
        className="runs-list"
        inert={isCollapsed}
        onClickCapture={runDrag.onListClickCapture}
      >
        {!isReady ? (
          <div className="sidebar-skeleton-wrap" aria-hidden="true">
            <div className="sidebar-skeleton-item">
              <div className="sidebar-skeleton-dot" />
              <div className="sidebar-skeleton-lines">
                <div className="sidebar-skeleton-line title" style={{ width: "75%" }} />
                <div className="sidebar-skeleton-line sub" style={{ width: "45%" }} />
              </div>
            </div>
            <div className="sidebar-skeleton-item">
              <div className="sidebar-skeleton-dot" />
              <div className="sidebar-skeleton-lines">
                <div className="sidebar-skeleton-line title" style={{ width: "60%" }} />
                <div className="sidebar-skeleton-line sub" style={{ width: "35%" }} />
              </div>
            </div>
            <div className="sidebar-skeleton-item">
              <div className="sidebar-skeleton-dot" />
              <div className="sidebar-skeleton-lines">
                <div className="sidebar-skeleton-line title" style={{ width: "80%" }} />
                <div className="sidebar-skeleton-line sub" style={{ width: "50%" }} />
              </div>
            </div>
          </div>
        ) : reduceMotion ? (
          <div className="runs-list-view">{runsListContent}</div>
        ) : (
          <AnimatePresence mode="wait" initial={false} custom={runsViewDirection}>
            <motion.div
              key={runsViewKey}
              className="runs-list-view"
              custom={runsViewDirection}
              variants={LIST_VIEW_VARIANTS}
              initial="enter"
              animate="center"
              exit="exit"
            >
              {runsListContent}
            </motion.div>
          </AnimatePresence>
        )}
      </div>

      <div className="sidebar-bottom">
        <button
          type="button"
          className="sidebar-bottom-btn"
          onClick={onOpenSettings}
          aria-label="Settings"
        >
          <Settings2 size={18} />
          <span>Settings</span>
          {hasUpdateAvailable && (
            <i className="sidebar-update-dot" aria-hidden="true" title={t("发现新版本")} />
          )}
        </button>
      </div>

      {projectContextMenu && (
        <ContextMenu
          anchor={projectContextMenu}
          label={projectContextMenu.project.name}
          onClose={() => setProjectContextMenu(null)}
        >
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className="context-menu-item"
            onClick={() => {
              onCancelPendingPromptCopy();
              void copyTextToClipboard(normalizeWorkspacePath(projectContextMenu.project.path));
              setProjectContextMenu(null);
            }}
          >
            <Copy size={14} />
            <span>{t("复制仓库路径")}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className="context-menu-item"
            onClick={() => {
              const project = projectContextMenu.project;
              setProjectContextMenu(null);
              if (isMenuProjectArchived) onUnarchiveProject(project);
              else {
                if (workspaceKey(project.path) === activeRepoKey) setShowArchivedRuns(false);
                onArchiveProject(project);
              }
            }}
          >
            {isMenuProjectArchived ? <RotateCcw size={14} strokeWidth={1.85} /> : <Inbox size={14} strokeWidth={1.85} />}
            <span>{isMenuProjectArchived ? t("取消归档工作区") : t("归档工作区")}</span>
          </button>
          <div className="context-menu-divider" />
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className="context-menu-item danger"
            onClick={() => {
              const project = projectContextMenu.project;
              setProjectContextMenu(null);
              onRemoveProject(project);
            }}
          >
            <Trash2 size={14} />
            <span>{t("从工作区移除")}</span>
          </button>
        </ContextMenu>
      )}

      {runContextMenu && (
        <ContextMenu
          anchor={runContextMenu}
          label={runLabels[runContextMenu.runId]
            ? formatManagedAttachmentDisplayLabel(runLabels[runContextMenu.runId])
            : `Graph ${runContextMenu.runId.slice(0, 8)}`}
          onClose={() => setRunContextMenu(null)}
        >
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className="context-menu-item"
            onClick={() => {
              onCancelPendingPromptCopy();
              void copyTextToClipboard(runContextMenu.runId);
              setRunContextMenu(null);
            }}
          >
            <Copy size={14} />
            <span>{t("复制快照 ID")}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className="context-menu-item"
            onClick={() => {
              const { runId, provisionalPrompt } = runContextMenu;
              setRunContextMenu(null);
              onCopyRunPrompt(runId, provisionalPrompt);
            }}
          >
            <Copy size={14} />
            <span>{t("复制提示词")}</span>
          </button>
          {!isMenuRunArchived && onPinRun && onUnpinRun && (
            menuRunPinColor ? (
              <>
                <button
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  className="context-menu-item"
                  onClick={() => {
                    const runId = runContextMenu.runId;
                    setRunContextMenu(null);
                    onUnpinRun(runId);
                  }}
                >
                  <PinOff size={14} strokeWidth={1.85} />
                  <span>{t("取消置顶")}</span>
                </button>
                <ContextMenuSubmenu
                  label={t("置顶颜色")}
                  triggerContent={
                    <>
                      <span
                        className={`context-menu-pin-swatch is-color-${menuRunPinColor}`}
                        aria-hidden="true"
                      />
                      <span>{t("置顶颜色")}</span>
                    </>
                  }
                >
                  {PIN_DOT_COLORS.map((color) => (
                    <button
                      key={color}
                      type="button"
                      role="menuitem"
                      tabIndex={-1}
                      className="context-menu-item context-menu-color-item"
                      aria-checked={menuRunPinColor === color}
                      data-pin-color={color}
                      onClick={() => {
                        const runId = runContextMenu.runId;
                        setRunContextMenu(null);
                        onPinRun(runId, color);
                      }}
                    >
                      <span className={`context-menu-pin-swatch is-color-${color}`} aria-hidden="true" />
                      <span>{pinColorLabel(color)}</span>
                      {menuRunPinColor === color && (
                        <Check size={13} className="context-menu-check" aria-hidden="true" />
                      )}
                    </button>
                  ))}
                </ContextMenuSubmenu>
              </>
            ) : (
              <ContextMenuSubmenu
                label={t("置顶颜色")}
                disabled={isMenuRunPending}
                triggerContent={
                  <>
                    <Pin size={14} strokeWidth={1.85} />
                    <span>{t("置顶对话")}</span>
                  </>
                }
                onTriggerClick={() => {
                  const runId = runContextMenu.runId;
                  setRunContextMenu(null);
                  onPinRun(runId, DEFAULT_PIN_DOT_COLOR);
                }}
              >
                {PIN_DOT_COLORS.map((color) => (
                  <button
                    key={color}
                    type="button"
                    role="menuitem"
                    tabIndex={-1}
                    className="context-menu-item context-menu-color-item"
                    data-pin-color={color}
                    onClick={() => {
                      const runId = runContextMenu.runId;
                      setRunContextMenu(null);
                      onPinRun(runId, color);
                    }}
                  >
                    <span className={`context-menu-pin-swatch is-color-${color}`} aria-hidden="true" />
                    <span>{pinColorLabel(color)}</span>
                  </button>
                ))}
              </ContextMenuSubmenu>
            )
          )}
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className="context-menu-item"
            disabled={isMenuRunPending}
            onClick={() => {
              const runId = runContextMenu.runId;
              setRunContextMenu(null);
              if (isMenuRunArchived) onUnarchiveRun(runId);
              else onArchiveRun(runId);
            }}
          >
            {isMenuRunArchived ? <RotateCcw size={14} strokeWidth={1.85} /> : <Inbox size={14} strokeWidth={1.85} />}
            <span>{isMenuRunArchived ? t("取消归档对话") : t("归档对话")}</span>
          </button>
          <div className="context-menu-divider" />
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className="context-menu-item danger"
            disabled={isMenuRunPending}
            onClick={() => {
              const runId = runContextMenu.runId;
              setRunContextMenu(null);
              onDeleteRun(runId);
            }}
          >
            <Trash2 size={14} />
            <span>{t("删除此条历史")}</span>
          </button>
        </ContextMenu>
      )}
    </aside>
  );
});

Sidebar.displayName = "Sidebar";
