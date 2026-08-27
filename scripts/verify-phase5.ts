import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { stringify as toYaml } from "yaml";
import type { FastifyInstance } from "fastify";
import { createApp } from "../src/server";
import type { TextIntelligenceProvider } from "../src/ai/text-provider";
import { FfmpegMediaToolchain } from "../src/media/media-toolchain";
import { reviewDimensions, type MediaMetadata } from "../src/shared/quality-schemas";
import type { Project, ShotSpec } from "../src/shared/schemas";

interface CommandResult { stdout: string; stderr: string }

function run(command: string, args: string[], timeoutMs = 120_000): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`${path.basename(command)} Phase 5 验收超时`));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => { clearTimeout(timeout); reject(error); });
    child.on("exit", (code) => {
      clearTimeout(timeout);
      code === 0
        ? resolve({ stdout, stderr })
        : reject(new Error(`${path.basename(command)} Phase 5 验收失败（退出码 ${code ?? "未知"}）：${stderr.slice(-1_000)}`));
    });
  });
}

function requireStatus(response: { statusCode: number; body: string }, expected: number, step: string) {
  if (response.statusCode !== expected) {
    throw new Error(`${step} 返回 ${response.statusCode}：${response.body.slice(0, 1_000)}`);
  }
}

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const projectRoot = path.resolve(import.meta.dirname, "..");
const toolchain = new FfmpegMediaToolchain(projectRoot);
const mediaStatus = await toolchain.getStatus();
if (!mediaStatus.roughCutReady) throw new Error(`媒体工具链未就绪：${JSON.stringify(mediaStatus)}`);

const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-video-studio-phase5-"));
const disabledTextProvider = {} as TextIntelligenceProvider;
let app: FastifyInstance | null = null;
let verified = false;

