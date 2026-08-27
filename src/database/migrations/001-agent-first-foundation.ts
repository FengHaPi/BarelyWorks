import type Database from "better-sqlite3";
import type { StudioMigration } from "./types";

function hasColumn(sqlite: Database.Database, table: string, column: string): boolean {
  const rows = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

function addColumn(sqlite: Database.Database, table: string, definition: string): void {
  const [column] = definition.split(/\s+/u);
  if (!hasColumn(sqlite, table, column)) sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
}

export const agentFirstFoundationMigration: StudioMigration = {
  version: "001",
  name: "agent-first-foundation",
  checksum: "sha256:agent-first-foundation-v3",
  up(sqlite) {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS project_heads (
        project_id TEXT NOT NULL REFERENCES projects(id),
        artifact_type TEXT NOT NULL,
        artifact_id TEXT NOT NULL REFERENCES artifacts(id),
        selected_at TEXT NOT NULL,
        selected_by TEXT NOT NULL,
        PRIMARY KEY(project_id, artifact_type)
      );
      CREATE TABLE IF NOT EXISTS artifact_edges (
        artifact_id TEXT NOT NULL REFERENCES artifacts(id),
        input_artifact_id TEXT NOT NULL REFERENCES artifacts(id),
        relation TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(artifact_id, input_artifact_id, relation)
      );
      CREATE TABLE IF NOT EXISTS operations (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        kind TEXT NOT NULL,
        target_type TEXT,
        target_id TEXT,
        status TEXT NOT NULL,
        phase TEXT,
        progress_current INTEGER,
        progress_total INTEGER,
        request_payload TEXT NOT NULL,
        result_payload TEXT,
        error_code TEXT,
        error_message TEXT,
        retryable INTEGER NOT NULL DEFAULT 0,
        process_id INTEGER,
        idempotency_key TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        heartbeat_at TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS operations_idempotency
        ON operations(project_id, kind, idempotency_key)
        WHERE idempotency_key IS NOT NULL;
      CREATE INDEX IF NOT EXISTS operations_project_created
        ON operations(project_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS operation_events (
        operation_id TEXT NOT NULL REFERENCES operations(id),
        sequence INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(operation_id, sequence)
      );
      CREATE TABLE IF NOT EXISTS project_issues (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        scope_type TEXT NOT NULL,
        scope_id TEXT,
        severity TEXT NOT NULL,
        code TEXT NOT NULL,
        title TEXT NOT NULL,
        detail TEXT NOT NULL,
        suggested_action TEXT,
        status TEXT NOT NULL,
        source TEXT NOT NULL,
        resolution_note TEXT,
        resolved_by TEXT,
        created_at TEXT NOT NULL,
        resolved_at TEXT
      );
      CREATE INDEX IF NOT EXISTS project_issues_scope
        ON project_issues(project_id, status, scope_type, scope_id);
      CREATE TABLE IF NOT EXISTS agent_threads (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        title TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES agent_threads(id),
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        message_type TEXT NOT NULL DEFAULT 'explanation',
        target_type TEXT,
        target_id TEXT,
        operation_id TEXT REFERENCES operations(id),
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS agent_messages_thread_created
        ON agent_messages(thread_id, created_at);
      CREATE TABLE IF NOT EXISTS revision_requests (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        target_artifact_id TEXT NOT NULL REFERENCES artifacts(id),
        target_type TEXT NOT NULL,
        instruction TEXT NOT NULL,
        intent TEXT NOT NULL,
        status TEXT NOT NULL,
        operation_id TEXT REFERENCES operations(id),
        output_artifact_id TEXT REFERENCES artifacts(id),
        created_at TEXT NOT NULL,
        completed_at TEXT
      );
    `);

    addColumn(sqlite, "approvals", "artifact_id TEXT");
    addColumn(sqlite, "generation_jobs", "storyboard_artifact_id TEXT");
    addColumn(sqlite, "generation_jobs", "shot_package_artifact_id TEXT");
    addColumn(sqlite, "renders", "manifest_artifact_id TEXT");
    addColumn(sqlite, "renders", "source_job_ids TEXT");
  },
};
