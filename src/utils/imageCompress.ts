/**
 * Client-side raster image resizing/compression for inline Pi RPC vision images.
 *
 * Keeps ordinary images untouched while intelligently optimizing oversized or
 * bloated screenshots/photos (for example 5K Retina PNGs) to stay well within
 * both Pi^n's JSON request limit and upstream vision API budgets (e.g. 5 MB):
 *   - Progressive (>2x) downscaling for crisper UI text and hairlines
 *   - Content/alpha-aware format selection: preserves compact lossless PNGs,
 *     prefers WebP when supported by the canvas encoder, and falls back to JPEG
 *     with luminance-matched transparency matte
 *   - Binary search over encoder quality to maximize fidelity within budget
 *   - Adaptive area-based scale stepping instead of coarse fixed jumps
 *   - Opportunistic high-quality optimization for bloated within-dimension
 *     images (> ~1.1 MiB raw) only when re-encoding saves >= 35%
 */

export const MAX_VISION_IMAGE_DIMENSION = 2000;
/** ~4.3 MiB of base64 payload (~3.2 MiB raw), below Anthropic's 5 MB limit. */
export const MAX_VISION_IMAGE_BASE64_BYTES = 4_500_000;
/** ~1.43 MiB base64 (~1.1 MiB raw): above this, try high-quality optimization. */
export const SOFT_VISION_IMAGE_BASE64_BYTES = 1_500_000;

const OPPORTUNISTIC_MIN_SAVINGS_RATIO = 0.65;
const OPPORTUNISTIC_QUALITY = 0.9;
const MAX_WEBP_QUALITY = 0.92;
const MIN_WEBP_QUALITY = 0.6;
const MAX_JPEG_QUALITY = 0.92;
const MIN_JPEG_QUALITY = 0.55;
const QUALITY_SEARCH_TOLERANCE = 0.04;
const QUALITY_SEARCH_MAX_STEPS = 3;
const MAX_SCALE_ROUNDS = 8;
const MIN_SCALE_FACTOR = 0.1;

export interface PreparedVisionImage {
  mimeType: string;
  data: string;
  /** True when the image was resized or re-encoded rather than kept verbatim. */
  compressed: boolean;
  originalWidth?: number;
  originalHeight?: number;
  width?: number;
  height?: number;
}

export interface VisionImageResizeOptions {
  maxWidth?: number;
  maxHeight?: number;
  maxBase64Bytes?: number;
  /**
   * Soft byte budget (base64 chars) above which within-dimension images are
   * opportunistically optimized at high quality if doing so saves >= 35%.
   * Set to Infinity to disable opportunistic optimization.
   */
  softTargetBase64Bytes?: number;
}

export function extractBase64FromDataUrl(dataUrl: string): string {
  const commaIndex = dataUrl.indexOf(",");
  return commaIndex !== -1 ? dataUrl.slice(commaIndex + 1) : dataUrl;
}

export function computeScaledDimensions(
  width: number,
  height: number,
  maxWidth = MAX_VISION_IMAGE_DIMENSION,
  maxHeight = MAX_VISION_IMAGE_DIMENSION,
): { width: number; height: number; scaled: boolean } {
  if (width <= 0 || height <= 0) {
    return { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)), scaled: false };
  }
  const ratio = Math.min(1, maxWidth / width, maxHeight / height);
  if (ratio >= 1) {
    return { width: Math.round(width), height: Math.round(height), scaled: false };
  }
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
    scaled: true,
  };
}

/**
 * Dynamically allocate a base64 byte budget for the next image in a multi-image
 * turn so sending 6-10 large images succeeds within the total turn cap instead
 * of failing on the later attachments.
 */
export function computePerImageBase64Budget(
  remainingTotalBase64Bytes: number,
  remainingImageCount: number,
  singleImageMax = MAX_VISION_IMAGE_BASE64_BYTES,
): number {
  const safeRemaining = Math.max(0, remainingTotalBase64Bytes);
  if (remainingImageCount <= 1) {
    return Math.min(singleImageMax, safeRemaining);
  }
  return Math.min(singleImageMax, Math.floor(safeRemaining / remainingImageCount));
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read image file"));
    reader.readAsDataURL(file);
  });
}

function loadHtmlImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to decode image"));
    img.src = src;
  });
}

interface EncodedCandidate {
  mimeType: string;
  data: string;
  width: number;
  height: number;
}

function encodeExistingCanvas(
  canvas: HTMLCanvasElement,
  mimeType: string,
  quality?: number,
): EncodedCandidate | null {
  const dataUrl = quality !== undefined ? canvas.toDataURL(mimeType, quality) : canvas.toDataURL(mimeType);
  if (!dataUrl || !dataUrl.startsWith(`data:${mimeType}`)) {
    return null;
  }
  const data = extractBase64FromDataUrl(dataUrl);
  return data ? { mimeType, data, width: canvas.width, height: canvas.height } : null;
}

function pickSmaller(a: EncodedCandidate | null, b: EncodedCandidate | null): EncodedCandidate | null {
  if (!a) return b;
  if (!b) return a;
  return b.data.length < a.data.length ? b : a;
}

function releaseCanvas(canvas: HTMLCanvasElement | null | undefined) {
  if (!canvas) return;
  canvas.width = 0;
  canvas.height = 0;
}

/**
 * Sample an alpha-capable image on a tiny canvas to detect transparency and
 * pick a contrasting matte color if JPEG fallback is needed (avoiding invisible
 * white icons/text on transparent backgrounds).
 */
function analyzeTransparencyMatte(
  img: HTMLImageElement,
  naturalWidth: number,
  naturalHeight: number,
  initialMimeType: string,
): { hasAlpha: boolean; jpegMatte: string } {
  if (initialMimeType !== "image/png" && initialMimeType !== "image/webp") {
    return { hasAlpha: false, jpegMatte: "#ffffff" };
  }
  const sampleW = Math.max(1, Math.min(32, naturalWidth));
  const sampleH = Math.max(1, Math.min(32, naturalHeight));
  const sample = document.createElement("canvas");
  sample.width = sampleW;
  sample.height = sampleH;
  try {
    const ctx = sample.getContext("2d");
    if (!ctx || typeof ctx.getImageData !== "function") {
      return { hasAlpha: true, jpegMatte: "#ffffff" };
    }
    ctx.drawImage(img, 0, 0, sampleW, sampleH);
    const pixels = ctx.getImageData(0, 0, sampleW, sampleH).data;
    let hasAlpha = false;
    let weightedLuminance = 0;
    let totalWeight = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      const a = pixels[i + 3];
      if (a < 250) hasAlpha = true;
      if (a >= 32) {
        const weight = a / 255;
        weightedLuminance += (0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2]) * weight;
        totalWeight += weight;
      }
    }
    if (!hasAlpha) {
      return { hasAlpha: false, jpegMatte: "#ffffff" };
    }
    const avgLuminance = totalWeight > 0 ? weightedLuminance / totalWeight : 0;
    return {
      hasAlpha: true,
      jpegMatte: avgLuminance > 185 ? "#1e1e1e" : "#ffffff",
    };
  } catch {
    return { hasAlpha: true, jpegMatte: "#ffffff" };
  } finally {
    releaseCanvas(sample);
  }
}

/**
 * Draw `img` onto a target-sized canvas, using progressive halving when
 * downscaling by more than 2x so text and 1px UI borders stay sharp.
 */
