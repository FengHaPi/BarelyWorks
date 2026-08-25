import fs, { createReadStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { z, ZodError } from "zod";
import { createStudioDatabase } from "./database/client";
import { CodexCliProvider } from "./ai/codex-cli-provider";
import type { TextIntelligenceProvider } from "./ai/text-provider";
import { ProjectService } from "./projects/project-service";
import { QualityService } from "./projects/quality-service";
import type { MediaToolchain } from "./media/media-toolchain";
import {
  artifactTypeSchema,
  createArtifactVersionInputSchema,
  createProjectInputSchema,
  projectStageSchema,
} from "./shared/schemas";

export interface CreateAppOptions {
  runtimeRoot?: string;
  logger?: boolean;
  textProvider?: TextIntelligenceProvider;
  mediaToolchain?: MediaToolchain;
}

function mediaMime(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".webm") return "video/webm";
  if (extension === ".mov") return "video/quicktime";
  if (extension === ".mkv") return "video/x-matroska";
  return "video/mp4";
}

function imageMime(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".png") return "image/png";
  if (extension === ".webp") return "image/webp";
  return "image/jpeg";
}

function sendLocalVideo(reply: FastifyReply, filePath: string, fileName: string, rangeHeader?: string) {
  const size = fs.statSync(filePath).size;
  reply.type(mediaMime(filePath)).header("Accept-Ranges", "bytes").header("Content-Disposition", `inline; filename=\"${fileName}\"`);
  if (!rangeHeader) {
    return reply.header("Content-Length", size).send(createReadStream(filePath));
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match) return reply.status(416).header("Content-Range", `bytes */${size}`).send();
  let start: number;
  let end: number;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return reply.status(416).header("Content-Range", `bytes */${size}`).send();
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
  }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= size) {
    return reply.status(416).header("Content-Range", `bytes */${size}`).send();
  }
  end = Math.min(end, size - 1);
  return reply.status(206)
    .header("Content-Range", `bytes ${start}-${end}/${size}`)
    .header("Content-Length", end - start + 1)
    .send(createReadStream(filePath, { start, end }));
}

