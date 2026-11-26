import { isSafeInlineImageDataUrl } from "./workspaceImages";

export const IMAGE_STACK_MIN_COUNT = 3;

export interface StackedMarkdownImage {
  src?: string;
  workspacePath?: string;
  alt: string;
  title?: string;
  width?: string;
  height?: string;
  loading?: string;
  decoding?: string;
  referrerpolicy?: string;
}

export type MarkdownSegment =
  | { type: "html"; blocks: string[] | null; html: string; key: string }
  | { type: "image-stack"; images: StackedMarkdownImage[]; trailingCursor?: boolean; key: string };

const STREAMING_CURSOR_RE = /^<span\s+class="thinking-streaming-cursor"\s*><\/span>/i;
const IMG_TAG_OPEN_RE = /^<img\b([^>]*?)\s*\/?>/i;
const BR_TAG_RE = /^<br\s*\/?>/i;
const ATTR_RE = /([a-zA-Z_:][a-zA-Z0-9_.:-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

function decodeHtmlEntities(value: string): string {
  if (!value.includes("&")) return value;
  return value.replace(/&(?:#x([0-9a-f]+)|#([0-9]+)|([a-z]+));/gi, (match, hex, dec, named) => {
    if (hex) {
      const code = Number.parseInt(hex, 16);
      return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    if (dec) {
      const code = Number.parseInt(dec, 10);
      return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    switch (named.toLowerCase()) {
      case "amp": return "&";
      case "lt": return "<";
      case "gt": return ">";
      case "quot": return "\"";
      case "apos": return "'";
      case "nbsp": return "\u00a0";
      default: return match;
    }
  });
}

function parseImgTag(rawTag: string): StackedMarkdownImage | null {
  const match = IMG_TAG_OPEN_RE.exec(rawTag);
  if (!match) return null;
  const attrs: Record<string, string> = {};
  ATTR_RE.lastIndex = 0;
  let attrMatch: RegExpExecArray | null;
  while ((attrMatch = ATTR_RE.exec(match[1])) !== null) {
    const name = attrMatch[1].toLowerCase();
    const rawValue = attrMatch[2] ?? attrMatch[3] ?? attrMatch[4] ?? "";
    attrs[name] = decodeHtmlEntities(rawValue);
  }
  const src = attrs.src && (/^https?:\/\//i.test(attrs.src) || isSafeInlineImageDataUrl(attrs.src))
    ? attrs.src
    : undefined;
  const workspacePath = attrs["data-workspace-path"] || undefined;
  if (!src && !workspacePath) return null;
  return {
    ...(src ? { src } : {}),
    ...(workspacePath ? { workspacePath } : {}),
    alt: attrs.alt ?? "",
    ...(attrs.title ? { title: attrs.title } : {}),
    ...(attrs.width ? { width: attrs.width } : {}),
    ...(attrs.height ? { height: attrs.height } : {}),
    ...(attrs.loading ? { loading: attrs.loading } : {}),
    ...(attrs.decoding ? { decoding: attrs.decoding } : {}),
    ...(attrs.referrerpolicy ? { referrerpolicy: attrs.referrerpolicy } : {}),
  };
}

function countImgTags(html: string): number {
  let count = 0;
  let index = 0;
  const lower = html.toLowerCase();
  while ((index = lower.indexOf("<img", index)) !== -1) {
    const next = lower[index + 4];
    if (!next || /[\s/>]/.test(next)) count++;
    index += 4;
  }
  return count;
}

type InlinePiece =
  | { kind: "img"; image: StackedMarkdownImage; raw: string }
  | { kind: "sep"; raw: string }
  | { kind: "cursor"; raw: string }
  | { kind: "other"; raw: string };

function tokenizeInline(innerHtml: string): InlinePiece[] {
  const tokens: InlinePiece[] = [];
  let index = 0;
  const len = innerHtml.length;

  while (index < len) {
    const rest = innerHtml.slice(index);

    const wsMatch = /^[\s\u00a0]+/.exec(rest);
    if (wsMatch) {
      tokens.push({ kind: "sep", raw: wsMatch[0] });
      index += wsMatch[0].length;
      continue;
    }

    const brMatch = BR_TAG_RE.exec(rest);
    if (brMatch) {
      tokens.push({ kind: "sep", raw: brMatch[0] });
      index += brMatch[0].length;
      continue;
    }

    const cursorMatch = STREAMING_CURSOR_RE.exec(rest);
    if (cursorMatch) {
      tokens.push({ kind: "cursor", raw: cursorMatch[0] });
      index += cursorMatch[0].length;
      continue;
    }

    const imgMatch = IMG_TAG_OPEN_RE.exec(rest);
    if (imgMatch) {
      const image = parseImgTag(imgMatch[0]);
      if (image) {
        tokens.push({ kind: "img", image, raw: imgMatch[0] });
      } else {
        tokens.push({ kind: "other", raw: imgMatch[0] });
      }
      index += imgMatch[0].length;
      continue;
    }

    if (innerHtml[index] === "<") {
      const closeBracket = innerHtml.indexOf(">", index + 1);
      if (closeBracket !== -1) {
        tokens.push({ kind: "other", raw: innerHtml.slice(index, closeBracket + 1) });
        index = closeBracket + 1;
        continue;
      }
    }

    const nextTag = innerHtml.indexOf("<", index + 1);
    const end = nextTag === -1 ? len : nextTag;
    const chunk = innerHtml.slice(index, end);
    // Split trailing whitespace out of text chunks so separators stay clean.
    const trailingWs = /([\s\u00a0]+)$/.exec(chunk);
    if (trailingWs && trailingWs.index > 0) {
      tokens.push({ kind: "other", raw: chunk.slice(0, trailingWs.index) });
      tokens.push({ kind: "sep", raw: trailingWs[1] });
    } else {
      tokens.push({ kind: "other", raw: chunk });
    }
    index = end;
  }

  return tokens;
}

function trimEdgeSeparators(pieces: InlinePiece[]): string {
  let start = 0;
  let end = pieces.length;
  while (start < end && pieces[start].kind === "sep") start++;
  while (end > start && pieces[end - 1].kind === "sep") end--;
  return pieces.slice(start, end).map(piece => piece.raw).join("");
}

type BlockUnit =
  | { kind: "html"; html: string; groupId: number }
  | { kind: "images"; images: StackedMarkdownImage[]; rawFallback: string; trailingCursor: boolean; groupId: number; partial: boolean };

function extractParagraphUnits(block: string, groupId: number): BlockUnit[] {
  const match = /^\s*<p>([\s\S]*?)<\/p>\s*$/i.exec(block);
  if (!match) return [{ kind: "html", html: block, groupId }];
  const inner = match[1];
  if (!inner.toLowerCase().includes("<img")) {
    return [{ kind: "html", html: block, groupId }];
  }

  const tokens = tokenizeInline(inner);
  const imgCount = tokens.filter(token => token.kind === "img").length;
  if (imgCount === 0) return [{ kind: "html", html: block, groupId }];

  const hasOther = tokens.some(token => token.kind === "other");
  if (!hasOther) {
    const images = tokens.filter((t): t is Extract<InlinePiece, { kind: "img" }> => t.kind === "img").map(t => t.image);
    const trailingCursor = tokens.some(t => t.kind === "cursor");
    return [{ kind: "images", images, rawFallback: block, trailingCursor, groupId, partial: false }];
  }

  // Paragraph mixes prose and images (e.g. "Screenshots:\n![1](...)\n![2](...)\n![3](...)").
  // Partition into alternating prose chunks and contiguous image runs.
  const units: BlockUnit[] = [];
  let proseBuffer: InlinePiece[] = [];
  let i = 0;

  const flushProse = () => {
    const content = trimEdgeSeparators(proseBuffer);
    proseBuffer = [];
    if (content) units.push({ kind: "html", html: `<p>${content}</p>`, groupId });
  };

  while (i < tokens.length) {
    if (tokens[i].kind === "img") {
      let j = i;
      const runImages: StackedMarkdownImage[] = [];
      let runCursor = false;
      let lastImgIndex = i;
      while (j < tokens.length) {
        const current = tokens[j];
        if (current.kind === "img") {
          runImages.push(current.image);
          lastImgIndex = j;
          j++;
        } else if (current.kind === "sep") {
          j++;
        } else if (current.kind === "cursor") {
          // Cursor right after an image stays with the image run if no prose follows.
          let nextNonSep = j + 1;
          while (nextNonSep < tokens.length && tokens[nextNonSep].kind === "sep") nextNonSep++;
          if (nextNonSep >= tokens.length) {
            runCursor = true;
            lastImgIndex = j;
            j++;
          } else {
            break;
          }
        } else {
          break;
        }
      }

      const atStart = proseBuffer.every(p => p.kind === "sep") && units.length === 0;
      let nextNonSep = lastImgIndex + 1;
      while (nextNonSep < tokens.length && tokens[nextNonSep].kind === "sep") nextNonSep++;
      const atEnd = nextNonSep >= tokens.length;

      // Only split an image run out of a mixed paragraph if it can form a stack on its own
      // or sits at the paragraph boundary where it can merge with adjacent image blocks.
      if (runImages.length >= IMAGE_STACK_MIN_COUNT || atStart || atEnd) {
        flushProse();
        const rawRun = tokens.slice(i, lastImgIndex + 1).map(t => t.raw).join("");
        units.push({
          kind: "images",
          images: runImages,
          rawFallback: `<p>${rawRun}</p>`,
          trailingCursor: runCursor,
          groupId,
          partial: true,
        });
        i = lastImgIndex + 1;
        // Consume separators right after the extracted image run.
        while (i < tokens.length && tokens[i].kind === "sep") i++;
        continue;
      }

      // Mid-paragraph 1-2 inline images stay inline with prose.
      for (let k = i; k <= lastImgIndex; k++) proseBuffer.push(tokens[k]);
      i = lastImgIndex + 1;
      continue;
    }

    proseBuffer.push(tokens[i]);
    i++;
  }

  flushProse();
  return units.length > 0 ? units : [{ kind: "html", html: block, groupId }];
}

function extractImageListUnits(block: string, groupId: number): BlockUnit[] | null {
  const listMatch = /^\s*<(ul|ol)(?:\s+[^>]*)?>([\s\S]*?)<\/\1>\s*$/i.exec(block);
  if (!listMatch) return null;
  const inner = listMatch[2];
  if (!inner.toLowerCase().includes("<img")) return null;

  // Walk top-level <li>...</li> items without tripping on nested lists.
  const items: string[] = [];
  let index = 0;
  while (index < inner.length) {
    const ws = /^[\s\u00a0]+/.exec(inner.slice(index));
    if (ws) { index += ws[0].length; continue; }
    const openLi = /^<li\b[^>]*>/i.exec(inner.slice(index));
    if (!openLi) return null;
    index += openLi[0].length;
    const itemStart = index;
    let depth = 1;
    while (index < inner.length && depth > 0) {
      const nextTagIdx = inner.indexOf("<", index);
      if (nextTagIdx === -1) return null;
      const closeBracket = inner.indexOf(">", nextTagIdx + 1);
      if (closeBracket === -1) return null;
      const tag = inner.slice(nextTagIdx, closeBracket + 1);
      if (/^<li\b/i.test(tag)) depth++;
      else if (/^<\/li\s*>/i.test(tag)) {
        depth--;
        if (depth === 0) {
          items.push(inner.slice(itemStart, nextTagIdx));
          index = closeBracket + 1;
          break;
        }
      }
      index = closeBracket + 1;
    }
    if (depth !== 0) return null;
  }

  if (items.length === 0) return null;
  const allImages: StackedMarkdownImage[] = [];
  let trailingCursor = false;

  for (let i = 0; i < items.length; i++) {
    let content = items[i].trim();
    const wrappedP = /^<p>([\s\S]*?)<\/p>$/i.exec(content);
    if (wrappedP) content = wrappedP[1];
    const tokens = tokenizeInline(content);
    if (tokens.some(t => t.kind === "other")) return null;
    const itemImages = tokens.filter((t): t is Extract<InlinePiece, { kind: "img" }> => t.kind === "img").map(t => t.image);
    if (itemImages.length === 0) return null;
    allImages.push(...itemImages);
    if (i === items.length - 1 && tokens.some(t => t.kind === "cursor")) {
      trailingCursor = true;
    }
  }

  if (allImages.length < IMAGE_STACK_MIN_COUNT) return null;
  return [{ kind: "images", images: allImages, rawFallback: block, trailingCursor, groupId, partial: false }];
}

function splitTopLevelHtmlBlocks(html: string): string[] {
  const blocks: string[] = [];
  let index = 0;
  const len = html.length;

  while (index < len) {
    const ws = /^[\s\u00a0]+/.exec(html.slice(index));
    if (ws) {
      index += ws[0].length;
      continue;
    }
    if (html[index] !== "<") {
      const next = html.indexOf("<", index);
      const end = next === -1 ? len : next;
      const text = html.slice(index, end);
      if (text.trim()) blocks.push(text);
      index = end;
      continue;
    }

    const openMatch = /^<([a-z][a-z0-9-]*)\b[^>]*>/i.exec(html.slice(index));
    if (!openMatch) {
      const closeBracket = html.indexOf(">", index + 1);
      const end = closeBracket === -1 ? len : closeBracket + 1;
      blocks.push(html.slice(index, end));
      index = end;
      continue;
    }

    const tagName = openMatch[1].toLowerCase();
    const openTag = openMatch[0];
    if (VOID_TAGS.has(tagName) || /\/>\s*$/.test(openTag)) {
      blocks.push(openTag);
      index += openTag.length;
      continue;
    }

    const start = index;
    index += openTag.length;
    let depth = 1;
    const openRe = new RegExp(`^<${tagName}\\b[^>]*>`, "i");
    const closeRe = new RegExp(`^<\\/${tagName}\\s*>`, "i");

    while (index < len && depth > 0) {
      const nextLt = html.indexOf("<", index);
      if (nextLt === -1) {
        index = len;
        break;
      }
      const slice = html.slice(nextLt);
      const closeMatch = closeRe.exec(slice);
      if (closeMatch) {
        depth--;
        index = nextLt + closeMatch[0].length;
        continue;
      }
      const nestedOpen = openRe.exec(slice);
      if (nestedOpen && !/\/>\s*$/.test(nestedOpen[0])) {
        depth++;
        index = nextLt + nestedOpen[0].length;
        continue;
      }
      index = nextLt + 1;
    }
    blocks.push(html.slice(start, index));
  }

  return blocks;
}

function analyzeBlock(block: string, groupId: number): BlockUnit[] {
  const trimmed = block.trim();
  if (!trimmed) return [];

  // Bare top-level <img ...> (common in raw HTML mode)
  const bareImg = IMG_TAG_OPEN_RE.exec(trimmed);
  if (bareImg && bareImg[0].length === trimmed.length) {
    const image = parseImgTag(bareImg[0]);
    if (image) {
      return [{ kind: "images", images: [image], rawFallback: block, trailingCursor: false, groupId, partial: false }];
    }
  }

  // Bare <br> between raw <img> tags acts as a transparent separator when adjacent to images.
  if (BR_TAG_RE.test(trimmed) && trimmed.replace(BR_TAG_RE, "").trim() === "") {
    return [{ kind: "html", html: block, groupId }];
  }

  if (/^<p>/i.test(trimmed)) {
    return extractParagraphUnits(block, groupId);
  }

  if (/^<(?:ul|ol)\b/i.test(trimmed)) {
    const listUnits = extractImageListUnits(block, groupId);
    if (listUnits) return listUnits;
  }

  return [{ kind: "html", html: block, groupId }];
}

function isTransparentSeparatorBlock(unit: BlockUnit): boolean {
  if (unit.kind !== "html") return false;
  const trimmed = unit.html.trim();
  return trimmed === "" || (BR_TAG_RE.test(trimmed) && trimmed.replace(BR_TAG_RE, "").trim() === "");
}

/**
 * Detect runs of strictly more than 2 consecutive images (`>= 3`) in sanitized
 * Markdown HTML and segment them into interactive image-stack segments while
 * keeping all surrounding Markdown blocks intact.
 *
 * Returns `null` when no image stack is formed so callers can stay on the
 * single-container fast path with zero extra wrappers.
 */
export function segmentMarkdownImageStacks(
  blocks: string[] | null,
  html: string,
): MarkdownSegment[] | null {
  if (!html || countImgTags(html) < IMAGE_STACK_MIN_COUNT) return null;

  const isBlockMode = blocks !== null;
  const sourceBlocks = blocks ?? splitTopLevelHtmlBlocks(html);
  const rawUnits: BlockUnit[] = [];
  const originalBlockByGroup = new Map<number, string>();

  for (let i = 0; i < sourceBlocks.length; i++) {
    originalBlockByGroup.set(i, sourceBlocks[i]);
    rawUnits.push(...analyzeBlock(sourceBlocks[i], i));
  }

  // First pass: identify which image runs reach >= IMAGE_STACK_MIN_COUNT.
  type OutputItem =
    | { type: "html"; html: string; groupId: number }
    | { type: "stack"; images: StackedMarkdownImage[]; trailingCursor: boolean };

  const output: OutputItem[] = [];
  let hasStack = false;
  let pendingImages: StackedMarkdownImage[] = [];
  let pendingUnits: BlockUnit[] = [];
  let pendingSeparators: BlockUnit[] = [];
  let pendingCursor = false;

  // Track which original groups had a partial split accepted into a real stack.
  const splitGroupsStacked = new Set<number>();

  const flushPending = () => {
    if (pendingImages.length === 0) {
      for (const sep of pendingSeparators) {
        if (sep.kind === "html") output.push({ type: "html", html: sep.html, groupId: sep.groupId });
      }
      pendingSeparators = [];
      return;
    }

    if (pendingImages.length >= IMAGE_STACK_MIN_COUNT) {
      hasStack = true;
      for (const unit of pendingUnits) {
        if (unit.kind === "images" && unit.partial) splitGroupsStacked.add(unit.groupId);
      }
      output.push({
        type: "stack",
        images: pendingImages,
        trailingCursor: pendingCursor,
      });
    } else {
      for (const unit of pendingUnits) {
        if (unit.kind === "images") {
          output.push({ type: "html", html: unit.rawFallback, groupId: unit.groupId });
        } else {
          output.push({ type: "html", html: unit.html, groupId: unit.groupId });
        }
      }
    }

    // Any trailing separators after the image run belong to the following HTML.
    for (const sep of pendingSeparators) {
      if (sep.kind === "html") output.push({ type: "html", html: sep.html, groupId: sep.groupId });
    }
    pendingImages = [];
    pendingUnits = [];
    pendingSeparators = [];
    pendingCursor = false;
  };

  for (const unit of rawUnits) {
    if (unit.kind === "images") {
      if (pendingSeparators.length > 0) {
        pendingUnits.push(...pendingSeparators);
        pendingSeparators = [];
      }
      pendingImages.push(...unit.images);
      pendingUnits.push(unit);
      if (unit.trailingCursor) pendingCursor = true;
      continue;
    }

    if (pendingImages.length > 0 && isTransparentSeparatorBlock(unit)) {
      pendingSeparators.push(unit);
      continue;
    }

    flushPending();
    output.push({ type: "html", html: unit.html, groupId: unit.groupId });
  }
  flushPending();

  if (!hasStack) return null;

  // Restore original untouched block HTML for any partially split paragraph
  // whose image portion did NOT end up inside a >= 3 image stack.
  const normalizedOutput: Array<{ type: "html"; html: string } | { type: "stack"; images: StackedMarkdownImage[]; trailingCursor: boolean }> = [];
  const restoredGroups = new Set<number>();
  for (const item of output) {
    if (item.type === "stack") {
      normalizedOutput.push(item);
      continue;
    }
    if (!splitGroupsStacked.has(item.groupId) && originalBlockByGroup.has(item.groupId)) {
      // Check if this group was split into multiple html items without any stack.
      if (!restoredGroups.has(item.groupId)) {
        restoredGroups.add(item.groupId);
        normalizedOutput.push({ type: "html", html: originalBlockByGroup.get(item.groupId)! });
      }
      continue;
    }
    normalizedOutput.push({ type: "html", html: item.html });
  }

  // Coalesce adjacent HTML items into MarkdownSegments.
  const segments: MarkdownSegment[] = [];
  let htmlCount = 0;
  let stackCount = 0;
  let currentHtmlBlocks: string[] = [];

  const flushHtmlSegment = () => {
    if (currentHtmlBlocks.length === 0) return;
    const joined = currentHtmlBlocks.join("");
    segments.push({
      type: "html",
      blocks: isBlockMode ? currentHtmlBlocks : null,
      html: joined,
      key: `html-${htmlCount++}`,
    });
    currentHtmlBlocks = [];
  };

  for (const item of normalizedOutput) {
    if (item.type === "html") {
      currentHtmlBlocks.push(item.html);
    } else {
      flushHtmlSegment();
      segments.push({
        type: "image-stack",
        images: item.images,
        ...(item.trailingCursor ? { trailingCursor: true } : {}),
        key: `stack-${stackCount++}`,
      });
    }
  }
  flushHtmlSegment();

  return segments;
}
