import { t, localizeError, languagePreference, restartFrontendWithLanguage, type LanguagePreference } from "../../i18n";
import React, { useEffect, useRef, useState, useId } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useIsPresent, useReducedMotion } from "motion/react";
import { RotateCcw, Terminal, Check, X, Copy, GitBranch, Languages, RefreshCw, Wallpaper, AlertTriangle, Info } from "lucide-react";
import { Config, MAX_MAX_FEEDBACK, MAX_MAX_PARALLEL, MIN_MAX_FEEDBACK, MIN_MAX_PARALLEL, normalizeMaxFeedback, normalizeMaxParallel } from "../../types";
import { normalizeModelThinkingLevels } from "../../modelConfig";
import { providerAuth, type ProviderCatalog } from "../../services/providerAuth";
import { ProviderSettings } from "../ProviderSettings";
import { RoleModelSettings } from "../RoleModelSettings";
import { ExtensionSettings } from "../ExtensionSettings";
import { AutostartSettings } from "../AutostartSettings";
import { UpdateSettings } from "../UpdateSettings";
import { normalizeWorkspacePath } from "../../services/workspaceConversations";
import { autoExpandCotEnabled, setAutoExpandCot, executionOverviewEnabled, setExecutionOverview, currentLandingBackground, setLandingBackground, currentAccentColor, setAccentColor, completionNotificationsEnabled, setCompletionNotifications, completionNotificationSoundEnabled, setCompletionNotificationSound } from "../../services/displayPreferences";
import {
  getNotificationPermissionStatus,
  openDesktopNotificationSettings,
  requestBrowserNotificationPermission,
  type NotificationPermissionState,
} from "../../services/completionNotifications";
import { isTauriDesktop } from "../../services/apiBase";
import { copyTextToClipboard } from "../../services/externalLink";
import { DotPattern } from "../ui/dot-pattern";
import { ConfirmModal } from "./ConfirmModal";
import { dialogVeilMotion, largeDialogMotion } from "./dialogMotion";
import { useDialogFocus } from "../../hooks/useDialogFocus";

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  config: Config;
  dataPath: string;
  envOverrides?: Record<string, string>;
  conversationScoped?: boolean;
  onSaveConfig: (config: Config) => void | Promise<boolean>;
}

let cachedDesktopNotificationPermission: NotificationPermissionState | null = null;

