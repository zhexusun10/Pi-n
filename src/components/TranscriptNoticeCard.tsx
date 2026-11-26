import React, { memo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronRight, Database, Flame, Sparkles } from "lucide-react";
import { t } from "../i18n";
import type { TranscriptItem, TranscriptNoticeInfo } from "../types";
import { formatTokenCount } from "../utils/tokenUsage";
import { formatNoticeUsd } from "../services/transcriptNotices";
import { useCardAppear } from "../services/cardAnimations";
import { CardReveal } from "./CardReveal";
import { CollapsibleCardBody } from "./CollapsibleCardBody";

interface TranscriptNoticeCardProps {
  item: TranscriptItem;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean, card?: HTMLElement) => void;
  className?: string;
}

interface NoticePresentation {
  tone: "warning" | "neutral";
  statusTone: "warning" | "success";
  statusLabel: string;
  title: string;
  summary: string;
  rows: Array<{ label: string; value: string; mono?: boolean }>;
  note: string;
}

function buildNoticePresentation(notice: TranscriptNoticeInfo): NoticePresentation {
  if (notice.kind === "cache_miss") {
    const title = notice.modelChanged
      ? t("切换模型后缓存未命中")
      : notice.idleMinutes !== undefined
        ? t("空闲 {0} 分钟后缓存未命中", notice.idleMinutes)
        : t("缓存未命中");
    const tokens = formatTokenCount(notice.missedTokens);
    const cost = formatNoticeUsd(notice.missedCost);
    const summary = cost
      ? t("{0} tokens 重计费 ({1})", tokens, cost)
      : t("{0} tokens 重计费", tokens);
    const cause = notice.modelChanged
      ? t("本轮切换了模型或 Provider，提示前缀缓存无法复用")
      : notice.idleMinutes !== undefined
        ? t("距离上一轮已超过提示缓存有效期（约 {0} 分钟）", notice.idleMinutes)
        : t("本轮提示前缀与上一轮缓存未对齐");
    const rows: NoticePresentation["rows"] = [
      { label: t("重计费 Token"), value: `${tokens} tokens`, mono: true },
      ...(cost ? [{ label: t("额外估算费用"), value: cost, mono: true }] : []),
      { label: t("原因"), value: cause },
    ];
    return {
      tone: "warning",
      statusTone: "warning",
      statusLabel: notice.modelChanged
        ? t("模型切换")
        : notice.idleMinutes !== undefined
          ? t("缓存过期")
          : t("已提示"),
      title,
      summary,
      rows,
      note: t("仅反映提示缓存计费变化，当前回复已正常完成，并非执行错误。"),
    };
  }

  if (notice.kind === "reasoning_drop") {
    const provider = notice.provider || "Provider";
    const count = notice.droppedCount ?? 1;
    const isThinking = notice.droppedNoun === "thinking";
    const baseText = isThinking
      ? t("{0} 省略了 {1} 段历史思考块", provider, count)
      : t("{0} 省略了 {1} 条历史推理项", provider, count);
    const reasons = notice.reasons ?? [];
    const summary = reasons.length > 1 ? `${baseText} · ${reasons.join(", ")}` : baseText;
    const rows: NoticePresentation["rows"] = [
      { label: "Provider", value: provider },
      {
        label: isThinking ? t("省略思考块") : t("省略推理项"),
        value: String(count),
        mono: true,
      },
      ...(reasons.length > 0 ? [{ label: t("诊断代码"), value: reasons.join(", "), mono: true }] : []),
    ];
    return {
      tone: "warning",
      statusTone: "warning",
      statusLabel: reasons[0] || t("已提示"),
      title: t("推理上下文已省略"),
      summary,
      rows,
      note: t("常见于上下文压缩或历史前缀变更后，Provider 自动跳过了不匹配的旧推理内容，本轮回复本身未报错。"),
    };
  }

  // cache_warming
  const cost = formatNoticeUsd(notice.warmingCost, true);
  const count = notice.warmingCount ?? 1;
  const parts: string[] = [];
  if (cost) parts.push(cost);
  if (count > 1) parts.push(t("{0} 次预热", count));
  if (notice.warmingNote) parts.push(notice.warmingNote);
  const summary = parts.join(" · ") || t("后台已刷新提示缓存");
  const rows: NoticePresentation["rows"] = [
    ...(cost ? [{ label: t("累计预热费用"), value: cost, mono: true }] : []),
    { label: t("预热次数"), value: String(count), mono: true },
    ...(notice.warmingNote ? [{ label: t("说明"), value: notice.warmingNote }] : []),
  ];
  return {
    tone: "neutral",
    statusTone: "success",
    statusLabel: t("已预热"),
    title: t("缓存预热"),
    summary,
    rows,
    note: t("Pi 在空闲期间发送了轻量缓存保活请求，以减少下一轮对话的缓存未命中开销。"),
  };
}

