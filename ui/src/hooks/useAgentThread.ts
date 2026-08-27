import { useCallback, useEffect, useState } from "react";
import type { AgentMessage, AgentThread } from "../../../src/shared/api-contracts/agent-first";
import { api } from "../api";

export function useAgentThread(projectId: string) {
  const [thread, setThread] = useState<AgentThread | null>(null);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reloadMessages = useCallback(async (target = thread) => {
    if (!target) return;
    const response = await api.listAgentMessages(projectId, target.id);
    setMessages(response.messages);
  }, [projectId, thread]);

  const initialize = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const listed = await api.listAgentThreads(projectId);
      const target = listed.threads[0] ?? (await api.createAgentThread(projectId)).thread;
      setThread(target);
      const response = await api.listAgentMessages(projectId, target.id);
      setMessages(response.messages);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Agent 会话载入失败");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { void initialize(); }, [initialize]);
  return { thread, messages, loading, error, reloadMessages, setMessages };
}
