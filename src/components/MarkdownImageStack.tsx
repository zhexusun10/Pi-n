import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Maximize2 } from "lucide-react";
import { t } from "../i18n";
import type { StackedMarkdownImage } from "../services/markdownImageStack";
import { ImagePreviewModal, type PreviewImageItem } from "./modals/ImagePreviewModal";

interface MarkdownImageStackProps {
  images: readonly StackedMarkdownImage[];
  trailingCursor?: boolean;
}

const DRAG_ACTIVATION_PX = 8;
const DRAG_FLIP_THRESHOLD_PX = 44;
const WHEEL_FLIP_THRESHOLD_PX = 36;
const WHEEL_COOLDOWN_MS = 240;

function computeRelativeOffset(index: number, activeIndex: number, total: number, isBrowse: boolean): number {
  const forward = (index - activeIndex + total) % total;
  if (!isBrowse) return forward;
  const half = Math.floor(total / 2);
  return forward <= half ? forward : forward - total;
}

function getCardKey(image: StackedMarkdownImage, occurrence: number): string {
  return `${image.workspacePath ?? image.src ?? "img"}::${occurrence}`;
}

export function buildStackPreviewState(
  images: readonly StackedMarkdownImage[],
  cardKeys: readonly string[],
  errorMap: Readonly<Record<string, string>>,
  resolveSrc: (index: number, image: StackedMarkdownImage) => string,
  targetIndex: number,
  fallbackAlt: (index: number) => string = (index) => t("图片 {0}", index + 1),
): { items: PreviewImageItem[]; index: number } | null {
  const targetKey = cardKeys[targetIndex];
  if (!targetKey || errorMap[targetKey]) return null;

  const items: PreviewImageItem[] = [];
  let mappedIndex = -1;
  for (let i = 0; i < images.length; i++) {
    const key = cardKeys[i];
    if (key && errorMap[key]) continue;
    const img = images[i];
    const resolvedSrc = resolveSrc(i, img);
    if (!resolvedSrc) continue;
    if (i === targetIndex) mappedIndex = items.length;
    items.push({
      src: resolvedSrc,
      ...(img.workspacePath ? { workspacePath: img.workspacePath } : {}),
      alt: img.alt || img.title || fallbackAlt(i),
      name: img.alt || img.title || undefined,
    });
  }
  if (mappedIndex === -1 || items.length === 0) return null;
  return { items, index: mappedIndex };
}

interface StackCardProps {
  image: StackedMarkdownImage;
  index: number;
  rel: number;
  isActive: boolean;
  isBrowse: boolean;
  isDragging: boolean;
  dragOffsetX: number;
  errorMessage: string | null;
  onRegisterImg: (index: number, node: HTMLImageElement | null) => void;
  onImageError: (index: number, message: string) => void;
  onSelectCard: (index: number) => void;
  onPointerDownActive: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerMoveActive: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerUpActive: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerCancelActive: (event: React.PointerEvent<HTMLDivElement>) => void;
}

