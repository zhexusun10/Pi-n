import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { t } from "../../i18n";
import { useDialogFocus } from "../../hooks/useDialogFocus";
import {
  getCachedOriginalImageUrl,
  loadOriginalImageUrl,
} from "../../services/originalImagePreview";
import { ImageContextMenu } from "../ui/ImageContextMenu";
import type { ContextMenuAnchor } from "../ui/context-menu";

export interface PreviewImageItem {
  src: string;
  /** Optional managed attachment path to load the uncompressed original on demand. */
  originalPath?: string;
  /** Optional workspace/source path used to derive a clean download filename. */
  workspacePath?: string;
  /** Optional run scope for loading `originalPath`. */
  runId?: string;
  /** Optional in-memory fallback key for oversized originals in the current session. */
  sessionOriginalKey?: string;
  alt?: string;
  name?: string;
}

interface ImagePreviewModalProps {
  images: readonly PreviewImageItem[];
  index: number | null;
  onChangeIndex?: (index: number) => void;
  onClose: () => void;
}

export function ImagePreviewModal({
  images,
  index,
  onChangeIndex,
  onClose,
}: ImagePreviewModalProps) {
  const open = index !== null && index >= 0 && index < images.length;
  const current = open ? images[index] : null;
  const total = images.length;
  const canNavigate = open && total > 1 && !!onChangeIndex;

  const originalPath = current?.originalPath;
  const runId = current?.runId;
  const sessionOriginalKey = current?.sessionOriginalKey;
  const targetKey = current ? `${originalPath ?? ""}::${sessionOriginalKey ?? ""}::${current.src}` : "";
  const cachedOriginalSrc = current
    ? getCachedOriginalImageUrl({ originalPath, runId, sessionOriginalKey })
    : null;
  const [resolvedOriginal, setResolvedOriginal] = useState<{ key: string; url: string } | null>(null);
  const [failedOriginalKey, setFailedOriginalKey] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuAnchor | null>(null);

  useEffect(() => {
    setContextMenu(null);
    if (!open) setFailedOriginalKey(null);
  }, [open, index]);

  useEffect(() => {
    if (!open || !current || (!originalPath && !sessionOriginalKey)) return;
    if (cachedOriginalSrc) return;
    let cancelled = false;
    void loadOriginalImageUrl({ originalPath, runId, sessionOriginalKey })
      .then((url) => {
        if (!cancelled && url) {
          setResolvedOriginal({ key: targetKey, url });
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open, current, originalPath, runId, sessionOriginalKey, cachedOriginalSrc, targetKey]);

  const upgradedSrc = failedOriginalKey === targetKey
    ? null
    : (cachedOriginalSrc ?? (resolvedOriginal?.key === targetKey ? resolvedOriginal.url : null));
  const displayedSrc = upgradedSrc ?? current?.src ?? "";

  const dialogRef = useDialogFocus<HTMLDivElement>({
    open,
    onClose,
    initialFocus: ".image-preview-close-btn",
  });

  useEffect(() => {
    if (!canNavigate || index === null || !onChangeIndex || contextMenu) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        onChangeIndex((index - 1 + total) % total);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        onChangeIndex((index + 1) % total);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [canNavigate, index, total, onChangeIndex, contextMenu]);

  if (!open || !current || typeof document === "undefined") return null;

  return createPortal(
    <div
      className="image-preview-backdrop"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("图片预览")}
        tabIndex={-1}
        className="image-preview-dialog"
        onClick={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          className="image-preview-close-btn"
          onClick={onClose}
          aria-label={t("关闭预览")}
        >
          <X size={18} />
        </button>

        {canNavigate && index !== null && onChangeIndex && (
          <>
            <button
              type="button"
              className="image-preview-nav-btn prev"
              onClick={() => onChangeIndex((index - 1 + total) % total)}
              aria-label={t("上一张图片")}
            >
              <ChevronLeft size={20} />
            </button>
            <button
              type="button"
              className="image-preview-nav-btn next"
              onClick={() => onChangeIndex((index + 1) % total)}
              aria-label={t("下一张图片")}
            >
              <ChevronRight size={20} />
            </button>
          </>
        )}

        <img
          src={displayedSrc}
          alt={current.alt || current.name || t("图片预览")}
          className="image-preview-full-img"
          onContextMenu={(event) => {
            if (!displayedSrc) return;
            event.preventDefault();
            event.stopPropagation();
            setContextMenu({
              x: event.clientX,
              y: event.clientY,
              trigger: event.currentTarget,
            });
          }}
          onError={() => {
            if (upgradedSrc && failedOriginalKey !== targetKey) {
              setFailedOriginalKey(targetKey);
            }
          }}
        />

        {contextMenu && displayedSrc && (
          <ImageContextMenu
            anchor={contextMenu}
            target={{
              src: displayedSrc,
              originalPath: current.originalPath,
              runId: current.runId,
              sessionOriginalKey: current.sessionOriginalKey,
              workspacePath: current.workspacePath,
              name: current.name,
              alt: current.alt,
            }}
            onClose={() => setContextMenu(null)}
          />
        )}

        {(current.name || total > 1) && (
          <div className="image-preview-caption">
            {current.name ? <span className="image-preview-name">{current.name}</span> : null}
            {total > 1 && index !== null ? (
              <span className="image-preview-counter">
                {index + 1} / {total}
              </span>
            ) : null}
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
