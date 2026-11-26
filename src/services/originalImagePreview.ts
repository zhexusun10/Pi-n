import type { GraphEvent, ImageAttachment } from "../types";
import { runtimeService } from "./runtime";

const MAX_FINGERPRINT_ENTRIES = 512;
const MAX_CACHED_OBJECT_URLS = 24;
const MAX_SESSION_BLOBS = 8;

const fingerprintToOriginalPath = new Map<string, string>();
const resolvedObjectUrls = new Map<string, string>();
const inFlightLoads = new Map<string, Promise<string | null>>();
const sessionOriginalBlobs = new Map<string, Blob>();
const registeredBlobUrls = new Map<string, Blob>();

export function registerImageBlobUrl(url: string, blob: Blob): string {
  registeredBlobUrls.set(url, blob);
  return url;
}

export function unregisterImageBlobUrl(url: string | null | undefined): void {
  if (!url) return;
  registeredBlobUrls.delete(url);
}

export function getRegisteredImageBlob(url: string | null | undefined): Blob | null {
  if (!url) return null;
  return registeredBlobUrls.get(url) ?? null;
}

export interface OriginalPreviewTarget {
  originalPath?: string;
  runId?: string;
  sessionOriginalKey?: string;
}

export function imageAttachmentFingerprint(
  image: Pick<ImageAttachment, "mimeType" | "data">,
): string {
  const data = image.data || "";
  const len = data.length;
  const head = data.slice(0, 64);
  const midStart = Math.max(0, Math.floor((len - 64) / 2));
  const mid = len > 128 ? data.slice(midStart, midStart + 64) : "";
  const tail = len > 64 ? data.slice(-64) : "";
  return `${image.mimeType || "image/png"}:${len}:${head}:${mid}:${tail}`;
}

export function indexOriginalImagePath(
  image: Pick<ImageAttachment, "mimeType" | "data" | "originalPath"> | null | undefined,
): void {
  if (!image?.originalPath || !image.data) return;
  const key = imageAttachmentFingerprint(image);
  if (fingerprintToOriginalPath.has(key)) {
    fingerprintToOriginalPath.delete(key);
  }
  fingerprintToOriginalPath.set(key, image.originalPath);
  if (fingerprintToOriginalPath.size > MAX_FINGERPRINT_ENTRIES) {
    const oldest = fingerprintToOriginalPath.keys().next().value;
    if (oldest !== undefined) fingerprintToOriginalPath.delete(oldest);
  }
}

export function indexOriginalImagePathsFromEvents(
  events: readonly GraphEvent[] | undefined,
): void {
  if (!events?.length) return;
  for (const event of events) {
    if (!event.images?.length) continue;
    for (const image of event.images) {
      indexOriginalImagePath(image);
    }
  }
}

export function resolveOriginalImagePath(
  image: Pick<ImageAttachment, "mimeType" | "data" | "originalPath">,
): string | undefined {
  if (image.originalPath) {
    indexOriginalImagePath(image);
    return image.originalPath;
  }
  if (!image.data) return undefined;
  return fingerprintToOriginalPath.get(imageAttachmentFingerprint(image));
}

export function rememberSessionOriginalImage(
  image: Pick<ImageAttachment, "mimeType" | "data">,
  blob: Blob,
): string {
  const key = imageAttachmentFingerprint(image);
  if (sessionOriginalBlobs.has(key)) {
    sessionOriginalBlobs.delete(key);
  }
  sessionOriginalBlobs.set(key, blob);
  if (sessionOriginalBlobs.size > MAX_SESSION_BLOBS) {
    const oldest = sessionOriginalBlobs.keys().next().value;
    if (oldest !== undefined) sessionOriginalBlobs.delete(oldest);
  }
  return key;
}

function cacheKeyForTarget(target: OriginalPreviewTarget): string | null {
  if (target.originalPath) return `path:${target.originalPath}`;
  if (target.sessionOriginalKey && sessionOriginalBlobs.has(target.sessionOriginalKey)) {
    return `session:${target.sessionOriginalKey}`;
  }
  return null;
}

function storeCachedUrl(cacheKey: string, url: string, blob: Blob): string {
  if (resolvedObjectUrls.has(cacheKey)) {
    const existing = resolvedObjectUrls.get(cacheKey)!;
    resolvedObjectUrls.delete(cacheKey);
    resolvedObjectUrls.set(cacheKey, existing);
    if (existing !== url && typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") {
      unregisterImageBlobUrl(url);
      URL.revokeObjectURL(url);
    }
    return existing;
  }
  registerImageBlobUrl(url, blob);
  resolvedObjectUrls.set(cacheKey, url);
  while (resolvedObjectUrls.size > MAX_CACHED_OBJECT_URLS) {
    const oldestKey = resolvedObjectUrls.keys().next().value;
    if (oldestKey === undefined) break;
    const oldestUrl = resolvedObjectUrls.get(oldestKey);
    resolvedObjectUrls.delete(oldestKey);
    if (oldestUrl && typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") {
      unregisterImageBlobUrl(oldestUrl);
      URL.revokeObjectURL(oldestUrl);
    }
  }
  return url;
}

export function getCachedOriginalImageUrl(target: OriginalPreviewTarget): string | null {
  const cacheKey = cacheKeyForTarget(target);
  if (!cacheKey) return null;
  const cached = resolvedObjectUrls.get(cacheKey);
  if (!cached) return null;
  // Refresh LRU recency.
  resolvedObjectUrls.delete(cacheKey);
  resolvedObjectUrls.set(cacheKey, cached);
  return cached;
}

export async function loadOriginalImageUrl(
  target: OriginalPreviewTarget,
): Promise<string | null> {
  if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
    return null;
  }
  const cacheKey = cacheKeyForTarget(target);
  if (!cacheKey) return null;

  const cached = getCachedOriginalImageUrl(target);
  if (cached) return cached;

  if (target.sessionOriginalKey && sessionOriginalBlobs.has(target.sessionOriginalKey)) {
    const blob = sessionOriginalBlobs.get(target.sessionOriginalKey)!;
    return storeCachedUrl(cacheKey, URL.createObjectURL(blob), blob);
  }

  if (!target.originalPath) return null;

  const existingLoad = inFlightLoads.get(cacheKey);
  if (existingLoad) {
    return existingLoad;
  }

  const originalPath = target.originalPath;
  const promise = runtimeService
    .getAttachmentImage(originalPath, target.runId)
    .then((blob) => storeCachedUrl(cacheKey, URL.createObjectURL(blob), blob))
    .catch(() => null)
    .finally(() => {
      if (inFlightLoads.get(cacheKey) === promise) {
        inFlightLoads.delete(cacheKey);
      }
    });

  inFlightLoads.set(cacheKey, promise);
  return promise;
}
