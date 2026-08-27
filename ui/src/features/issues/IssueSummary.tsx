import type { ProjectIssue } from "../../../../src/shared/api-contracts/agent-first";

export function IssueSummary({ issues, onOpen }: { issues: ProjectIssue[]; onOpen: () => void }) {
  const open = issues.filter((issue) => issue.status === "open");
  const errors = open.filter((issue) => issue.severity === "error").length;
  return <button className={`af-issue-summary ${errors ? "has-errors" : ""}`} onClick={onOpen}>
    <span><strong>{open.length ? `${open.length} 个待处理问题` : "没有待处理问题"}</strong><small>{errors ? `${errors} 个错误仅作用于对应内容` : "问题不会锁定整个项目"}</small></span>
    <b>查看</b>
  </button>;
}
