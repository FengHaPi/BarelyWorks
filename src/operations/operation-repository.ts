import { randomUUID } from "node:crypto";
import type { StudioDatabase } from "../database/client";
import { parseJsonObject } from "../database/row-utils";
import type { Operation, OperationEvent } from "../shared/api-contracts/agent-first";

interface OperationRow {
  id: string; project_id: string; kind: string; target_type: string | null; target_id: string | null;
  status: Operation["status"]; phase: string | null; progress_current: number | null; progress_total: number | null;
  request_payload: string; result_payload: string | null; error_code: string | null; error_message: string | null;
  retryable: number; process_id: number | null; idempotency_key: string | null; created_at: string;
  started_at: string | null; finished_at: string | null; heartbeat_at: string | null;
}

interface EventRow {
  operation_id: string; sequence: number; event_type: string; payload: string; created_at: string;
}

function mapOperation(row: OperationRow): Operation {
  return {
    id: row.id, projectId: row.project_id, kind: row.kind, targetType: row.target_type, targetId: row.target_id,
    status: row.status, phase: row.phase, progressCurrent: row.progress_current, progressTotal: row.progress_total,
    requestPayload: parseJsonObject(row.request_payload), resultPayload: row.result_payload ? parseJsonObject(row.result_payload) : null,
    errorCode: row.error_code, errorMessage: row.error_message, retryable: Boolean(row.retryable),
    processId: row.process_id, idempotencyKey: row.idempotency_key, createdAt: row.created_at,
    startedAt: row.started_at, finishedAt: row.finished_at, heartbeatAt: row.heartbeat_at,
  };
}

function mapEvent(row: EventRow): OperationEvent {
  return { operationId: row.operation_id, sequence: row.sequence, eventType: row.event_type, payload: parseJsonObject(row.payload), createdAt: row.created_at };
}

export interface CreateOperationInput {
  projectId: string;
  kind: string;
  targetType?: string | null;
  targetId?: string | null;
  requestPayload: Record<string, unknown>;
  idempotencyKey?: string | null;
  phase?: string | null;
  progressTotal?: number | null;
}

export class OperationRepository {
  constructor(private readonly studio: StudioDatabase) {}

