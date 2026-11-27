import { isPinDotColor, type Config, type PinDotColor, type PlanMode, type ProjectItem, type RoleModelConfig, type ThinkingLevel } from "../types";
import { normalizeWorkspacePath } from "./workspaceConversations";

export const STORAGE_KEYS = {
  projects: "pi_n_projects",
  projectOrder: "pi_n_project_order",
  lastWorkspace: "pi_n_last_workspace",
  workspaceRuns: "pi_n_workspace_runs",
  workspaceRunOrder: "pi_n_workspace_run_order",
  archivedRuns: "pi_n_archived_runs",
  pinnedRuns: "pi_n_pinned_runs",
  runLabels: "pi_n_run_labels",
  runModes: "pi_n_run_modes",
  config: "pi_n_config",
  dataPath: "pi_n_data_path",
  planMode: "pi_n_plan_mode",
} as const;

type StoredJson = {
  pi_n_projects: ProjectItem[];
  pi_n_project_order: string[];
  pi_n_workspace_runs: Record<string, string[]>;
  pi_n_workspace_run_order: Record<string, string[]>;
  pi_n_archived_runs: string[];
  pi_n_pinned_runs: Record<string, PinDotColor>;
  pi_n_run_labels: Record<string, string>;
  pi_n_run_modes: Record<string, PlanMode>;
  pi_n_config: Partial<Config>;
};
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const thinkingLevels = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const isThinkingLevel = (value: unknown): value is ThinkingLevel => typeof value === "string" && thinkingLevels.has(value);

function projects(value: unknown): ProjectItem[] | null {
  if (!Array.isArray(value)) return null;
  const items = value.flatMap(item => {
    if (!record(item) || typeof item.path !== "string" || !item.path.trim()) return [];
    const path = normalizeWorkspacePath(item.path);
    return [{
      id: typeof item.id === "string" && item.id ? normalizeWorkspacePath(item.id) : path, path,
      name: typeof item.name === "string" && item.name ? item.name : path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path,
      branch: typeof item.branch === "string" ? item.branch : "",
      clean: item.clean === true,
      ...(typeof item.isShadow === "boolean" ? { isShadow: item.isShadow } : {}),
      ...(item.archived === true ? { archived: true } : {}),
      lastOpened: typeof item.lastOpened === "number" && Number.isFinite(item.lastOpened) ? item.lastOpened : 0,
    }];
  });
  // An explicitly empty list means the user removed all workspaces; a corrupt
  // nonempty list must still allow bootstrap to recover the backend binding.
  return value.length && !items.length ? null : items;
}

function config(value: unknown): Partial<Config> | null {
  if (!record(value)) return null;
  const result: Partial<Config> = {};
  for (const key of ["repository", "model"] as const) if (typeof value[key] === "string") result[key] = value[key];
  if (isThinkingLevel(value.thinkingLevel)) result.thinkingLevel = value.thinkingLevel;
  for (const key of ["maxParallel", "maxFeedback"] as const) {
    if (typeof value[key] === "number" && Number.isFinite(value[key])) result[key] = value[key];
  }
  for (const key of ["autoApprove", "postTaskReview", "plannerWriteTools", "isolateParallelNodes", "feedbackEnabled"] as const) {
    if (typeof value[key] === "boolean") result[key] = value[key];
  }
  if (record(value.roleModels)) {
    const roles: NonNullable<Config["roleModels"]> = {};
    for (const role of ["planner", "nodeAgent"] as const) {
      const model = value.roleModels[role];
      if (!record(model) || typeof model.model !== "string") continue;
      const settings: RoleModelConfig = { model: model.model };
      if (isThinkingLevel(model.thinkingLevel)) settings.thinkingLevel = model.thinkingLevel;
      roles[role] = settings;
    }
    result.roleModels = roles;
  }
  return result;
}

const decoders: { [K in keyof StoredJson]: (value: unknown) => StoredJson[K] | null } = {
  pi_n_projects: projects,
  pi_n_project_order: value => Array.isArray(value)
    ? [...new Set(value.filter((key): key is string => typeof key === "string" && key.length > 0))]
    : null,
  pi_n_config: config,
  pi_n_workspace_runs: value => record(value) ? Object.fromEntries(Object.entries(value)
    .filter(([, ids]) => Array.isArray(ids))
    .map(([path, ids]) => [path, (ids as unknown[]).filter((id): id is string => typeof id === "string")])) : null,
  pi_n_workspace_run_order: value => record(value) ? Object.fromEntries(Object.entries(value)
    .filter(([, ids]) => Array.isArray(ids))
    .map(([path, ids]) => [path, [...new Set((ids as unknown[]).filter((id): id is string => typeof id === "string" && id.length > 0 && !id.startsWith("pending-")))]])) : null,
  pi_n_archived_runs: value => Array.isArray(value)
    ? [...new Set(value.filter((id): id is string => typeof id === "string" && id.length > 0 && !id.startsWith("pending-")))]
    : null,
  pi_n_pinned_runs: value => record(value) ? Object.fromEntries(Object.entries(value)
    .filter((entry): entry is [string, PinDotColor] => entry[0].length > 0 && !entry[0].startsWith("pending-") && isPinDotColor(entry[1]))) : null,
  pi_n_run_labels: value => record(value) ? Object.fromEntries(Object.entries(value)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")) : null,
  pi_n_run_modes: value => record(value) ? Object.fromEntries(Object.entries(value)
    .filter((entry): entry is [string, PlanMode] => ["serial", "graph"].includes(entry[1] as string))) : null,
};

export function readStorageString(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

export function storageJsonKey(key: string): string {
  if ([STORAGE_KEYS.workspaceRuns, STORAGE_KEYS.workspaceRunOrder, STORAGE_KEYS.archivedRuns, STORAGE_KEYS.pinnedRuns, STORAGE_KEYS.runLabels, STORAGE_KEYS.runModes, STORAGE_KEYS.config].includes(key as any)) {
    return `pi-n-format-1:${readStorageString(STORAGE_KEYS.dataPath) ?? ""}:${key}`;
  }
  return key;
}

/** Persisted browser hints can outlive schemas or be partially corrupt. Never
 * treat a successful JSON parse as proof that a value is safe for rendering. */
export function readStorageJson<K extends keyof StoredJson>(key: K): StoredJson[K] | null {
  const raw = readStorageString(storageJsonKey(key));
  if (raw === null) return null;
  try { return decoders[key](JSON.parse(raw)); } catch { return null; }
}

export function writeStorageString(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch {}
}

export function writeStorageJson(key: string, value: unknown): void {
  try { localStorage.setItem(storageJsonKey(key), JSON.stringify(value)); } catch {}
}
