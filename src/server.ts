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
import { DisabledImageGenerationProvider, type ImageGenerationProvider } from "./ai/image-provider";
import { ArtifactVersionConflictError, ProjectService } from "./projects/project-service";
import { ProjectIntegrityService } from "./projects/project-integrity-service";
import { CumulativeVerificationService } from "./projects/cumulative-verification-service";
import { QualityService } from "./projects/quality-service";
import type { MediaToolchain } from "./media/media-toolchain";
import { generationResolutionSchema } from "./shared/handoff-schemas";
import type { FileClipboard } from "./handoff/file-clipboard";
import { isAllowedBrowserOrigin, localBrowserOrigins } from "./server/local-origin";
import { OperationCoordinator, OperationInProgressError } from "./server/operation-coordinator";
import { ProjectRepository } from "./projects/project-repository";
import { ArtifactRepository } from "./artifacts/artifact-repository";
import { ArtifactLineageService } from "./artifacts/artifact-lineage-service";
import { ArtifactValidityService } from "./artifacts/artifact-validity-service";
import { ArtifactService } from "./artifacts/artifact-service";
import { IssueRepository } from "./issues/issue-repository";
import { IssueService } from "./issues/issue-service";
import { OperationRepository } from "./operations/operation-repository";
import { OperationRunner } from "./operations/operation-runner";
import { OperationService } from "./operations/operation-service";
import type { ProcessController } from "./operations/process-controller";
import { ProjectWorkspaceService } from "./projects/project-workspace-service";
import { CodexArtifactRevisionExecutor, type ArtifactRevisionExecutor } from "./revisions/artifact-revision-executor";
import { RevisionService } from "./revisions/revision-service";
import { ProjectAgentService } from "./agent/project-agent-service";
import { CodexProjectAgentExecutor, type ProjectAgentExecutor } from "./agent/project-agent-executor";
import { ApprovalService } from "./approvals/approval-service";
import { ProductionOperationService } from "./production/production-operation-service";
import { ContinuityRepairOperationService } from "./continuity/continuity-repair-operation-service";
import { registerAgentFirstRoutes } from "./server/routes/agent-first-routes";
import {
  artifactTypeSchema,
  assetReferenceRoleSchema,
  createArtifactVersionInputSchema,
  createProjectInputSchema,
  projectStageSchema,
  updateShotInputSchema,
} from "./shared/schemas";