try {
  await Promise.all([
    fs.cp(path.join(projectRoot, "skills"), path.join(temporaryRoot, "skills"), { recursive: true }),
    fs.cp(path.join(projectRoot, ".codex-plugin"), path.join(temporaryRoot, ".codex-plugin"), { recursive: true }),
  ]);
  app = await createApp({
    runtimeRoot: temporaryRoot,
    logger: false,
    textProvider: disabledTextProvider,
    mediaToolchain: toolchain,
  });
  const created = await app.inject({
    method: "POST",
    url: "/api/projects",
    payload: {
      title: "Phase 5 媒体链路验收",
      sourceType: "story",
      sourceText: "用于验证真实视频导回、质检、粗剪和交付。",
      targetDurationSec: 4,
      aspectRatio: "16:9",
      resolution: "1920x1080",
      videoType: "验收短片",
      visualStyle: "工具链测试图",
      releasePlatform: "本地验收",
      targetAudience: "开发验收",
      allowStorySuggestions: false,
    },
  });
  requireStatus(created, 201, "创建临时项目");
  const createdProject = created.json().project as Project;
  await app.close();
  app = null;

  const now = new Date().toISOString();
  const seededProject: Project = { ...createdProject, currentStage: "READY_FOR_GENERATION", updatedAt: now };
  const shot: ShotSpec = {
    id: "S001",
    projectId: createdProject.id,
    sequence: 1,
    startTimeSec: 0,
    endTimeSec: 4,
    durationSec: 4,
    purpose: "验证完整 Phase 5 媒体链路",
    characterIds: [],
    sceneId: "SCENE-TEST",
    propIds: [],
    styleIds: [],
    shotSize: "全景",
    camera: { position: "固定机位", movement: "静止", lens: "35mm", composition: "测试图居中" },
    action: "测试图形连续运动四秒。",
    dialogue: [{ speakerId: "旁白", text: "工具链端到端验收。", language: "zh-CN" }],
    sound: ["440Hz 测试音"],
    startState: "测试图开始",
    endState: "测试图结束",
    preferredProvider: "updream",
    status: "approved",
  };
  const sqlite = new Database(path.join(temporaryRoot, "data", "studio.sqlite"));
  try {
    sqlite.prepare("UPDATE projects SET current_stage = ?, updated_at = ? WHERE id = ?")
      .run(seededProject.currentStage, now, seededProject.id);
    sqlite.prepare("INSERT INTO shots (id, project_id, sequence, payload, status) VALUES (?, ?, ?, ?, ?)")
      .run(shot.id, shot.projectId, shot.sequence, JSON.stringify(shot), shot.status);
  } finally {
    sqlite.close();
  }
  await fs.writeFile(path.join(createdProject.projectDir, "project.yaml"), toYaml(seededProject), "utf8");

  const inboxPath = path.join(createdProject.projectDir, "generated", "inbox");
  const sourceVideoPath = path.join(inboxPath, "S001_V01.mp4");
  await run(mediaStatus.ffmpegPath, [
    "-y",
    "-f", "lavfi", "-i", "testsrc2=size=960x540:rate=24:duration=4",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=4",
    "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", sourceVideoPath,
  ]);

  app = await createApp({
    runtimeRoot: temporaryRoot,
    logger: false,
    textProvider: disabledTextProvider,
    mediaToolchain: toolchain,
  });
  const imported = await app.inject({ method: "POST", url: `/api/projects/${createdProject.id}/generations/scan` });
  requireStatus(imported, 200, "扫描真实视频收件箱");
  const importedPayload = imported.json() as {
    project: Project;
    imported: Array<{ id: string; sourceHash: string; media: MediaMetadata; reviewFramePaths: string[] }>;
    skipped: unknown[];
    errors: unknown[];
  };
  requireCondition(importedPayload.imported.length === 1, "真实视频没有被唯一导入");
  requireCondition(importedPayload.project.currentStage === "GENERATION_REVIEW", "导入后没有进入生成质检阶段");
  requireCondition(importedPayload.errors.length === 0, `导入出现错误：${JSON.stringify(importedPayload.errors)}`);
  requireCondition(importedPayload.imported[0].media.videoCodec === "h264", "导入视频编码器探测结果错误");
  requireCondition(importedPayload.imported[0].media.hasAudio, "导入视频音轨探测结果错误");
  requireCondition(importedPayload.imported[0].reviewFramePaths.length === 3, "没有生成起始、中段、结束三张质检关键帧");

  const job = importedPayload.imported[0];
  const review = await app.inject({
    method: "POST",
    url: `/api/projects/${createdProject.id}/generations/${job.id}/reviews`,
    payload: {
      dimensions: reviewDimensions.map((dimension) => ({
        dimension,
        status: "pass",
        note: "Phase 5 临时验收素材检查通过",
        evidence: "完整检查 00:00.000-00:04.000",
      })),
      decision: "accepted",
      summary: "临时合成素材用于验证正式导回、审核、粗剪与交付契约。",
      conditions: [],
      retryInstructions: [],
      unverifiedClaims: ["该结论只验证程序链路，不代表真实生成视频的视觉质量"],
    },
  });
  requireStatus(review, 201, "保存九维质量审核");
  requireCondition(review.json().generation.status === "accepted", "质量审核没有放行镜头");

  const roughCut = await app.inject({ method: "POST", url: `/api/projects/${createdProject.id}/renders/rough-cut` });
  requireStatus(roughCut, 201, "创建真实粗剪");
  const roughCutPayload = roughCut.json() as {
    project: Project;
    render: { id: string; version: number; status: string; videoPath: string; subtitlePath: string; reportPath: string };
  };
  requireCondition(roughCutPayload.project.currentStage === "FINAL_REVIEW", "粗剪后没有进入成片终审");
  requireCondition(roughCutPayload.render.status === "review", "粗剪版本没有进入待终审状态");
  const roughCutMedia = await toolchain.probe(roughCutPayload.render.videoPath);
  requireCondition(roughCutMedia.width === 1920 && roughCutMedia.height === 1080, "粗剪没有输出项目要求的 1080p 分辨率");
  requireCondition(roughCutMedia.videoCodec === "h264" && roughCutMedia.audioCodec === "aac", "粗剪编码格式错误");
  requireCondition((await fs.readFile(roughCutPayload.render.subtitlePath, "utf8")).includes("工具链端到端验收"), "SRT 字幕没有写入镜头对白");
  requireCondition((await fs.readFile(roughCutPayload.render.reportPath, "utf8")).includes(job.sourceHash), "项目报告缺少采用的视频哈希");

  const delivered = await app.inject({
    method: "POST",
    url: `/api/projects/${createdProject.id}/renders/${roughCutPayload.render.id}/decision`,
    payload: { decision: "approved", comment: "Phase 5 自动验收通过" },
  });
  requireStatus(delivered, 200, "批准交付版本");
  const deliveredPayload = delivered.json() as {
    project: Project;
    render: { deliveryVideoPath: string; deliverySubtitlePath: string; deliveryReportPath: string };
  };
  requireCondition(deliveredPayload.project.currentStage === "DELIVERED", "批准后项目没有进入已交付状态");
  await Promise.all([
    fs.access(deliveredPayload.render.deliveryVideoPath),
    fs.access(deliveredPayload.render.deliverySubtitlePath),
    fs.access(deliveredPayload.render.deliveryReportPath),
  ]);

  const downloadResults = await Promise.all(["video", "subtitle", "report"].map(async (kind) => {
    const response = await app!.inject({
      method: "GET",
      url: `/api/projects/${createdProject.id}/renders/${roughCutPayload.render.id}/files/${kind}`,
    });
    requireStatus(response, 200, `下载 ${kind} 交付文件`);
    requireCondition(response.headers["content-disposition"]?.includes("attachment"), `${kind} 缺少下载响应头`);
    return { kind, bytes: response.rawPayload.length, contentType: response.headers["content-type"] };
  }));

  verified = true;
  process.stdout.write(`${JSON.stringify({
    ok: true,
    workflow: ["真实收件箱导入", "ffprobe 探测", "三点关键帧", "九维审核", "1080p FFmpeg 粗剪", "SRT 字幕", "终审交付", "三类文件下载"],
    ffmpegVersion: mediaStatus.ffmpegVersion,
    sourceMedia: job.media,
    roughCutMedia,
    renderVersion: roughCutPayload.render.version,
    downloads: downloadResults,
  }, null, 2)}\n`);
} finally {
  if (app) await app.close().catch(() => undefined);
  if (verified) {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  } else {
    process.stderr.write(`Phase 5 验收失败，诊断项目保留在：${temporaryRoot}\n`);
  }
}
