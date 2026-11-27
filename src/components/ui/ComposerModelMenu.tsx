import React, { useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronRight } from "lucide-react";
import { t } from "../../i18n";
import {
  THINKING_LEVEL_SCALE,
  availableCatalogModels,
  normalizeModelThinkingLevels,
  roleModelConfig,
  thinkingLevelLabel,
  updateRoleModelConfig,
} from "../../modelConfig";
import { ComposerModels } from "../../services/composerCommands";
import { providerAuth, type ProviderCatalog } from "../../services/providerAuth";
import { getDesktopTitlebarInset } from "../../services/apiBase";
import type { Config, ModelRole, RoleModelConfig, ThinkingLevel } from "../../types";

export interface ComposerModelMenuProps {
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  menuId: string;
  catalog: ProviderCatalog | null;
  role: ModelRole;
  runId?: string;
  modelNode?: string;
  isMerger: boolean;
  baseConfig?: Config;
  currentModel: string;
  currentThinkingLevel: ThinkingLevel;
  currentModelThinkingLevels: ThinkingLevel[];
  isCurrentHidden: boolean;
  compact: boolean;
  scopeKey: string;
  settingsKey: string;
  scopeIdentityRef: React.RefObject<string>;
  settingsIdentityRef: React.RefObject<string>;
  selectorMountedRef: React.RefObject<boolean>;
  saveGenerationRef: React.MutableRefObject<number>;
  onOptimisticChange: (next: Required<RoleModelConfig> | null) => void;
  onError?: (message: string) => void;
  onNoticeClear?: () => void;
  onClose: (restoreFocus?: boolean) => void;
  onOpenScopedModels?: () => void;
}

interface PickerModelEntry {
  key: string;
  displayName: string;
  thinkingLevels: ThinkingLevel[];
  hiddenCurrent?: boolean;
}

