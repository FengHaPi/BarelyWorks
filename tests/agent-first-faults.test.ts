import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { ArtifactRevisionExecutor } from "../src/revisions/artifact-revision-executor";
import { createApp } from "../src/server";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))));

const projectInput = {
  title: "Agent-first 故障注入",
  sourceType: "screenplay",
  sourceText: "# 第一场\n\n原始版本。",
  targetDurationSec: 20,
  aspectRatio: "16:9",
  resolution: "1280x720",
  videoType: "叙事短片",
  visualStyle: "写实",
  releasePlatform: "本地",
  targetAudience: "测试",
  allowStorySuggestions: false,
};

async function createFixture(executor: ArtifactRevisionExecutor) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-first-fault-"));
  roots.push(root);
  const app = await createApp({ runtimeRoot: root, logger: false, artifactRevisionExecutor: executor });
  const project = (await app.inject({ method: "POST", url: "/api/projects", payload: projectInput })).json().project;
  const workspace = (await app.inject({ method: "GET", url: `/api/projects/${project.id}/workspace` })).json().workspace;
  const artifact = workspace.artifactGroups.find((group: { type: string }) => group.type === "screenplay").head;
  return { root, app, project, artifact };
}

async function startAndWait(fixture: Awaited<ReturnType<typeof createFixture>>, instruction: string) {
  const started = await fixture.app.inject({ method: "POST", url: `/api/projects/${fixture.project.id}/revisions`, payload: {
    targetArtifactId: fixture.artifact.id,
    instruction,
    intent: "revise",
    idempotencyKey: instruction,
  } });
  expect(started.statusCode).toBe(202);
  const operationId = started.json().operationId as string;
  const beganAt = Date.now();
  for (;;) {
    const operation = (await fixture.app.inject({ method: "GET", url: `/api/operations/${operationId}` })).json().operation;
    if (["succeeded", "failed", "cancelled"].includes(operation.status)) return operation;
    if (Date.now() - beganAt > 3_000) throw new Error("等待故障注入作业结束超时");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function expectNoFalseCompletion(fixture: Awaited<ReturnType<typeof createFixture>>) {
  const workspace = (await fixture.app.inject({ method: "GET", url: `/api/projects/${fixture.project.id}/workspace` })).json().workspace;
  const screenplay = workspace.artifactGroups.find((group: { type: string }) => group.type === "screenplay");
  expect(screenplay.versions).toHaveLength(1);
  expect(screenplay.head.id).toBe(fixture.artifact.id);
  expect(workspace.operations).toHaveLength(1);
  expect(workspace.operations[0].status).toBe("failed");
  expect(workspace.issues).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: "revision-failed", scopeId: fixture.artifact.id, status: "open" }),
  ]));
}

describe("Agent-first fault injection", () => {
  it.each([
    ["Provider 超时", "fixture.provider-timeout", "PROVIDER_TIMEOUT"],
    ["Provider 进程被杀", "fixture.provider-process-exited", "PROVIDER_PROCESS_EXITED"],
  ])("stops at %s without creating downstream completion", async (message, eventType, expectedCode) => {
    const fixture = await createFixture({
      async revise(input) {
        input.onEvent?.(eventType, { injected: true });
        throw new Error(message);
      },
    });
    const operation = await startAndWait(fixture, message);
    expect(operation).toMatchObject({
      status: "failed", errorCode: expectedCode, errorMessage: message,
      resultPayload: { failedPhase: "agent-revision", completedActions: ["读取并校验目标版本"] },
    });
    const events = (await fixture.app.inject({ method: "GET", url: `/api/operations/${operation.id}/events` })).json().events;
    expect(events.map((event: { eventType: string }) => event.eventType)).toContain(eventType);
    await expectNoFalseCompletion(fixture);
    await fixture.app.close();
  });

  it("preserves a conflicting file and removes temporary output when the atomic file install fails", async () => {
    const fixture = await createFixture({ async revise(input) {
      return { content: `${input.artifact.content}\n新版`, changeSummary: ["新版"], provider: "fixture", runId: "file-failure" };
    } });
    const versionPath = path.join(fixture.project.projectDir, "screenplay", "screenplay-v002.md");
    await fs.mkdir(path.dirname(versionPath), { recursive: true });
    await fs.writeFile(versionPath, "不可覆盖的既有证据", { encoding: "utf8", flag: "wx" });
    const operation = await startAndWait(fixture, "注入文件写入冲突");
    expect(operation.status).toBe("failed");
    expect(await fs.readFile(versionPath, "utf8")).toBe("不可覆盖的既有证据");
    expect((await fs.readdir(path.dirname(versionPath))).some((name) => name.endsWith(".tmp"))).toBe(false);
    await expectNoFalseCompletion(fixture);
    await fixture.app.close();
  });

  it("rolls back the installed file when the artifact database transaction fails", async () => {
    const fixture = await createFixture({ async revise(input) {
      return { content: `${input.artifact.content}\n新版`, changeSummary: ["新版"], provider: "fixture", runId: "database-failure" };
    } });
    const injected = new Database(path.join(fixture.root, "data", "studio.sqlite"));
    injected.exec(`
      CREATE TRIGGER fail_agent_revision_insert
      BEFORE INSERT ON artifacts
      WHEN NEW.metadata LIKE '%project-agent-revision%'
      BEGIN
        SELECT RAISE(ABORT, 'injected artifact transaction failure');
      END;
    `);
    injected.close();
    const operation = await startAndWait(fixture, "注入数据库事务失败");
    expect(operation).toMatchObject({ status: "failed", errorMessage: expect.stringContaining("injected artifact transaction failure") });
    const versionPath = path.join(fixture.project.projectDir, "screenplay", "screenplay-v002.md");
    await expect(fs.access(versionPath)).rejects.toThrow();
    expect((await fs.readdir(path.dirname(versionPath))).some((name) => name.endsWith(".tmp"))).toBe(false);
    await expectNoFalseCompletion(fixture);
    await fixture.app.close();
  });
});
