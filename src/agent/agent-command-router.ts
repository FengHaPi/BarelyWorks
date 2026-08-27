import type { AgentMessageCommand } from "./project-agent-service";

export function classifyAgentCommand(command: AgentMessageCommand): "read-only" | "plan" | "revision" {
  const targets = new Set([...(command.targetArtifactIds ?? []), ...(command.targetArtifactId ? [command.targetArtifactId] : [])]);
  if (command.mode === "plan" || targets.size > 1) return "plan";
  if (command.mode === "ask" || command.mode === "compare") return "read-only";
  return "revision";
}