const StackCard: React.FC<StackCardProps> = React.memo(({
  image,
  index,
  rel,
  isActive,
  isBrowse,
  isDragging,
  dragOffsetX,
  errorMessage,
  onRegisterImg,
  onImageError,
  onSelectCard,
  onPointerDownActive,
  onPointerMoveActive,
  onPointerUpActive,
  onPointerCancelActive,
}) => {
  const imgRef = useRef<HTMLImageElement | null>(null);

  const setImgNode = useCallback((node: HTMLImageElement | null) => {
    imgRef.current = node;
    onRegisterImg(index, node);
  }, [index, onRegisterImg]);

  useEffect(() => {
    const node = imgRef.current;
    if (!node) return;
    const handleManagedError = (event: Event) => {
      const detail = (event as CustomEvent<{ message?: string }>).detail;
      const fallbackMessage = detail?.message || `${t("无法加载图片")} · ${image.alt || image.workspacePath || ""}`;
      onImageError(index, fallbackMessage);
    };
    node.addEventListener("pi-n:image-error", handleManagedError);
    return () => node.removeEventListener("pi-n:image-error", handleManagedError);
  }, [index, image.alt, image.workspacePath, onImageError, errorMessage]);

  const absRel = Math.abs(rel);
  const clampedSlot = isBrowse
    ? (absRel === 0 ? "0" : absRel === 1 ? (rel > 0 ? "1" : "-1") : absRel === 2 ? (rel > 0 ? "2" : "-2") : "back")
    : (rel === 0 ? "0" : rel === 1 ? "1" : rel === 2 ? "2" : rel === 3 ? "3" : "back");

  let zIndex = 1;
  if (isActive) zIndex = 10;
  else if (isBrowse) zIndex = absRel === 1 ? 8 : absRel === 2 ? 6 : 1;
  else zIndex = rel === 1 ? 8 : rel === 2 ? 6 : rel === 3 ? 4 : 1;

  const dragStyle: React.CSSProperties = {
    zIndex,
    ...(isActive && isDragging ? {
      transform: `translate3d(${dragOffsetX}px, -4px, 0) rotate(${Math.max(-10, Math.min(10, dragOffsetX * 0.045))}deg) scale(1.015)`,
      transition: "none",
    } : {}),
  };

  const canClickToFlip = !isActive && isBrowse && absRel <= 2;

  return (
    <div
      className={`markdown-image-stack-card${isActive ? " is-active" : ""}${canClickToFlip ? " is-clickable-wing" : ""}`}
      data-slot={clampedSlot}
      data-index={index}
      style={dragStyle}
      onClick={canClickToFlip ? (event) => {
        event.stopPropagation();
        onSelectCard(index);
      } : undefined}
      onPointerDown={isActive ? onPointerDownActive : undefined}
      onPointerMove={isActive ? onPointerMoveActive : undefined}
      onPointerUp={isActive ? onPointerUpActive : undefined}
      onPointerCancel={isActive ? onPointerCancelActive : undefined}
    >
      <div className="markdown-image-stack-frame">
        {errorMessage ? (
          <span
            className="markdown-image-error markdown-image-stack-error"
            role="img"
            aria-label={errorMessage}
            {...(image.workspacePath ? { "data-workspace-path": image.workspacePath } : {})}
          >
            {errorMessage}
          </span>
        ) : (
          <img
            ref={setImgNode}
            src={image.src}
            alt={image.alt}
            title={image.title}
            width={image.width}
            height={image.height}
            loading={image.loading as "eager" | "lazy" | undefined}
            decoding={image.decoding as "async" | "auto" | "sync" | undefined}
            referrerPolicy={image.referrerpolicy as React.HTMLAttributeReferrerPolicy | undefined}
            data-workspace-path={image.workspacePath}
            data-managed-image="true"
            draggable={false}
          />
        )}
      </div>
    </div>
  );
});

StackCard.displayName = "StackCard";