function pointInTriangle(
  px: number, py: number,
  ax: number, ay: number,
  bx: number, by: number,
  cx: number, cy: number,
): boolean {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

const HOVER_INTENT_DELAY_MS = 160;
const SUBMENU_CLOSE_DELAY_MS = 220;

function defaultUnchosenThinkingLevel(
  model: ProviderCatalog["models"][number],
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

export default function ComposerModelMenu({
  triggerRef,
  menuId,
  catalog,
  role,
  runId,
  modelNode,
  isMerger,
  baseConfig,
  currentModel,
  currentThinkingLevel,
  currentModelThinkingLevels,
  isCurrentHidden,
  compact,
  scopeKey,
  settingsKey,
  scopeIdentityRef,
  settingsIdentityRef,
  selectorMountedRef,
  saveGenerationRef,
  onOptimisticChange,
  onError,
  onNoticeClear,
  onClose,
  onOpenScopedModels,
}: ComposerModelMenuProps) {
  const context = useContext(ComposerModels);
  const envOverrides = context?.envOverrides ?? {};
  const modelEnvOverride = isMerger
    ? Boolean(envOverrides.merger?.trim() || envOverrides.nodeAgent?.trim())
    : Boolean(envOverrides[role]?.trim());
  const thinkingEnvOverride = isMerger
    ? Boolean(envOverrides.mergerThinking?.trim() || envOverrides.nodeAgentThinking?.trim())
    : Boolean(envOverrides[`${role}Thinking`]?.trim());
  const availableModels = useMemo(() => availableCatalogModels(catalog), [catalog]);
  const submenuId = useId();
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState("");
  const [submenuKey, setSubmenuKey] = useState<string | null>(null);
  const [menuPos, setMenuPos] = useState<{ left: number; top: number; maxHeight: number; placement: "above" | "below" }>({
    left: -9999,
    top: -9999,
    maxHeight: 320,
    placement: "above",
  });
  const [submenuPos, setSubmenuPos] = useState<{ left: number; top: number; side: "left" | "right" }>({
    left: -9999,
    top: -9999,
    side: "right",
  });

  const menuRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const submenuRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const submenuTimerRef = useRef<number | null>(null);
  const lastPointerRef = useRef<{ x: number; y: number } | null>(null);
  const lastPointerTypeRef = useRef<string>("mouse");
  const focusSubmenuOnOpenRef = useRef(false);
  const mountedRef = useRef(true);
  const catalogFetchGenerationRef = useRef(0);

  const clearSubmenuTimer = useCallback(() => {
    if (submenuTimerRef.current !== null) {
      window.clearTimeout(submenuTimerRef.current);
      submenuTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearSubmenuTimer();
    };
  }, [clearSubmenuTimer]);

  const loadCatalog = useCallback((forceRefresh = false) => {
    const fetchGen = ++catalogFetchGenerationRef.current;
    setCatalogError("");
    if (forceRefresh || !providerAuth.getCachedCatalog()) {
      setCatalogLoading(true);
    }
    void providerAuth.catalog(forceRefresh).then(
      () => {
        if (!mountedRef.current || fetchGen !== catalogFetchGenerationRef.current) return;
        setCatalogLoading(false);
        setCatalogError("");
      },
      () => {
        if (!mountedRef.current || fetchGen !== catalogFetchGenerationRef.current) return;
        setCatalogLoading(false);
        if (!providerAuth.getCachedCatalog() || forceRefresh) {
          setCatalogError(t("模型列表加载失败，请重试。"));
        }
      },
    );
  }, []);

  useEffect(() => {
    loadCatalog(false);
  }, [loadCatalog]);

  const entries = useMemo<PickerModelEntry[]>(() => {
    const list: PickerModelEntry[] = [];
    if (isCurrentHidden && currentModel) {
      list.push({
        key: currentModel,
        displayName: t("当前已选模型已隐藏"),
        thinkingLevels: currentModelThinkingLevels,
        hiddenCurrent: true,
      });
    }

    const nameCounts = new Map<string, number>();
    for (const model of availableModels) {
      const base = model.name || model.id;
      nameCounts.set(base, (nameCounts.get(base) ?? 0) + 1);
    }

    for (const model of availableModels) {
      const base = model.name || model.id;
      const displayName = (nameCounts.get(base) ?? 0) > 1 ? `${base} (${model.provider})` : base;
      list.push({
        key: `${model.provider}/${model.id}`,
        displayName,
        thinkingLevels: model.thinkingLevels ?? [],
      });
    }
    return list;
  }, [availableModels, isCurrentHidden, currentModel, currentModelThinkingLevels]);

  const submenuEntry = useMemo(
    () => (submenuKey ? entries.find(item => item.key === submenuKey) ?? null : null),
    [entries, submenuKey],
  );

  useEffect(() => {
    if (submenuKey && !submenuEntry) {
      setSubmenuKey(null);
    }
  }, [submenuKey, submenuEntry]);

  const placeMenu = useCallback(() => {
    const trigger = triggerRef.current;
    const menu = menuRef.current;
    if (!trigger || !menu) return;
    const triggerRect = trigger.getBoundingClientRect();
    const width = menu.offsetWidth || 220;
    const minTop = getDesktopTitlebarInset() + 8;
    const spaceAbove = Math.max(0, triggerRect.top - minTop - 8);
    const spaceBelow = Math.max(0, window.innerHeight - triggerRect.bottom - 8 - 8);
    const naturalHeight = menu.offsetHeight || 160;
    const placement: "above" | "below" =
      spaceAbove >= naturalHeight || spaceAbove >= spaceBelow ? "above" : "below";
    const availableHeight = placement === "above" ? spaceAbove : spaceBelow;
    const maxHeight = Math.max(120, Math.min(340, availableHeight));
    const renderedHeight = Math.min(naturalHeight, maxHeight);
    const left = Math.max(8, Math.min(triggerRect.right - width, window.innerWidth - width - 8));
    const top = placement === "above"
      ? Math.max(minTop, triggerRect.top - renderedHeight - 8)
      : Math.min(window.innerHeight - renderedHeight - 8, triggerRect.bottom + 8);
    setMenuPos(prev =>
      prev.left === left && prev.top === top && prev.maxHeight === maxHeight && prev.placement === placement
        ? prev
        : { left, top, maxHeight, placement },
    );
  }, [triggerRef]);

  useLayoutEffect(() => {
    placeMenu();
    const menu = menuRef.current;
    if (!menu) return;
    const observer = new ResizeObserver(placeMenu);
    observer.observe(menu);
    return () => observer.disconnect();
  }, [placeMenu, entries.length, catalogLoading, catalogError]);

  useLayoutEffect(() => {
    const activeRow = currentModel ? rowRefs.current.get(currentModel) : undefined;
    if (activeRow) {
      activeRow.scrollIntoView({ block: "nearest" });
    }
    const target = (activeRow && !activeRow.disabled ? activeRow : null)
      ?? menuRef.current?.querySelector<HTMLButtonElement>(".composer-model-item:not(:disabled)")
      ?? menuRef.current;
    target?.focus({ preventScroll: true });
  }, []);

  useLayoutEffect(() => {
    if (entries.length === 0 || document.activeElement !== menuRef.current) return;
    const activeRow = currentModel ? rowRefs.current.get(currentModel) : undefined;
    const target = (activeRow && !activeRow.disabled ? activeRow : null)
      ?? menuRef.current?.querySelector<HTMLButtonElement>(".composer-model-item:not(:disabled)");
    target?.scrollIntoView({ block: "nearest" });
    target?.focus({ preventScroll: true });
  }, [entries.length, currentModel]);

  const placeSubmenu = useCallback(() => {
    if (!submenuKey) return;
    const row = rowRefs.current.get(submenuKey);
    const menu = menuRef.current;
    const submenu = submenuRef.current;
    if (!row || !menu || !submenu) return;
    const list = listRef.current;
    const rowRect = row.getBoundingClientRect();
    if (list) {
      const listRect = list.getBoundingClientRect();
      if (rowRect.bottom <= listRect.top || rowRect.top >= listRect.bottom) {
        setSubmenuKey(null);
        return;
      }
    }
    const menuLeft = menuPos.left > -9000 ? menuPos.left : menu.getBoundingClientRect().left;
    const menuTop = menuPos.top > -9000 ? menuPos.top : menu.getBoundingClientRect().top;
    const menuRight = menuLeft + menu.offsetWidth;
    const menuBottom = menuTop + menu.offsetHeight;
    const subWidth = submenu.offsetWidth || 148;
    const subHeight = submenu.offsetHeight || 140;
    const minTop = getDesktopTitlebarInset() + 8;
    const rightLeft = menuRight + 6;
    const fitsRight = rightLeft + subWidth + 8 <= window.innerWidth;
    const left = fitsRight
      ? rightLeft
      : Math.max(8, Math.min(menuLeft - subWidth - 6, window.innerWidth - subWidth - 8));
    const maxBottom = menuPos.placement === "above"
      ? Math.min(window.innerHeight - 8, menuBottom)
      : window.innerHeight - 8;
    const maxTop = Math.max(minTop, maxBottom - subHeight);
    const top = Math.max(minTop, Math.min(rowRect.top - 6, maxTop));
    const side = fitsRight ? "right" : "left";
    setSubmenuPos(prev =>
      prev.left === left && prev.top === top && prev.side === side
        ? prev
        : { left, top, side },
    );
  }, [submenuKey, menuPos.left, menuPos.top, menuPos.placement]);

  useLayoutEffect(() => {
    if (!submenuKey || !submenuEntry) return;
    placeSubmenu();
    const submenu = submenuRef.current;
    if (!submenu) return;
    if (focusSubmenuOnOpenRef.current) {
      focusSubmenuOnOpenRef.current = false;
      const activeOption = submenu.querySelector<HTMLButtonElement>(".composer-thinking-item.is-selected:not(:disabled)")
        ?? submenu.querySelector<HTMLButtonElement>(".composer-thinking-item:not(:disabled)");
      activeOption?.focus({ preventScroll: true });
    }
    const observer = new ResizeObserver(placeSubmenu);
    observer.observe(submenu);
    return () => observer.disconnect();
  }, [submenuKey, submenuEntry, placeSubmenu]);

  useEffect(() => {
    const containsTarget = (target: EventTarget | null) => {
      if (!(target instanceof Node)) return false;
      if (triggerRef.current?.contains(target)) return true;
      if (menuRef.current?.contains(target)) return true;
      if (submenuRef.current?.contains(target)) return true;
      return false;
    };
    const onOutsidePointer = (event: Event) => {
      if (!containsTarget(event.target)) onClose(false);
    };
    const onScroll = (event: Event) => {
      if (!containsTarget(event.target)) {
        onClose(false);
      }
    };
    const onResize = () => onClose(false);
    window.addEventListener("pointerdown", onOutsidePointer, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("contextmenu", onOutsidePointer, true);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("pointerdown", onOutsidePointer, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("contextmenu", onOutsidePointer, true);
      window.removeEventListener("resize", onResize);
    };
  }, [triggerRef, onClose]);

  const isHeadingTowardSubmenu = useCallback((currX: number, currY: number): boolean => {
    const prev = lastPointerRef.current;
    const submenu = submenuRef.current;
    const menu = menuRef.current;
    if (!prev || !submenu || !menu) return false;
    const subRect = submenu.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const edgeX = subRect.left >= menuRect.left ? subRect.left : subRect.right;
    if (Math.abs(currX - edgeX) >= Math.abs(prev.x - edgeX)) return false;
    return pointInTriangle(
      currX, currY,
      prev.x, prev.y,
      edgeX, subRect.top - 14,
      edgeX, subRect.bottom + 14,
    );
  }, []);

  const scheduleSubmenuUpdate = useCallback((nextKey: string | null, immediate = false) => {
    clearSubmenuTimer();
    if (immediate) {
      setSubmenuKey(nextKey);
      return;
    }
    submenuTimerRef.current = window.setTimeout(() => {
      submenuTimerRef.current = null;
      setSubmenuKey(nextKey);
    }, nextKey === null ? SUBMENU_CLOSE_DELAY_MS : HOVER_INTENT_DELAY_MS);
  }, [clearSubmenuTimer]);

  const handleRowPointerEnter = (entry: PickerModelEntry, event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.pointerType === "touch") return;
    const nextSubmenu = entry.thinkingLevels.length > 1 ? entry.key : null;
    if (nextSubmenu === submenuKey) {
      clearSubmenuTimer();
      return;
    }
    if (submenuKey && isHeadingTowardSubmenu(event.clientX, event.clientY)) {
      scheduleSubmenuUpdate(nextSubmenu, false);
    } else {
      scheduleSubmenuUpdate(nextSubmenu, true);
    }
  };

  const handleSelect = useCallback(async (modelKey: string, explicitThinkingLevel?: ThinkingLevel, fromKeyboard = false) => {
    if (!context) return;
    onClose(fromKeyboard);
    onNoticeClear?.();

    const switchingModel = modelKey !== currentModel;
    const switchingThinking = explicitThinkingLevel !== undefined && explicitThinkingLevel !== currentThinkingLevel;
    if (!switchingModel && !switchingThinking) return;

    if ((switchingModel && modelEnvOverride) || (switchingThinking && thinkingEnvOverride)) {
      onError?.(t("此配置由环境变量覆盖，请先移除环境变量。"));
      return;
    }

    const previewModel = catalog?.models.find(item => `${item.provider}/${item.id}` === modelKey);
    const optimisticThinking: ThinkingLevel = explicitThinkingLevel
      ?? (switchingModel && previewModel && !thinkingEnvOverride
        ? defaultUnchosenThinkingLevel(previewModel)
        : currentThinkingLevel);

    const saveGen = ++saveGenerationRef.current;
    const startedScope = scopeKey;
    const startedSettings = settingsKey;
    onOptimisticChange({ model: modelKey, thinkingLevel: optimisticThinking });
    try {
      const fresh = await providerAuth.catalog();
      if (!selectorMountedRef.current || saveGen !== saveGenerationRef.current ||
          scopeIdentityRef.current !== startedScope || settingsIdentityRef.current !== startedSettings) {
        return;
      }

      let patch: RoleModelConfig;
      if (!switchingModel) {
        const current = fresh.models.find(item => `${item.provider}/${item.id}` === modelKey);
        const supported = current?.thinkingLevels;
        if (!supported?.length) {
          throw new Error(t("无法读取当前模型的思考等级，请刷新 Provider 配置。"));
        }
        if (!explicitThinkingLevel || !supported.includes(explicitThinkingLevel)) {
          throw new Error(t("当前模型不支持此思考等级。"));
        }
        patch = { model: currentModel, thinkingLevel: explicitThinkingLevel };
      } else {
        const selected = availableCatalogModels(fresh).find(item => `${item.provider}/${item.id}` === modelKey);
        if (!selected) {
          throw new Error(t("请选择唯一且可用的 provider/model。"));
        }
        if (explicitThinkingLevel !== undefined) {
          if (!selected.thinkingLevels.includes(explicitThinkingLevel)) {
            throw new Error(t("当前模型不支持此思考等级。"));
          }
          patch = { model: modelKey, thinkingLevel: explicitThinkingLevel };
        } else if (thinkingEnvOverride) {
          const next = normalizeModelThinkingLevels(
            updateRoleModelConfig(baseConfig ?? context.config, role, {
              model: modelKey,
              thinkingLevel: currentThinkingLevel,
            }),
            fresh,
          );
          patch = roleModelConfig(next, role);
        } else {
          patch = {
            model: modelKey,
            thinkingLevel: defaultUnchosenThinkingLevel(selected),
          };
        }
      }

      await context.save({ runId, node: modelNode, role }, patch);
    } catch (error) {
      if (selectorMountedRef.current && saveGen === saveGenerationRef.current && scopeIdentityRef.current === startedScope) {
        onError?.(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (selectorMountedRef.current && saveGen === saveGenerationRef.current) {
        onOptimisticChange(null);
      }
    }
  }, [
    context,
    catalog,
    onClose,
    onNoticeClear,
    currentModel,
    currentThinkingLevel,
    modelEnvOverride,
    thinkingEnvOverride,
    onError,
    saveGenerationRef,
    scopeKey,
    settingsKey,
    onOptimisticChange,
    selectorMountedRef,
    scopeIdentityRef,
    settingsIdentityRef,
    baseConfig,
    role,
    runId,
    modelNode,
  ]);

  const handleRowClick = (entry: PickerModelEntry, fromKeyboard = false) => {
    const isCurrent = entry.key === currentModel;
    const hasSubmenu = entry.thinkingLevels.length > 1;
    const isTouch = !fromKeyboard && lastPointerTypeRef.current === "touch";

    if (entry.hiddenCurrent) {
      if (hasSubmenu) {
        clearSubmenuTimer();
        focusSubmenuOnOpenRef.current = true;
        setSubmenuKey(entry.key);
      }
      return;
    }
    if (isCurrent) {
      if (hasSubmenu) {
        clearSubmenuTimer();
        focusSubmenuOnOpenRef.current = true;
        setSubmenuKey(entry.key);
      } else {
        onClose(fromKeyboard);
      }
      return;
    }
    if (isTouch && hasSubmenu && submenuKey !== entry.key) {
      clearSubmenuTimer();
      setSubmenuKey(entry.key);
      return;
    }
    void handleSelect(entry.key, undefined, fromKeyboard);
  };

  const handleMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose(true);
      return;
    }
    if (event.key === "Tab") {
      event.stopPropagation();
      onClose(true);
      return;
    }
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>(".composer-model-item:not(:disabled)") ?? [],
    );
    if (items.length === 0) return;
    const currentIdx = items.indexOf(document.activeElement as HTMLButtonElement);

    if (event.key === "ArrowRight") {
      const focused = items[currentIdx];
      const key = focused?.getAttribute("data-entry-key");
      const target = key ? entries.find(item => item.key === key) : undefined;
      if (target && target.thinkingLevels.length > 1) {
        event.preventDefault();
        event.stopPropagation();
        clearSubmenuTimer();
        focusSubmenuOnOpenRef.current = true;
        setSubmenuKey(target.key);
      }
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const next = event.key === "Home"
      ? 0
      : event.key === "End"
        ? items.length - 1
        : (currentIdx + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next]?.scrollIntoView({ block: "nearest" });
    items[next]?.focus({ preventScroll: true });
  };

  const handleSubmenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowLeft" || event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      const parentKey = submenuKey;
      clearSubmenuTimer();
      setSubmenuKey(null);
      if (parentKey) {
        rowRefs.current.get(parentKey)?.focus({ preventScroll: true });
      }
      return;
    }
    if (event.key === "Tab") {
      event.stopPropagation();
      onClose(true);
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const items = Array.from(
      submenuRef.current?.querySelectorAll<HTMLButtonElement>(".composer-thinking-item:not(:disabled)") ?? [],
    );
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home"
      ? 0
      : event.key === "End"
        ? items.length - 1
        : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next]?.focus({ preventScroll: true });
  };

  const allHidden = Boolean(
    catalog &&
    availableModels.length === 0 &&
    catalog.models.some(item => item.available),
  );

  return (
    <>
      {createPortal(
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          tabIndex={-1}
          aria-label={t("选择模型")}
          className={`composer-model-menu${compact ? " is-compact" : ""}`}
          data-testid="composer-model-menu"
          data-placement={menuPos.placement}
          style={{ left: menuPos.left, top: menuPos.top, maxHeight: menuPos.maxHeight }}
          onClick={event => event.stopPropagation()}
          onContextMenu={event => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onPointerMove={event => {
            lastPointerRef.current = { x: event.clientX, y: event.clientY };
          }}
          onPointerLeave={event => {
            if (event.pointerType === "touch") return;
            scheduleSubmenuUpdate(null, false);
          }}
          onKeyDown={handleMenuKeyDown}
        >
          <div
            ref={listRef}
            className="composer-model-list"
            onScroll={placeSubmenu}
          >
            {catalogLoading && entries.length === 0 ? (
              <div className="composer-model-empty" role="status">
                <span>{t("正在加载可用模型…")}</span>
              </div>
            ) : catalogError && entries.length === 0 ? (
              <div className="composer-model-empty" role="status">
                <span>{catalogError}</span>
                <button
                  type="button"
                  className="composer-model-empty-action"
                  onClick={() => loadCatalog(true)}
                >
                  {t("重试")}
                </button>
              </div>
            ) : entries.length === 0 ? (
              <div className="composer-model-empty" role="status">
                <span>
                  {allHidden
                    ? t("所有可用模型均已隐藏，可在管理可见模型中恢复显示。")
                    : t("暂无可用模型")}
                </span>
                {allHidden && onOpenScopedModels && (
                  <button
                    type="button"
                    className="composer-model-empty-action"
                    onClick={() => {
                      onClose(false);
                      onOpenScopedModels();
                    }}
                  >
                    {t("管理可见模型")}
                  </button>
                )}
              </div>
            ) : (
              entries.map(entry => {
                const isSelected = entry.key === currentModel;
                const hasSubmenu = entry.thinkingLevels.length > 1;
                const isSubmenuOpen = submenuKey === entry.key && hasSubmenu;
                const itemDisabled = entry.hiddenCurrent
                  ? (!hasSubmenu || thinkingEnvOverride)
                  : (!isSelected && modelEnvOverride);

                return (
                  <React.Fragment key={entry.hiddenCurrent ? `__hidden__:${entry.key}` : entry.key}>
                    <button
                      ref={el => {
                        if (el) rowRefs.current.set(entry.key, el);
                        else rowRefs.current.delete(entry.key);
                      }}
                      type="button"
                      role="menuitem"
                      tabIndex={-1}
                      disabled={itemDisabled}
                      aria-haspopup={hasSubmenu ? "menu" : undefined}
                      aria-expanded={hasSubmenu ? isSubmenuOpen : undefined}
                      aria-controls={isSubmenuOpen ? submenuId : undefined}
                      data-entry-key={entry.key}
                      data-model-key={entry.hiddenCurrent ? undefined : entry.key}
                      data-submenu-open={isSubmenuOpen ? "true" : undefined}
                      className={`composer-model-item${isSelected ? " is-selected" : ""}`}
                      onPointerDown={event => {
                        lastPointerTypeRef.current = event.pointerType || "mouse";
                      }}
                      onPointerEnter={event => handleRowPointerEnter(entry, event)}
                      onClick={event => handleRowClick(entry, event.detail === 0)}
                    >
                      <span className="composer-model-item-name">{entry.displayName}</span>
                      <span className="composer-model-item-meta">
                        {isSelected && (
                          <Check size={13} className="composer-model-item-check" aria-hidden="true" />
                        )}
                        {hasSubmenu && (
                          <ChevronRight size={13} className="composer-model-item-chevron" aria-hidden="true" />
                        )}
                      </span>
                    </button>
                    {entry.hiddenCurrent && entries.length > 1 && (
                      <div className="composer-model-divider" role="separator" />
                    )}
                  </React.Fragment>
                );
              })
            )}
          </div>
        </div>,
        document.body,
      )}

      {submenuEntry && submenuEntry.thinkingLevels.length > 1 && createPortal(
        <div
          ref={submenuRef}
          id={submenuId}
          role="menu"
          aria-label={t("思维等级")}
          className={`composer-thinking-submenu${compact ? " is-compact" : ""}`}
          data-testid="composer-thinking-submenu"
          data-side={submenuPos.side}
          data-model-key={submenuEntry.hiddenCurrent ? undefined : submenuEntry.key}
          style={{ left: submenuPos.left, top: submenuPos.top }}
          onClick={event => event.stopPropagation()}
          onContextMenu={event => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onPointerEnter={clearSubmenuTimer}
          onPointerLeave={event => {
            if (event.pointerType === "touch") return;
            scheduleSubmenuUpdate(null, false);
          }}
          onKeyDown={handleSubmenuKeyDown}
        >
          <div className="composer-thinking-list">
            {submenuEntry.thinkingLevels.map(level => {
              const isSelectedLevel =
                submenuEntry.key === currentModel && currentThinkingLevel === level;
              const levelDisabled =
                thinkingEnvOverride ||
                (submenuEntry.key !== currentModel && modelEnvOverride);
              return (
                <button
                  key={level}
                  type="button"
                  role="menuitemradio"
                  tabIndex={-1}
                  aria-checked={isSelectedLevel}
                  disabled={levelDisabled}
                  data-thinking-level={level}
                  className={`composer-thinking-item${isSelectedLevel ? " is-selected" : ""}`}
                  onClick={event => { void handleSelect(submenuEntry.key, level, event.detail === 0); }}
                >
                  <span>{thinkingLevelLabel(level)}</span>
                  {isSelectedLevel && (
                    <Check size={13} className="composer-thinking-item-check" aria-hidden="true" />
                  )}
                </button>
              );
            })}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
