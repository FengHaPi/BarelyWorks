import type { ContinuityIssue } from "./types";

export interface ContinuityIssueGroup {
  code: string;
  severity: ContinuityIssue["severity"];
  issues: ContinuityIssue[];
  affectedIds: string[];
  suggestedFixes: string[];
  requiresReapproval: boolean;
}

const severityRank: Record<ContinuityIssue["severity"], number> = {
  error: 0,
  warning: 1,
  info: 2,
};

const issueTitles: Record<string, string> = {
  CONTINUITY_REVIEW_UNAVAILABLE: "连续性检查没有完成",
  PHYSICAL_CAMERA_CONTINUITY_TASK_SPLIT: "一镜到底要求与分段生成方式冲突",
  PHYSICAL_CAMERA_CONTINUOUS_TAKE_BROKEN: "一镜到底要求与分段生成方式冲突",
  PHYSICAL_REFLECTION_PLAN_MISMATCH: "反射设定与导演脚本不一致",
};

export function groupContinuityIssues(issues: ContinuityIssue[]): ContinuityIssueGroup[] {
  const groups = new Map<string, ContinuityIssueGroup>();
  for (const issue of issues) {
    const current = groups.get(issue.code);
    if (!current) {
      groups.set(issue.code, {
        code: issue.code,
        severity: issue.severity,
        issues: [issue],
        affectedIds: [...new Set(issue.affectedIds)],
        suggestedFixes: issue.suggestedFix ? [issue.suggestedFix] : [],
        requiresReapproval: issue.requiresReapproval,
      });
      continue;
    }
    current.issues.push(issue);
    current.affectedIds = [...new Set([...current.affectedIds, ...issue.affectedIds])];
    current.suggestedFixes = [...new Set([...current.suggestedFixes, issue.suggestedFix].filter(Boolean))];
    current.requiresReapproval ||= issue.requiresReapproval;
    if (severityRank[issue.severity] < severityRank[current.severity]) current.severity = issue.severity;
  }
  return [...groups.values()].sort((left, right) => severityRank[left.severity] - severityRank[right.severity]);
}

export function continuityIssueGroupTitle(group: ContinuityIssueGroup): string {
  if (group.code === "PHYSICAL_CAMERA_BLOCKING_FAILED") {
    return `${Math.max(group.affectedIds.length, group.issues.length)} 个镜头的摄影机调度不可执行`;
  }
  const knownTitle = issueTitles[group.code];
  if (knownTitle) return knownTitle;
  const firstSentence = group.issues[0]?.message.split(/[。；]/, 1)[0]?.trim() || group.code;
  return firstSentence.length > 34 ? `${firstSentence.slice(0, 34)}…` : firstSentence;
}
