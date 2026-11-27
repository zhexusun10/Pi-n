import type { CompactionItemInfo, TranscriptItem } from "../types";
import { extractCompactionUsage } from "./transcriptNotices";

function normalizeReason(value: unknown): CompactionItemInfo["reason"] {
  return value === "manual" || value === "threshold" || value === "overflow" ? value : undefined;
}

function normalizeTokenCount(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return Math.round(value);
}

function normalizeFileList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  const files: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    files.push(trimmed);
  }
  return files.length > 0 ? files : undefined;
}

const FENCE_OPEN_RE = /^\s{0,3}(`{3,}|~{3,})/;
const FILE_SECTION_OPEN_RE = /^\s*<(read-files|modified-files)>\s*$/;
const FILE_SECTION_SINGLE_LINE_RE = /^\s*<(read-files|modified-files)>([\s\S]*?)<\/\1>\s*$/;

export interface StrippedCompactionSummary {
  summary: string;
  readFiles?: string[];
  modifiedFiles?: string[];
}

/** Strip Pi-appended `<read-files>` / `<modified-files>` XML blocks from a
 * compaction summary (outside fenced code blocks) so Markdown rendering does
 * not duplicate the structured file chip lists shown below the summary. */
export function stripCompactionFileSections(rawSummary: string): StrippedCompactionSummary {
  if (!rawSummary || (!rawSummary.includes("<read-files>") && !rawSummary.includes("<modified-files>"))) {
    return { summary: rawSummary.trim() };
  }

  const lines = rawSummary.replace(/\r\n/g, "\n").split("\n");
  const kept: string[] = [];
  const extractedRead: string[] = [];
  const extractedModified: string[] = [];
  let strippedAny = false;
  let fenceChar: string | null = null;
  let fenceLen = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    if (fenceChar) {
      kept.push(line);
      const closeMatch = line.match(/^\s{0,3}(`{3,}|~{3,})\s*$/);
      if (closeMatch && closeMatch[1][0] === fenceChar && closeMatch[1].length >= fenceLen) {
        fenceChar = null;
        fenceLen = 0;
      }
      continue;
    }

    const fenceMatch = line.match(FENCE_OPEN_RE);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (marker[0] !== "`" || !line.slice(line.indexOf(marker) + marker.length).includes("`")) {
        fenceChar = marker[0];
        fenceLen = marker.length;
        kept.push(line);
        continue;
      }
    }

    const singleLineMatch = line.match(FILE_SECTION_SINGLE_LINE_RE);
    if (singleLineMatch) {
      strippedAny = true;
      const target = singleLineMatch[1] === "read-files" ? extractedRead : extractedModified;
      const entry = singleLineMatch[2].trim();
      if (entry) target.push(entry);
      continue;
    }

    const openMatch = line.match(FILE_SECTION_OPEN_RE);
    if (openMatch) {
      const tag = openMatch[1];
      const closeRe = new RegExp(`^\\s*</${tag}>\\s*$`);
      let closeIndex = -1;
      for (let j = i + 1; j < lines.length; j += 1) {
        if (closeRe.test(lines[j])) {
          closeIndex = j;
          break;
        }
      }
      if (closeIndex !== -1) {
        strippedAny = true;
        const target = tag === "read-files" ? extractedRead : extractedModified;
        for (let j = i + 1; j < closeIndex; j += 1) {
          const entry = lines[j].trim();
          if (entry) target.push(entry);
        }
        i = closeIndex;
        continue;
      }
    }

    kept.push(line);
  }

  if (!strippedAny) {
    return { summary: rawSummary.trim() };
  }

  const summary = kept
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const modifiedFiles = normalizeFileList(extractedModified);
  const modifiedSet = modifiedFiles ? new Set(modifiedFiles) : null;
  const readFiles = normalizeFileList(
    modifiedSet ? extractedRead.filter((file) => !modifiedSet.has(file)) : extractedRead,
  );

  return {
    summary,
    ...(readFiles ? { readFiles } : {}),
    ...(modifiedFiles ? { modifiedFiles } : {}),
  };
}

