import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server";
import type { ProjectAgentExecutor } from "../src/agent/project-agent-executor";
import type { ArtifactRevisionExecutor } from "../src/revisions/artifact-revision-executor";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))));

const projectInput = {
  title: "Agent-first 测试",
  sourceType: "screenplay",
  sourceText: "# 第一场\n\n旧版对白。",
  targetDurationSec: 20,
  aspectRatio: "16:9",
  resolution: "1920x1080",
  videoType: "叙事短片",
  visualStyle: "写实",
  releasePlatform: "本地",
  targetAudience: "测试",
  allowStorySuggestions: false,
};

async function waitForOperation(app: Awaited<ReturnType<typeof createApp>>, operationId: string, terminal = ["succeeded", "failed", "cancelled"]) {
  const started = Date.now();
  for (;;) {
    const response = await app.inject({ method: "GET", url: `/api/operations/${operationId}` });
    const operation = response.json().operation;
    if (terminal.includes(operation.status)) return operation;
    if (Date.now() - started > 3_000) throw new Error("等待 operation 超时");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("agent-first HTTP contract", () => {
  it("creates an immutable revision operation without changing Head or the legacy project stage", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-first-api-"));
    roots.push(root);
    const executor: ArtifactRevisionExecutor = {
      async revise(input) {
        input.onEvent?.("test.provider", { ok: true });
        return { content: `${input.artifact.content.trim()}\n\n新版对白。\n`, changeSummary: ["追加新版对白"], provider: "test-double", runId: "run-1" };
      },
    };
    const app = await createApp({ runtimeRoot: root, logger: false, artifactRevisionExecutor: executor });
    const created = await app.inject({ method: "POST", url: "/api/projects", payload: projectInput });
    const project = created.json().project;
    const workspaceResponse = await app.inject({ method: "GET", url: `/api/projects/${project.id}/workspace` });
    expect(workspaceResponse.statusCode).toBe(200);
    const screenplay = workspaceResponse.json().workspace.artifactGroups.find((group: { type: string }) => group.type === "screenplay");
    expect(screenplay.head.version).toBe(1);
    const originalHeadId = screenplay.head.id;

    const started = Date.now();
    const revision = await app.inject({
      method: "POST", url: `/api/projects/${project.id}/revisions`,
      payload: { targetArtifactId: originalHeadId, instruction: "追加新版对白", intent: "revise", idempotencyKey: "revision-one" },
    });
    expect(revision.statusCode).toBe(202);
    expect(Date.now() - started).toBeLessThan(500);
    const terminal = await waitForOperation(app, revision.json().operationId);
    expect(terminal).toMatchObject({ status: "succeeded", resultPayload: { version: 2, headChanged: false } });

    const refreshed = (await app.inject({ method: "GET", url: `/api/projects/${project.id}/workspace` })).json().workspace;
    const refreshedScreenplay = refreshed.artifactGroups.find((group: { type: string }) => group.type === "screenplay");
    expect(refreshedScreenplay.versions).toHaveLength(2);
    expect(refreshedScreenplay.head.id).toBe(originalHeadId);
    const newArtifact = refreshedScreenplay.versions.find((artifact: { version: number }) => artifact.version === 2);
    const detail = await app.inject({ method: "GET", url: `/api/projects/${project.id}/artifacts/${newArtifact.id}` });
    expect(detail.json()).toMatchObject({ artifact: { version: 2, isHead: false }, inputs: [{ inputArtifactId: originalHeadId, relation: "derived-from" }] });

    const selected = await app.inject({
      method: "PATCH", url: `/api/projects/${project.id}/heads/screenplay`, payload: { artifactId: newArtifact.id, selectedBy: "user" },
    });
    expect(selected.json().workspace.artifactGroups.find((group: { type: string }) => group.type === "screenplay").head.id).toBe(newArtifact.id);
    const beforeApprovalStage = (await app.inject({ method: "GET", url: `/api/projects/${project.id}` })).json().project.currentStage;
    const approval = await app.inject({
      method: "POST", url: `/api/projects/${project.id}/artifacts/${newArtifact.id}/decisions`, payload: { decision: "approved", comment: "仅批准该版本" },
    });
    expect(approval.statusCode).toBe(201);
    const repeatedApproval = await app.inject({
      method: "POST", url: `/api/projects/${project.id}/artifacts/${newArtifact.id}/decisions`, payload: { decision: "approved", comment: "重复点击不应写入" },
    });
    expect(repeatedApproval.statusCode).toBe(201);
    expect(repeatedApproval.json().approvalId).toBe(approval.json().approvalId);
    const approvedDetail = await app.inject({ method: "GET", url: `/api/projects/${project.id}/artifacts/${newArtifact.id}` });
    expect(approvedDetail.json().approvals).toHaveLength(1);
    expect((await app.inject({ method: "GET", url: `/api/projects/${project.id}` })).json().project.currentStage).toBe(beforeApprovalStage);
    await app.close();
  });

  it("runs read-only Agent messages through a real executor operation without creating artifact versions", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-first-agent-"));
    roots.push(root);
    const executor: ArtifactRevisionExecutor = { async revise() { throw new Error("不应调用修订执行器"); } };
    const agentExecutor: ProjectAgentExecutor = {
      async respond(input) {
        return {
          answer: input.mode === "plan"
            ? `真实计划：${input.artifacts.map((item) => `${item.type} V${item.version}`).join("、")}`
            : `真实分析：${input.userInstruction}；目标正文包含“${input.artifacts[0].content.trim().slice(0, 8)}”。`,
          provider: "test-double",
          runId: `agent-${input.mode}`,
        };
      },
    };
    const app = await createApp({ runtimeRoot: root, logger: false, artifactRevisionExecutor: executor, projectAgentExecutor: agentExecutor });
    const project = (await app.inject({ method: "POST", url: "/api/projects", payload: projectInput })).json().project;
    const outline = (await app.inject({
      method: "POST", url: `/api/projects/${project.id}/artifacts/outline`,
      payload: { content: "# 大纲\n\n只用于多目标计划测试。", expectedLatestArtifactId: null },
    })).json().artifact;
    const workspace = (await app.inject({ method: "GET", url: `/api/projects/${project.id}/workspace` })).json().workspace;
    const artifactId = workspace.artifactGroups.find((group: { type: string }) => group.type === "screenplay").head.id;
    const thread = (await app.inject({ method: "POST", url: `/api/projects/${project.id}/agent/threads`, payload: { title: "剧本讨论" } })).json().thread;
    const before = workspace.artifactGroups.find((group: { type: string }) => group.type === "screenplay").versions.length;
    const answer = await app.inject({
      method: "POST", url: `/api/projects/${project.id}/agent/threads/${thread.id}/messages`,
      payload: { mode: "ask", targetArtifactId: artifactId, content: "这一版是什么状态？" },
    });
    expect(answer.statusCode).toBe(202);
    expect(answer.json()).toMatchObject({ kind: "operation", message: { messageType: "operation", targetId: artifactId } });
    const answerOperation = await waitForOperation(app, answer.json().operationId);
    expect(answerOperation).toMatchObject({ status: "succeeded", resultPayload: { provider: "test-double", messageType: "explanation", sideEffects: [] } });
    const answeredMessages = (await app.inject({ method: "GET", url: `/api/projects/${project.id}/agent/threads/${thread.id}/messages` })).json().messages;
    expect(answeredMessages.at(-1)).toMatchObject({ messageType: "explanation", content: expect.stringContaining("真实分析：这一版是什么状态？") });
    const plan = await app.inject({
      method: "POST", url: `/api/projects/${project.id}/agent/threads/${thread.id}/messages`,
      payload: { mode: "revise", targetArtifactIds: [artifactId, outline.id], content: "同时修改" },
    });
    expect(plan.statusCode).toBe(202);
    expect(plan.json()).toMatchObject({ kind: "operation", impactedArtifactIds: expect.arrayContaining([artifactId, outline.id]) });
    const planOperation = await waitForOperation(app, plan.json().operationId);
    expect(planOperation).toMatchObject({ status: "succeeded", resultPayload: { provider: "test-double", messageType: "plan", sideEffects: [] } });
    const after = (await app.inject({ method: "GET", url: `/api/projects/${project.id}/workspace` })).json().workspace;
    expect(after.artifactGroups.find((group: { type: string }) => group.type === "screenplay").versions).toHaveLength(before);
    expect(after.operations.map((operation: { kind: string }) => operation.kind)).toEqual(["agent.respond", "agent.respond"]);
    await app.close();
  });

  it("fails visibly when the Agent provider is unavailable instead of returning a fixed fallback", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-first-agent-failure-"));
    roots.push(root);
    const app = await createApp({
      runtimeRoot: root,
      logger: false,
      artifactRevisionExecutor: { async revise() { throw new Error("不应调用修订执行器"); } },
      projectAgentExecutor: { async respond() { throw new Error("测试网络不可用"); } },
    });
    const project = (await app.inject({ method: "POST", url: "/api/projects", payload: projectInput })).json().project;
    const workspace = (await app.inject({ method: "GET", url: `/api/projects/${project.id}/workspace` })).json().workspace;
    const artifactId = workspace.artifactGroups.find((group: { type: string }) => group.type === "screenplay").head.id;
    const thread = (await app.inject({ method: "POST", url: `/api/projects/${project.id}/agent/threads`, payload: { title: "失败测试" } })).json().thread;
    const response = await app.inject({
      method: "POST", url: `/api/projects/${project.id}/agent/threads/${thread.id}/messages`,
      payload: { mode: "ask", targetArtifactId: artifactId, content: "给我真实回答" },
    });
    const operation = await waitForOperation(app, response.json().operationId);
    expect(operation).toMatchObject({ status: "failed", errorCode: "AGENT_PROVIDER_FAILED", retryable: true });
    const messages = (await app.inject({ method: "GET", url: `/api/projects/${project.id}/agent/threads/${thread.id}/messages` })).json().messages;
    expect(messages.at(-1)).toMatchObject({ messageType: "error", content: expect.stringContaining("测试网络不可用") });
    expect(messages.at(-1).content).not.toContain("正文");
    const after = (await app.inject({ method: "GET", url: `/api/projects/${project.id}/workspace` })).json().workspace;
    expect(after.artifactGroups.find((group: { type: string }) => group.type === "screenplay").versions).toHaveLength(1);
    await app.close();
  });

  it("creates persistent production commands and keeps legacy stage unchanged on a blocked command", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-first-production-operation-"));
    roots.push(root);
    const app = await createApp({
      runtimeRoot: root,
      logger: false,
      artifactRevisionExecutor: { async revise() { throw new Error("不应调用修订执行器"); } },
      projectAgentExecutor: { async respond() { throw new Error("不应调用 Agent"); } },
    });
    const project = (await app.inject({ method: "POST", url: "/api/projects", payload: projectInput })).json().project;
    const beforeStage = (await app.inject({ method: "GET", url: `/api/projects/${project.id}` })).json().project.currentStage;
    const started = Date.now();
    const response = await app.inject({
      method: "POST", url: `/api/projects/${project.id}/production/bootstrap`, payload: { idempotencyKey: "blocked-bootstrap" },
    });
    expect(response.statusCode).toBe(202);
    expect(Date.now() - started).toBeLessThan(500);
    expect(response.json()).toMatchObject({ operation: { kind: "generation.bootstrap", status: "queued" } });
    const terminal = await waitForOperation(app, response.json().operationId);
    expect(terminal.status).toBe("failed");
    expect(terminal.errorMessage).toContain("storyboard Head");
    expect((await app.inject({ method: "GET", url: `/api/projects/${project.id}` })).json().project.currentStage).toBe(beforeStage);
    const duplicate = await app.inject({
      method: "POST", url: `/api/projects/${project.id}/production/bootstrap`, payload: { idempotencyKey: "blocked-bootstrap" },
    });
    expect(duplicate.json().operationId).toBe(response.json().operationId);
    await app.close();
  });

  it("cancels a running revision without writing a new artifact", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-first-cancel-"));
    roots.push(root);
    const executor: ArtifactRevisionExecutor = {
      async revise(input) {
        input.onProcessId?.(6789);
        await new Promise<void>((_resolve, reject) => input.signal.addEventListener("abort", () => reject(new Error("已取消")), { once: true }));
        throw new Error("不可达");
      },
    };
    const terminated: number[] = [];
    const app = await createApp({
      runtimeRoot: root, logger: false, artifactRevisionExecutor: executor,
      processController: { terminateTree: async (processId) => { terminated.push(processId); } },
    });
    const project = (await app.inject({ method: "POST", url: "/api/projects", payload: projectInput })).json().project;
    const workspace = (await app.inject({ method: "GET", url: `/api/projects/${project.id}/workspace` })).json().workspace;
    const artifactId = workspace.artifactGroups.find((group: { type: string }) => group.type === "screenplay").head.id;
    const revision = (await app.inject({ method: "POST", url: `/api/projects/${project.id}/revisions`, payload: {
      targetArtifactId: artifactId, instruction: "执行一个会被取消的修改", intent: "revise", idempotencyKey: "cancel-me",
    } })).json();
    let running = await waitForOperation(app, revision.operationId, ["running"]);
    const processWaitStarted = Date.now();
    while (running.processId !== 6789) {
      if (Date.now() - processWaitStarted > 2_000) throw new Error("等待子进程登记超时");
      await new Promise((resolve) => setTimeout(resolve, 10));
      running = (await app.inject({ method: "GET", url: `/api/operations/${revision.operationId}` })).json().operation;
    }
    const cancelled = await app.inject({ method: "POST", url: `/api/operations/${revision.operationId}/cancel` });
    expect(cancelled.json().operation.status).toBe("cancelled");
    expect(terminated).toEqual([6789]);
    const refreshed = (await app.inject({ method: "GET", url: `/api/projects/${project.id}/workspace` })).json().workspace;
    expect(refreshed.artifactGroups.find((group: { type: string }) => group.type === "screenplay").versions).toHaveLength(1);
    await app.close();
  });
});
