import type { StudioDatabase } from "../database/client";
import type { ProjectIssue } from "../shared/api-contracts/agent-first";

interface IssueRow {
  id: string;
  project_id: string;
  scope_type: string;
  scope_id: string | null;
  severity: ProjectIssue["severity"];
  code: string;
  title: string;
  detail: string;
  suggested_action: string | null;
  status: ProjectIssue["status"];
  source: string;
  resolution_note: string | null;
  resolved_by: string | null;
  created_at: string;
  resolved_at: string | null;
}

function mapIssue(row: IssueRow): ProjectIssue {
  return {
    id: row.id, projectId: row.project_id, scopeType: row.scope_type, scopeId: row.scope_id,
    severity: row.severity, code: row.code, title: row.title, detail: row.detail,
    suggestedAction: row.suggested_action, status: row.status, source: row.source,
    resolutionNote: row.resolution_note, resolvedBy: row.resolved_by,
    createdAt: row.created_at, resolvedAt: row.resolved_at,
  };
}

export interface UpsertIssueInput {
  id: string;
  projectId: string;
  scopeType: string;
  scopeId?: string | null;
  severity: ProjectIssue["severity"];
  code: string;
  title: string;
  detail: string;
  suggestedAction?: string | null;
  source: string;
}

export class IssueRepository {
  constructor(private readonly studio: StudioDatabase) {}

  list(projectId: string, status?: ProjectIssue["status"]): ProjectIssue[] {
    const rows = (status
      ? this.studio.sqlite.prepare("SELECT * FROM project_issues WHERE project_id = ? AND status = ? ORDER BY CASE severity WHEN 'error' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, created_at DESC").all(projectId, status)
      : this.studio.sqlite.prepare("SELECT * FROM project_issues WHERE project_id = ? ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, created_at DESC").all(projectId)) as IssueRow[];
    return rows.map(mapIssue);
  }

  listForScope(projectId: string, scopeType: string, scopeId: string | null): ProjectIssue[] {
    const rows = this.studio.sqlite.prepare(`
      SELECT * FROM project_issues WHERE project_id = ? AND scope_type = ?
      AND ((scope_id IS NULL AND ? IS NULL) OR scope_id = ?) ORDER BY created_at DESC
    `).all(projectId, scopeType, scopeId, scopeId) as IssueRow[];
    return rows.map(mapIssue);
  }

  get(id: string): ProjectIssue | null {
    const row = this.studio.sqlite.prepare("SELECT * FROM project_issues WHERE id = ?").get(id) as IssueRow | undefined;
    return row ? mapIssue(row) : null;
  }

  upsertOpen(input: UpsertIssueInput): ProjectIssue {
    const now = new Date().toISOString();
    this.studio.sqlite.prepare(`
      INSERT INTO project_issues(
        id, project_id, scope_type, scope_id, severity, code, title, detail,
        suggested_action, status, source, created_at
      ) VALUES(?,?,?,?,?,?,?,?,?,'open',?,?)
      ON CONFLICT(id) DO UPDATE SET
        severity = excluded.severity, title = excluded.title, detail = excluded.detail,
        suggested_action = excluded.suggested_action,
        status = CASE WHEN project_issues.status = 'resolved' THEN 'open' ELSE project_issues.status END,
        resolved_at = CASE WHEN project_issues.status = 'resolved' THEN NULL ELSE project_issues.resolved_at END,
        resolution_note = CASE WHEN project_issues.status = 'resolved' THEN NULL ELSE project_issues.resolution_note END,
        resolved_by = CASE WHEN project_issues.status = 'resolved' THEN NULL ELSE project_issues.resolved_by END
    `).run(input.id, input.projectId, input.scopeType, input.scopeId ?? null, input.severity, input.code,
      input.title, input.detail, input.suggestedAction ?? null, input.source, now);
    return this.get(input.id)!;
  }

  resolveIfOpen(id: string, actor = "system", note = "条件已不再成立"): void {
    const now = new Date().toISOString();
    this.studio.sqlite.prepare(`
      UPDATE project_issues SET status = 'resolved', resolution_note = ?, resolved_by = ?, resolved_at = ?
      WHERE id = ? AND status = 'open'
    `).run(note, actor, now, id);
  }

  updateStatus(id: string, status: "resolved" | "ignored", actor: string, reason?: string): ProjectIssue {
    const issue = this.get(id);
    if (!issue) throw new Error("问题不存在");
    if (status === "ignored" && !reason?.trim()) throw new Error("忽略问题时必须填写理由");
    const now = new Date().toISOString();
    this.studio.sqlite.prepare(`
      UPDATE project_issues SET status = ?, resolution_note = ?, resolved_by = ?, resolved_at = ? WHERE id = ?
    `).run(status, reason?.trim() || (status === "resolved" ? "已由用户确认解决" : null), actor, now, id);
    return this.get(id)!;
  }
}