export const MarkdownImageStack: React.FC<MarkdownImageStackProps> = React.memo(({
  images,
  trailingCursor = false,
}) => {
  const total = images.length;
  const [rawActiveIndex, setRawActiveIndex] = useState(0);
  const [isHovered, setIsHovered] = useState(false);
  const [isFocused, setIsFocused] = useState(false);
  const [isTouchOpen, setIsTouchOpen] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [dragOffsetX, setDragOffsetX] = useState(0);
  const [errorMap, setErrorMap] = useState<Record<string, string>>({});
  const [previewState, setPreviewState] = useState<{ items: PreviewImageItem[]; index: number } | null>(null);

  const stageRef = useRef<HTMLDivElement | null>(null);
  const imgNodesRef = useRef<Map<number, HTMLImageElement>>(new Map());
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    moved: boolean;
    offsetX: number;
  } | null>(null);
  const wheelRef = useRef<{ accumX: number; lastFlipAt: number }>({ accumX: 0, lastFlipAt: 0 });

  const activeIndex = total > 0 ? Math.min(rawActiveIndex, total - 1) : 0;
  const isBrowse = isHovered || isFocused || isTouchOpen;

  const cardKeys = useMemo(() => {
    const counts = new Map<string, number>();
    return images.map(image => {
      const id = image.workspacePath ?? image.src ?? "img";
      const seen = counts.get(id) ?? 0;
      counts.set(id, seen + 1);
      return getCardKey(image, seen);
    });
  }, [images]);

  // Clear stale error entries when images change.
  useEffect(() => {
    const valid = new Set(cardKeys);
    setErrorMap(prev => {
      const next: Record<string, string> = {};
      let changed = false;
      for (const [k, v] of Object.entries(prev)) {
        if (valid.has(k)) next[k] = v;
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [cardKeys]);

  const registerImg = useCallback((index: number, node: HTMLImageElement | null) => {
    if (node) imgNodesRef.current.set(index, node);
    else imgNodesRef.current.delete(index);
  }, []);

  const handleImageError = useCallback((index: number, message: string) => {
    const key = cardKeys[index];
    if (!key) return;
    setErrorMap(prev => (prev[key] === message ? prev : { ...prev, [key]: message }));
  }, [cardKeys]);

  const step = useCallback((delta: number) => {
    if (total <= 1) return;
    setRawActiveIndex(prev => {
      const clamped = Math.min(prev, total - 1);
      return (clamped + delta + total) % total;
    });
  }, [total]);

  const openPreviewAt = useCallback((targetIndex: number) => {
    const next = buildStackPreviewState(
      images,
      cardKeys,
      errorMap,
      (index, img) => {
        const node = imgNodesRef.current.get(index);
        return node?.currentSrc || node?.getAttribute("src") || img.src || "";
      },
      targetIndex,
    );
    if (!next) return;
    setPreviewState(next);
  }, [cardKeys, errorMap, images]);

  // Support natural two-finger horizontal swipe on trackpads when hovered,
  // while never hijacking vertical page/transcript scrolling.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !isBrowse) return;
    const onWheel = (event: WheelEvent) => {
      const absX = Math.abs(event.deltaX);
      const absY = Math.abs(event.deltaY);
      if (absX <= absY || absX < 2) return;
      event.preventDefault();
      const now = Date.now();
      if (now - wheelRef.current.lastFlipAt < WHEEL_COOLDOWN_MS) return;
      wheelRef.current.accumX += event.deltaX;
      if (Math.abs(wheelRef.current.accumX) >= WHEEL_FLIP_THRESHOLD_PX) {
        step(wheelRef.current.accumX > 0 ? 1 : -1);
        wheelRef.current.accumX = 0;
        wheelRef.current.lastFlipAt = now;
      }
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      stage.removeEventListener("wheel", onWheel);
      wheelRef.current.accumX = 0;
    };
  }, [isBrowse, step]);

  const handlePointerDownActive = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    // On touch devices where hover isn't triggered before tap, first tap enters browse mode.
    if (event.pointerType === "touch" && !isBrowse) {
      setIsTouchOpen(true);
      return;
    }
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
      offsetX: 0,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }, [isBrowse]);

  const releasePointerCaptureSafely = useCallback((el: HTMLElement | null, pointerId: number) => {
    if (!el) return;
    try {
      if (typeof el.hasPointerCapture !== "function" || el.hasPointerCapture(pointerId)) {
        el.releasePointerCapture?.(pointerId);
      }
    } catch {
      // Safari / WKWebView may have already released capture implicitly.
    }
  }, []);

  const handlePointerMoveActive = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.moved) {
      if (Math.abs(dx) < DRAG_ACTIVATION_PX) return;
      // If user is clearly dragging vertically (e.g. touch scrolling), abort card drag.
      if (Math.abs(dy) > Math.abs(dx)) {
        releasePointerCaptureSafely(event.currentTarget, event.pointerId);
        dragRef.current = null;
        setIsDragging(false);
        setDragOffsetX(0);
        return;
      }
      drag.moved = true;
      setIsDragging(true);
    }
    const clamped = Math.max(-180, Math.min(180, dx));
    drag.offsetX = clamped;
    setDragOffsetX(clamped);
  }, [releasePointerCaptureSafely]);

  const finishDrag = useCallback((shouldFlipOrClick: boolean) => {
    const drag = dragRef.current;
    dragRef.current = null;
    setIsDragging(false);
    setDragOffsetX(0);
    if (!drag || !shouldFlipOrClick) return;
    if (drag.moved) {
      if (drag.offsetX <= -DRAG_FLIP_THRESHOLD_PX) step(1);
      else if (drag.offsetX >= DRAG_FLIP_THRESHOLD_PX) step(-1);
    } else {
      openPreviewAt(activeIndex);
    }
  }, [activeIndex, openPreviewAt, step]);

  const handlePointerUpActive = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    releasePointerCaptureSafely(event.currentTarget, event.pointerId);
    finishDrag(true);
  }, [finishDrag, releasePointerCaptureSafely]);

  const handlePointerCancelActive = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    releasePointerCaptureSafely(event.currentTarget, event.pointerId);
    finishDrag(false);
  }, [finishDrag, releasePointerCaptureSafely]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented) return;
    if (event.key === "ArrowRight") {
      event.preventDefault();
      step(1);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      step(-1);
    } else if (event.key === "Home") {
      event.preventDefault();
      setRawActiveIndex(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setRawActiveIndex(total - 1);
    } else if ((event.key === "Enter" || event.key === " ") && event.target === event.currentTarget) {
      event.preventDefault();
      openPreviewAt(activeIndex);
    }
  }, [activeIndex, openPreviewAt, step, total]);

  const activeImage = images[activeIndex];
  const activeCaption = activeImage?.alt || activeImage?.title || "";
  const activeHasError = Boolean(cardKeys[activeIndex] && errorMap[cardKeys[activeIndex]]);

  return (
    <>
      <div
        className={`markdown-image-stack${isBrowse ? " is-browse" : ""}${isDragging ? " is-dragging" : ""}`}
        data-browse={isBrowse ? "true" : "false"}
        data-active-index={activeIndex}
        data-count={total}
        role="region"
        aria-roledescription="carousel"
        aria-label={t("图片堆叠（共 {0} 张）", total)}
        tabIndex={0}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => {
          setIsHovered(false);
          setIsTouchOpen(false);
        }}
        onFocus={() => setIsFocused(true)}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            setIsFocused(false);
            setIsTouchOpen(false);
          }
        }}
        onKeyDown={handleKeyDown}
      >
        <div ref={stageRef} className="markdown-image-stack-stage">
          {images.map((image, index) => {
            const rel = computeRelativeOffset(index, activeIndex, total, isBrowse);
            const key = cardKeys[index];
            return (
              <StackCard
                key={key}
                image={image}
                index={index}
                rel={rel}
                isActive={index === activeIndex}
                isBrowse={isBrowse}
                isDragging={isDragging}
                dragOffsetX={dragOffsetX}
                errorMessage={errorMap[key] ?? null}
                onRegisterImg={registerImg}
                onImageError={handleImageError}
                onSelectCard={setRawActiveIndex}
                onPointerDownActive={handlePointerDownActive}
                onPointerMoveActive={handlePointerMoveActive}
                onPointerUpActive={handlePointerUpActive}
                onPointerCancelActive={handlePointerCancelActive}
              />
            );
          })}

          {/* Resting counter pill so the stacked deck signals multiple photos at a glance */}
          <div className="markdown-image-stack-badge" aria-hidden="true">
            <span>{activeIndex + 1} / {total}</span>
          </div>

          {/* Hover-revealed flip navigation controls */}
          <button
            type="button"
            className="markdown-image-stack-nav prev"
            aria-label={t("上一张图片")}
            tabIndex={isBrowse ? 0 : -1}
            onClick={(event) => {
              event.stopPropagation();
              step(-1);
            }}
          >
            <ChevronLeft size={16} strokeWidth={2.2} />
          </button>

          <button
            type="button"
            className="markdown-image-stack-nav next"
            aria-label={t("下一张图片")}
            tabIndex={isBrowse ? 0 : -1}
            onClick={(event) => {
              event.stopPropagation();
              step(1);
            }}
          >
            <ChevronRight size={16} strokeWidth={2.2} />
          </button>

          {!activeHasError ? (
            <button
              type="button"
              className="markdown-image-stack-expand"
              aria-label={t("查看大图")}
              tabIndex={isBrowse ? 0 : -1}
              onClick={(event) => {
                event.stopPropagation();
                openPreviewAt(activeIndex);
              }}
            >
              <Maximize2 size={13} strokeWidth={2.1} />
            </button>
          ) : null}
        </div>

        {/* Footer bar: subtle caption + dots, becomes interactive on hover */}
        <div className="markdown-image-stack-footer">
          <div className="markdown-image-stack-caption" title={activeCaption || undefined}>
            {activeCaption || t("图片 {0}", activeIndex + 1)}
          </div>
          <div className="markdown-image-stack-dots" role="tablist" aria-label={t("图片列表")}>
            {images.map((image, index) => (
              <button
                key={cardKeys[index]}
                type="button"
                role="tab"
                aria-selected={index === activeIndex}
                aria-label={image.alt ? `${index + 1}. ${image.alt}` : t("查看第 {0} 张图片", index + 1)}
                className={`markdown-image-stack-dot${index === activeIndex ? " is-active" : ""}`}
                tabIndex={isBrowse ? 0 : -1}
                onClick={(event) => {
                  event.stopPropagation();
                  setRawActiveIndex(index);
                }}
              />
            ))}
          </div>
          <span className="markdown-image-stack-counter">
            {activeIndex + 1} / {total}
          </span>
        </div>
      </div>
      {trailingCursor ? <span className="thinking-streaming-cursor" /> : null}

      <ImagePreviewModal
        images={previewState?.items ?? []}
        index={previewState ? previewState.index : null}
        onChangeIndex={(nextIndex) => setPreviewState(prev => (prev ? { ...prev, index: nextIndex } : null))}
        onClose={() => setPreviewState(null)}
      />
    </>
  );
});

MarkdownImageStack.displayName = "MarkdownImageStack";
