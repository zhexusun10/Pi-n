import { getTauriInvoke, isTauriDesktop } from "./apiBase";

export type GitBootstrapPhase = "not_needed" | "downloading" | "ready" | "failed";

export interface GitBootstrapStatus {
  phase: GitBootstrapPhase;
  gitPath: string | null;
  error: string | null;
}

function normalizeStatus(raw: unknown): GitBootstrapStatus | null {
  if (!raw || typeof raw !== "object") return null;
  const candidate = raw as Record<string, unknown>;
  const phase = candidate.phase;
  if (
    phase !== "not_needed" &&
    phase !== "downloading" &&
    phase !== "ready" &&
    phase !== "failed"
  ) {
    return null;
  }
  return {
    phase,
    gitPath: typeof candidate.gitPath === "string" ? candidate.gitPath : null,
    error: typeof candidate.error === "string" ? candidate.error : null,
  };
}

export async function getGitBootstrapStatus(): Promise<GitBootstrapStatus | null> {
  const invoke = getTauriInvoke();
  if (!invoke) return null;
  try {
    return normalizeStatus(await invoke("git_bootstrap_status"));
  } catch {
    return null;
  }
}

export async function retryGitBootstrap(): Promise<GitBootstrapStatus | null> {
  const invoke = getTauriInvoke();
  if (!invoke) return null;
  try {
    return normalizeStatus(await invoke("retry_git_bootstrap"));
  } catch {
    return null;
  }
}
