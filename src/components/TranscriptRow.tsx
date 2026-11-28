import { memo, useCallback } from "react";
import type { FileAttachment, ImageAttachment, TranscriptItem } from "../types";
import { ToolCallCard } from "./ToolCallCard";
import { ThinkingCard } from "./ThinkingCard";
import { CompactedCard } from "./CompactedCard";
import { TranscriptNoticeCard } from "./TranscriptNoticeCard";
import { TranscriptErrorCard } from "./TranscriptErrorCard";
import { ActivitySummaryRow, type CardsTransitionPhase } from "./ActivitySummaryRow";
import { EditableUserBubble, StreamingAssistantBubble } from "./views/ChatBubbles";
import { AnimatedUserTurn } from "./AnimatedUserTurn";

function mergeImageMetadata(
  primary?: ImageAttachment[],
  fallback?: ImageAttachment[],
): ImageAttachment[] | undefined {
  if (!primary?.length) return fallback;
  if (!fallback?.length) return primary;
  let changed = false;
  const merged = primary.map((img, idx) => {
    if (img.originalPath && img.name) return img;
    const match = fallback.find(candidate => candidate.data === img.data) ?? fallback[idx];
    if (!match) return img;
    const name = img.name ?? match.name;
    const originalPath = img.originalPath ?? match.originalPath;
    if (name === img.name && originalPath === img.originalPath) return img;
    changed = true;
    return { ...img, ...(name ? { name } : {}), ...(originalPath ? { originalPath } : {}) };
  });
  return changed ? merged : primary;
}

export type EditTranscriptUser = (
  text: string, replacement: string, userTurnOffset?: number, images?: ImageAttachment[], piMessageTimestamp?: number,
) => boolean | void | Promise<unknown>;

export const TranscriptRow = memo(function TranscriptRow({ item, expanded, cardsTransition, showNotices = false, getChildExpanded, onExpandedChange, onChildResize, onChildExpandedChange, editing, draft,
  onDraftChange, onStartEdit, onCancelEdit, onEditUser, steerAttachments }: {
  item: TranscriptItem; expanded?: boolean;
  cardsTransition?: CardsTransitionPhase;
  showNotices?: boolean;
  getChildExpanded?: (id: string) => boolean | undefined;
  onExpandedChange: (id: string, expanded: boolean, card?: HTMLElement) => void;
  onChildResize?: (expanded: boolean, card?: HTMLElement) => void;
  onChildExpandedChange?: (child: TranscriptItem, expanded: boolean, card?: HTMLElement) => void;
  editing: boolean; draft: string; onDraftChange: (text: string) => void;
  onStartEdit: (id: string, text: string) => void; onCancelEdit: () => void;
  onEditUser?: EditTranscriptUser;
  steerAttachments?: { text?: string; images?: ImageAttachment[]; files?: FileAttachment[] };
}) {
  const expand = useCallback((value: boolean, card?: HTMLElement) => onExpandedChange(item.id, value, card), [item.id, onExpandedChange]);
  // Keep execution rows in the exact same layout as the Planner transcript:
  // rows sit directly in the shared list (which owns the 10px card rhythm),
  // and text uses the shared chat bubble classes.
  if (item.type === "divider") return <div className="transcript-divider" role="separator" aria-hidden="true" />;
  if (item.type === "activity_summary") return <ActivitySummaryRow item={item} expanded={expanded} transitionPhase={cardsTransition} showNotices={showNotices} getChildExpanded={getChildExpanded} onExpandedChange={expand} onChildResize={onChildResize} onChildExpandedChange={onChildExpandedChange} />;
  if (item.type === "tool_call") return <ToolCallCard item={item} expanded={expanded} onExpandedChange={expand} />;
  if (item.type === "compaction") return <CompactedCard item={item} showCost={showNotices} expanded={expanded} onExpandedChange={expand} />;
  if (item.type === "notice") return <TranscriptNoticeCard item={item} expanded={expanded} onExpandedChange={expand} />;
  if (item.type === "thinking") return <ThinkingCard item={item} isStreaming={item.status === "running"}
    title="Chain of Thought"
    defaultExpanded={item.defaultExpanded ?? (item.status === "running")} autoExpandWhileStreaming={true} expanded={expanded} onExpandedChange={expand} />;
  if (item.errorItems || ((item.type === "text" || item.type === "system") && (item.isError || item.status === "error"))) {
    return <TranscriptErrorCard item={item} expanded={expanded} onExpandedChange={expand} />;
  }
  if (item.type === "system") return <div className={`transcript-row system-row ${item.isError ? "error" : ""}`}>
    <span className={`system-pill${item.isError && item.role === "assistant" ? " conversation-error-message" : ""}`}>{item.content}</span>
  </div>;
  if (item.role === "user") {
    const displayedText = (item.steerRequestId && steerAttachments?.text) ? steerAttachments.text : (item.content || "");
    const resolvedImages = mergeImageMetadata(item.images, steerAttachments?.images);
    return <AnimatedUserTurn id={item.id} animateAppear={item.animateAppear}
    className="chat-message-row user planner-user-turn"><EditableUserBubble text={displayedText} images={resolvedImages} files={item.files ?? steerAttachments?.files}
    editing={editing} draft={draft} onDraftChange={onDraftChange}
    onEdit={onEditUser ? () => onStartEdit(item.id, displayedText) : undefined}
    onCancel={onCancelEdit} onSend={onEditUser ? text => {
      return Promise.resolve(onEditUser(item.content || "", text, item.userTurnOffset, resolvedImages, item.piMessageTimestamp)).then(accepted => {
        if (accepted !== false) onCancelEdit();
        return accepted === false ? false : true;
      });
    } : () => {}} /></AnimatedUserTurn>;
  }
  // Keep virtualized Markdown rows out of Motion's transform layer: fenced code
  // contains its own horizontal scroller, and transformed scrollable descendants
  // can leave a stale compositor copy at the viewport edge during scrollback.
  if (item.isError || item.status === "error") {
    return <div className="chat-message-row assistant">
      <div className="node-error" style={{ margin: "4px 0" }}>{item.content || ""}</div>
    </div>;
  }
  return <div className="chat-message-row assistant">
    <div className="chat-bubble-assistant chat-message-assistant">
      <StreamingAssistantBubble content={item.content || ""} isStreaming={item.status === "running"} />
    </div>
  </div>;
});
