import type { AgentMessage } from "../../../../src/shared/api-contracts/agent-first";

const messageLabels = { user: "你", explanation: "真实 Agent 回答", plan: "真实 Agent 影响计划", operation: "Agent 作业", error: "错误", "legacy-template": "旧版固定说明（非 Agent）" } as const;

export function AgentMessageList({ messages }: { messages: AgentMessage[] }) {
  if (!messages.length) return <div className="af-agent-empty"><strong>围绕当前版本工作</strong><p>可以先询问状态、比较版本，或明确要求创建修订版。</p></div>;
  return <div className="af-agent-messages">
    {messages.map((message) => <article key={message.id} className={`af-agent-message ${message.role} ${message.messageType}`}>
      <header><span>{messageLabels[message.messageType]}</span><time>{new Date(message.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</time></header>
      <p>{message.content}</p>
      {message.operationId && <small>Operation {message.operationId.slice(0, 8)}</small>}
    </article>)}
  </div>;
}
