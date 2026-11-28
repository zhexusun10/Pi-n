import { useCallback, useRef } from "react";
import { t } from "../i18n";
import { applyModelConfig, updateRoleModelConfig } from "../modelConfig";
import { type ComposerScope } from "../services/composerCommands";
import { runtimeService } from "../services/runtime";
import { readStorageJson, STORAGE_KEYS, writeStorageJson, writeStorageString } from "../services/appStorage";
import { normalizeWorkspacePath, snapshotBelongsToWorkspace } from "../services/workspaceConversations";
import {
  type Config,
  type ConversationModelConfig,
  type RoleModelConfig,
  type Snapshot,
  normalizeMaxFeedback,
  normalizeMaxParallel,
} from "../types";

export interface UseConfigPersistenceOptions {
  config: Config;
  setConfig: React.Dispatch<React.SetStateAction<Config>>;
  defaultSettings: Config;
  setDefaultSettings: React.Dispatch<React.SetStateAction<Config>>;
  acceptedSettingsRef: React.MutableRefObject<Config | null>;
  isBootstrapReady: boolean;
  setIsBootstrapReady: React.Dispatch<React.SetStateAction<boolean>>;
  stateRunId: string;
  displayedRunIdRef: React.MutableRefObject<string>;
  foregroundGeneration: React.MutableRefObject<number>;
  navigationPending: boolean;
  detachForeground: (repository: string) => void;
  setComposerSnapshot: (snapshot: Snapshot) => void;
  observeRunSnapshot: (snapshot: Snapshot) => void;
  snapshotModelConfig: (snapshot: Snapshot | null | undefined, repository: string) => ConversationModelConfig | null;
  setDataPath: React.Dispatch<React.SetStateAction<string>>;
  setEnvOverrides: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  setModal: (modal: "settings" | "editor" | "approval" | null) => void;
  setError: React.Dispatch<React.SetStateAction<string>>;
}

/**
 * Owns Settings modal read/save and home/composer model persistence with
 * explicit async generation tokens so stale reads/writes never overwrite newer
 * selections or active conversations.
 */