function createScaledCanvas(
  img: HTMLImageElement,
  srcWidth: number,
  srcHeight: number,
  targetWidth: number,
  targetHeight: number,
): HTMLCanvasElement | null {
  const needsProgressive = srcWidth > targetWidth * 2 || srcHeight > targetHeight * 2;
  let source: CanvasImageSource = img;
  let curW = srcWidth;
  let curH = srcHeight;
  let intermediate: HTMLCanvasElement | null = null;

  try {
    if (needsProgressive) {
      while (curW > targetWidth * 2 || curH > targetHeight * 2) {
        const nextW = Math.max(targetWidth, Math.ceil(curW / 2));
        const nextH = Math.max(targetHeight, Math.ceil(curH / 2));
        if (nextW === curW && nextH === curH) break;
        const stepCanvas = document.createElement("canvas");
        stepCanvas.width = nextW;
        stepCanvas.height = nextH;
        const stepCtx = stepCanvas.getContext("2d");
        if (!stepCtx) {
          releaseCanvas(stepCanvas);
          break;
        }
        stepCtx.imageSmoothingEnabled = true;
        stepCtx.imageSmoothingQuality = "high";
        stepCtx.drawImage(source, 0, 0, nextW, nextH);
        releaseCanvas(intermediate);
        intermediate = stepCanvas;
        source = stepCanvas;
        curW = nextW;
        curH = nextH;
      }
    }

    const canvas = document.createElement("canvas");
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      releaseCanvas(canvas);
      return null;
    }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(source, 0, 0, targetWidth, targetHeight);
    return canvas;
  } finally {
    releaseCanvas(intermediate);
  }
}

function paintMatteBehindCanvas(canvas: HTMLCanvasElement, matteColor: string) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.globalCompositeOperation = "destination-over";
  ctx.fillStyle = matteColor;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.globalCompositeOperation = "source-over";
}

interface QualitySearchResult {
  fit: EncodedCandidate | null;
  smallest: EncodedCandidate | null;
  supported: boolean;
}

/**
 * Binary-search encoder quality in [minQuality, maxQuality] to find the highest
 * quality that fits within `maxBytes` using at most ~5 encodes (usually 1-2).
 */
function binarySearchQuality(
  canvas: HTMLCanvasElement,
  mimeType: string,
  maxBytes: number,
  minQuality: number,
  maxQuality: number,
): QualitySearchResult {
  const high = encodeExistingCanvas(canvas, mimeType, maxQuality);
  if (!high) {
    return { fit: null, smallest: null, supported: false };
  }
  if (high.data.length <= maxBytes) {
    return { fit: high, smallest: high, supported: true };
  }

  const low = encodeExistingCanvas(canvas, mimeType, minQuality);
  if (!low) {
    return { fit: null, smallest: high, supported: true };
  }
  if (low.data.length > maxBytes) {
    return { fit: null, smallest: pickSmaller(high, low), supported: true };
  }

  let lo = minQuality;
  let hi = maxQuality;
  let bestFit = low;
  let smallest = pickSmaller(high, low);

  for (let step = 0; step < QUALITY_SEARCH_MAX_STEPS && hi - lo > QUALITY_SEARCH_TOLERANCE; step++) {
    const mid = Math.round(((lo + hi) / 2) * 100) / 100;
    if (mid <= lo || mid >= hi) break;
    const candidate = encodeExistingCanvas(canvas, mimeType, mid);
    if (!candidate) break;
    smallest = pickSmaller(smallest, candidate);
    if (candidate.data.length <= maxBytes) {
      bestFit = candidate;
      lo = mid;
    } else {
      hi = mid;
    }
  }

  return { fit: bestFit, smallest, supported: true };
}

function computeNextAdaptiveScale(
  currentScale: number,
  smallestBytes: number | null,
  maxBase64Bytes: number,
): number {
  if (!smallestBytes || smallestBytes <= maxBase64Bytes) {
    return currentScale * 0.72;
  }
  // Byte size scales roughly with pixel area (~scale^2); add a small safety margin.
  const estimatedRatio = Math.sqrt(maxBase64Bytes / smallestBytes) * 0.92;
  const clampedRatio = Math.max(0.45, Math.min(0.85, estimatedRatio));
  return currentScale * clampedRatio;
}

