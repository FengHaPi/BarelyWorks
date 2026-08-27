import { useCallback, useEffect, useState } from "react";
import type { AgentMessage, ArtifactDetail, Operation } from "../../../../src/shared/api-contracts/agent-first";
import { api } from "../../api";
import { useAgentThread } from "../../hooks/useAgentThread";
import { ActiveOperationCard } from "../operations/ActiveOperationCard";
import { AgentComposer } from "./AgentComposer";
import { AgentMessageList } from "./AgentMessageList";

export function ProjectAgentPanel({ projectId, detail, onWorkspaceChanged, initialOperationId, onOperationTerminal }: {
  projectId: string;
  detail: ArtifactDetail | null;
  onWorkspaceChanged: () => Promise<void>;
  initialOperationId?: string | null;
  onOperationTerminal?: (operation: Operation) => void;
}) {
  const { thread, messages, loading, error, reloadMessages } = useAgentThread(projectId);
  const operationStorageKey = `ai-video-studio:workspace:${projectId}:operation`;
  const [operationId, setOperationId] = useState<string | null>(() => initialOperationId ?? window.localStorage.getItem(operationStorageKey));
  useEffect(() => {
    if (initialOperationId) setOperationId(initialOperationId);
  }, [initialOperationId]);
  useEffect(() => {
    if (operationId) window.localStorage.setItem(operationStorageKey, operationId);
    else window.localStorage.removeItem(operationStorageKey);
  }, [operationId, operationStorageKey]);
  const terminal = useCallback(async (operation: Operation) => {
    await Promise.all([onWorkspaceChanged(), reloadMessages()]);
    onOperationTerminal?.(operation);
  }, [onOperationTerminal, onWorkspaceChanged, reloadMessages]);
  async function send(input: { content: string; mode: "ask" | "compare" | "revise" | "plan"; intent?: "revise" | "rewrite-section" | "extend" | "fix-issue" }) {
    if (!thread || !detail) return;
    const response = await api.sendAgentMessage(projectId, thread.id, {
      ...input,
      targetArtifactId: detail.artifact.id,
      ...(input.mode === "revise" ? { idempotencyKey: crypto.randomUUID() } : {}),
    });
    await reloadMessages(thread);
    if (response.operationId) setOperationId(response.operationId);
  }
  return <aside className="af-agent-panel">
    <div className="af-panel-title"><span>项目 Agent</span>{thread && <small>{thread.title}</small>}</div>
    {loading ? <div className="af-loading-inline">正在载入会话…</div> : error ? <div className="af-form-error">{error}</div> : <AgentMessageList messages={messages as AgentMessage[]} />}
    {operationId && <ActiveOperationCard operationId={operationId} onTerminal={terminal} />}
    <AgentComposer disabled={!thread || !detail} targetLabel={detail ? `${detail.artifact.type} V${String(detail.artifact.version).padStart(3, "0")}` : null} onSend={send} />
  </aside>;
}
