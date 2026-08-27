import type { ProjectIssue } from "../shared/api-contracts/agent-first";
import { IssueRepository } from "./issue-repository";

export class IssueService {
  constructor(private readonly issues: IssueRepository) {}

  list(projectId: string): ProjectIssue[] {
    return this.issues.list(projectId);
  }

  update(id: string, projectId: string, status: "resolved" | "ignored", actor: string, reason?: string): ProjectIssue {
    const issue = this.issues.get(id);
    if (!issue || issue.projectId !== projectId) throw new Error("问题不存在");
    return this.issues.updateStatus(id, status, actor, reason);
  }
}
