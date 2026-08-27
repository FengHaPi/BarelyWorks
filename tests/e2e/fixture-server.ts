import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import type { ArtifactRevisionExecutor } from "../../src/revisions/artifact-revision-executor";
import type { ProjectAgentExecutor } from "../../src/agent/project-agent-executor";
import { createApp } from "../../src/server";

const runtimeRoot = path.join(os.tmpdir(), "ai-video-studio-agent-first-e2e");
const safeTemporaryParent = path.resolve(os.tmpdir());
const resolvedRuntimeRoot = path.resolve(runtimeRoot);
if (!resolvedRuntimeRoot.startsWith(`${safeTemporaryParent}${path.sep}`)) throw new Error("E2E 临时目录不在系统临时目录内");
await fs.rm(resolvedRuntimeRoot, { recursive: true, force: true });
await fs.mkdir(path.join(resolvedRuntimeRoot, "dist"), { recursive: true });
await fs.cp(path.resolve("dist", "ui"), path.join(resolvedRuntimeRoot, "dist", "ui"), { recursive: true });

const executor: ArtifactRevisionExecutor = {
  async revise(input) {
    input.onEvent?.("fixture.provider-started", { intent: input.intent });
    if (input.instruction.includes("[hang]")) {
      await new Promise<void>((_resolve, reject) => {
        input.signal.addEventListener("abort", () => reject(new Error("浏览器用例已确认取消")), { once: true });
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
    if (input.instruction.includes("[fail]")) throw new Error("注入的 Provider 失败，未写入新版本");
    return {
      content: `${input.artifact.content.trim()}\n\n${input.instruction}\n`,
      changeSummary: [input.instruction],
      provider: "playwright-fixture",
      runId: randomUUID(),
    };
  },
};
const agentExecutor: ProjectAgentExecutor = {
  async respond(input) {
    await new Promise((resolve) => setTimeout(resolve, 80));
    return {
      answer: `真实 Agent 测试回答：${input.userInstruction}；读取到 ${input.artifacts[0].type} V${input.artifacts[0].version}。`,
      provider: "playwright-fixture",
      runId: randomUUID(),
    };
  },
};

const app = await createApp({
  runtimeRoot: resolvedRuntimeRoot,
  apiPort: 4328,
  logger: false,
  artifactRevisionExecutor: executor,
  projectAgentExecutor: agentExecutor,
  processController: { terminateTree: async () => undefined },
});
app.post("/__e2e/shutdown", async (_request, reply) => {
  reply.send({ ok: true });
  setTimeout(() => { void shutdown().finally(() => process.exit(0)); }, 25).unref();
});

const projectInput = {
  title: "Playwright Agent-first 项目",
  sourceType: "screenplay",
  sourceText: "# 第一场\n\nV1 原始对白。",
  targetDurationSec: 20,
  aspectRatio: "16:9",
  resolution: "1280x720",
  videoType: "叙事短片",
  visualStyle: "写实",
  releasePlatform: "本地",
  targetAudience: "测试",
  allowStorySuggestions: false,
};
const created = await app.inject({ method: "POST", url: "/api/projects", payload: projectInput });
if (created.statusCode !== 201) throw new Error(`E2E 项目创建失败：${created.body}`);
const project = created.json().project as { id: string; projectDir: string };
const workspace = (await app.inject({ method: "GET", url: `/api/projects/${project.id}/workspace` })).json().workspace;
const v1 = workspace.artifactGroups.find((group: { type: string }) => group.type === "screenplay").head;
const revision = (await app.inject({
  method: "POST",
  url: `/api/projects/${project.id}/revisions`,
  payload: { targetArtifactId: v1.id, instruction: "E2E 预置 V2", intent: "revise", idempotencyKey: "e2e-seed-v2" },
})).json();
for (;;) {
  const operation = (await app.inject({ method: "GET", url: `/api/operations/${revision.operationId}` })).json().operation;
  if (operation.status === "succeeded") break;
  if (operation.status === "failed" || operation.status === "cancelled") throw new Error(`E2E V2 预置失败：${JSON.stringify(operation)}`);
  await new Promise((resolve) => setTimeout(resolve, 10));
}
const seededWorkspace = (await app.inject({ method: "GET", url: `/api/projects/${project.id}/workspace` })).json().workspace;
const v2 = seededWorkspace.artifactGroups.find((group: { type: string }) => group.type === "screenplay").versions
  .find((artifact: { version: number }) => artifact.version === 2);
const selectedHead = await app.inject({ method: "PATCH", url: `/api/projects/${project.id}/heads/screenplay`, payload: { artifactId: v2.id, selectedBy: "user" } });
if (selectedHead.statusCode !== 200) throw new Error(`E2E Head 预置失败：${selectedHead.body}`);

const sqlite = new Database(path.join(resolvedRuntimeRoot, "data", "studio.sqlite"));
const now = new Date().toISOString();
const assetId = "CHAR-001";
sqlite.prepare(`INSERT INTO project_issues(
  id, project_id, scope_type, scope_id, severity, code, title, detail,
  suggested_action, status, source, created_at
) VALUES(?,?,?,?,?,?,?,?,?,'open','fixture',?)`).run(
  "e2e-project-guidance",
  project.id,
  "project",
  null,
  "warning",
  "e2e-project-guidance",
  "端到端问题中心可读性检查",
  "这条测试记录用于确认问题中心的按钮、说明和输入框都清晰可见。",
  "核对界面后保留记录",
  now,
);
sqlite.prepare(`INSERT INTO assets(id, project_id, type, name, version, payload, approved) VALUES(?,?,?,?,?,?,?)`).run(
  assetId,
  project.id,
  "character",
  "测试角色",
  1,
  JSON.stringify({
    id: assetId,
    projectId: project.id,
    type: "character",
    name: "测试角色",
    version: 1,
    localFiles: [],
    sha256: [],
    approved: true,
    authorizationState: "confirmed",
    uploadState: {},
    referencedBy: [],
    identity: "用于验证上传闭环的测试角色",
    appearance: "测试外观",
    designBasis: "creative-proposal",
    productionReady: true,
    designSummary: "浏览器测试资产",
    distinctiveFeatures: ["测试标记"],
    negativeConstraints: [],
    fileRoles: [],
    referencePrompts: [],
    referenceBaseline: null,
    continuityRules: [],
    usage: [],
    sourceEvidence: [],
    unknowns: [],
  }),
  1,
);
const generationId = randomUUID();
sqlite.prepare(`INSERT INTO generation_jobs(
  id, project_id, shot_id, provider, model, mode, status, parameter_hash,
  storyboard_artifact_id, shot_package_artifact_id, payload
) VALUES(?,?,?,?,?,?,?,?,NULL,NULL,?)`).run(
  generationId, project.id, "S001", "fixture", "fixture", "manual", "accepted", "fixture-hash",
  JSON.stringify({ id: generationId, projectId: project.id, shotId: "S001", createdAt: now }),
);
const renderId = randomUUID();
sqlite.prepare(`INSERT INTO renders(
  id, project_id, version, status, video_path, subtitle_path, report_path,
  payload, manifest_artifact_id, source_job_ids, created_at, updated_at
) VALUES(?,?,?,?,?,?,?, ?,NULL,?,?,?)`).run(
  renderId, project.id, 1, "approved", path.join(resolvedRuntimeRoot, "historical.mp4"), null,
  path.join(resolvedRuntimeRoot, "historical.md"),
  JSON.stringify({ id: renderId, projectId: project.id, version: 1, status: "approved", sourceJobIds: [generationId], deliveryVideoPath: "historical-final.mp4", createdAt: now, updatedAt: now }),
  JSON.stringify([generationId]), now, now,
);
sqlite.close();

await app.listen({ host: "127.0.0.1", port: 4328 });

async function shutdown() {
  await app.close().catch(() => undefined);
  await fs.rm(resolvedRuntimeRoot, { recursive: true, force: true }).catch(() => undefined);
}
process.once("SIGINT", () => { void shutdown().finally(() => process.exit(0)); });
process.once("SIGTERM", () => { void shutdown().finally(() => process.exit(0)); });
