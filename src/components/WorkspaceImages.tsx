import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, type ReactNode, type RefObject } from "react";
import { runtimeService } from "../services/runtime";
import { registerImageBlobUrl, unregisterImageBlobUrl } from "../services/originalImagePreview";
import { notifyTranscriptContentGrowth } from "../services/transcriptScroll";
import { t } from "../i18n";

const useIsomorphicLayoutEffect = typeof document !== "undefined" ? useLayoutEffect : useEffect;

export const WORKSPACE_IMAGE_SETTLED_EVENT = "pi-n:workspace-image-settled";

type ImageScope = { runId: string; executionId?: string };
const WorkspaceImageScope = createContext<ImageScope | null>(null);

interface ImageResource {
  abort: AbortController;
  pending: Promise<string>;
  url?: string;
  decoded?: boolean;
}

function releaseImage(resource: ImageResource) {
  resource.abort.abort();
  if (resource.url) {
    unregisterImageBlobUrl(resource.url);
    URL.revokeObjectURL(resource.url);
  }
}

function decodeImageUrl(url: string, signal: AbortSignal): Promise<void> {
  if (signal.aborted || typeof Image === "undefined") return Promise.resolve();
  return new Promise((resolve) => {
    const probe = new Image();
    const finish = () => {
      signal.removeEventListener("abort", onAbort);
      probe.onload = null;
      probe.onerror = null;
      resolve();
    };
    const onAbort = () => {
      probe.src = "";
      finish();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    probe.onload = () => {
      if (typeof probe.decode === "function") {
        probe.decode().then(finish, finish);
      } else {
        finish();
      }
    };
    probe.onerror = finish;
    probe.src = url;
  });
}

export function WorkspaceImageProvider({ runId, executionId, children }: ImageScope & { children: ReactNode }) {
  const scope = useMemo(() => ({ runId, executionId }), [runId, executionId]);
  return <WorkspaceImageScope.Provider value={scope}>{children}</WorkspaceImageScope.Provider>;
}

/** Hydrate only sanitized, inert local image placeholders. URLs belong to the
 * mounted Markdown, not the HTML/parse cache, and are revoked when no longer used. */
export function useWorkspaceImages(root: RefObject<HTMLDivElement | null>, html: string): string {
  const scope = useContext(WorkspaceImageScope);
  const runId = scope?.runId;
  const executionId = scope?.executionId;
  const resources = useRef<{ entries: Map<string, ImageResource> } | null>(null);

  useIsomorphicLayoutEffect(() => {
    const store = { entries: new Map<string, ImageResource>() };
    resources.current = store;
    return () => {
      for (const resource of store.entries.values()) releaseImage(resource);
      store.entries.clear();
      resources.current = null;
    };
  }, [runId, executionId]);

  useIsomorphicLayoutEffect(() => {
    const store = resources.current;
    const container = root.current;
    if (!store || !container) return;
    const notifySettled = () => {
      container.dispatchEvent(new CustomEvent(WORKSPACE_IMAGE_SETTLED_EVENT, { bubbles: true }));
    };
    const paths = new Set(Array.from(container.querySelectorAll<HTMLElement>("[data-workspace-path]"),
      element => element.dataset.workspacePath));
    for (const [path, resource] of store.entries) {
      if (paths.has(path)) continue;
      store.entries.delete(path);
      releaseImage(resource);
    }
    let disposed = false;
    const failed = (image: HTMLImageElement) => {
      if (disposed || !container.contains(image)) return;
      const message = `${t("无法加载图片")} · ${image.alt || image.dataset.workspacePath || ""}`;
      if (image.dataset.managedImage === "true") {
        image.removeAttribute("aria-busy");
        image.dispatchEvent(new CustomEvent("pi-n:image-error", { detail: { message } }));
        notifyTranscriptContentGrowth(container);
        notifySettled();
        return;
      }
      const fallback = document.createElement("span");
      fallback.className = "markdown-image-error";
      // Keep failed paths referenced while their fallback remains mounted.
      if (image.dataset.workspacePath) fallback.dataset.workspacePath = image.dataset.workspacePath;
      fallback.setAttribute("role", "img");
      fallback.textContent = message;
      fallback.setAttribute("aria-label", message);
      image.replaceWith(fallback);
      notifyTranscriptContentGrowth(container);
      notifySettled();
    };
    for (const image of container.querySelectorAll<HTMLImageElement>("img")) {
      image.onload = () => {
        notifyTranscriptContentGrowth(container);
        notifySettled();
      };
      image.onerror = () => failed(image);
      if (!image.dataset.workspacePath) continue;
      if (!runId) { failed(image); continue; }
      const path = image.dataset.workspacePath!;
      let resource = store.entries.get(path);
      if (!resource) {
        const abort = new AbortController();
        const entry: ImageResource = {
          abort,
          pending: runtimeService.getWorkspaceImage(runId, path, executionId, abort.signal).then(async blob => {
            if (abort.signal.aborted || store.entries.get(path) !== entry) throw new Error("Image retired");
            const url = registerImageBlobUrl(URL.createObjectURL(blob), blob);
            entry.url = url;
            await decodeImageUrl(url, abort.signal);
            if (abort.signal.aborted || store.entries.get(path) !== entry) throw new Error("Image retired");
            entry.decoded = true;
            return url;
          }),
        };
        resource = entry;
        store.entries.set(path, entry);
      }
      const attachResolvedUrl = (url: string) => {
        if (disposed || resource!.abort.signal.aborted || !container.contains(image)) return;
        const onReady = () => {
          if (disposed || resource!.abort.signal.aborted || !container.contains(image)) return;
          image.removeAttribute("aria-busy");
          notifyTranscriptContentGrowth(container);
          notifySettled();
        };
        if (image.getAttribute("src") === url) {
          if (image.complete && image.naturalWidth > 0) {
            image.removeAttribute("aria-busy");
            notifySettled();
          } else {
            image.setAttribute("aria-busy", "true");
            image.onload = onReady;
            image.onerror = () => failed(image);
          }
          return;
        }
        image.decoding = "sync";
        image.onload = onReady;
        image.onerror = () => failed(image);
        image.src = url;
        if (image.complete && image.naturalWidth > 0) {
          image.onload = null;
          onReady();
        }
      };
      if (resource.decoded && resource.url) {
        attachResolvedUrl(resource.url);
        continue;
      }
      if (!image.getAttribute("src")) image.setAttribute("aria-busy", "true");
      resource.pending.then(attachResolvedUrl).catch(() => failed(image));
    }
    return () => { disposed = true; };
  }, [root, html, runId, executionId]);
  // Replace the DOM too when scope changes: an old blob/failure placeholder
  // must never remain visible while another conversation's image loads.
  return JSON.stringify([runId, executionId]);
}
