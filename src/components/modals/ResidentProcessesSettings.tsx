import React, { useCallback, useState } from "react";
import { Cpu, RefreshCw, Trash2 } from "lucide-react";
import { t } from "../../i18n";
import { runtimeService } from "../../services/runtime";
import type { ResidentProcessStatus, ResidentReleaseScope } from "../../types";

interface ResidentProcessesSettingsProps {
  disabled?: boolean;
}

export const ResidentProcessesSettings = React.memo(function ResidentProcessesSettings({
  disabled = false,
}: ResidentProcessesSettingsProps) {
  const [status, setStatus] = useState<ResidentProcessStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string>("");
  const [error, setError] = useState<string>("");

  const inspect = useCallback(async () => {
    setBusy("inspect");
    setError("");
    try {
      const next = await runtimeService.getResidentProcesses();
      setStatus(next);
      setFeedback("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, []);

  const release = useCallback(async (scope: ResidentReleaseScope) => {
    setBusy(scope);
    setError("");
    try {
      const result = await runtimeService.releaseResidentProcesses({ scope });
      setStatus(result.status);
      if (scope === "agents") {
        setFeedback(
          result.releasedAgents > 0
            ? t("已释放 {0} 个驻留 Agent（已保留后台服务）", result.releasedAgents)
            : t("当前没有可释放的驻留 Agent"),
        );
      } else {
        setFeedback(
          result.releasedAgents + result.releasedServices > 0
            ? t("已释放 {0} 个驻留 Agent 与 {1} 组后台服务", result.releasedAgents, result.releasedServices)
            : t("当前没有运行中的驻留进程"),
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, []);

  const serviceCount = status
    ? status.backgroundServices.reduce((sum, item) => sum + item.count, 0)
    : 0;
  const controlsDisabled = disabled || busy !== null;

  return (
    <section className="settings-card" aria-labelledby="resident-processes-settings-title">
      <div className="settings-card-title">
        <Cpu size={16} />
        <h4 id="resident-processes-settings-title">{t("驻留进程与资源")}</h4>
      </div>
      <p className="section-desc">
        {t("Direct 会话会自动驻留以加速续写，并在超出容量或空闲超时后回收 Agent（保留后台服务）。扩展开关变更后也会自动轮换旧会话。")}
      </p>
      {status && (
        <p className="section-desc" data-testid="resident-processes-status">
          {t(
            "当前驻留 Agent：{0} / {1}（空闲回收：{2} 分钟），后台服务组：{3}",
            status.parkedAgents.length,
            status.maxParkedAgents,
            Math.max(1, Math.round(status.idleTtlSecs / 60)),
            serviceCount,
          )}
        </p>
      )}
      <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", marginTop: "8px" }}>
        <button
          type="button"
          className="settings-cancel-btn"
          data-testid="resident-processes-inspect"
          disabled={controlsDisabled}
          onClick={() => void inspect()}
        >
          <RefreshCw size={13} />
          {t("查看状态")}
        </button>
        <button
          type="button"
          className="settings-cancel-btn"
          data-testid="resident-processes-release-agents"
          disabled={controlsDisabled}
          onClick={() => void release("agents")}
        >
          {t("释放空闲 Agent")}
        </button>
        <button
          type="button"
          className="settings-cancel-btn"
          data-testid="resident-processes-release-all"
          disabled={controlsDisabled}
          onClick={() => void release("all")}
        >
          <Trash2 size={13} />
          {t("释放全部驻留进程")}
        </button>
      </div>
      {feedback && (
        <p className="section-desc" data-testid="resident-processes-feedback" style={{ marginTop: "6px" }}>
          {feedback}
        </p>
      )}
      {error && (
        <p role="alert" className="settings-language-error" style={{ marginTop: "6px" }}>
          {error}
        </p>
      )}
    </section>
  );
});

ResidentProcessesSettings.displayName = "ResidentProcessesSettings";