export async function createApp(options: CreateAppOptions = {}): Promise<FastifyInstance> {
  const runtimeRoot = options.runtimeRoot ?? process.env.AI_VIDEO_STUDIO_RUNTIME_ROOT ?? process.cwd();
  const studio = createStudioDatabase(runtimeRoot);
  const textProvider = options.textProvider ?? new CodexCliProvider(runtimeRoot);
  const projectService = new ProjectService(studio, textProvider);
  const qualityService = new QualityService(studio, options.mediaToolchain);
  const app = Fastify({ logger: options.logger ?? true, bodyLimit: 6 * 1024 * 1024 });
  let inboxScanRunning = false;
  const inboxScanTimer = setInterval(() => {
    if (inboxScanRunning) return;
    inboxScanRunning = true;
    void qualityService.scanAllGenerationInboxes().finally(() => { inboxScanRunning = false; });
  }, 15_000);
  inboxScanTimer.unref();

  await app.register(cors, {
    origin: [/^http:\/\/127\.0\.0\.1(?::\d+)?$/, /^http:\/\/localhost(?::\d+)?$/],
  });

  app.addHook("onClose", async () => {
    clearInterval(inboxScanTimer);
    studio.sqlite.close();
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: "VALIDATION_ERROR",
        message: "输入校验失败",
        issues: error.issues,
      });
    }
    const message = error instanceof Error ? error.message : "未知请求错误";
    const statusCode = message === "项目不存在" ? 404 : 400;
    return reply.status(statusCode).send({ error: "REQUEST_FAILED", message });
  });

  app.get("/api/health", async () => {
    let textSkills: Awaited<ReturnType<NonNullable<TextIntelligenceProvider["getSkillStatus"]>>> = [];
    let skillLoadError: string | null = null;
    try {
      textSkills = textProvider.getSkillStatus ? await textProvider.getSkillStatus() : [];
    } catch (error) {
      skillLoadError = error instanceof Error ? error.message : "Skill 加载失败";
    }
    const mediaTools = await qualityService.getMediaToolStatus();
    return {
      ok: true,
      service: "ai-video-studio",
      version: "0.1.0",
      bind: "127.0.0.1",
      paidVideoApiEnabled: false,
      skillDrivenTextGeneration: textSkills.length > 0 && !skillLoadError,
      textSkills,
      skillLoadError,
      mediaTools,
    };
  });

  app.get("/api/projects", async () => ({ projects: await projectService.list() }));

  app.post("/api/projects", async (request, reply) => {
    const input = createProjectInputSchema.parse(request.body);
    const project = await projectService.create(input);
    return reply.status(201).send({ project });
  });

  app.get<{ Params: { id: string } }>("/api/projects/:id", async (request, reply) => {
    const project = await projectService.get(request.params.id);
    if (!project) return reply.status(404).send({ error: "NOT_FOUND", message: "项目不存在" });
    return { project };
  });

  app.get<{ Params: { id: string } }>("/api/projects/:id/source", async (request) => projectService.readSource(request.params.id));

  app.get<{ Params: { id: string; type: string } }>("/api/projects/:id/artifacts/:type", async (request) => {
    const type = artifactTypeSchema.parse(request.params.type);
    return { artifacts: await projectService.listArtifacts(request.params.id, type) };
  });

  app.post<{ Params: { id: string; type: string }; Body: unknown }>("/api/projects/:id/artifacts/:type", async (request, reply) => {
    const type = artifactTypeSchema.parse(request.params.type);
    const input = createArtifactVersionInputSchema.parse(request.body);
    const result = await projectService.createArtifactVersion(request.params.id, type, input.content, {
      sourceArtifactId: input.sourceArtifactId ?? null,
      metadata: { origin: "manual-edit" },
    });
    return reply.status(201).send(result);
  });

  app.post<{ Params: { id: string } }>("/api/projects/:id/stages/outline/generate", async (request, reply) => {
    return reply.status(201).send(await projectService.generateOutline(request.params.id));
  });

  app.post<{ Params: { id: string } }>("/api/projects/:id/stages/screenplay/generate", async (request, reply) => {
    return reply.status(201).send(await projectService.generateScreenplay(request.params.id));
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/api/projects/:id/stages/asset-bible/generate", async (request, reply) => {
    const body = z.object({ designMode: z.enum(["original-proposal", "reference-first"]).default("original-proposal") }).parse(request.body ?? {});
    return reply.status(201).send(await projectService.generateAssetBible(request.params.id, body.designMode));
  });

  app.post<{ Params: { id: string } }>("/api/projects/:id/stages/shooting-script/generate", async (request, reply) => {
    return reply.status(201).send(await projectService.generateShootingScript(request.params.id));
  });

  app.post<{ Params: { id: string } }>("/api/projects/:id/stages/storyboard/generate", async (request, reply) => {
    return reply.status(201).send(await projectService.generateStoryboard(request.params.id));
  });

  app.post<{ Params: { id: string; stage: string } }>(
    "/api/projects/:id/stages/:stage/run",
    async (request) => {
      const stage = projectStageSchema.parse(request.params.stage);
      const project = await projectService.get(request.params.id);
      if (!project) throw new Error("项目不存在");
      if (project.currentStage !== stage) throw new Error("路径阶段与项目当前阶段不一致");
      return { project: await projectService.startNextStage(project.id) };
    },
  );

  app.post<{
    Params: { id: string; stage: string };
    Body: { artifactId?: string; artifactPath?: string; artifactVersion?: number; comment?: string };
  }>("/api/projects/:id/stages/:stage/approve", async (request) => {
    const stage = projectStageSchema.parse(request.params.stage);
    return projectService.recordDecision({
      projectId: request.params.id,
      stage,
      decision: "approved",
      ...request.body,
    });
  });

  app.post<{
    Params: { id: string; stage: string };
    Body: { artifactId?: string; artifactPath?: string; artifactVersion?: number; comment?: string };
  }>("/api/projects/:id/stages/:stage/reject", async (request) => {
    const stage = projectStageSchema.parse(request.params.stage);
    return projectService.recordDecision({
      projectId: request.params.id,
      stage,
      decision: "rejected",
      ...request.body,
    });
  });

  app.get<{ Params: { id: string } }>("/api/projects/:id/assets", async (request) => ({ assets: await projectService.listAssets(request.params.id) }));
  app.post<{ Params: { id: string; assetId: string }; Body: unknown }>("/api/projects/:id/assets/:assetId/references", async (request, reply) => {
    const body = z.object({
      fileName: z.string().trim().min(1).max(200),
      mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]),
      dataBase64: z.string().min(1).max(5_700_000),
      role: z.enum(["主参考", "正面", "侧面", "背面", "表情", "服装", "其他"]).default("主参考"),
      authorizationConfirmed: z.literal(true),
    }).parse(request.body);
    return reply.status(201).send({ asset: await projectService.addAssetReferenceFile(request.params.id, request.params.assetId, body) });
  });
  app.get<{ Params: { id: string; assetId: string; index: string } }>("/api/projects/:id/assets/:assetId/references/:index", async (request, reply) => {
    const index = z.coerce.number().int().nonnegative().parse(request.params.index);
    const file = await projectService.readAssetReferenceFile(request.params.id, request.params.assetId, index);
    return reply.type(imageMime(file.filePath)).header("Content-Disposition", `inline; filename=\"${file.fileName}\"`).send(createReadStream(file.filePath));
  });
  app.get<{ Params: { id: string } }>("/api/projects/:id/shots", async (request) => ({ shots: await projectService.listShots(request.params.id) }));
  app.patch<{ Params: { id: string; shotId: string }; Body: unknown }>("/api/projects/:id/shots/:shotId", async (request, reply) => {
    return reply.status(201).send(await projectService.updateShot(request.params.id, request.params.shotId, request.body));
  });

  app.get<{ Params: { id: string } }>("/api/projects/:id/generation-center", async (request) => {
    return projectService.getGenerationCenter(request.params.id);
  });
  app.post<{ Params: { id: string } }>("/api/projects/:id/handoff/updream/lock-assets", async (request) => ({
    project: await projectService.lockAssets(request.params.id),
  }));
  app.post<{ Params: { id: string } }>("/api/projects/:id/handoff/updream/bootstrap", async (request, reply) => {
    return reply.status(201).send(await projectService.createUpdreamBootstrap(request.params.id));
  });
  app.post<{ Params: { id: string; shotId: string } }>("/api/projects/:id/handoff/updream/shots/:shotId/package", async (request, reply) => {
    return reply.status(201).send(await projectService.createUpdreamShotPackage(request.params.id, request.params.shotId));
  });
  app.get<{ Params: { id: string; shotId: string; version: string } }>("/api/projects/:id/handoff/updream/shots/:shotId/packages/:version/prompt", async (request) => {
    const version = z.coerce.number().int().positive().parse(request.params.version);
    return projectService.readShotPackagePrompt(request.params.id, request.params.shotId, version);
  });
  app.patch<{ Params: { id: string; assetId: string }; Body: unknown }>("/api/projects/:id/assets/:assetId/updream-upload-state", async (request) => {
    const body = z.object({ state: z.enum(["not-uploaded", "uploaded"]) }).parse(request.body);
    return { asset: await projectService.setAssetUploadState(request.params.id, request.params.assetId, body.state) };
  });
  app.patch<{ Params: { id: string; shotId: string; version: string }; Body: unknown }>("/api/projects/:id/handoff/updream/shots/:shotId/packages/:version/upload-state", async (request) => {
    const version = z.coerce.number().int().positive().parse(request.params.version);
    const body = z.object({ state: z.enum(["not-uploaded", "uploaded"]) }).parse(request.body);
    return { package: await projectService.setShotPackageUploadState(request.params.id, request.params.shotId, version, body.state) };
  });

  app.get<{ Params: { id: string } }>("/api/projects/:id/quality-center", async (request) => {
    return qualityService.getQualityCenter(request.params.id);
  });
  app.post<{ Params: { id: string } }>("/api/projects/:id/generations/scan", async (request) => {
    return qualityService.scanGenerationInbox(request.params.id);
  });
  app.get<{ Params: { id: string; jobId: string } }>("/api/projects/:id/generations/:jobId/media", async (request, reply) => {
    const media = await qualityService.readGenerationMedia(request.params.id, request.params.jobId);
    return sendLocalVideo(reply, media.filePath, media.fileName, request.headers.range);
  });
  app.post<{ Params: { id: string; jobId: string }; Body: unknown }>("/api/projects/:id/generations/:jobId/reviews", async (request, reply) => {
    return reply.status(201).send(await qualityService.recordQualityReview(request.params.id, request.params.jobId, request.body as never));
  });
  app.post<{ Params: { id: string } }>("/api/projects/:id/renders/rough-cut", async (request, reply) => {
    return reply.status(201).send(await qualityService.renderRoughCut(request.params.id));
  });
  app.get<{ Params: { id: string; renderId: string } }>("/api/projects/:id/renders/:renderId/media", async (request, reply) => {
    const media = await qualityService.readRenderMedia(request.params.id, request.params.renderId);
    return sendLocalVideo(reply, media.filePath, media.fileName, request.headers.range);
  });
  app.post<{ Params: { id: string; renderId: string }; Body: unknown }>("/api/projects/:id/renders/:renderId/decision", async (request) => {
    const body = z.object({ decision: z.enum(["approved", "rejected"]), comment: z.string().max(2_000).optional() }).parse(request.body);
    return qualityService.recordDeliveryDecision(request.params.id, request.params.renderId, body.decision, body.comment);
  });

  const uiRoot = path.resolve(runtimeRoot, "dist", "ui");
  if (fs.existsSync(uiRoot)) {
    await app.register(fastifyStatic, { root: uiRoot });
  } else {
    app.get("/", async (_request, reply) => reply.redirect("http://127.0.0.1:5173"));
  }

  return app;
}

const isMainModule = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isMainModule) {
  const host = process.env.AI_VIDEO_STUDIO_HOST ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "localhost") {
    throw new Error("V1 仅允许监听 127.0.0.1 或 localhost");
  }
  const port = Number(process.env.AI_VIDEO_STUDIO_PORT ?? 4317);
  const app = await createApp();
  await app.listen({ host, port });
}