export const SettingsModal: React.FC<SettingsModalProps> = React.memo(({
  isOpen,
  onClose,
  config,
  dataPath,
  envOverrides,
  conversationScoped = false,
  onSaveConfig,
}) => {
  const reduceMotion = useReducedMotion();
  const titleId = useId();
  const [draftConfig, setDraftConfig] = useState(() => ({ ...config }));
  const [autoApprove, setAutoApprove] = useState(config.autoApprove ?? true);
  const [postTaskReview, setPostTaskReview] = useState(config.postTaskReview ?? true);
  const [plannerWriteTools, setPlannerWriteTools] = useState(config.plannerWriteTools ?? true);
  const [isolateParallelNodes, setIsolateParallelNodes] = useState(config.isolateParallelNodes ?? true);
  const [maxParallelInput, setMaxParallelInput] = useState(() => String(normalizeMaxParallel(config.maxParallel)));
  const [maxFeedbackInput, setMaxFeedbackInput] = useState(() => String(normalizeMaxFeedback(config.maxFeedback)));
  const [feedbackEnabled, setFeedbackEnabled] = useState(config.feedbackEnabled ?? false);
  // Display-only preference, but it follows the same contract as the other
  // toggles: staged here, committed only when the settings save is accepted.
  const [autoExpandCot, setAutoExpandCotDraft] = useState(() => autoExpandCotEnabled());
  const [executionOverview, setExecutionOverviewDraft] = useState(() => executionOverviewEnabled());
  const [landingBackground, setLandingBackgroundDraft] = useState(() => currentLandingBackground());
  const [accentColor, setAccentColorDraft] = useState(() => currentAccentColor());
  const [completionNotifications, setCompletionNotificationsDraft] = useState(() => completionNotificationsEnabled());
  const [completionNotificationSound, setCompletionNotificationSoundDraft] = useState(() => completionNotificationSoundEnabled());
  const [desktopNotificationPermission, setDesktopNotificationPermission] = useState<NotificationPermissionState | null>(
    () => (isTauriDesktop() ? cachedDesktopNotificationPermission : null),
  );
  const [requestingNotificationPermission, setRequestingNotificationPermission] = useState(false);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [saveError, setSaveError] = useState("");
  // The modal mounts before the background Run re-read finishes, so it can
  // briefly hold a stale conversation config. Adopt the refreshed config while
  // the draft is untouched; once the user edits, their draft wins.
  const dirtyRef = useRef(false);
  const syncedConfigRef = useRef(config);
  const markDirty = () => { dirtyRef.current = true; };
  const updateDraftConfig: React.Dispatch<React.SetStateAction<Config>> = (action) => {
    dirtyRef.current = true;
    setDraftConfig(action);
  };
  useEffect(() => {
    if (config === syncedConfigRef.current) return;
    syncedConfigRef.current = config;
    if (dirtyRef.current) return;
    setDraftConfig({ ...config });
    setAutoApprove(config.autoApprove ?? true);
    setPostTaskReview(config.postTaskReview ?? true);
    setPlannerWriteTools(config.plannerWriteTools ?? true);
    setIsolateParallelNodes(config.isolateParallelNodes ?? true);
    setMaxParallelInput(String(normalizeMaxParallel(config.maxParallel)));
    setMaxFeedbackInput(String(normalizeMaxFeedback(config.maxFeedback)));
    setFeedbackEnabled(config.feedbackEnabled ?? false);
  }, [config]);
  const save = async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setSaveError("");
    const maxParallel = normalizeMaxParallel(maxParallelInput);
    const maxFeedback = normalizeMaxFeedback(maxFeedbackInput);
    setMaxParallelInput(String(maxParallel));
    setMaxFeedbackInput(String(maxFeedback));
    try {
      const ok = await onSaveConfig({ ...normalizeModelThinkingLevels(draftConfig, catalog), autoApprove, postTaskReview, plannerWriteTools, isolateParallelNodes, maxParallel, maxFeedback, feedbackEnabled });
      if (ok === false) {
        savingRef.current = false;
        setSaving(false);
        return;
      }
      // The backend accepted the save, so the browser draft may commit too:
      // cancelling or failing the save leaves the stored preference untouched.
      setAutoExpandCot(autoExpandCot);
      setExecutionOverview(executionOverview);
      setLandingBackground(landingBackground);
      setAccentColor(accentColor);
      setCompletionNotifications(completionNotifications);
      setCompletionNotificationSound(completionNotificationSound);
      if (completionNotifications) void requestBrowserNotificationPermission();
    } catch (error) {
      savingRef.current = false;
      setSaving(false);
      setSaveError(String(error));
    }
  };
  const [catalog, setCatalog] = useState<ProviderCatalog | undefined>(() => providerAuth.getCachedCatalog() ?? undefined);
  useEffect(() => providerAuth.subscribeCatalog(() => setCatalog(providerAuth.getCachedCatalog() ?? undefined)), []);
  useEffect(() => {
    if (!isOpen || !isTauriDesktop()) return;
    let cancelled = false;
    const syncPermission = () => {
      void getNotificationPermissionStatus().then((status) => {
        cachedDesktopNotificationPermission = status;
        if (!cancelled) setDesktopNotificationPermission(status);
      });
    };
    syncPermission();
    window.addEventListener("focus", syncPermission);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", syncPermission);
    };
  }, [isOpen]);
  const [catalogBusy, setCatalogBusy] = useState(() => !providerAuth.getCachedCatalog());
  const [pendingLanguage, setPendingLanguage] = useState<LanguagePreference | null>(null);
  const [languageError, setLanguageError] = useState("");
  const languageLabels: Record<LanguagePreference, string> = {
    auto: t("跟随系统"),
    "zh-CN": t("中文"),
    en: t("英文"),
  };

  const dialogRef = useDialogFocus<HTMLElement>({
    open: isOpen,
    onClose: () => { if (!savingRef.current && pendingLanguage === null) onClose(); },
  });
  const isPresent = useIsPresent();
  const wasPresentRef = useRef(isPresent);
  // If the modal is reopened before AnimatePresence finishes its exit
  // animation, React reuses the mounted instance; reset staged drafts so
  // cancelled edits never leak into the new session.
  useEffect(() => {
    const wasPresent = wasPresentRef.current;
    wasPresentRef.current = isPresent;
    if (!wasPresent && isPresent) {
      savingRef.current = false;
      setSaving(false);
      dirtyRef.current = false;
      syncedConfigRef.current = config;
      setDraftConfig({ ...config });
      setAutoApprove(config.autoApprove ?? true);
      setPostTaskReview(config.postTaskReview ?? true);
      setPlannerWriteTools(config.plannerWriteTools ?? true);
      setIsolateParallelNodes(config.isolateParallelNodes ?? true);
      setMaxParallelInput(String(normalizeMaxParallel(config.maxParallel)));
      setMaxFeedbackInput(String(normalizeMaxFeedback(config.maxFeedback)));
      setFeedbackEnabled(config.feedbackEnabled ?? false);
      setAutoExpandCotDraft(autoExpandCotEnabled());
      setExecutionOverviewDraft(executionOverviewEnabled());
      setLandingBackgroundDraft(currentLandingBackground());
      setAccentColorDraft(currentAccentColor());
      setCompletionNotificationsDraft(completionNotificationsEnabled());
      setCompletionNotificationSoundDraft(completionNotificationSoundEnabled());
      setSaveError("");
      setLanguageError("");
      setPendingLanguage(null);
    }
  }, [isPresent, config]);

  if (!isOpen) return null;

  const dialogMotion = largeDialogMotion(reduceMotion);
  const veilMotion = dialogVeilMotion(reduceMotion);

  const content = (
    <div
      className="modal-backdrop subtle-backdrop"
      inert={!isPresent || undefined}
      style={!isPresent ? { pointerEvents: "none" } : undefined}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && isPresent && !savingRef.current && pendingLanguage === null) onClose();
      }}
    >
      {/* Light translucent veil only: a full-screen backdrop-filter forced the
          browser onto a slow compositing path and made even modal scrolling
          janky. Only this layer fades, via a cheap compositor opacity change. */}
      <motion.div
        className="modal-backdrop-tint"
        aria-hidden="true"
        {...veilMotion}
      />
      <motion.section
        className="modal settings-modal surface-modal"
        ref={dialogRef}
        tabIndex={-1}
        inert={pendingLanguage !== null}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={saving}
        {...dialogMotion}
      >
        <header className="settings-modal-header">
          <div className="settings-header-title-wrap">
            <h2 id={titleId}>Settings</h2>
          </div>
          <button type="button" className="icon-button" aria-label={t("关闭弹窗")} disabled={saving} onClick={onClose}>
            <X size={18} />
          </button>
        </header>

        <div className="settings-modal-content">
          <div className="settings-sections">
            <section className="settings-card" aria-labelledby="provider-settings-title">
              <ProviderSettings onCatalogChange={setCatalog} onBusyChange={setCatalogBusy} />
            </section>

            <section className="settings-card" aria-labelledby="role-model-settings-title">
              <div className="settings-card-title">
                <Terminal size={16} />
                <div className="settings-card-title-text">
                  <h4 id="role-model-settings-title">{t("模型配置")}</h4>
                  <span className="settings-card-inline-desc">{conversationScoped
                    ? t("当前编辑此对话的模型配置，仅对当前对话生效。")
                    : t("配置新对话的默认模型，不影响已有对话。")}</span>
                </div>
              </div>
              <RoleModelSettings config={draftConfig} setConfig={updateDraftConfig} catalog={catalog} envOverrides={envOverrides} busy={catalogBusy || saving} />
            </section>

            <ExtensionSettings disabled={saving} />

            <section className="settings-card" aria-labelledby="execution-planning-settings-title">
              <div className="settings-card-title">
                <GitBranch size={16} />
                <h4 id="execution-planning-settings-title">{t("Compile模式设置")}</h4>
              </div>
              <label className="settings-toggle-row">
                <span>
                  <strong>Auto Approve</strong>
                  <small>{t("自动批准执行计划并立即开始运行。")}</small>
                </span>
                <input
                  type="checkbox"
                  checked={autoApprove}
                  disabled={saving}
                  onChange={(event) => { markDirty(); setAutoApprove(event.target.checked); }}
                  aria-label={t("Auto Approve Planner 图纸")}
                />
              </label>
              <label className="settings-toggle-row">
                <span>
                  <strong>{t("任务后 Planner 复盘")}</strong>
                  <small>{t("任务完成后由 Planner 自动复盘结果并推进下一步。")}</small>
                </span>
                <input
                  type="checkbox"
                  checked={postTaskReview}
                  disabled={saving}
                  onChange={(event) => { markDirty(); setPostTaskReview(event.target.checked); }}
                  aria-label={t("任务后 Planner 复盘")}
                />
              </label>
              <label className="settings-toggle-row">
                <span>
                  <strong>{t("并行节点独立工作区")}</strong>
                  <small>{t("多节点大规模并行时自动分配独立工作区，避免并发修改互相冲突。")}</small>
                </span>
                <input
                  type="checkbox"
                  checked={isolateParallelNodes}
                  disabled={saving}
                  onChange={(event) => { markDirty(); setIsolateParallelNodes(event.target.checked); }}
                  aria-label={t("并行节点独立工作区")}
                />
              </label>
              <label className="settings-toggle-row">
                <span>
                  <strong>{t("挂载 Planner write 和 edit 工具")}</strong>
                  <small>{t("允许 Planner 直接编辑项目文件；关闭后仅负责只读分析与规划。")}</small>
                </span>
                <input
                  type="checkbox"
                  checked={plannerWriteTools}
                  disabled={saving}
                  onChange={(event) => { markDirty(); setPlannerWriteTools(event.target.checked); }}
                  aria-label={t("挂载 Planner write 和 edit 工具")}
                />
              </label>
              <label className="settings-toggle-row">
                <span>
                  <strong>{t("启用 Feedback")}</strong>
                  <small>{t("支持在执行图中添加反馈回路，让节点根据下游结果自动返工优化。")}</small>
                </span>
                <input
                  type="checkbox"
                  checked={feedbackEnabled}
                  disabled={saving}
                  onChange={(event) => { markDirty(); setFeedbackEnabled(event.target.checked); }}
                  aria-label={t("启用 Feedback")}
                />
              </label>
              <label className="settings-number-row">
                <span>
                  <strong>{t("可并行 Agent 数量")}</strong>
                  <small>{t("同时运行的 Agent 上限（2–40，默认 20），提升复杂任务的并行速度。")}</small>
                </span>
                <input
                  type="number"
                  min={MIN_MAX_PARALLEL}
                  max={MAX_MAX_PARALLEL}
                  step={1}
                  inputMode="numeric"
                  value={maxParallelInput}
                  disabled={saving}
                  onChange={(event) => {
                    markDirty();
                    setMaxParallelInput(event.target.value);
                  }}
                  onBlur={() => {
                    setMaxParallelInput(String(normalizeMaxParallel(maxParallelInput)));
                  }}
                  aria-label={t("可并行 Agent 数量")}
                />
              </label>
              <label className="settings-number-row">
                <span>
                  <strong>{t("反馈预算")}</strong>
                  <small>{t("单次运行中允许自动返工的最大次数（2–40，默认 4）。")}</small>
                </span>
                <input
                  type="number"
                  min={MIN_MAX_FEEDBACK}
                  max={MAX_MAX_FEEDBACK}
                  step={1}
                  inputMode="numeric"
                  value={maxFeedbackInput}
                  disabled={saving || !feedbackEnabled}
                  onChange={(event) => {
                    markDirty();
                    setMaxFeedbackInput(event.target.value);
                  }}
                  onBlur={() => {
                    setMaxFeedbackInput(String(normalizeMaxFeedback(maxFeedbackInput)));
                  }}
                  aria-label={t("反馈预算")}
                />
              </label>
            </section>

            <section className="settings-card" aria-labelledby="ui-settings-title">
              <div className="settings-card-title">
                <Wallpaper size={16} />
                <h4 id="ui-settings-title">{t("UI设置")}</h4>
              </div>
              <label className="settings-toggle-row">
                <span>
                  <strong>{t("执行时自动展开思维链")}</strong>
                  <small>{t("Agent 思考时自动展开推理过程，实时查看思路。")}</small>
                </span>
                <input
                  type="checkbox"
                  checked={autoExpandCot}
                  disabled={saving}
                  onChange={(event) => setAutoExpandCotDraft(event.target.checked)}
                  aria-label={t("执行时自动展开思维链")}
                />
              </label>
              <label className="settings-toggle-row">
                <span>
                  <strong>{t("显示执行拓扑概览")}</strong>
                  <small>{t("在规划对话底部展示执行拓扑概览与结果写回状态。")}</small>
                </span>
                <input
                  type="checkbox"
                  checked={executionOverview}
                  disabled={saving}
                  onChange={(event) => setExecutionOverviewDraft(event.target.checked)}
                  aria-label={t("显示执行拓扑概览")}
                />
              </label>
              <label className="settings-toggle-row">
                <span>
                  <strong>{t("对话完成系统通知")}</strong>
                  <small>{t("后台任务完成时推送系统通知并预览最终回复，无需一直盯屏。")}</small>
                </span>
                <input
                  type="checkbox"
                  checked={completionNotifications}
                  disabled={saving}
                  onChange={(event) => setCompletionNotificationsDraft(event.target.checked)}
                  aria-label={t("对话完成系统通知")}
                />
              </label>
              {isTauriDesktop() && completionNotifications && desktopNotificationPermission === "denied" && (
                <div className="settings-notification-permission-bar is-warning" role="status">
                  <span className="settings-notification-permission-text">
                    <AlertTriangle size={14} aria-hidden="true" />
                    <span>{t("系统通知权限未开启，请在系统设置中允许 Pi^n 发送通知。")}</span>
                  </span>
                  <button
                    type="button"
                    className="settings-notification-permission-btn"
                    disabled={saving}
                    onClick={() => void openDesktopNotificationSettings()}
                  >
                    {t("打开系统通知设置")}
                  </button>
                </div>
              )}
              {isTauriDesktop() && completionNotifications && desktopNotificationPermission === "default" && (
                <div className="settings-notification-permission-bar" role="status">
                  <span className="settings-notification-permission-text">
                    <Info size={14} aria-hidden="true" />
                    <span>{t("尚未授予系统通知权限，授权后才能在后台收到对话完成提醒。")}</span>
                  </span>
                  <button
                    type="button"
                    className="settings-notification-permission-btn"
                    disabled={saving || requestingNotificationPermission}
                    onClick={() => {
                      setRequestingNotificationPermission(true);
                      void requestBrowserNotificationPermission()
                        .then((status) => {
                          cachedDesktopNotificationPermission = status;
                          setDesktopNotificationPermission(status);
                        })
                        .finally(() => setRequestingNotificationPermission(false));
                    }}
                  >
                    {t("允许系统通知")}
                  </button>
                </div>
              )}
              <label className={`settings-toggle-row is-suboption${!completionNotifications ? " is-disabled" : ""}`}>
                <span>
                  <strong>{t("通知提示音")}</strong>
                  <small>{t("收到完成通知时播放提示音；关闭则静音提醒。")}</small>
                </span>
                <input
                  type="checkbox"
                  checked={completionNotificationSound}
                  disabled={saving || !completionNotifications}
                  onChange={(event) => setCompletionNotificationSoundDraft(event.target.checked)}
                  aria-label={t("通知提示音")}
                />
              </label>
              <h5 className="settings-ui-group-title">{t("重点色")}</h5>
              <p className="section-desc">{t("选择卡片、输入框控件与运行呼吸灯的重点色风格。")}</p>
              <fieldset className="settings-accent-options" disabled={saving}>
                <legend className="sr-only">{t("重点色")}</legend>
                <label className={`settings-accent-option ${accentColor === "blue" ? "is-selected" : ""}`}>
                  <span className="settings-background-preview settings-accent-preview is-blue" aria-hidden="true">
                    <span className="settings-accent-preview-sidebar">
                      <span className="settings-accent-preview-card">
                        <span className="settings-accent-preview-dot" />
                        <span className="settings-accent-preview-line" />
                      </span>
                      <span className="settings-accent-preview-line is-muted" />
                    </span>
                    <span className="settings-accent-preview-main">
                      <span className="settings-accent-preview-bubble" />
                      <span className="settings-accent-preview-composer">
                        <span className="settings-accent-preview-pill" />
                        <span className="settings-accent-preview-send" />
                      </span>
                    </span>
                  </span>
                  <span className="settings-background-option-label">
                    <input type="radio" name="accent-color" value="blue" checked={accentColor === "blue"}
                      onChange={() => setAccentColorDraft("blue")} />
                    <span><strong>{t("蓝色")}</strong><small>{t("淡蓝色卡片搭配蓝色输入框与呼吸灯")}</small></span>
                  </span>
                </label>
                <label className={`settings-accent-option ${accentColor === "black" ? "is-selected" : ""}`}>
                  <span className="settings-background-preview settings-accent-preview is-black" aria-hidden="true">
                    <span className="settings-accent-preview-sidebar">
                      <span className="settings-accent-preview-card">
                        <span className="settings-accent-preview-dot" />
                        <span className="settings-accent-preview-line" />
                      </span>
                      <span className="settings-accent-preview-line is-muted" />
                    </span>
                    <span className="settings-accent-preview-main">
                      <span className="settings-accent-preview-bubble" />
                      <span className="settings-accent-preview-composer">
                        <span className="settings-accent-preview-pill" />
                        <span className="settings-accent-preview-send" />
                      </span>
                    </span>
                  </span>
                  <span className="settings-background-option-label">
                    <input type="radio" name="accent-color" value="black" checked={accentColor === "black"}
                      onChange={() => setAccentColorDraft("black")} />
                    <span><strong>{t("黑色")}</strong><small>{t("灰色卡片搭配黑色输入框与呼吸灯")}</small></span>
                  </span>
                </label>
              </fieldset>
              <h5 className="settings-ui-group-title">{t("首页背景")}</h5>
              <p className="section-desc">{t("自定义首页视觉风格。")}</p>
              <fieldset className="settings-background-options" disabled={saving}>
                <legend className="sr-only">{t("首页背景")}</legend>
                <label className={`settings-background-option ${landingBackground === "grid" ? "is-selected" : ""}`}>
                  <span className="settings-background-preview settings-background-preview-grid" aria-hidden="true" />
                  <span className="settings-background-option-label">
                    <input type="radio" name="landing-background" value="grid" checked={landingBackground === "grid"}
                      onChange={() => setLandingBackgroundDraft("grid")} />
                    <span><strong>{t("三色格子")}</strong><small>{t("图标三色细线格子背景")}</small></span>
                  </span>
                </label>
                <label className={`settings-background-option ${landingBackground === "dots" ? "is-selected" : ""}`}>
                  <span className="settings-background-preview" aria-hidden="true">
                    <DotPattern width={18} height={18} cr={1} className="[mask-image:radial-gradient(130px_circle_at_center,white,transparent)]" />
                  </span>
                  <span className="settings-background-option-label">
                    <input type="radio" name="landing-background" value="dots" checked={landingBackground === "dots"}
                      onChange={() => setLandingBackgroundDraft("dots")} />
                    <span><strong>{t("点阵")}</strong><small>{t("简约静态渐隐点阵")}</small></span>
                  </span>
                </label>
                <label className={`settings-background-option ${landingBackground === "paths" ? "is-selected" : ""}`}>
                  <span className="settings-background-preview settings-background-preview-paths" aria-hidden="true">
                    <svg viewBox="0 0 240 80" preserveAspectRatio="xMidYMid slice" fill="none">
                      <path d="M-25 8 C25 -4 45 72 107 58 S188 0 265 20" />
                      <path d="M-25 20 C25 8 45 84 107 70 S188 12 265 32" />
                      <path d="M-25 -4 C25 -16 45 60 107 46 S188 -12 265 8" />
                      <path d="M-25 32 C25 20 45 96 107 82 S188 24 265 44" />
                    </svg>
                  </span>
                  <span className="settings-background-option-label">
                    <input type="radio" name="landing-background" value="paths" checked={landingBackground === "paths"}
                      onChange={() => setLandingBackgroundDraft("paths")} />
                    <span><strong>{t("动态线条")}</strong><small>{t("流畅动态线条背景")}</small></span>
                  </span>
                </label>
              </fieldset>
            </section>

            <section className="settings-card" aria-labelledby="language-settings-title">
              <div className="settings-card-title">
                <Languages size={16} />
                <h4 id="language-settings-title">{t("界面语言")}</h4>
              </div>
              <div className="settings-language-row">
                <p className="section-desc">{t("选择界面显示语言，确认后将重新加载界面生效。")}</p>
                <select
                  aria-label={t("界面语言")}
                  disabled={saving}
                  value={languagePreference}
                  onChange={(event) => {
                    const next = event.target.value as LanguagePreference;
                    if (next === languagePreference) return;
                    setLanguageError("");
                    setPendingLanguage(next);
                  }}
                >
                  <option value="auto">{languageLabels.auto}</option>
                  <option value="zh-CN">{languageLabels["zh-CN"]}</option>
                  <option value="en">{languageLabels.en}</option>
                </select>
              </div>
              {languageError && <p role="alert" className="settings-language-error">{languageError}</p>}
            </section>

            <AutostartSettings disabled={saving} active={isOpen} />

            <UpdateSettings disabled={saving} />

            {/* 存储与重置 */}
            <section className="settings-card" aria-labelledby="storage-settings-title">
              <div className="settings-card-title">
                <RotateCcw size={16} />
                <h4 id="storage-settings-title">{t("存储与重置")}</h4>
              </div>
              <div className="section-desc">
                <p>{t("数据路径")}</p>
                <div className="settings-data-path-row">
                  <code>{normalizeWorkspacePath(dataPath) || t("本地系统应用目录")}</code>
                  <button
                    type="button"
                    className="icon-tiny-btn"
                    disabled={!dataPath}
                    onClick={() => {
                      const cleanPath = normalizeWorkspacePath(dataPath);
                      if (cleanPath) void copyTextToClipboard(cleanPath);
                    }}
                    aria-label={t("复制路径")}
                  >
                    <Copy size={13} />
                  </button>
                </div>
              </div>
            </section>
          </div>

          {saveError && <p role="alert" className="settings-save-error">{localizeError(saveError)}</p>}
          <footer className="settings-modal-footer">
            <button type="button" className="settings-cancel-btn" disabled={saving} onClick={onClose}>
              {t("取消")}
            </button>
            <button type="button" className="primary save-config-btn" disabled={saving || catalogBusy} aria-busy={saving} onClick={() => void save()}>
              <Check size={14} />{t("保存")}
            </button>
          </footer>
        </div>
      </motion.section>
      <AnimatePresence>
        {pendingLanguage !== null && (
          <ConfirmModal
            key="language-confirmation"
            config={{
              title: t("切换语言并重启前端？"),
              message: t("将界面语言切换为「{0}」并重新加载前端。", languageLabels[pendingLanguage]),
              detail: t("尚未保存的设置和输入内容可能丢失。仅重新加载前端，不会重启后端或停止后台任务。"),
              confirmText: t("确认并重启前端"),
              icon: <RefreshCw size={18} />,
              onConfirm: () => {
                try {
                  restartFrontendWithLanguage(pendingLanguage);
                } catch {
                  setLanguageError(t("无法保存语言偏好，请检查浏览器是否允许本地存储后重试。"));
                }
              },
            }}
            onClose={() => setPendingLanguage(null)}
          />
        )}
      </AnimatePresence>
    </div>
  );
  return typeof document !== "undefined" ? createPortal(content, document.body) : content;
});

SettingsModal.displayName = "SettingsModal";

export default SettingsModal;