function renderKindIcon(kind: TranscriptNoticeInfo["kind"]) {
  if (kind === "reasoning_drop") return <Sparkles size={14} />;
  if (kind === "cache_miss") return <Database size={14} />;
  return <Flame size={14} />;
}

export const TranscriptNoticeCard: React.FC<TranscriptNoticeCardProps> = memo(
  ({ item, expanded, onExpandedChange, className = "" }) => {
    const [localExpanded, setLocalExpanded] = useState(false);
    const isExpanded = expanded ?? localExpanded;
    const cardRef = useRef<HTMLDivElement>(null);
    const animateAppear = useCardAppear(item.id, false, item.timestamp, item.animateAppear);

    const notice = item.notice;
    if (!notice) return null;
    const view = buildNoticePresentation(notice);

    const toggleExpand = () => {
      const next = !isExpanded;
      setLocalExpanded(next);
      onExpandedChange?.(next, cardRef.current ?? undefined);
    };

    return (
      <CardReveal animate={animateAppear}>
        <div
          ref={cardRef}
          className={`transcript-notice-card tone-${view.tone} ${isExpanded ? "expanded" : "collapsed"}${animateAppear ? " appear-active" : ""} ${className}`.trim()}
          data-testid="transcript-notice-card"
          data-notice-kind={notice.kind}
          role="note"
        >
          <button
            type="button"
            className="transcript-notice-header"
            onClick={toggleExpand}
            onMouseDown={(event) => event.preventDefault()}
            aria-expanded={isExpanded}
          >
            <div className="transcript-notice-left">
              <span className="transcript-notice-expand-icon" aria-hidden="true">
                <ChevronRight size={14} className={`transcript-notice-chevron ${isExpanded ? "open" : ""}`} />
              </span>
              <span className="transcript-notice-icon" aria-hidden="true">
                {renderKindIcon(notice.kind)}
              </span>
              <span className="transcript-notice-title">{view.title}</span>
              <span className="transcript-notice-summary">{view.summary}</span>
            </div>
            <span className={`transcript-notice-status status-${view.statusTone}`}>
              {view.statusTone === "success" ? <CheckCircle2 size={13} aria-hidden="true" /> : <AlertTriangle size={13} aria-hidden="true" />}
              <span>{view.statusLabel}</span>
            </span>
          </button>

          <CollapsibleCardBody expanded={isExpanded}>
            {() => (
              <div className="transcript-notice-body">
                <dl className="transcript-notice-meta">
                  {view.rows.map((row) => (
                    <div key={row.label} className="transcript-notice-meta-row">
                      <dt>{row.label}</dt>
                      <dd className={row.mono ? "is-mono" : undefined}>{row.value}</dd>
                    </div>
                  ))}
                </dl>
                <p className="transcript-notice-note">{view.note}</p>
              </div>
            )}
          </CollapsibleCardBody>
        </div>
      </CardReveal>
    );
  },
);

TranscriptNoticeCard.displayName = "TranscriptNoticeCard";
export default TranscriptNoticeCard;
