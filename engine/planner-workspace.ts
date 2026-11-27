import { readFileSync, realpathSync } from 'node:fs';
import { createWorkspacePaths } from './workspace-paths.mjs';
import { rebindWorkspaceEnvironment } from './launch-binding.mjs';

type WorkspaceTarget = {
  requestedNode: string;
  actualNode: string;
  executionId: string;
  workspace: string;
  runtimeEnvironment?: Record<string, string>;
  redirected?: boolean;
};

type WorkspaceState = {
  workspace: string;
  project: string;
  alias: string;
  paths: ReturnType<typeof createWorkspacePaths>;
};

let state: WorkspaceState | undefined;
let targetFile: string | undefined;
let targets = new Map<string, WorkspaceTarget>();
const listeners = new Set<(state: WorkspaceState, target: WorkspaceTarget) => void>();

function workspaceRoots(current: Map<string, WorkspaceTarget>): string[] {
  return [...new Set([...current.values()].map(target => target.workspace).filter(Boolean))];
}

function parseWorkspaceTargets(raw: string): Record<string, WorkspaceTarget> {
  const parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid Planner workspace targets');
  }
  return parsed as Record<string, WorkspaceTarget>;
}

export function configurePlannerWorkspace(
  workspace: string,
  project: string,
  alias: string,
  rawTargets = process.env.PI_N_PLANNER_WORKSPACES || '{}',
) {
  const parsed = parseWorkspaceTargets(rawTargets);
  targetFile = process.env.PI_N_PLANNER_WORKSPACES_FILE;
  targets = new Map(Object.entries(parsed));
  listeners.clear();
  const initial = realpathSync.native(workspace);
  state = { workspace: initial, project, alias, paths: createWorkspacePaths(initial, project, alias, workspaceRoots(targets)) };
}

export function onPlannerWorkspaceChanged(listener: (state: WorkspaceState, target: WorkspaceTarget) => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function plannerWorkspaceState(): WorkspaceState {
  if (!state) throw new Error('Planner workspace switching is unavailable');
  return state;
}

export function switchPlannerWorkspace(requestedNode: string): WorkspaceTarget {
  if (!state) throw new Error('Planner workspace switching is unavailable');
  const currentTargets = targetFile
    ? parseWorkspaceTargets(readFileSync(targetFile, 'utf8'))
    : Object.fromEntries(targets);
  // Arbitrary node IDs may match Object.prototype keys; only backend entries count.
  const target = Object.hasOwn(currentTargets, requestedNode) ? currentTargets[requestedNode] : undefined;
  if (!target) throw new Error(`No current workspace is available for node '${requestedNode}'`);
  const workspace = realpathSync.native(target.workspace);
  if (process.env.PI_N_EXECUTION_KIND === 'graph' && workspace !== state.workspace) {
    // Native launch grants cover these exact backend targets. Both the process
    // cwd (extensions/subprocesses) and managed Bash state follow the new slot.
    rebindWorkspaceEnvironment(target.runtimeEnvironment, workspace);
  } else {
    process.chdir(workspace);
  }
  targets = new Map(Object.entries(currentTargets));
  state = { ...state, workspace, paths: createWorkspacePaths(workspace, state.project, state.alias, workspaceRoots(targets)) };
  for (const listener of listeners) listener(state, target);
  return { ...target, workspace };
}