export interface CreateAppOptions {
  runtimeRoot?: string;
  logger?: boolean;
  textProvider?: TextIntelligenceProvider;
  imageProvider?: ImageGenerationProvider;
  mediaToolchain?: MediaToolchain;
  fileClipboard?: FileClipboard;
  apiPort?: number;
  artifactRevisionExecutor?: ArtifactRevisionExecutor;
  projectAgentExecutor?: ProjectAgentExecutor;
  processController?: ProcessController;
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

function contentDisposition(kind: "inline" | "attachment", fileName: string): string {
  return `${kind}; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

function sendLocalVideo(reply: FastifyReply, filePath: string, fileName: string, rangeHeader?: string) {
  const size = fs.statSync(filePath).size;
  reply.type(mediaMime(filePath)).header("Accept-Ranges", "bytes").header("Content-Disposition", contentDisposition("inline", fileName));
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

function sendLocalDownload(reply: FastifyReply, filePath: string, fileName: string, contentType: string) {
  const size = fs.statSync(filePath).size;
  return reply
    .type(contentType)
    .header("Content-Length", size)
    .header("Content-Disposition", contentDisposition("attachment", fileName))
    .send(createReadStream(filePath));
}

export async function createApp(options: CreateAppOptions = {}): Promise<FastifyInstance> {
  const runtimeRoot = options.runtimeRoot ?? process.env.AI_VIDEO_STUDIO_RUNTIME_ROOT ?? process.cwd();
  const studio = createStudioDatabase(runtimeRoot);
  const textProvider = options.textProvider ?? new CodexCliProvider(runtimeRoot);
  const imageProvider = options.imageProvider ?? new DisabledImageGenerationProvider();
  const projectService = new ProjectService(studio, textProvider, imageProvider, options.fileClipboard);
  const integrityService = new ProjectIntegrityService(studio);
  const qualityService = new QualityService(studio, options.mediaToolchain, integrityService);
  const projectRepository = new ProjectRepository(studio);
  const artifactRepository = new ArtifactRepository(studio);
  const issueRepository = new IssueRepository(studio);
  const operationRepository = new OperationRepository(studio);
  const operationRunner = new OperationRunner(operationRepository, options.processController);
  const operationService = new OperationService(operationRepository, operationRunner);
  const lineageService = new ArtifactLineageService(artifactRepository, issueRepository);
  const validityService = new ArtifactValidityService(lineageService);
  const cumulativeVerificationService = new CumulativeVerificationService(studio, artifactRepository, issueRepository, projectService);
  const artifactService = new ArtifactService(projectRepository, artifactRepository, issueRepository, lineageService, validityService, projectService);
  const workspaceService = new ProjectWorkspaceService(studio, projectRepository, artifactRepository, issueRepository, operationRepository, lineageService, validityService);
  const revisionService = new RevisionService(
    studio, projectRepository, artifactRepository, issueRepository, operationRepository, operationRunner,
    options.artifactRevisionExecutor ?? new CodexArtifactRevisionExecutor(runtimeRoot),
  );
  const agentService = new ProjectAgentService(
    studio,
    projectRepository,
    artifactRepository,
    issueRepository,
    lineageService,
    revisionService,
    operationRepository,
    operationRunner,
    options.projectAgentExecutor ?? new CodexProjectAgentExecutor(runtimeRoot),
    cumulativeVerificationService,
  );
  const approvalService = new ApprovalService(studio, projectRepository, artifactRepository, projectService, cumulativeVerificationService);
  approvalService.reconcileProjectionApprovals();
  const issueService = new IssueService(issueRepository);
  const productionService = new ProductionOperationService(projectService, qualityService, projectRepository, operationRepository, operationRunner, cumulativeVerificationService);
  const continuityRepairService = new ContinuityRepairOperationService(
    projectService, projectRepository, artifactRepository, operationRepository, operationRunner,
  );
  operationRunner.recover();
  const app = Fastify({ logger: options.logger ?? true, bodyLimit: 6 * 1024 * 1024 });
  const trustedOrigins = localBrowserOrigins(options.apiPort ?? Number(process.env.AI_VIDEO_STUDIO_PORT ?? 4317));
  const projectOperations = new OperationCoordinator();
  let inboxScanRunning = false;
  let inboxScanPromise: Promise<void> | null = null;
  const inboxScanTimer = setInterval(() => {
    if (inboxScanRunning) return;
    inboxScanRunning = true;
    inboxScanPromise = qualityService.scanAllGenerationInboxes(async (projectId, scan) => {
      try {
        await projectOperations.run(projectId, scan);
      } catch (error) {
        if (!(error instanceof OperationInProgressError)) throw error;
      }
    })
      .then(() => undefined)
      .catch((error: unknown) => {
        app.log.error({ err: error }, "generation inbox scan failed");
      })
      .finally(() => {
        inboxScanRunning = false;
        inboxScanPromise = null;
      });
  }, 15_000);
  inboxScanTimer.unref();

  await app.register(cors, {
    origin: [...trustedOrigins],
  });

  app.addHook("onRequest", async (request, reply) => {
    if (!isAllowedBrowserOrigin(request.headers.origin, trustedOrigins)) {
      return reply.status(403).send({ error: "ORIGIN_NOT_ALLOWED", message: "请求来源不是受信任的本地界面" });
    }
  });

  app.addHook("onClose", async () => {
    clearInterval(inboxScanTimer);
    await inboxScanPromise;
    await operationRunner.close();
    studio.sqlite.close();
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: "VALIDATION_ERROR",
        code: "VALIDATION_ERROR",
        message: "输入校验失败",
        issues: error.issues,
        details: error.issues,
        retryable: false,
      });
    }
    if (error instanceof OperationInProgressError) {
      return reply.status(409).send({ error: "OPERATION_IN_PROGRESS", code: "OPERATION_IN_PROGRESS", message: error.message, retryable: true });
    }
    if (error instanceof ArtifactVersionConflictError) {
      return reply.status(409).send({ error: "ARTIFACT_VERSION_CONFLICT", code: "ARTIFACT_VERSION_CONFLICT", message: error.message, retryable: true });
    }
    const message = error instanceof Error ? error.message : "未知请求错误";
    const statusCode = message === "项目不存在" || message === "归档项目不存在" ? 404 : 400;
    return reply.status(statusCode).send({ error: "REQUEST_FAILED", code: "REQUEST_FAILED", message, retryable: false });
  });

  registerAgentFirstRoutes(app, {
    workspace: workspaceService,
    artifacts: artifactService,
    revisions: revisionService,
    operations: operationService,
    issues: issueService,
    agent: agentService,
    approvals: approvalService,
    production: productionService,
    continuityRepairs: continuityRepairService,
    verification: cumulativeVerificationService,
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
    const imageProviderCapabilities = await imageProvider.getCapabilities();
    return {
      ok: true,
      service: "ai-video-studio",
      version: "0.2.0",
      bind: "127.0.0.1",
      paidVideoApiEnabled: false,
      paidImageApiEnabled: imageProviderCapabilities.enabled && imageProviderCapabilities.requiresPayment,
      imageProvider: imageProviderCapabilities,
      skillDrivenTextGeneration: textSkills.length > 0 && !skillLoadError,
      textModel: textProvider.getTextModel?.() ?? "unreported",
      textSkills,
      skillLoadError,
      mediaTools,
    };
  });

  app.get("/api/projects", async () => ({ projects: await projectService.list() }));

  app.get("/api/projects/archived", async () => ({ projects: await projectService.listArchived() }));

  app.post("/api/projects", async (request, reply) => {
    const input = createProjectInputSchema.parse(request.body);
    const project = await projectService.create(input);
    return reply.status(201).send({ project });
  });

  app.patch<{ Params: { id: string }; Body: unknown }>("/api/projects/:id/production-constraints", async (request) => {
    const body = z.object({
      targetDurationSec: z.coerce.number().int().min(5).max(21_600),
      restartNarrative: z.boolean().optional().default(false),
    }).parse(request.body);
    return projectOperations.run(request.params.id, async () => ({
      project: await projectService.reviseTargetDuration(request.params.id, body.targetDurationSec, body.restartNarrative),
    }));
  });

  app.get<{ Params: { id: string } }>("/api/projects/:id", async (request, reply) => {
    const project = await projectService.get(request.params.id);
    if (!project) return reply.status(404).send({ error: "NOT_FOUND", message: "项目不存在" });
    return { project };
  });

  app.get<{ Params: { id: string } }>("/api/projects/:id/integrity", async (request) => ({
    audit: await integrityService.audit(request.params.id),
  }));

  app.get<{ Params: { id: string } }>("/api/projects/:id/operation", async (request) => ({
    operation: projectOperations.get(request.params.id),
  }));

  app.delete<{ Params: { id: string } }>("/api/projects/:id", async (request) => ({
    project: await projectOperations.run(request.params.id, () => projectService.archive(request.params.id)),
    recoverable: true,
  }));

  app.post<{ Params: { id: string } }>("/api/projects/:id/restore", async (request) => ({
    project: await projectOperations.run(request.params.id, () => projectService.restore(request.params.id)),
  }));

  app.get<{ Params: { id: string } }>("/api/projects/:id/source", async (request) => projectService.readSource(request.params.id));

  app.get<{ Params: { id: string; artifactId: string } }>("/api/projects/:id/artifacts/:artifactId/continuity-report", async (request) => ({
    report: await projectService.readContinuityReport(request.params.id, request.params.artifactId),
  }));

  app.post<{ Params: { id: string; artifactId: string } }>("/api/projects/:id/artifacts/:artifactId/continuity-review", async (request, reply) => {
    const result = await projectOperations.run(
      request.params.id,
      () => projectService.reviewStoryboardContinuity(request.params.id, request.params.artifactId),
      { operation: "storyboard.continuity-review", phase: "continuity", phaseLabel: "正在单独检查分镜连续性" },
    );
    return reply.status(201).send(result);
  });

  app.post<{ Params: { id: string; artifactId: string } }>("/api/projects/:id/artifacts/:artifactId/continuity-repair", async (request, reply) => {
    const result = await projectOperations.run(request.params.id, () => projectService.startContinuityRepair(request.params.id, request.params.artifactId));
    return reply.status(201).send(result);
  });

  app.post<{ Params: { id: string; artifactId: string }; Body: unknown }>("/api/projects/:id/artifacts/:artifactId/continuity-repair/auto", async (request, reply) => {
    const body = z.object({ maxAttempts: z.coerce.number().int().min(1).max(5).optional().default(3) }).parse(request.body ?? {});
    const result = await projectOperations.run(request.params.id, () => projectService.autoRepairContinuity(
      request.params.id,
      request.params.artifactId,
      { maxAttempts: body.maxAttempts },
    ));
    return reply.status(201).send(result);
  });

  app.post<{ Params: { id: string } }>("/api/projects/:id/continuity-repair/continue", async (request, reply) => {
    const result = await projectOperations.run(request.params.id, () => projectService.continueContinuityRepair(request.params.id));
    return reply.status(201).send(result);
  });

  app.get<{ Params: { id: string; type: string } }>("/api/projects/:id/artifacts/:type", async (request) => {
    const type = artifactTypeSchema.safeParse(request.params.type);
    if (type.success) return { artifacts: await projectService.listArtifacts(request.params.id, type.data) };
    return artifactService.detail(request.params.id, request.params.type);
  });

  app.post<{ Params: { id: string; type: string }; Body: unknown }>("/api/projects/:id/artifacts/:type", async (request, reply) => {
    const type = artifactTypeSchema.parse(request.params.type);
    const input = createArtifactVersionInputSchema.parse(request.body);
    const result = await projectOperations.run(request.params.id, () => projectService.createArtifactVersion(request.params.id, type, input.content, {
      sourceArtifactId: input.sourceArtifactId ?? null,
      expectedLatestArtifactId: input.expectedLatestArtifactId ?? null,
      metadata: { origin: "manual-edit" },
    }));
    return reply.status(201).send(result);
  });

  app.post<{ Params: { id: string } }>("/api/projects/:id/stages/outline/generate", async (request, reply) => {
    return reply.status(201).send(await projectOperations.run(request.params.id, () => projectService.generateOutline(request.params.id)));
  });

  app.post<{ Params: { id: string } }>("/api/projects/:id/stages/screenplay/generate", async (request, reply) => {
    return reply.status(201).send(await projectOperations.run(request.params.id, () => projectService.generateScreenplay(request.params.id)));
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/api/projects/:id/stages/asset-bible/generate", async (request, reply) => {
    const body = z.object({ designMode: z.enum(["original-proposal", "reference-first"]).default("original-proposal") }).parse(request.body ?? {});
    return reply.status(201).send(await projectOperations.run(request.params.id, () => projectService.generateAssetBible(request.params.id, body.designMode)));
  });

  app.post<{ Params: { id: string } }>("/api/projects/:id/stages/shooting-script/generate", async (request, reply) => {
    return reply.status(201).send(await projectOperations.run(request.params.id, () => projectService.generateShootingScript(request.params.id)));
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/api/projects/:id/stages/storyboard/generate", async (request, reply) => {
    const body = z.object({ autoRepair: z.boolean().optional().default(false), maxAutoRepairAttempts: z.coerce.number().int().min(1).max(5).optional().default(3) }).parse(request.body ?? {});
    const phaseLabels = {
      storyboard: "正在生成分镜草案",
      continuity: "分镜草案已保存，正在检查连续性",
      "auto-repair": "正在按连续性报告定点修复",
    } as const;
    return reply.status(201).send(await projectOperations.run(request.params.id, () => projectService.generateStoryboard(request.params.id, {
      ...body,
      onPhase: (phase) => projectOperations.update(request.params.id, { phase, phaseLabel: phaseLabels[phase] }),
    }), { operation: "storyboard.generate", phase: "storyboard", phaseLabel: phaseLabels.storyboard }));
  });

  app.post<{
    Params: { id: string; stage: string };
    Body: { artifactId?: string; artifactPath?: string; artifactVersion?: number; comment?: string };
  }>("/api/projects/:id/stages/:stage/approve", async (request) => {
    const stage = projectStageSchema.parse(request.params.stage);
    return projectOperations.run(request.params.id, () => projectService.recordDecision({
      projectId: request.params.id,
      stage,
      decision: "approved",
      ...request.body,
    }));
  });

  app.post<{
    Params: { id: string; stage: string };
    Body: { artifactId?: string; artifactPath?: string; artifactVersion?: number; comment?: string };
  }>("/api/projects/:id/stages/:stage/reject", async (request) => {
    const stage = projectStageSchema.parse(request.params.stage);
    return projectOperations.run(request.params.id, () => projectService.recordDecision({
      projectId: request.params.id,
      stage,
      decision: "rejected",
      ...request.body,
    }));
  });

  app.get<{ Params: { id: string } }>("/api/projects/:id/assets", async (request) => ({ assets: await projectService.listAssets(request.params.id) }));
  app.get<{ Params: { id: string } }>("/api/projects/:id/assets/readiness", async (request) => projectService.readAssetReadiness(request.params.id));
  app.get("/api/image-provider/capabilities", async () => projectService.getImageProviderCapabilities());
  app.post<{ Params: { id: string; assetId: string }; Body: unknown }>("/api/projects/:id/assets/:assetId/reference-prompts", async (request, reply) => {
    const body = z.object({ role: assetReferenceRoleSchema.default("主参考") }).parse(request.body ?? {});
    const result = await projectOperations.run(request.params.id, () => projectService.generateAssetReferencePrompt(request.params.id, request.params.assetId, body.role));
    return reply.status(201).send(result);
  });
  app.post<{ Params: { id: string; assetId: string }; Body: unknown }>("/api/projects/:id/assets/:assetId/reference-images/generate", async (request, reply) => {
    const body = z.object({ promptId: z.uuid() }).parse(request.body);
    const result = await projectOperations.run(request.params.id, () => projectService.generateAssetReferenceImage(request.params.id, request.params.assetId, body.promptId));
    return reply.status(201).send(result);
  });
  app.post<{ Params: { id: string; assetId: string }; Body: unknown }>("/api/projects/:id/assets/:assetId/references", async (request, reply) => {
    const body = z.object({
      fileName: z.string().trim().min(1).max(200),
      mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]),
      dataBase64: z.string().min(1).max(5_700_000),
      role: z.enum(["主参考", "正面", "侧面", "背面", "表情", "服装", "其他"]).default("主参考"),
      authorizationConfirmed: z.literal(true),
      workflowMode: z.literal("agent-first").optional(),
    }).parse(request.body);
    const asset = await projectOperations.run(request.params.id, () => projectService.addAssetReferenceFile(request.params.id, request.params.assetId, body, { agentFirst: body.workflowMode === "agent-first" }));
    return reply.status(201).send({ asset });
  });
  app.put<{ Params: { id: string; assetId: string; index: string }; Body: unknown }>("/api/projects/:id/assets/:assetId/references/:index", async (request) => {
    const index = z.coerce.number().int().nonnegative().parse(request.params.index);
    const body = z.object({
      fileName: z.string().trim().min(1).max(200),
      mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]),
      dataBase64: z.string().min(1).max(5_700_000),
      authorizationConfirmed: z.literal(true),
      workflowMode: z.literal("agent-first").optional(),
    }).parse(request.body);
    const asset = await projectOperations.run(request.params.id, () => projectService.replaceAssetReferenceFile(request.params.id, request.params.assetId, index, body, { agentFirst: body.workflowMode === "agent-first" }));
    return { asset };
  });
  app.delete<{ Params: { id: string; assetId: string; index: string }; Querystring: { workflowMode?: string } }>("/api/projects/:id/assets/:assetId/references/:index", async (request) => {
    const index = z.coerce.number().int().nonnegative().parse(request.params.index);
    const workflowMode = z.literal("agent-first").optional().parse(request.query.workflowMode);
    return projectOperations.run(request.params.id, () => projectService.removeAssetReferenceFile(request.params.id, request.params.assetId, index, { agentFirst: workflowMode === "agent-first" }));
  });
  app.get<{ Params: { id: string; assetId: string; index: string } }>("/api/projects/:id/assets/:assetId/references/:index", async (request, reply) => {
    const index = z.coerce.number().int().nonnegative().parse(request.params.index);
    const file = await projectService.readAssetReferenceFile(request.params.id, request.params.assetId, index);
    return reply.type(imageMime(file.filePath)).header("Content-Disposition", contentDisposition("inline", file.fileName)).send(createReadStream(file.filePath));
  });
  app.get<{ Params: { id: string } }>("/api/projects/:id/shots", async (request) => ({ shots: await projectService.listShots(request.params.id) }));
  app.patch<{ Params: { id: string; shotId: string }; Body: unknown }>("/api/projects/:id/shots/:shotId", async (request, reply) => {
    const input = updateShotInputSchema.parse(request.body);
    return reply.status(201).send(await projectOperations.run(request.params.id, () => projectService.updateShot(
      request.params.id,
      request.params.shotId,
      input.shot,
      input.expectedLatestArtifactId,
    )));
  });

  app.get<{ Params: { id: string } }>("/api/projects/:id/generation-center", async (request) => {
    return projectService.getGenerationCenter(request.params.id);
  });
  app.get<{ Params: { id: string } }>("/api/projects/:id/generation-readiness", async (request) => ({
    readiness: await projectService.getGenerationReadiness(request.params.id),
  }));
  app.post<{ Params: { id: string } }>("/api/projects/:id/handoff/updream/lock-assets", async (request) => ({
    project: await projectOperations.run(request.params.id, () => projectService.lockAssets(request.params.id)),
  }));
  app.post<{ Params: { id: string }; Body: unknown }>("/api/projects/:id/handoff/updream/bootstrap", async (request, reply) => {
    const body = z.object({ workflowMode: z.literal("agent-first").optional() }).parse(request.body ?? {});
    return reply.status(201).send(await projectOperations.run(request.params.id, () => projectService.createUpdreamBootstrap(request.params.id, { agentFirst: body.workflowMode === "agent-first" })));
  });
  app.post<{ Params: { id: string; shotId: string }; Body: unknown }>("/api/projects/:id/handoff/updream/shots/:shotId/package", async (request, reply) => {
    const body = z.object({ generationResolution: generationResolutionSchema.default("platform-default"), workflowMode: z.literal("agent-first").optional() }).parse(request.body ?? {});
    return reply.status(201).send(await projectOperations.run(request.params.id, () => projectService.createUpdreamShotPackage(request.params.id, request.params.shotId, body.generationResolution, { agentFirst: body.workflowMode === "agent-first" })));
  });
  app.get<{ Params: { id: string; shotId: string; version: string } }>("/api/projects/:id/handoff/updream/shots/:shotId/packages/:version/prompt", async (request) => {
    const version = z.coerce.number().int().positive().parse(request.params.version);
    return projectService.readShotPackagePrompt(request.params.id, request.params.shotId, version);
  });
  app.post<{ Params: { id: string; shotId: string; version: string }; Body: unknown }>("/api/projects/:id/handoff/updream/shots/:shotId/packages/:version/copy-materials", async (request) => {
    const version = z.coerce.number().int().positive().parse(request.params.version);
    const body = z.object({ label: z.string().regex(/^<(Subject|Picture|Video|Audio) \d+>$/).optional() }).parse(request.body ?? {});
    return projectOperations.run(request.params.id, () => projectService.copyShotPackageMaterials(request.params.id, request.params.shotId, version, body.label));
  });
  app.patch<{ Params: { id: string; assetId: string }; Body: unknown }>("/api/projects/:id/assets/:assetId/updream-upload-state", async (request) => {
    const body = z.object({ state: z.enum(["not-uploaded", "uploaded"]), workflowMode: z.literal("agent-first").optional() }).parse(request.body);
    return { asset: await projectOperations.run(request.params.id, () => projectService.setAssetUploadState(request.params.id, request.params.assetId, body.state, { agentFirst: body.workflowMode === "agent-first" })) };
  });
  app.patch<{ Params: { id: string; shotId: string; version: string }; Body: unknown }>("/api/projects/:id/handoff/updream/shots/:shotId/packages/:version/upload-state", async (request) => {
    const version = z.coerce.number().int().positive().parse(request.params.version);
    const body = z.object({ state: z.enum(["not-uploaded", "uploaded"]), workflowMode: z.literal("agent-first").optional() }).parse(request.body);
    return { package: await projectOperations.run(request.params.id, () => projectService.setShotPackageUploadState(request.params.id, request.params.shotId, version, body.state, { agentFirst: body.workflowMode === "agent-first" })) };
  });

  app.get<{ Params: { id: string }; Querystring: { workflowMode?: string } }>("/api/projects/:id/quality-center", async (request) => {
    const workflowMode = z.literal("agent-first").optional().parse(request.query.workflowMode);
    return qualityService.getQualityCenter(request.params.id, { agentFirst: workflowMode === "agent-first" });
  });
  app.post<{ Params: { id: string }; Body: unknown }>("/api/projects/:id/generations/scan", async (request) => {
    const body = z.object({ workflowMode: z.literal("agent-first").optional() }).parse(request.body ?? {});
    return projectOperations.run(request.params.id, () => qualityService.scanGenerationInbox(request.params.id, 0, undefined, { agentFirst: body.workflowMode === "agent-first" }));
  });
  app.get<{ Params: { id: string; jobId: string } }>("/api/projects/:id/generations/:jobId/media", async (request, reply) => {
    const media = await qualityService.readGenerationMedia(request.params.id, request.params.jobId);
    return sendLocalVideo(reply, media.filePath, media.fileName, request.headers.range);
  });
  app.get<{ Params: { id: string; jobId: string; index: string } }>("/api/projects/:id/generations/:jobId/review-frames/:index", async (request, reply) => {
    const index = z.coerce.number().int().nonnegative().parse(request.params.index);
    const frame = await qualityService.readGenerationReviewFrame(request.params.id, request.params.jobId, index);
    return reply.type(imageMime(frame.filePath)).header("Content-Disposition", `inline; filename=\"${frame.fileName}\"`).send(createReadStream(frame.filePath));
  });
  app.post<{ Params: { id: string; jobId: string }; Body: unknown }>("/api/projects/:id/generations/:jobId/reviews", async (request, reply) => {
    const body = z.object({ workflowMode: z.literal("agent-first").optional() }).passthrough().parse(request.body);
    return reply.status(201).send(await projectOperations.run(request.params.id, () => qualityService.recordQualityReview(request.params.id, request.params.jobId, body as never, { agentFirst: body.workflowMode === "agent-first" })));
  });
  app.post<{ Params: { id: string }; Body: unknown }>("/api/projects/:id/renders/rough-cut", async (request, reply) => {
    const body = z.object({ workflowMode: z.literal("agent-first").optional() }).parse(request.body ?? {});
    return reply.status(201).send(await projectOperations.run(request.params.id, () => qualityService.renderRoughCut(request.params.id, { agentFirst: body.workflowMode === "agent-first" })));
  });
  app.get<{ Params: { id: string; renderId: string } }>("/api/projects/:id/renders/:renderId/media", async (request, reply) => {
    const media = await qualityService.readRenderMedia(request.params.id, request.params.renderId);
    return sendLocalVideo(reply, media.filePath, media.fileName, request.headers.range);
  });
  app.get<{ Params: { id: string; renderId: string; kind: string } }>("/api/projects/:id/renders/:renderId/files/:kind", async (request, reply) => {
    const kind = z.enum(["video", "subtitle", "report"]).parse(request.params.kind);
    const file = await qualityService.readRenderFile(request.params.id, request.params.renderId, kind);
    const contentType = kind === "video" ? mediaMime(file.filePath) : kind === "subtitle" ? "application/x-subrip; charset=utf-8" : "text/markdown; charset=utf-8";
    return sendLocalDownload(reply, file.filePath, file.fileName, contentType);
  });
  app.post<{ Params: { id: string; renderId: string }; Body: unknown }>("/api/projects/:id/renders/:renderId/decision", async (request) => {
    const body = z.object({ decision: z.enum(["approved", "rejected"]), comment: z.string().max(2_000).optional(), workflowMode: z.literal("agent-first").optional() }).parse(request.body);
    return projectOperations.run(request.params.id, () => qualityService.recordDeliveryDecision(request.params.id, request.params.renderId, body.decision, body.comment, { agentFirst: body.workflowMode === "agent-first" }));
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
  const app = await createApp({ apiPort: port });
  await app.listen({ host, port });
}
