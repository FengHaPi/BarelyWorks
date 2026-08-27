import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createStudioDatabase, type StudioDatabase } from "../src/database/client";
import { OperationRepository } from "../src/operations/operation-repository";
import { OperationRunner } from "../src/operations/operation-runner";
import type { ProcessController } from "../src/operations/process-controller";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))));

async function fixture(): Promise<{ studio: StudioDatabase; projectId: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "operation-persistence-"));
  roots.push(root);
  const studio = createStudioDatabase(root);
  const projectId = randomUUID();
  const now = new Date().toISOString();
  studio.sqlite.prepare(`INSERT INTO projects(
    id,title,source_type,target_duration_sec,aspect_ratio,resolution,allow_story_suggestions,
    current_stage,stale_stages,source_path,project_dir,created_at,updated_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(projectId, "作业测试", "story", 20, "16:9", "1080p", 0, "SOURCE_IMPORTED", "[]", path.join(root, "source.txt"), root, now, now);
  return { studio, projectId };
}

async function waitFor(read: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (!read()) {
    if (Date.now() - started > timeoutMs) throw new Error("等待作业状态超时");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("persistent operations", () => {
  it("persists progress, result and idempotency across repository instances", async () => {
    const { studio, projectId } = await fixture();
    const repository = new OperationRepository(studio);
    const runner = new OperationRunner(repository, { terminateTree: async () => undefined }, 20);
    runner.register("test.work", async (context) => {
      context.progress("writing", 1, 2);
      context.progress("verifying", 2, 2);
      return { artifactId: "artifact-1" };
    });
    const first = repository.create({ projectId, kind: "test.work", targetId: "artifact-1", requestPayload: { value: 1 }, idempotencyKey: "same" });
    const duplicate = repository.create({ projectId, kind: "test.work", targetId: "artifact-1", requestPayload: { value: 1 }, idempotencyKey: "same" });
    expect(duplicate.created).toBe(false);
    expect(duplicate.operation.id).toBe(first.operation.id);
    runner.schedule(first.operation.id);
    await waitFor(() => new OperationRepository(studio).get(first.operation.id)?.status === "succeeded");
    const reloaded = new OperationRepository(studio).require(first.operation.id);
    expect(reloaded).toMatchObject({ status: "succeeded", phase: "completed", resultPayload: { artifactId: "artifact-1" } });
    expect(repository.listEvents(first.operation.id).map((event) => event.eventType)).toEqual([
      "operation.queued", "operation.started", "operation.progress", "operation.progress", "operation.succeeded",
    ]);
    await runner.close();
    studio.sqlite.close();
  });

  it("records cancellation only after aborting the handler and terminating its process tree", async () => {
    const { studio, projectId } = await fixture();
    const terminated: number[] = [];
    const controller: ProcessController = { terminateTree: async (processId) => { terminated.push(processId); } };
    const repository = new OperationRepository(studio);
    const runner = new OperationRunner(repository, controller, 20);
    let handlerSettled = false;
    runner.register("test.long", async (context) => {
      context.setProcessId(4242);
      try {
        await new Promise<void>((_resolve, reject) => context.signal.addEventListener("abort", () => reject(new Error("已停止")), { once: true }));
        return {};
      } finally {
        handlerSettled = true;
      }
    });
    const operation = repository.create({ projectId, kind: "test.long", requestPayload: {} }).operation;
    runner.schedule(operation.id);
    await waitFor(() => repository.get(operation.id)?.processId === 4242);
    const cancelled = await runner.cancel(operation.id);
    expect(cancelled.status).toBe("cancelled");
    expect(handlerSettled).toBe(true);
    expect(terminated).toEqual([4242]);
    expect(repository.listEvents(operation.id).map((event) => event.eventType)).toContain("operation.process-tree-terminated");
    await runner.close();
    studio.sqlite.close();
  });

  it("marks stale running work as interrupted instead of completed", async () => {
    const { studio, projectId } = await fixture();
    const repository = new OperationRepository(studio);
    const operation = repository.create({ projectId, kind: "test.recover", requestPayload: {} }).operation;
    repository.claim(operation.id);
    studio.sqlite.prepare("UPDATE operations SET heartbeat_at = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", operation.id);
    const recovered = repository.recoverInterrupted("2026-01-01T00:00:00.000Z");
    expect(recovered).toHaveLength(1);
    expect(repository.require(operation.id)).toMatchObject({ status: "failed", errorCode: "APP_RESTARTED", retryable: true });
    studio.sqlite.close();
  });
});
