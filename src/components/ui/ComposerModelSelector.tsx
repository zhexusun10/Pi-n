import { Suspense, lazy, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { t } from "../../i18n";
import {
  normalizeModelThinkingLevels,
  providerIdForModel,
  roleModelConfig,
  updateRoleModelConfig,
} from "../../modelConfig";
import { ComposerModels } from "../../services/composerCommands";
import { providerAuth } from "../../services/providerAuth";
import type { ModelRole, RoleModelConfig, ThinkingLevel } from "../../types";
import "./composer-model-selector.css";

const loadComposerModelMenu = () => import("./ComposerModelMenu");
const LazyComposerModelMenu = lazy(loadComposerModelMenu);

interface ComposerModelSelectorProps {
  runId?: string;
  node?: string;
  planMode?: "auto" | "serial" | "graph";
  conversationModel?: boolean;
  isMerger?: boolean;
  compact?: boolean;
  disabled?: boolean;
  onOpenScopedModels?: () => void;
  onError?: (message: string) => void;
  onNoticeClear?: () => void;
}

export function ComposerModelSelector({
  runId,
  node,
  planMode,
  conversationModel,
  isMerger = false,
  compact = false,
  disabled = false,
  onOpenScopedModels,
  onError,
  onNoticeClear,
}: ComposerModelSelectorProps) {
  const context = useContext(ComposerModels);
  const catalog = useSyncExternalStore(
    providerAuth.subscribeCatalog,
    providerAuth.getCachedCatalog,
    () => null,
  );
  const menuId = useId();

  const role: ModelRole = node || (planMode ?? context?.snapshot.planType) === "serial" ? "nodeAgent" : "planner";
  const modelNode = conversationModel || isMerger ? undefined : node;
  const isProvisionalRun = Boolean(runId && runId.startsWith("pending-"));
  const effectiveDisabled = disabled || isProvisionalRun || isMerger;

  const baseConfig = useMemo(() => {
    if (!context) return undefined;
    if (modelNode && context.snapshot.nodes[modelNode]?.modelOverride && context.snapshot.nodes[modelNode]?.modelConfig) {
      return updateRoleModelConfig(context.config, role, context.snapshot.nodes[modelNode].modelConfig!);
    }
    return context.config;
  }, [context, modelNode, role]);

  const normalizedConfig = useMemo(
    () => (baseConfig ? normalizeModelThinkingLevels(baseConfig, catalog ?? undefined) : undefined),
    [baseConfig, catalog],
  );

  const envOverrides = context?.envOverrides ?? {};
  const authoritativeSettings = useMemo(() => {
    if (!normalizedConfig) return { model: "", thinkingLevel: "low" as ThinkingLevel };
    const resolved = roleModelConfig(normalizedConfig, role, envOverrides);
    if (isMerger) {
      return {
        model: envOverrides.merger?.trim() || resolved.model,
        thinkingLevel: (envOverrides.mergerThinking?.trim() as ThinkingLevel | undefined) || resolved.thinkingLevel,
      };
    }
    return resolved;
  }, [normalizedConfig, role, envOverrides, isMerger]);

  const scopeKey = JSON.stringify([runId, modelNode, role, isMerger]);
  const scopeIdentityRef = useRef(scopeKey);
  scopeIdentityRef.current = scopeKey;
  const settingsKey = JSON.stringify([
    authoritativeSettings.model,
    authoritativeSettings.thinkingLevel,
    envOverrides[role],
    envOverrides[`${role}Thinking`],
  ]);
  const settingsIdentityRef = useRef(settingsKey);
  settingsIdentityRef.current = settingsKey;

  const [open, setOpen] = useState(false);
  const [optimistic, setOptimistic] = useState<{ scope: string; settings: Required<RoleModelConfig> } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const mountedRef = useRef(true);
  const saveGenerationRef = useRef(0);

  const settings = optimistic && optimistic.scope === scopeKey
    ? optimistic.settings
    : authoritativeSettings;

  const currentCatalogModel = useMemo(
    () => catalog?.models.find(item => `${item.provider}/${item.id}` === settings.model),
    [catalog, settings.model],
  );
  const isCurrentHidden = Boolean(
    settings.model && (
      catalog?.hiddenModels?.includes(settings.model) ||
      Boolean(currentCatalogModel?.hidden)
    ),
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const closeMenu = useCallback((restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus && triggerRef.current?.isConnected) {
      triggerRef.current.focus({ preventScroll: true });
    }
  }, []);

  useEffect(() => {
    saveGenerationRef.current += 1;
    setOptimistic(null);
    setOpen(false);
  }, [scopeKey]);

  useEffect(() => {
    if (effectiveDisabled && open) {
      setOpen(false);
    }
  }, [effectiveDisabled, open]);

  if (!context) return null;

  const displayName = (() => {
    if (isCurrentHidden) return t("当前已选模型已隐藏");
    if (currentCatalogModel) return currentCatalogModel.name || currentCatalogModel.id;
    if (settings.model) {
      const providerId = providerIdForModel(settings.model, catalog?.providers ?? []);
      if (providerId && settings.model.startsWith(`${providerId}/`)) {
        return settings.model.slice(providerId.length + 1) || settings.model;
      }
      return settings.model;
    }
    return t("选择模型");
  })();

  const currentLevels = currentCatalogModel?.thinkingLevels ?? [];
  const showThinkingBadge = Boolean(settings.model) && (
    currentLevels.length > 1 ||
    (currentLevels.length === 1
      ? currentLevels[0] !== "off"
      : Boolean(settings.thinkingLevel && settings.thinkingLevel !== "off"))
  );

  const triggerAriaLabel = settings.model
    ? t(
        "选择模型与思维等级：{0}",
        `${displayName}${showThinkingBadge ? ` (${settings.thinkingLevel})` : ""}`,
      )
    : t("选择模型与思维等级");

  return (
    <div className="prompt-box-model-picker">
      <button
        ref={triggerRef}
        type="button"
        className={`prompt-box-model-trigger${!settings.model ? " is-placeholder" : ""}${isCurrentHidden ? " is-hidden-model" : ""}`}
        data-testid="composer-model-selector"
        data-model-role={role}
        data-model-node={modelNode || undefined}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={triggerAriaLabel}
        disabled={effectiveDisabled}
        onPointerEnter={() => { if (!effectiveDisabled) void loadComposerModelMenu(); }}
        onFocus={() => { if (!effectiveDisabled) void loadComposerModelMenu(); }}
        onClick={(event) => {
          event.stopPropagation();
          if (effectiveDisabled) return;
          if (open) {
            closeMenu(false);
          } else {
            onNoticeClear?.();
            setOpen(true);
          }
        }}
        onKeyDown={(event) => {
          if (effectiveDisabled) return;
          if (!open && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
            event.preventDefault();
            event.stopPropagation();
            onNoticeClear?.();
            setOpen(true);
          }
        }}
      >
        <span className="prompt-box-model-trigger-name">{displayName}</span>
        {showThinkingBadge && (
          <>
            <span className="prompt-box-model-trigger-sep" aria-hidden="true">·</span>
            <span className="prompt-box-model-trigger-level">{settings.thinkingLevel}</span>
          </>
        )}
      </button>

      {open && (
        <Suspense fallback={null}>
          <LazyComposerModelMenu
            triggerRef={triggerRef}
            menuId={menuId}
            catalog={catalog}
            role={role}
            runId={runId}
            modelNode={modelNode}
            isMerger={isMerger}
            baseConfig={baseConfig}
            currentModel={settings.model}
            currentThinkingLevel={settings.thinkingLevel}
            currentModelThinkingLevels={currentLevels}
            isCurrentHidden={isCurrentHidden}
            compact={compact}
            scopeKey={scopeKey}
            settingsKey={settingsKey}
            scopeIdentityRef={scopeIdentityRef}
            settingsIdentityRef={settingsIdentityRef}
            selectorMountedRef={mountedRef}
            saveGenerationRef={saveGenerationRef}
            onOptimisticChange={next => setOptimistic(next ? { scope: scopeKey, settings: next } : null)}
            onError={onError}
            onNoticeClear={onNoticeClear}
            onClose={closeMenu}
            onOpenScopedModels={onOpenScopedModels}
          />
        </Suspense>
      )}
    </div>
  );
}