function resolveCompactionFiles(
  details: Record<string, unknown> | undefined,
  stripped: StrippedCompactionSummary,
): { readFiles?: string[]; modifiedFiles?: string[] } {
  const hasDetailsRead = Array.isArray(details?.readFiles);
  const hasDetailsModified = Array.isArray(details?.modifiedFiles);
  const modifiedFiles = hasDetailsModified ? normalizeFileList(details.modifiedFiles) : stripped.modifiedFiles;
  const modifiedSet = modifiedFiles ? new Set(modifiedFiles) : null;
  const fallbackReadFiles = stripped.readFiles && modifiedSet
    ? normalizeFileList(stripped.readFiles.filter((file) => !modifiedSet.has(file)))
    : stripped.readFiles;
  const readFiles = hasDetailsRead ? normalizeFileList(details.readFiles) : fallbackReadFiles;
  return {
    ...(readFiles ? { readFiles } : {}),
    ...(modifiedFiles ? { modifiedFiles } : {}),
  };
}

/** Extract structured compaction metadata from either a live Pi `compaction_end`
 * RPC event or a persisted Pi session JSONL `compaction` entry. Aborted or
 * empty compaction_end events return null so no misleading card is rendered. */
export function extractCompactionInfo(event: any): CompactionItemInfo | null {
  if (!event || typeof event !== "object") return null;

  if (event.type === "compaction_end") {
    if (event.aborted === true) return null;
    const result = event.result;
    if (!result || typeof result !== "object") return null;
    const stripped = stripCompactionFileSections(typeof result.summary === "string" ? result.summary : "");
    const summary = stripped.summary;
    const tokensBefore = normalizeTokenCount(result.tokensBefore);
    const tokensAfter = normalizeTokenCount(result.estimatedTokensAfter);
    const details = result.details && typeof result.details === "object" ? result.details : undefined;
    const { readFiles, modifiedFiles } = resolveCompactionFiles(details, stripped);
    if (!summary && !(tokensBefore && tokensBefore > 0) && !readFiles && !modifiedFiles) return null;
    const billing = extractCompactionUsage(result.usage);
    return {
      reason: normalizeReason(event.reason),
      tokensBefore,
      tokensAfter,
      ...billing,
      summary,
      ...(typeof result.firstKeptEntryId === "string" && result.firstKeptEntryId
        ? { firstKeptEntryId: result.firstKeptEntryId } : {}),
      ...(readFiles ? { readFiles } : {}),
      ...(modifiedFiles ? { modifiedFiles } : {}),
    };
  }

  if (event.type === "compaction") {
    const stripped = stripCompactionFileSections(typeof event.summary === "string" ? event.summary : "");
    const summary = stripped.summary;
    const tokensBefore = normalizeTokenCount(event.tokensBefore);
    const tokensAfter = normalizeTokenCount(event.estimatedTokensAfter);
    const details = event.details && typeof event.details === "object" ? event.details : undefined;
    const { readFiles, modifiedFiles } = resolveCompactionFiles(details, stripped);
    if (!summary && !(tokensBefore && tokensBefore > 0) && !readFiles && !modifiedFiles) return null;
    const billing = extractCompactionUsage(event.usage);
    return {
      reason: normalizeReason(event.reason),
      tokensBefore,
      tokensAfter,
      ...billing,
      summary,
      ...(typeof event.firstKeptEntryId === "string" && event.firstKeptEntryId
        ? { firstKeptEntryId: event.firstKeptEntryId } : {}),
      ...(readFiles ? { readFiles } : {}),
      ...(modifiedFiles ? { modifiedFiles } : {}),
      ...(typeof event.fromHook === "boolean" ? { fromHook: event.fromHook } : {}),
    };
  }

  return null;
}

export function createCompactionTranscriptItem(
  id: string,
  compaction: CompactionItemInfo,
  timestamp: number,
  animateAppear?: boolean,
): TranscriptItem {
  return {
    id,
    type: "compaction",
    role: "system",
    status: "success",
    content: compaction.summary,
    compaction,
    timestamp,
    ...(animateAppear !== undefined ? { animateAppear } : {}),
  };
}
