import React, { useRef, useState } from "react";
import { runtimeService } from "../../src/services/runtime";
import { ComposerDrafts } from "../../src/services/composerDrafts";
import { createRoot } from "react-dom/client";
import { GraphWorkbench } from "../../src/components/views/GraphWorkbench";
import { defaultConfig, emptySnapshot, type ChatMessage, type Snapshot } from "../../src/types";
import { tokens } from "../../src/tokens";
import "../../src/styles.css";
import "../../src/styles-workbench.css";
import "../../src/styles-planning.css";

const config = { ...defaultConfig, repository: "/mock", model: "test/model" };
const line = (event: unknown) => JSON.stringify(event) + "\n";
const user = (text: string, requestId?: string) => line({ type: "message_start", piNRequestId: requestId, message: { role: "user", content: [{ type: "text", text }] } });
const assistant = (text: string) => line({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } });

function Fixture() {
  const [visible, setVisible] = useState(true);
  const params = new URLSearchParams(location.search);
  const graph = params.get("mode") === "graph";
  const paged = params.get("paged") === "true";
  const stopped = params.get("stopped") === "true";
  // A settled reload with a consumed steer already in the transcript.
  const presettled = stopped || params.get("presettled") === "true";
  const consumedId = stopped ? "e09bf10c-abbd-4142-a90a-da74b5acc872" : undefined;
  const beforeSteer = (stopped ? user("Original task") : "") + assistant("OUTPUT BEFORE STEER");
  const [output, setOutput] = useState(presettled
    ? beforeSteer + user("CONSUMED STEER", consumedId) + assistant("OUTPUT AFTER STEER")
    : beforeSteer);
  const [messages, setMessages] = useState<ChatMessage[]>(presettled && !stopped
    ? [{ id: "initial", role: "user", text: "Original task" },
      { id: "consumed", role: "user", text: "CONSUMED STEER", node: "task", runId: "steer-run",
        delivery: "steered", executionId: "exec", steerOrdinal: 0, inlineSteerOrdinal: 0 }]
    : [{ id: "initial", role: "user", text: "Original task" }]);
  const [events, setEvents] = useState<Snapshot["events"]>(() => {
    const consumed = { type: "steered", sequence: 1, timestamp: 1, node: "task", execution_id: "exec", instruction: "CONSUMED STEER", request_id: consumedId };
    if (!stopped) return presettled ? [consumed] : [];
    return [
      { type: "started", sequence: 0, timestamp: 0, execution: { id: "exec", node: "task" } },
      consumed,
      { type: "steered", sequence: 2, timestamp: 2, node: "task", execution_id: "exec", instruction: "RESENT STEER", request_id: "eeb6ba12-f49d-489f-b261-f116933a0396" },
      { type: "execution_stop_requested", sequence: 3, timestamp: 3, execution_ids: ["exec"] },
      { type: "failed", sequence: 4, timestamp: 4, node: "task", execution_id: "exec" },
      { type: "invalidated", sequence: 5, timestamp: 5, target: "task", human: true, instruction: "RESENT STEER", request_id: "172b340c-3f20-4c62-beef-26dae07871ad" },
      { type: "started", sequence: 6, timestamp: 6, execution: { id: "after-stop", node: "task" }, message_sequences: [5] },
    ];
  });
  const [running, setRunning] = useState(!presettled);
  const submissions = useRef<unknown[]>([]);
  const drafts = useRef(new ComposerDrafts());
  const audit = ((window as any).steerAudit = { submissions: submissions.current, events });
  audit.consume = (text: string) => setOutput(previous => previous + line({ type: "message_start", message: { role: "user", content: [{ type: "text", text }] } }) + assistant("OUTPUT AFTER STEER"));
  audit.settle = () => setRunning(false);
  const state = { ...emptySnapshot, runId: "steer-run", config, phase: running ? "running" : "completed", approved: true,
    planType: graph ? "graph" : "serial", events, graph: { originalGoal: "Original task", nodes: [{ id: "task", task: "Original task" }], edges: [] },
    nodes: { task: { status: running ? "running" : "completed", revision: 0, instruction: "", error: null } },
    executions: [{ id: "exec", node: "task", status: running ? "running" : "completed", revision: 0, attempt: 1,
      output: "", outputBytes: paged ? 100 : new TextEncoder().encode(output).length, startedAt: 1, completedAt: running ? null : 2, sessionId: "session", worktree: "/mock", before: "", after: "" }] } as Snapshot;
  const retryOutput = user("RESENT STEER") + assistant("REPLY TO RESENT STEER");
  if (stopped) {
    const first = state.executions[0];
    state.executions = [
      { ...first, status: "paused", completedAt: 4 },
      { ...first, id: "after-stop", attempt: 2, outputBytes: new TextEncoder().encode(retryOutput).length, startedAt: 6, completedAt: 7 },
    ];
  }
  audit.snapshot = () => ({ ...state, executions: state.executions.map(execution => ({
    ...execution, output: execution.id === "after-stop" ? retryOutput : output,
  })) });
  const noop = () => {};
  return <><button style={{ position: "fixed", top: 0, left: 0, zIndex: 100 }} onClick={() => setVisible(value => !value)}>Toggle view</button>
    <div style={{ height: 800, display: "flex" }}>{visible && <GraphWorkbench state={state} routeType={graph ? "graph" : "serial"}
    selected={graph ? "task" : ""} setSelected={noop} selectedMergerId="" setSelectedMergerId={noop}
    effectiveMessages={messages} isPlanning={false} plannerStream={{ items: [] }} composerDrafts={drafts.current}
    onWithdrawMessages={async (node, requestId) => {
      const result = await runtimeService.withdrawMessages(state.runId, node, requestId);
      setEvents(result.snapshot.events);
      return result.messages;
    }}
    onSendMessage={(text, options) => {
      submissions.current.push({ text, interrupt: options?.interrupt, images: options?.images });
      const ordinal = messages.filter(message => message.text === text).length;
      setMessages(previous => [...previous, { id: `msg-${options?.requestId ?? ordinal}`, role: "user", text, node: "task", runId: "steer-run",
        delivery: "steered", executionId: "exec", steerRequestId: options?.requestId, steerOrdinal: ordinal, inlineSteerOrdinal: ordinal,
        images: options?.images, files: options?.files?.map(file => ({ name: file.name, size: file.size, type: file.type })) }]);
      setEvents(previous => [...previous, { type: "steered", sequence: previous.length + 1, timestamp: Date.now(),
        node: "task", execution_id: "exec", instruction: text, request_id: options?.requestId, images: options?.images }]);
      return true;
    }} onRequestConfirmation={noop} onControl={noop} onOpenEditor={noop} onOpenApproval={noop} onOpenFile={noop}
    repoInfo={null} config={config} active={running} locked={false} pendingRequest={false} publishing={false} publicationFailed={false}
    nodes={[]} edges={[]} nodeTypes={{}} edgeTypes={{}} tokens={tokens} />}</div></>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