export async function prepareVisionImageAttachment(
  file: File,
  initialMimeType: string,
  existingPreviewUrl?: string | null,
  options?: VisionImageResizeOptions,
): Promise<PreparedVisionImage> {
  const maxWidth = options?.maxWidth ?? MAX_VISION_IMAGE_DIMENSION;
  const maxHeight = options?.maxHeight ?? MAX_VISION_IMAGE_DIMENSION;
  const maxBase64Bytes = options?.maxBase64Bytes ?? MAX_VISION_IMAGE_BASE64_BYTES;
  const softTargetBase64Bytes = Math.min(
    options?.softTargetBase64Bytes ?? SOFT_VISION_IMAGE_BASE64_BYTES,
    maxBase64Bytes,
  );

  const existingDataUrl = existingPreviewUrl?.startsWith("data:") ? existingPreviewUrl : null;
  const existingBlobUrl = existingPreviewUrl?.startsWith("blob:") ? existingPreviewUrl : null;

  let cachedOriginal: { mimeType: string; data: string } | null = existingDataUrl
    ? { mimeType: initialMimeType, data: extractBase64FromDataUrl(existingDataUrl) }
    : null;
  const readOriginal = async (): Promise<{ mimeType: string; data: string }> => {
    if (cachedOriginal) return cachedOriginal;
    const dataUrl = await readFileAsDataUrl(file);
    cachedOriginal = { mimeType: initialMimeType, data: extractBase64FromDataUrl(dataUrl) };
    return cachedOriginal;
  };

  // Preserve animated GIFs untouched whenever they already fit the byte budget.
  if (initialMimeType === "image/gif") {
    const estimatedBase64 = cachedOriginal
      ? cachedOriginal.data.length
      : Math.ceil(file.size / 3) * 4;
    if (estimatedBase64 <= maxBase64Bytes) {
      const original = await readOriginal();
      if (original.data.length <= maxBase64Bytes) {
        return { ...original, compressed: false };
      }
    }
  }

  if (typeof Image === "undefined" || typeof document === "undefined") {
    const original = await readOriginal();
    if (original.data.length > maxBase64Bytes) {
      throw new Error("Image exceeds maximum supported size");
    }
    return { ...original, compressed: false };
  }

  let temporaryObjectUrl: string | null = null;
  let img: HTMLImageElement;
  try {
    let imageSrc = existingDataUrl || existingBlobUrl;
    if (!imageSrc) {
      if (typeof URL !== "undefined" && typeof URL.createObjectURL === "function") {
        temporaryObjectUrl = URL.createObjectURL(file);
        imageSrc = temporaryObjectUrl;
      } else {
        const original = await readOriginal();
        imageSrc = `data:${original.mimeType};base64,${original.data}`;
      }
    }
    img = await loadHtmlImage(imageSrc);
  } catch {
    if (temporaryObjectUrl) URL.revokeObjectURL(temporaryObjectUrl);
    const original = await readOriginal();
    if (original.data.length > maxBase64Bytes) {
      throw new Error("Image could not be decoded or compressed within size limit");
    }
    return { ...original, compressed: false };
  }

  try {
    const naturalWidth = img.naturalWidth || img.width;
    const naturalHeight = img.naturalHeight || img.height;
    const initialTarget = computeScaledDimensions(naturalWidth, naturalHeight, maxWidth, maxHeight);
    const estimatedOriginalBase64 = cachedOriginal
      ? cachedOriginal.data.length
      : Math.ceil(file.size / 3) * 4;

    // Fast path: within dimensions and already compact -> keep verbatim.
    if (!initialTarget.scaled && estimatedOriginalBase64 <= softTargetBase64Bytes) {
      const original = await readOriginal();
      if (original.data.length <= softTargetBase64Bytes) {
        return {
          ...original,
          compressed: false,
          originalWidth: naturalWidth,
          originalHeight: naturalHeight,
          width: naturalWidth,
          height: naturalHeight,
        };
      }
    }

    const { hasAlpha, jpegMatte } = analyzeTransparencyMatte(
      img,
      naturalWidth,
      naturalHeight,
      initialMimeType,
    );

    // Opportunistic path: within dimensions and within hard limit, but bloated
    // (e.g., a 3 MiB uncompressed 1080p PNG screenshot). Re-encode at full
    // resolution and high quality only when it yields a >= 35% size reduction.
    if (!initialTarget.scaled && estimatedOriginalBase64 <= maxBase64Bytes) {
      const original = await readOriginal();
      if (original.data.length <= maxBase64Bytes) {
        if (original.data.length <= softTargetBase64Bytes) {
          return {
            ...original,
            compressed: false,
            originalWidth: naturalWidth,
            originalHeight: naturalHeight,
            width: naturalWidth,
            height: naturalHeight,
          };
        }
        const savingsCap = Math.min(
          maxBase64Bytes,
          Math.floor(original.data.length * OPPORTUNISTIC_MIN_SAVINGS_RATIO),
        );
        const canvas = createScaledCanvas(img, naturalWidth, naturalHeight, naturalWidth, naturalHeight);
        if (canvas) {
          try {
            const webp = encodeExistingCanvas(canvas, "image/webp", OPPORTUNISTIC_QUALITY);
            if (webp && webp.data.length <= savingsCap) {
              return {
                mimeType: webp.mimeType,
                data: webp.data,
                compressed: true,
                originalWidth: naturalWidth,
                originalHeight: naturalHeight,
                width: webp.width,
                height: webp.height,
              };
            }
            if (!hasAlpha || !webp) {
              paintMatteBehindCanvas(canvas, jpegMatte);
              const jpeg = encodeExistingCanvas(canvas, "image/jpeg", OPPORTUNISTIC_QUALITY);
              if (jpeg && jpeg.data.length <= savingsCap) {
                return {
                  mimeType: jpeg.mimeType,
                  data: jpeg.data,
                  compressed: true,
                  originalWidth: naturalWidth,
                  originalHeight: naturalHeight,
                  width: jpeg.width,
                  height: jpeg.height,
                };
              }
            }
          } finally {
            releaseCanvas(canvas);
          }
        }
        return {
          ...original,
          compressed: false,
          originalWidth: naturalWidth,
          originalHeight: naturalHeight,
          width: naturalWidth,
          height: naturalHeight,
        };
      }
    }

    let best: EncodedCandidate | null = null;
    let webpSupported: boolean | null = null;
    let scale = 1;
    let prevWidth = Infinity;
    let prevHeight = Infinity;

    for (let round = 0; round < MAX_SCALE_ROUNDS && scale >= MIN_SCALE_FACTOR; round++) {
      let width = Math.max(1, Math.round(initialTarget.width * scale));
      let height = Math.max(1, Math.round(initialTarget.height * scale));
      if (round > 0 && width >= prevWidth && height >= prevHeight) {
        width = Math.max(1, Math.floor(prevWidth * 0.8));
        height = Math.max(1, Math.floor(prevHeight * 0.8));
        if (width === prevWidth && height === prevHeight) break;
      }
      prevWidth = width;
      prevHeight = height;

      const canvas = createScaledCanvas(img, naturalWidth, naturalHeight, width, height);
      if (!canvas) continue;

      let scaleSmallest: EncodedCandidate | null = null;
      try {
        let pngWithinLimit: EncodedCandidate | null = null;

        // 1. Preserve lossless PNG at full target scale when compact (great for diagrams/UI/text).
        if (round === 0 && initialMimeType === "image/png") {
          const png = encodeExistingCanvas(canvas, "image/png");
          scaleSmallest = pickSmaller(scaleSmallest, png);
          best = pickSmaller(best, png);
          if (png && png.data.length <= softTargetBase64Bytes) {
            return {
              mimeType: png.mimeType,
              data: png.data,
              compressed: true,
              originalWidth: naturalWidth,
              originalHeight: naturalHeight,
              width: png.width,
              height: png.height,
            };
          }
          if (png && png.data.length <= maxBase64Bytes) {
            pngWithinLimit = png;
          }
        }

        // 2. Prefer WebP (preserves alpha, sharper text/edges, smaller than JPEG) when supported.
        if (webpSupported !== false) {
          if (pngWithinLimit) {
            const webp = encodeExistingCanvas(canvas, "image/webp", OPPORTUNISTIC_QUALITY);
            if (!webp) {
              webpSupported = false;
            } else {
              webpSupported = true;
              best = pickSmaller(best, webp);
              if (webp.data.length <= Math.floor(pngWithinLimit.data.length * OPPORTUNISTIC_MIN_SAVINGS_RATIO)) {
                return {
                  mimeType: webp.mimeType,
                  data: webp.data,
                  compressed: true,
                  originalWidth: naturalWidth,
                  originalHeight: naturalHeight,
                  width: webp.width,
                  height: webp.height,
                };
              }
            }
          } else {
            const webpSearch = binarySearchQuality(
              canvas,
              "image/webp",
              maxBase64Bytes,
              MIN_WEBP_QUALITY,
              MAX_WEBP_QUALITY,
            );
            webpSupported = webpSearch.supported;
            scaleSmallest = pickSmaller(scaleSmallest, webpSearch.smallest);
            best = pickSmaller(best, webpSearch.smallest);
            if (webpSearch.fit) {
              return {
                mimeType: webpSearch.fit.mimeType,
                data: webpSearch.fit.data,
                compressed: true,
                originalWidth: naturalWidth,
                originalHeight: naturalHeight,
                width: webpSearch.fit.width,
                height: webpSearch.fit.height,
              };
            }
          }
        }

        // 3. Fallback to JPEG with smart matte and binary-searched quality.
        paintMatteBehindCanvas(canvas, jpegMatte);
        if (pngWithinLimit) {
          if (!hasAlpha || webpSupported === false) {
            const jpeg = encodeExistingCanvas(canvas, "image/jpeg", OPPORTUNISTIC_QUALITY);
            best = pickSmaller(best, jpeg);
            if (jpeg && jpeg.data.length <= Math.floor(pngWithinLimit.data.length * OPPORTUNISTIC_MIN_SAVINGS_RATIO)) {
              return {
                mimeType: jpeg.mimeType,
                data: jpeg.data,
                compressed: true,
                originalWidth: naturalWidth,
                originalHeight: naturalHeight,
                width: jpeg.width,
                height: jpeg.height,
              };
            }
          }
          // Lossless PNG was already within hard budget and lossy didn't save >= 35%.
          return {
            mimeType: pngWithinLimit.mimeType,
            data: pngWithinLimit.data,
            compressed: true,
            originalWidth: naturalWidth,
            originalHeight: naturalHeight,
            width: pngWithinLimit.width,
            height: pngWithinLimit.height,
          };
        }

        const jpegSearch = binarySearchQuality(
          canvas,
          "image/jpeg",
          maxBase64Bytes,
          MIN_JPEG_QUALITY,
          MAX_JPEG_QUALITY,
        );
        scaleSmallest = pickSmaller(scaleSmallest, jpegSearch.smallest);
        best = pickSmaller(best, jpegSearch.smallest);
        if (jpegSearch.fit) {
          return {
            mimeType: jpegSearch.fit.mimeType,
            data: jpegSearch.fit.data,
            compressed: true,
            originalWidth: naturalWidth,
            originalHeight: naturalHeight,
            width: jpegSearch.fit.width,
            height: jpegSearch.fit.height,
          };
        }
      } finally {
        // Release GPU backing store promptly on WebKit/WKWebView.
        releaseCanvas(canvas);
      }

      scale = computeNextAdaptiveScale(
        scale,
        scaleSmallest ? scaleSmallest.data.length : null,
        maxBase64Bytes,
      );
    }

    if (best && best.data.length <= maxBase64Bytes) {
      return {
        mimeType: best.mimeType,
        data: best.data,
        compressed: true,
        originalWidth: naturalWidth,
        originalHeight: naturalHeight,
        width: best.width,
        height: best.height,
      };
    }
    throw new Error("Image exceeds maximum supported size after compression");
  } finally {
    if (temporaryObjectUrl) URL.revokeObjectURL(temporaryObjectUrl);
  }
}