export function useConfigPersistence({
  config,
  setConfig,
  defaultSettings,
  setDefaultSettings,
  acceptedSettingsRef,
  isBootstrapReady,
  setIsBootstrapReady,
  stateRunId,
  displayedRunIdRef,
  foregroundGeneration,
  navigationPending,
  detachForeground,
  setComposerSnapshot,
  observeRunSnapshot,
  snapshotModelConfig,
  setDataPath,
  setEnvOverrides,
  setModal,
  setError,
}: UseConfigPersistenceOptions) {
  const settingsReadGeneration = useRef(0);
  const defaultSaveGeneration = useRef(0);
  const configSaveQueue = useRef(Promise.resolve());
  const lastSavedDefaults = useRef<Config | null>(null);

  // save_config replaces a full profile. Wait for each request to settle
  // before sending the next so acknowledged writes follow selection order.
  const saveConfigInOrder = useCallback((buildConfig: (saved: Config | null) => Config, runId?: string) => {
    const write = configSaveQueue.current.then(async () => {
      const boot = await runtimeService.saveConfig(buildConfig(lastSavedDefaults.current), runId);
      lastSavedDefaults.current = boot.config;
      return boot;
    });
    configSaveQueue.current = write.then(() => undefined, () => undefined);
    return write;
  }, []);

  const handleOpenSettings = useCallback(() => {
    // Settings belongs to the currently validated conversation. Opening it
    // supersedes an unfinished navigation, not the conversation it displays.
    if (navigationPending) detachForeground(config.repository);
    const runId = stateRunId;
    const generation = foregroundGeneration.current;
    const readGeneration = ++settingsReadGeneration.current;
    setModal("settings");
    if (runId && !runId.startsWith("pending-")) {
      void (async () => {
        try {
          const snapshot = await runtimeService.snapshotForRun(runId);
          if (generation !== foregroundGeneration.current || readGeneration !== settingsReadGeneration.current) return;
          if (snapshot.runId === runId && snapshotBelongsToWorkspace(snapshot, config.repository)) {
            const conversationConfig = snapshotModelConfig(snapshot, config.repository);
            if (conversationConfig) {
              setConfig((prev) => applyModelConfig(prev, conversationConfig));
            }
          }
        } catch {
          // Opening Settings must remain available when a snapshot read fails.
        }
      })();
    }
  }, [
    config.repository,
    detachForeground,
    foregroundGeneration,
    navigationPending,
    setConfig,
    setModal,
    snapshotModelConfig,
    stateRunId,
  ]);

  const handleCloseSettings = useCallback(() => {
    settingsReadGeneration.current += 1;
    setModal(null);
  }, [setModal]);

  const handleSaveConfig = useCallback(async (draftConfig: Config): Promise<boolean> => {
    settingsReadGeneration.current += 1;
    const saveGeneration = ++defaultSaveGeneration.current;
    const generation = foregroundGeneration.current;
    // Settings change models/defaults, not the selected workspace. Rediscovery
    // or Git status here can stall saving behind an unrelated large tree scan.
    const repoPath = normalizeWorkspacePath(config.repository.trim());
    if (generation !== foregroundGeneration.current) return false;
    const nextConfig = {
      ...draftConfig,
      repository: repoPath,
      maxFeedback: normalizeMaxFeedback(draftConfig.maxFeedback),
      maxParallel: normalizeMaxParallel(draftConfig.maxParallel),
    };
    let persistedDefaults: Config;
    try {
      // Settings always owns the Run profile, regardless of selected node.
      // Outside a Run it edits the global defaults for new conversations.
      const boot = await saveConfigInOrder(() => nextConfig, stateRunId || undefined);
      if (generation !== foregroundGeneration.current || saveGeneration !== defaultSaveGeneration.current) return false;
      if (boot.snapshot?.runId === stateRunId && stateRunId) {
        if (snapshotBelongsToWorkspace(boot.snapshot, config.repository)) {
          setComposerSnapshot(boot.snapshot);
          observeRunSnapshot(boot.snapshot);
        }
      }
      if (boot.dataPath) {
        const cleanDataPath = normalizeWorkspacePath(boot.dataPath);
        setDataPath(cleanDataPath);
        writeStorageString(STORAGE_KEYS.dataPath, cleanDataPath);
      }
      if (boot.envOverrides) setEnvOverrides(boot.envOverrides);
      persistedDefaults = {
        ...boot.config,
        maxFeedback: normalizeMaxFeedback(boot.config.maxFeedback),
        maxParallel: normalizeMaxParallel(boot.config.maxParallel),
      };
      setDefaultSettings(persistedDefaults);
    } catch (error) {
      throw new Error(t("保存设置失败：{0}", String(error)));
    }
    // Commit the browser draft only after acceptance. A timeout does not prove
    // the server write was rolled back; its error asks the user to verify first.
    acceptedSettingsRef.current = nextConfig;
    setConfig(nextConfig);
    setIsBootstrapReady(true);
    writeStorageJson(STORAGE_KEYS.config, applyModelConfig(nextConfig, persistedDefaults));
    // Saving settings never touches the workspace list or its order.
    setModal(null);
    setError("");
    return true;
  }, [
    acceptedSettingsRef,
    config.repository,
    foregroundGeneration,
    observeRunSnapshot,
    saveConfigInOrder,
    setConfig,
    setDataPath,
    setDefaultSettings,
    setEnvOverrides,
    setError,
    setIsBootstrapReady,
    setModal,
    setComposerSnapshot,
    stateRunId,
  ]);

  const saveComposerModels = useCallback(async (scope: ComposerScope, settings: RoleModelConfig) => {
    if (!isBootstrapReady) throw new Error(t("正在加载后端设置，请稍后重试；若加载失败，请在侧边栏重试。"));
    const generation = foregroundGeneration.current;
    if (scope.runId !== (stateRunId || undefined) || displayedRunIdRef.current !== stateRunId) {
      throw new Error(t("会话已切换，请重试。"));
    }
    settingsReadGeneration.current += 1;
    if (!scope.runId) {
      // The home composer's choice is remembered as the default for new
      // conversations, across restarts. Apply immediately so submitting a new
      // conversation before `saveConfig` returns uses the chosen model, and
      // keep global defaults/localStorage synced even if the user navigates
      // into that conversation while persistence is in flight.
      const saveGeneration = ++defaultSaveGeneration.current;
      setConfig((previous) => updateRoleModelConfig(previous, scope.role, settings));
      let boot: Awaited<ReturnType<typeof runtimeService.saveConfig>>;
      try {
        // Apply only this role's change to the last acknowledged defaults.
        // The visible config can still contain a rejected optimistic choice.
        boot = await saveConfigInOrder(saved => updateRoleModelConfig(
          { ...(saved ?? defaultSettings), repository: config.repository }, scope.role, settings,
        ));
      } catch (error) {
        if (
          generation === foregroundGeneration.current &&
          displayedRunIdRef.current === stateRunId &&
          saveGeneration === defaultSaveGeneration.current
        ) {
          const savedDefaults = lastSavedDefaults.current ?? defaultSettings;
          setConfig((previous) => applyModelConfig(previous, savedDefaults));
        }
        throw error;
      }
      const persisted = {
        ...boot.config,
        maxFeedback: normalizeMaxFeedback(boot.config.maxFeedback),
        maxParallel: normalizeMaxParallel(boot.config.maxParallel),
      };
      acceptedSettingsRef.current = persisted;
      setDefaultSettings(persisted);
      const storedConfig = readStorageJson(STORAGE_KEYS.config);
      writeStorageJson(
        STORAGE_KEYS.config,
        applyModelConfig({ ...persisted, ...storedConfig, repository: storedConfig?.repository ?? config.repository }, persisted),
      );
      if (
        saveGeneration === defaultSaveGeneration.current &&
        generation === foregroundGeneration.current &&
        displayedRunIdRef.current === stateRunId
      ) {
        setConfig((previous) => applyModelConfig(previous, persisted));
      }
      return;
    }
    const snapshot = await runtimeService.composerModels({ ...scope, settings });
    if (generation !== foregroundGeneration.current || displayedRunIdRef.current !== scope.runId) return;
    setComposerSnapshot(snapshot);
    observeRunSnapshot(snapshot);
    if (!scope.node) {
      setConfig((previous) => applyModelConfig(previous, snapshotModelConfig(snapshot, config.repository)));
    }
  }, [
    acceptedSettingsRef,
    config,
    defaultSettings,
    displayedRunIdRef,
    foregroundGeneration,
    isBootstrapReady,
    observeRunSnapshot,
    saveConfigInOrder,
    setComposerSnapshot,
    setConfig,
    setDefaultSettings,
    snapshotModelConfig,
    stateRunId,
  ]);

  return {
    handleOpenSettings,
    handleCloseSettings,
    handleSaveConfig,
    saveComposerModels,
  };
}