  create(input: CreateOperationInput): { operation: Operation; created: boolean } {
    const requestPayload = JSON.stringify(input.requestPayload);
    if (input.idempotencyKey) {
      const existing = this.studio.sqlite.prepare(`
        SELECT * FROM operations WHERE project_id = ? AND kind = ? AND idempotency_key = ?
      `).get(input.projectId, input.kind, input.idempotencyKey) as OperationRow | undefined;
      if (existing) {
        if (existing.request_payload !== requestPayload || existing.target_id !== (input.targetId ?? null)) {
          throw new Error("幂等键已用于不同请求");
        }
        return { operation: mapOperation(existing), created: false };
      }
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    this.studio.sqlite.transaction(() => {
      this.studio.sqlite.prepare(`
        INSERT INTO operations(
          id, project_id, kind, target_type, target_id, status, phase, progress_current,
          progress_total, request_payload, retryable, idempotency_key, created_at
        ) VALUES(?,?,?,?,?,'queued',?,0,?,?,0,?,?)
      `).run(id, input.projectId, input.kind, input.targetType ?? null, input.targetId ?? null,
        input.phase ?? "queued", input.progressTotal ?? null, requestPayload, input.idempotencyKey ?? null, now);
      this.appendEventInTransaction(id, "operation.queued", { kind: input.kind, phase: input.phase ?? "queued" }, now);
    })();
    return { operation: this.require(id), created: true };
  }

  get(id: string): Operation | null {
    const row = this.studio.sqlite.prepare("SELECT * FROM operations WHERE id = ?").get(id) as OperationRow | undefined;
    return row ? mapOperation(row) : null;
  }

  require(id: string): Operation {
    const operation = this.get(id);
    if (!operation) throw new Error("作业不存在");
    return operation;
  }

  listProject(projectId: string, limit = 50): Operation[] {
    const rows = this.studio.sqlite.prepare("SELECT * FROM operations WHERE project_id = ? ORDER BY created_at DESC LIMIT ?").all(projectId, limit) as OperationRow[];
    return rows.map(mapOperation);
  }

  listEvents(operationId: string): OperationEvent[] {
    const rows = this.studio.sqlite.prepare("SELECT * FROM operation_events WHERE operation_id = ? ORDER BY sequence").all(operationId) as EventRow[];
    return rows.map(mapEvent);
  }

  listQueued(): Operation[] {
    return (this.studio.sqlite.prepare("SELECT * FROM operations WHERE status = 'queued' ORDER BY created_at").all() as OperationRow[]).map(mapOperation);
  }

  claim(id: string): Operation | null {
    const now = new Date().toISOString();
    const claimed = this.studio.sqlite.transaction(() => {
      const result = this.studio.sqlite.prepare(`
        UPDATE operations SET status = 'running', phase = COALESCE(NULLIF(phase, 'queued'), 'starting'),
          started_at = COALESCE(started_at, ?), heartbeat_at = ?
        WHERE id = ? AND status = 'queued'
      `).run(now, now, id);
      if (!result.changes) return false;
      this.appendEventInTransaction(id, "operation.started", {}, now);
      return true;
    })();
    return claimed ? this.require(id) : null;
  }

  updateProgress(id: string, phase: string, current?: number | null, total?: number | null, payload: Record<string, unknown> = {}): Operation {
    const now = new Date().toISOString();
    this.studio.sqlite.transaction(() => {
      this.studio.sqlite.prepare(`
        UPDATE operations SET phase = ?, progress_current = COALESCE(?, progress_current),
          progress_total = COALESCE(?, progress_total), heartbeat_at = ?
        WHERE id = ? AND status IN ('running','cancel_requested')
      `).run(phase, current ?? null, total ?? null, now, id);
      this.appendEventInTransaction(id, "operation.progress", { phase, current: current ?? null, total: total ?? null, ...payload }, now);
    })();
    return this.require(id);
  }

  heartbeat(id: string): void {
    this.studio.sqlite.prepare("UPDATE operations SET heartbeat_at = ? WHERE id = ? AND status IN ('running','cancel_requested')").run(new Date().toISOString(), id);
  }

  setProcessId(id: string, processId: number | null): void {
    const now = new Date().toISOString();
    this.studio.sqlite.transaction(() => {
      this.studio.sqlite.prepare("UPDATE operations SET process_id = ?, heartbeat_at = ? WHERE id = ?").run(processId, now, id);
      this.appendEventInTransaction(id, "operation.process", { processId }, now);
    })();
  }

  appendEvent(id: string, eventType: string, payload: Record<string, unknown>): OperationEvent {
    const now = new Date().toISOString();
    const sequence = this.studio.sqlite.transaction(() => this.appendEventInTransaction(id, eventType, payload, now))();
    return { operationId: id, sequence, eventType, payload, createdAt: now };
  }

  succeed(id: string, resultPayload: Record<string, unknown>): Operation {
    const now = new Date().toISOString();
    this.studio.sqlite.transaction(() => {
      const operation = this.require(id);
      if (operation.status === "cancel_requested") {
        this.markCancelledInTransaction(id, "取消请求在提交成功前生效", now);
        return;
      }
      const result = this.studio.sqlite.prepare(`
        UPDATE operations SET status = 'succeeded', phase = 'completed', result_payload = ?,
          progress_current = COALESCE(progress_total, progress_current), finished_at = ?, heartbeat_at = ?, process_id = NULL
        WHERE id = ? AND status = 'running'
      `).run(JSON.stringify(resultPayload), now, now, id);
      if (result.changes) this.appendEventInTransaction(id, "operation.succeeded", resultPayload, now);
    })();
    return this.require(id);
  }

  fail(id: string, code: string, message: string, retryable: boolean, details: Record<string, unknown> = {}): Operation {
    const now = new Date().toISOString();
    this.studio.sqlite.transaction(() => {
      const operation = this.require(id);
      if (operation.status === "cancel_requested") {
        this.markCancelledInTransaction(id, message, now);
        return;
      }
      const result = this.studio.sqlite.prepare(`
        UPDATE operations SET status = 'failed', phase = 'failed', error_code = ?, error_message = ?, result_payload = ?,
          retryable = ?, finished_at = ?, heartbeat_at = ?, process_id = NULL
        WHERE id = ? AND status IN ('queued','running')
      `).run(code, message, Object.keys(details).length ? JSON.stringify(details) : null, retryable ? 1 : 0, now, now, id);
      if (result.changes) this.appendEventInTransaction(id, "operation.failed", { code, message, retryable, ...details }, now);
    })();
    return this.require(id);
  }

  requestCancel(id: string): Operation {
    const now = new Date().toISOString();
    this.studio.sqlite.transaction(() => {
      const operation = this.require(id);
      if (operation.status === "queued") {
        this.markCancelledInTransaction(id, "排队期间由用户取消", now);
      } else if (operation.status === "running") {
        this.studio.sqlite.prepare("UPDATE operations SET status = 'cancel_requested', phase = 'cancelling', heartbeat_at = ? WHERE id = ?").run(now, id);
        this.appendEventInTransaction(id, "operation.cancel-requested", {}, now);
      }
    })();
    return this.require(id);
  }

  markCancelled(id: string, message = "作业已取消"): Operation {
    const now = new Date().toISOString();
    this.studio.sqlite.transaction(() => this.markCancelledInTransaction(id, message, now))();
    return this.require(id);
  }

  recoverInterrupted(cutoffIso: string): Operation[] {
    const rows = this.studio.sqlite.prepare(`
      SELECT * FROM operations WHERE status IN ('running','cancel_requested')
      AND (heartbeat_at IS NULL OR heartbeat_at < ?)
    `).all(cutoffIso) as OperationRow[];
    for (const row of rows) {
      if (row.status === "cancel_requested") this.markCancelled(row.id, "应用重启后确认原进程已不存在");
      else this.fail(row.id, "APP_RESTARTED", "应用重启时发现遗留运行作业；未伪造完成状态", true, { recovered: true });
    }
    return rows.map((row) => this.require(row.id));
  }

  private appendEventInTransaction(id: string, eventType: string, payload: Record<string, unknown>, createdAt: string): number {
    const row = this.studio.sqlite.prepare("SELECT COALESCE(MAX(sequence), -1) + 1 AS sequence FROM operation_events WHERE operation_id = ?").get(id) as { sequence: number };
    this.studio.sqlite.prepare(`
      INSERT INTO operation_events(operation_id, sequence, event_type, payload, created_at) VALUES(?,?,?,?,?)
    `).run(id, row.sequence, eventType, JSON.stringify(payload), createdAt);
    return row.sequence;
  }

  private markCancelledInTransaction(id: string, message: string, now: string): void {
    const result = this.studio.sqlite.prepare(`
      UPDATE operations SET status = 'cancelled', phase = 'cancelled', error_code = 'CANCELLED',
        error_message = ?, retryable = 1, finished_at = ?, heartbeat_at = ?, process_id = NULL
      WHERE id = ? AND status IN ('queued','running','cancel_requested')
    `).run(message, now, now, id);
    if (result.changes) this.appendEventInTransaction(id, "operation.cancelled", { message }, now);
  }
}
