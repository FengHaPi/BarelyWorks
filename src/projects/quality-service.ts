import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { and, desc, eq, isNull } from "drizzle-orm";
import { stringify as toYaml } from "yaml";
import type { StudioDatabase } from "../database/client";
import { approvals, generationJobs, projects, qualityReviews, renders, shots } from "../database/schema";
import { importedMediaIssues } from "../media/import-validation";
import { FfmpegMediaToolchain, type MediaToolchain } from "../media/media-toolchain";
import { bindHandoffPackageToShot, UpdreamPackageBuilder } from "../handoff/updream-package-builder";
import {
  importedGenerationSchema,
  qualityCenterSchema,
  qualityReviewInputSchema,
  qualityReviewSchema,
  renderRecordSchema,
  type ImportedGeneration,
  type MediaToolStatus,
  type QualityCenter,
  type QualityReview,
  type QualityReviewInput,
  type RenderRecord,
} from "../shared/quality-schemas";
import {
  approvalRecordSchema,
  projectSchema,
  shotSpecSchema,
  type ApprovalRecord,
  type Project,
  type ProjectStage,
  type ShotSpec,
} from "../shared/schemas";
import { SkillRegistry } from "../skills/skill-registry";
import { assertTransition } from "../workflow/state-machine";
import { ProjectIntegrityService } from "./project-integrity-service";

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

function formatSrtTime(seconds: number): string {
  const milliseconds = Math.max(0, Math.round(seconds * 1_000));
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const secs = Math.floor((milliseconds % 60_000) / 1_000);
  const millis = milliseconds % 1_000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")},${String(millis).padStart(3, "0")}`;
}

function buildSrt(shotsInOrder: ShotSpec[], generationsByShot: Map<string, ImportedGeneration>): string {
  let cursor = 0;
  const cues: string[] = [];
  let cueNumber = 1;
  for (const shot of shotsInOrder) {
    const generation = generationsByShot.get(shot.id);
    if (!generation) continue;
    const start = cursor;
    const end = cursor + generation.media.durationSec;
    const dialogue = shot.dialogue.map((line) => `${line.speakerId}：${line.text}`).join("\n").trim();
    if (dialogue) cues.push(`${cueNumber++}\n${formatSrtTime(start)} --> ${formatSrtTime(end)}\n${dialogue}\n`);
    cursor = end;
  }
  return cues.join("\n");
}

export class QualityService {
  private readonly studioSkills: SkillRegistry;
  private readonly mediaToolchain: MediaToolchain;
  private readonly updreamPackages = new UpdreamPackageBuilder();
  private readonly failedInboxFiles = new Map<string, { fingerprint: string; reason: string; expiresAt: number }>();
  private readonly knownInboxHashes = new Map<string, { fingerprint: string; hash: string }>();

  constructor(
    private readonly studio: StudioDatabase,
    mediaToolchain?: MediaToolchain,
    private readonly integrityService = new ProjectIntegrityService(studio),
  ) {
    this.studioSkills = new SkillRegistry(studio.runtimeRoot);
    this.mediaToolchain = mediaToolchain ?? new FfmpegMediaToolchain(studio.runtimeRoot);
  }

  getMediaToolStatus() {
    return this.mediaToolchain.getStatus();
  }

  async listGenerations(projectId: string): Promise<ImportedGeneration[]> {
    await this.requireProject(projectId);
    const rows = await this.studio.db.select().from(generationJobs).where(eq(generationJobs.projectId, projectId));
    return rows
      .map((row) => importedGenerationSchema.parse({
        ...row.payload,
        id: row.id,
        projectId: row.projectId,
        shotId: row.shotId,
        provider: row.provider,
        model: row.model,
        mode: row.mode,
        status: row.status,
        parameterHash: row.parameterHash,
      }))
      .sort((left, right) => right.generationVersion - left.generationVersion || right.createdAt.localeCompare(left.createdAt));
  }

  async listQualityReviews(projectId: string): Promise<QualityReview[]> {
    await this.requireProject(projectId);
    const rows = await this.studio.db.select().from(qualityReviews)
      .where(eq(qualityReviews.projectId, projectId))
      .orderBy(desc(qualityReviews.createdAt));
    return rows.map((row) => qualityReviewSchema.parse({
      ...row.payload,
      id: row.id,
      projectId: row.projectId,
      jobId: row.jobId,
      shotId: row.shotId,
      decision: row.decision,
      createdAt: row.createdAt,
    }));
  }

  async listRenders(projectId: string): Promise<RenderRecord[]> {
    await this.requireProject(projectId);
    const rows = await this.studio.db.select().from(renders)
      .where(eq(renders.projectId, projectId))
      .orderBy(desc(renders.version));
    return rows.map((row) => renderRecordSchema.parse({
      ...row.payload,
      id: row.id,
      projectId: row.projectId,
      version: row.version,
      status: row.status,
      videoPath: row.videoPath,
      subtitlePath: row.subtitlePath,
      reportPath: row.reportPath,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
  }

  async getQualityCenter(projectId: string, options: { agentFirst?: boolean } = {}): Promise<QualityCenter> {
    const project = await this.requireProject(projectId);
    const inboxPath = path.join(project.projectDir, "generated", "inbox");
    await fs.mkdir(inboxPath, { recursive: true });
    const [mediaTools, skill, shotList, generations, reviews, renderList] = await Promise.all([
      this.mediaToolchain.getStatus(),
      this.studioSkills.load("video-quality-reviewer"),
      this.listShots(projectId),
      this.listGenerations(projectId),
      this.listQualityReviews(projectId),
      this.listRenders(projectId),
    ]);
    const gateAudit = await this.auditGenerationGate(project, shotList, generations, reviews, options);
    return qualityCenterSchema.parse({
      project,
      mediaTools,
      inboxPath,
      skill: skill.provenance,
      shots: shotList,
      generations,
      reviews,
      renders: renderList,
      gateAudit,
    });
  }

  async scanGenerationInbox(projectId: string, minimumAgeMs = 0, knownMediaTools?: MediaToolStatus, options: { agentFirst?: boolean; signal?: AbortSignal; onProcessId?: (processId: number | null) => void } = {}): Promise<{
    project: Project;
    imported: ImportedGeneration[];
    skipped: Array<{ fileName: string; reason: string }>;
    errors: Array<{ fileName: string; reason: string }>;
  }> {
    let project = await this.requireProject(projectId);
    if (!options.agentFirst && !(["READY_FOR_GENERATION", "GENERATING", "GENERATION_REVIEW"] as ProjectStage[]).includes(project.currentStage)) {
      throw new Error("只有等待生成、生成中或生成质检阶段才能导入视频");
    }
    if (!options.agentFirst) await this.integrityService.assertCanContinue(projectId, "导入生成视频");
    const mediaTools = knownMediaTools ?? await this.mediaToolchain.getStatus();
    if (!mediaTools.ffprobeAvailable) {
      throw new Error("未找到 ffprobe，无法验证并导入视频。请安装 FFmpeg 或设置 AI_VIDEO_STUDIO_FFPROBE_PATH");
    }
    const inboxPath = path.join(project.projectDir, "generated", "inbox");
    await fs.mkdir(inboxPath, { recursive: true });
    const shotList = await this.listShots(projectId);
    const shotsById = new Map(shotList.map((shot) => [shot.id, shot]));
    const existing = await this.listGenerations(projectId);
    const imported: ImportedGeneration[] = [];
    const skipped: Array<{ fileName: string; reason: string }> = [];
    const errors: Array<{ fileName: string; reason: string }> = [];
    const entries = (await fs.readdir(inboxPath, { withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      if (options.signal?.aborted) throw new Error("视频导入扫描已取消");
      const match = /^(S\d{3})_V(\d{2,3})\.(mp4|mov|mkv|webm)$/i.exec(entry.name);
      if (!match) {
        skipped.push({ fileName: entry.name, reason: "命名不符合 S003_V01.mp4 规则" });
        continue;
      }
      const shotId = match[1].toUpperCase();
      const generationVersion = Number(match[2]);
      const shot = shotsById.get(shotId);
      if (!shot) {
        errors.push({ fileName: entry.name, reason: `项目中不存在镜头 ${shotId}` });
        continue;
      }
      const promptBlocker = await this.promptPackageBlocker(project, shot, generationVersion);
      if (promptBlocker) {
        errors.push({ fileName: entry.name, reason: promptBlocker });
        continue;
      }
      const sourcePackage = (await this.updreamPackages.listShotPackages(project, shotId))
        .find((item) => item.version === generationVersion) ?? null;
      const sourcePath = path.join(inboxPath, entry.name);
      let sourceFingerprint: string | null = null;
      let deterministicFailure = false;
      try {
        const stat = await fs.stat(sourcePath);
        if (Date.now() - stat.mtimeMs < minimumAgeMs) {
          skipped.push({ fileName: entry.name, reason: "文件仍可能在下载，稍后自动重试" });
          continue;
        }
        sourceFingerprint = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
        const cachedFailure = this.failedInboxFiles.get(sourcePath);
        if (cachedFailure && cachedFailure.expiresAt <= Date.now()) this.failedInboxFiles.delete(sourcePath);
        else if (cachedFailure?.fingerprint === sourceFingerprint) {
          skipped.push({ fileName: entry.name, reason: `${cachedFailure.reason}（文件未变化，不重复探测）` });
          continue;
        }
        if (stat.size > 8 * 1024 * 1024 * 1024) {
          deterministicFailure = true;
          throw new Error("视频文件超过 8 GB 导入上限");
        }
        const knownHash = this.knownInboxHashes.get(sourcePath);
        const sourceHash = knownHash?.fingerprint === sourceFingerprint ? knownHash.hash : await sha256File(sourcePath);
        this.knownInboxHashes.set(sourcePath, { fingerprint: sourceFingerprint, hash: sourceHash });
        const existingVersion = [...existing, ...imported]
          .find((job) => job.shotId === shotId && job.generationVersion === generationVersion);
        if (existingVersion) {
          if (existingVersion.sourceHash === sourceHash) {
            skipped.push({ fileName: entry.name, reason: "该镜头版本已按相同文件哈希导入" });
          } else {
            errors.push({ fileName: entry.name, reason: `${shotId} V${String(generationVersion).padStart(3, "0")} 已存在且文件内容不同，历史版本不会被覆盖` });
          }
          continue;
        }
        if ([...existing, ...imported].some((job) => job.sourceHash === sourceHash)) {
          skipped.push({ fileName: entry.name, reason: "相同文件哈希已经导入" });
          continue;
        }
        const media = await this.mediaToolchain.probe(sourcePath, { signal: options.signal, onProcessId: options.onProcessId });
        const mediaIssues = importedMediaIssues(project, shot, media);
        if (mediaIssues.length) {
          deterministicFailure = true;
          throw new Error(`视频规格未通过：${mediaIssues.join("；")}`);
        }
        const versionDirectory = path.join(project.projectDir, "generated", shotId, `v${String(generationVersion).padStart(3, "0")}`);
        const importedPath = path.join(versionDirectory, entry.name);
        if (!isInside(project.projectDir, importedPath)) throw new Error("导入目标路径越界");
        await fs.mkdir(versionDirectory, { recursive: true });
        try {
          await fs.copyFile(sourcePath, importedPath, fsConstants.COPYFILE_EXCL);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          if (await sha256File(importedPath) !== sourceHash) throw new Error("同版本目标文件已存在且哈希不同，拒绝覆盖");
        }
        let reviewFramePaths: string[] = [];
        let reviewFrameError: string | null = null;
        if (mediaTools.ffmpegAvailable) {
          const reviewFrameDirectory = path.join(versionDirectory, "review-frames");
          if (!isInside(project.projectDir, reviewFrameDirectory)) throw new Error("关键帧输出路径越界");
          try {
            reviewFramePaths = await this.mediaToolchain.extractReviewFrames({
              inputPath: importedPath,
              durationSec: media.durationSec,
              outputDirectory: reviewFrameDirectory,
              signal: options.signal,
              onProcessId: options.onProcessId,
            });
            if (reviewFramePaths.some((framePath) => !isInside(project.projectDir, framePath))) {
              throw new Error("关键帧文件路径越界");
            }
          } catch (error) {
            reviewFramePaths = [];
            reviewFrameError = error instanceof Error ? error.message : String(error);
          }
        }
        const now = new Date().toISOString();
        const generation = importedGenerationSchema.parse({
          id: randomUUID(),
          projectId,
          shotId,
          provider: "updream",
          model: "MiniMax H3",
          mode: "manual",
          promptVersion: generationVersion,
          referenceAssetIds: [shot.sceneId, ...shot.characterIds, ...shot.propIds, ...shot.styleIds],
          providerTaskId: null,
          estimatedCost: null,
          actualCost: null,
          status: "review",
          retryCount: 0,
          parameterHash: sourceHash,
          sourceFileName: entry.name,
          sourceHash,
          importedPath,
          reviewFramePaths,
          generationVersion,
          media,
          createdAt: now,
          updatedAt: now,
        });
        if (!options.agentFirst && !imported.length && project.currentStage !== "GENERATING") {
          project = await this.transition(project, "GENERATING", "generation.import.started");
        }
        await this.studio.db.insert(generationJobs).values({
          id: generation.id,
          projectId: generation.projectId,
          shotId: generation.shotId,
          provider: generation.provider,
          model: generation.model ?? null,
          mode: generation.mode,
          status: generation.status,
          parameterHash: generation.parameterHash,
          storyboardArtifactId: sourcePackage?.sourceStoryboardArtifactId ?? null,
          shotPackageArtifactId: sourcePackage?.id ?? null,
          payload: generation,
        });
        await this.setShotStatus(project, shot, "generated");
        imported.push(generation);
        await this.appendLog(project.projectDir, "provider-jobs.jsonl", {
          type: "generation.imported",
          projectId,
          jobId: generation.id,
          shotId,
          generationVersion,
          sourceFileName: entry.name,
          sourceHash,
          importedPath,
          reviewFramePaths,
          reviewFrameError,
          media,
          createdAt: now,
        });
        this.failedInboxFiles.delete(sourcePath);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (sourceFingerprint && deterministicFailure) {
          this.failedInboxFiles.set(sourcePath, { fingerprint: sourceFingerprint, reason, expiresAt: Date.now() + 60_000 });
        }
        errors.push({ fileName: entry.name, reason });
      }
    }

    if (!options.agentFirst && imported.length) {
      const allJobs = [...existing, ...imported];
      if (shotList.length > 0 && shotList.every((shot) => allJobs.some((job) => job.shotId === shot.id)) && project.currentStage === "GENERATING") {
        project = await this.transition(project, "GENERATION_REVIEW", "generation.import.completed");
      }
    }
    return { project, imported, skipped, errors };
  }

  async scanAllGenerationInboxes(
    runForProject: (projectId: string, scan: () => Promise<void>) => Promise<void> = async (_projectId, scan) => scan(),
  ): Promise<void> {
    const rows = await this.studio.db.select().from(projects).where(isNull(projects.archivedAt));
    const candidates = rows.map((row) => projectSchema.parse(row)).filter((project) =>
      (["READY_FOR_GENERATION", "GENERATING", "GENERATION_REVIEW"] as ProjectStage[]).includes(project.currentStage));
    if (!candidates.length) return;
    const status = await this.mediaToolchain.getStatus();
    if (!status.ffprobeAvailable) return;
    await Promise.all(candidates.map(async (project) => {
      try {
        await runForProject(project.id, async () => {
          const result = await this.scanGenerationInbox(project.id, 2_000, status);
          if (result.errors.length) await this.appendLog(project.projectDir, "provider-jobs.jsonl", {
            type: "generation.inbox-scan.file-errors",
            projectId: project.id,
            errors: result.errors,
            createdAt: new Date().toISOString(),
          });
        });
      } catch (error) {
        await this.appendLog(project.projectDir, "provider-jobs.jsonl", {
          type: "generation.inbox-scan.failed",
          projectId: project.id,
          message: error instanceof Error ? error.message : String(error),
          createdAt: new Date().toISOString(),
        });
      }
    }));
  }

  async recordQualityReview(projectId: string, jobId: string, rawInput: QualityReviewInput): Promise<{
    project: Project;
    review: QualityReview;
    generation: ImportedGeneration;
  }>;
  async recordQualityReview(projectId: string, jobId: string, rawInput: QualityReviewInput, options?: { agentFirst?: boolean }): Promise<{
    project: Project;
    review: QualityReview;
    generation: ImportedGeneration;
  }>;
  async recordQualityReview(projectId: string, jobId: string, rawInput: QualityReviewInput, options: { agentFirst?: boolean } = {}): Promise<{
    project: Project;
    review: QualityReview;
    generation: ImportedGeneration;
  }> {
    let project = await this.requireProject(projectId);
    if (!options.agentFirst && project.currentStage !== "GENERATING" && project.currentStage !== "GENERATION_REVIEW") {
      throw new Error("只有生成中或生成质检阶段才能提交质量结论");
    }
    if (!options.agentFirst) await this.integrityService.assertCanContinue(projectId, "提交质量结论");
    const input = qualityReviewInputSchema.parse(rawInput);
    const generations = await this.listGenerations(projectId);
    const generation = generations.find((item) => item.id === jobId);
    if (!generation) throw new Error("生成任务不存在");
    if (generation.status !== "review") throw new Error(`该生成版本当前状态为 ${generation.status}，不能重复质检`);
    const latestForShot = generations.find((item) => item.shotId === generation.shotId);
    if (latestForShot?.id !== generation.id) throw new Error("只能质检该镜头的最新生成版本");
    const shot = (await this.listShots(projectId)).find((item) => item.id === generation.shotId);
    if (!shot) throw new Error("生成任务对应镜头不存在");
    const promptBlocker = await this.promptPackageBlocker(project, shot, generation.promptVersion);
    if (promptBlocker) throw new Error(promptBlocker);
    if (await sha256File(generation.importedPath) !== generation.sourceHash) {
      throw new Error("导入视频已在数据库外发生变化，不能继续质检");
    }
    const skill = await this.studioSkills.load("video-quality-reviewer");
    const now = new Date().toISOString();
    const review = qualityReviewSchema.parse({
      ...input,
      id: randomUUID(),
      projectId,
      jobId,
      shotId: generation.shotId,
      generationVersion: generation.generationVersion,
      reviewer: "human",
      skill: skill.provenance,
      createdAt: now,
    });
    const qaPath = path.join(
      project.projectDir,
      "qa",
      `${generation.shotId}-generation-v${String(generation.generationVersion).padStart(3, "0")}-review-${review.id}.json`,
    );
    if (!isInside(project.projectDir, qaPath)) throw new Error("质检记录路径越界");
    await fs.writeFile(qaPath, `${JSON.stringify(review, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    try {
      await this.studio.db.insert(qualityReviews).values({
        id: review.id,
        projectId,
        jobId,
        shotId: review.shotId,
        decision: review.decision,
        payload: review,
        createdAt: now,
      });
      const accepted = review.decision === "accepted";
      const jobStatus: ImportedGeneration["status"] = accepted
        ? "accepted"
        : review.decision === "manual-fix" || review.decision === "conditional-pass" ? "review" : "failed";
      const updatedGeneration = importedGenerationSchema.parse({ ...generation, status: jobStatus, updatedAt: now });
      await this.studio.db.update(generationJobs)
        .set({ status: jobStatus, payload: updatedGeneration })
        .where(eq(generationJobs.id, jobId));
      await this.setShotStatus(project, shot, accepted ? "accepted" : review.decision === "manual-fix" || review.decision === "conditional-pass" ? "generated" : "rejected");
      if (!options.agentFirst && !accepted && review.decision !== "manual-fix" && review.decision !== "conditional-pass" && project.currentStage === "GENERATION_REVIEW") {
        project = await this.transition(project, "GENERATING", "generation.retry.requested");
      }
      await this.appendLog(project.projectDir, "provider-jobs.jsonl", {
        type: "generation.review.recorded",
        projectId,
        jobId,
        reviewId: review.id,
        decision: review.decision,
        qaPath,
        skill: skill.provenance,
        createdAt: now,
      });
      return { project, review, generation: updatedGeneration };
    } catch (error) {
      await fs.rm(qaPath, { force: true });
      throw error;
    }
  }

  async renderRoughCut(projectId: string, options: { agentFirst?: boolean; signal?: AbortSignal; onProcessId?: (processId: number | null) => void } = {}): Promise<{ project: Project; render: RenderRecord }> {
    let project = await this.requireProject(projectId);
    if (!options.agentFirst && project.currentStage !== "GENERATION_REVIEW" && project.currentStage !== "EDITING") {
      throw new Error("只有生成质检完成后才能创建粗剪");
    }
    if (!options.agentFirst) await this.integrityService.assertCanContinue(projectId, "创建粗剪");
    const mediaTools = await this.mediaToolchain.getStatus();
    if (!mediaTools.roughCutReady) {
      const missing = [
        !mediaTools.ffmpegAvailable && "FFmpeg",
        !mediaTools.ffprobeAvailable && "ffprobe",
        mediaTools.ffmpegAvailable && !mediaTools.libx264Available && "libx264 编码器",
        mediaTools.ffmpegAvailable && !mediaTools.aacAvailable && "AAC 编码器",
      ].filter(Boolean).join("、");
      throw new Error(`粗剪媒体预检未通过：缺少 ${missing || "必要能力"}；未创建虚假成片`);
    }
    const [shotList, generationList, reviews, existingRenders] = await Promise.all([
      this.listShots(projectId),
      this.listGenerations(projectId),
      this.listQualityReviews(projectId),
      this.listRenders(projectId),
    ]);
    const gateAudit = await this.auditGenerationGate(project, shotList, generationList, reviews, options);
    if (!gateAudit.passed) {
      throw new Error(`生成审核门禁未通过，不能创建粗剪：${gateAudit.blockers.join("；")}`);
    }
    const acceptedByShot = new Map<string, ImportedGeneration>();
    for (const shot of shotList) {
      const accepted = generationList.find((item) => item.shotId === shot.id);
      if (accepted) acceptedByShot.set(shot.id, accepted);
    }
    for (const generation of acceptedByShot.values()) {
      if (await sha256File(generation.importedPath) !== generation.sourceHash) {
        throw new Error(`${generation.shotId} 的已接受视频在质检后发生变化，必须重新导入并审核`);
      }
    }
    const resolution = /^(\d+)\s*[xX×]\s*(\d+)$/.exec(project.resolution);
    if (!resolution) throw new Error(`无法解析项目分辨率：${project.resolution}`);
    const version = (existingRenders[0]?.version ?? 0) + 1;
    const stem = `rough-cut-v${String(version).padStart(3, "0")}`;
    const videoPath = path.join(project.projectDir, "edit", `${stem}.mp4`);
    const subtitlePath = path.join(project.projectDir, "edit", `subtitles-v${String(version).padStart(3, "0")}.srt`);
    const reportPath = path.join(project.projectDir, "deliverables", `report-v${String(version).padStart(3, "0")}.md`);
    const logPath = path.join(project.projectDir, "logs", `ffmpeg-${stem}.log`);
    if ([videoPath, subtitlePath, reportPath, logPath].some((target) => !isInside(project.projectDir, target))) {
      throw new Error("粗剪输出路径越界");
    }
    const now = new Date().toISOString();
    let render = renderRecordSchema.parse({
      id: randomUUID(),
      projectId,
      version,
      status: "rendering",
      videoPath,
      subtitlePath,
      reportPath,
      sourceJobIds: shotList.map((shot) => acceptedByShot.get(shot.id)!.id),
      media: null,
      error: null,
      deliveryVideoPath: null,
      deliverySubtitlePath: null,
      deliveryReportPath: null,
      createdAt: now,
      updatedAt: now,
    });
    await this.studio.db.insert(renders).values({
      id: render.id,
      projectId,
      version,
      status: render.status,
      videoPath,
      subtitlePath,
      reportPath,
      sourceJobIds: render.sourceJobIds,
      payload: render,
      createdAt: now,
      updatedAt: now,
    });
    if (!options.agentFirst && project.currentStage === "GENERATION_REVIEW") {
      project = await this.transition(project, "EDITING", "rough-cut.started");
    }
    try {
      await fs.writeFile(subtitlePath, buildSrt(shotList, acceptedByShot), { encoding: "utf8", flag: "wx" });
      await this.mediaToolchain.renderRoughCut({
        clips: shotList.map((shot) => {
          const generation = acceptedByShot.get(shot.id)!;
          return { path: generation.importedPath, media: generation.media };
        }),
        width: Number(resolution[1]),
        height: Number(resolution[2]),
        outputPath: videoPath,
        logPath,
        signal: options.signal,
        onProcessId: options.onProcessId,
      });
      const media = await this.mediaToolchain.probe(videoPath, { signal: options.signal, onProcessId: options.onProcessId });
      const finishedAt = new Date().toISOString();
      const report = [
        `# ${project.title} 粗剪报告 V${String(version).padStart(3, "0")}`,
        "",
        `- 生成时间：${finishedAt}`,
        `- 输出：${videoPath}`,
        `- 字幕：${subtitlePath}`,
        `- 实测时长：${media.durationSec.toFixed(3)} 秒`,
        `- 实测画面：${media.width}x${media.height} / ${media.frameRate.toFixed(3)} fps / ${media.videoCodec}`,
        `- 音频：${media.hasAudio ? media.audioCodec ?? "已检测" : "无音轨"}`,
        "",
        "## 采用的镜头版本",
        "",
        ...shotList.map((shot) => {
          const generation = acceptedByShot.get(shot.id)!;
          return `- ${shot.id}: V${String(generation.generationVersion).padStart(3, "0")} / ${generation.sourceHash}`;
        }),
        "",
        "> 本报告中的媒体参数来自 ffprobe；视觉与声音质量结论来自已保存的人工九维审核记录。",
        "",
      ].join("\n");
      await fs.writeFile(reportPath, report, { encoding: "utf8", flag: "wx" });
      render = renderRecordSchema.parse({ ...render, status: "review", media, updatedAt: finishedAt });
      await this.studio.db.update(renders)
        .set({ status: render.status, payload: render, updatedAt: finishedAt })
        .where(eq(renders.id, render.id));
      if (!options.agentFirst) project = await this.transition(project, "FINAL_REVIEW", "rough-cut.completed");
      await this.appendLog(project.projectDir, "render.log.jsonl", {
        type: "rough-cut.completed",
        projectId,
        renderId: render.id,
        version,
        videoPath,
        subtitlePath,
        reportPath,
        sourceJobIds: render.sourceJobIds,
        media,
        createdAt: finishedAt,
      });
      return { project, render };
    } catch (error) {
      const failedAt = new Date().toISOString();
      const message = error instanceof Error ? error.message : String(error);
      render = renderRecordSchema.parse({ ...render, status: "failed", error: message, updatedAt: failedAt });
      await this.studio.db.update(renders)
        .set({ status: render.status, payload: render, updatedAt: failedAt })
        .where(eq(renders.id, render.id));
      await fs.writeFile(reportPath, `# 粗剪失败\n\n- 时间：${failedAt}\n- 原因：${message}\n`, {
        encoding: "utf8",
        flag: "wx",
      }).catch(() => undefined);
      await this.appendLog(project.projectDir, "render.log.jsonl", {
        type: "rough-cut.failed",
        projectId,
        renderId: render.id,
        message,
        createdAt: failedAt,
      });
      throw error;
    }
  }

  async recordDeliveryDecision(
    projectId: string,
    renderId: string,
    decision: "approved" | "rejected",
    comment?: string,
    options: { agentFirst?: boolean } = {},
  ): Promise<{ project: Project; render: RenderRecord; approval: ApprovalRecord }> {
    let project = await this.requireProject(projectId);
    if (!options.agentFirst && project.currentStage !== "FINAL_REVIEW") {
      throw new Error("只有成片终审阶段可以批准或驳回交付版本");
    }
    if (decision === "approved" && !options.agentFirst) await this.integrityService.assertCanContinue(projectId, "批准交付版本");
    if (decision === "rejected" && !comment?.trim()) throw new Error("驳回成片时必须填写修改意见");
    const renderList = await this.listRenders(projectId);
    const current = renderList.find((item) => item.id === renderId);
    if (!current || current.status !== "review") throw new Error("只能审核当前待终审粗剪版本");
    if (renderList[0]?.id !== current.id) throw new Error("只能审核最新粗剪版本");
    if (decision === "approved") {
      const [shotList, generationList, reviews] = await Promise.all([
        this.listShots(projectId),
        this.listGenerations(projectId),
        this.listQualityReviews(projectId),
      ]);
      const gateAudit = await this.auditGenerationGate(project, shotList, generationList, reviews, options);
      if (!gateAudit.passed) {
        throw new Error(`生成审核门禁已失效，不能批准交付：${gateAudit.blockers.join("；")}`);
      }
      const currentSourceJobIds = shotList.map((shot) => generationList.find((item) => item.shotId === shot.id)?.id);
      const missingOrDifferentSource = currentSourceJobIds.some((jobId) => !jobId || !current.sourceJobIds.includes(jobId))
        || current.sourceJobIds.some((jobId) => !currentSourceJobIds.includes(jobId));
      if (missingOrDifferentSource) throw new Error("当前粗剪绑定的生成版本不是各镜头最新正式通过版本，必须重新创建粗剪");
    }
    const now = new Date().toISOString();
    let updatedRender = current;
    let artifactPath = current.videoPath;

    if (decision === "approved") {
      const deliverableDirectory = path.join(project.projectDir, "deliverables", `v${String(current.version).padStart(3, "0")}`);
      const deliveryVideoPath = path.join(deliverableDirectory, "final.mp4");
      const deliverySubtitlePath = current.subtitlePath ? path.join(deliverableDirectory, "subtitles.srt") : null;
      const deliveryReportPath = path.join(deliverableDirectory, "report.md");
      if ([deliveryVideoPath, deliverySubtitlePath, deliveryReportPath]
        .filter((target): target is string => Boolean(target))
        .some((target) => !isInside(project.projectDir, target))) {
        throw new Error("交付路径越界");
      }
      await fs.mkdir(deliverableDirectory, { recursive: false });
      try {
        await fs.copyFile(current.videoPath, deliveryVideoPath, fsConstants.COPYFILE_EXCL);
        if (current.subtitlePath && deliverySubtitlePath) {
          await fs.copyFile(current.subtitlePath, deliverySubtitlePath, fsConstants.COPYFILE_EXCL);
        }
        await fs.copyFile(current.reportPath, deliveryReportPath, fsConstants.COPYFILE_EXCL);
      } catch (error) {
        await fs.rm(deliverableDirectory, { recursive: true, force: true });
        throw error;
      }
      artifactPath = deliveryVideoPath;
      updatedRender = renderRecordSchema.parse({
        ...current,
        status: "approved",
        deliveryVideoPath,
        deliverySubtitlePath,
        deliveryReportPath,
        updatedAt: now,
      });
    } else {
      updatedRender = renderRecordSchema.parse({ ...current, status: "rejected", updatedAt: now });
    }

    const artifactHash = await sha256File(artifactPath);
    const approval = approvalRecordSchema.parse({
      id: randomUUID(),
      projectId,
      stage: "FINAL_REVIEW",
      artifactPath,
      artifactHash,
      artifactVersion: current.version,
      decision,
      comment: comment ?? null,
      createdAt: now,
    });
    await this.studio.db.insert(approvals).values(approval);
    await this.studio.db.update(renders)
      .set({ status: updatedRender.status, payload: updatedRender, updatedAt: now })
      .where(eq(renders.id, renderId));
    if (!options.agentFirst) {
      project = await this.transition(
        project,
        decision === "approved" ? "DELIVERED" : "EDITING",
        decision === "approved" ? "delivery.approved" : "delivery.rejected",
      );
    }
    await this.appendLog(project.projectDir, "render.log.jsonl", {
      type: decision === "approved" ? "delivery.approved" : "delivery.rejected",
      projectId,
      renderId,
      approvalId: approval.id,
      artifactPath,
      artifactHash,
      comment: comment ?? null,
      createdAt: now,
    });
    return { project, render: updatedRender, approval };
  }

  async readGenerationMedia(projectId: string, jobId: string): Promise<{ filePath: string; fileName: string }> {
    const project = await this.requireProject(projectId);
    const generation = (await this.listGenerations(projectId)).find((item) => item.id === jobId);
    if (!generation) throw new Error("生成任务不存在");
    if (!isInside(project.projectDir, generation.importedPath)) throw new Error("生成视频路径越界");
    await fs.access(generation.importedPath);
    return { filePath: generation.importedPath, fileName: path.basename(generation.importedPath) };
  }

  async readGenerationReviewFrame(projectId: string, jobId: string, index: number): Promise<{ filePath: string; fileName: string }> {
    const project = await this.requireProject(projectId);
    const generation = (await this.listGenerations(projectId)).find((item) => item.id === jobId);
    if (!generation) throw new Error("生成任务不存在");
    const filePath = generation.reviewFramePaths[index];
    if (!filePath) throw new Error("质检关键帧不存在");
    if (!isInside(project.projectDir, filePath)) throw new Error("质检关键帧路径越界");
    await fs.access(filePath);
    return { filePath, fileName: path.basename(filePath) };
  }

  async readRenderMedia(projectId: string, renderId: string): Promise<{ filePath: string; fileName: string }> {
    return this.readRenderFile(projectId, renderId, "video");
  }

  async readRenderFile(
    projectId: string,
    renderId: string,
    kind: "video" | "subtitle" | "report",
  ): Promise<{ filePath: string; fileName: string }> {
    const project = await this.requireProject(projectId);
    const render = (await this.listRenders(projectId)).find((item) => item.id === renderId);
    if (!render) throw new Error("粗剪版本不存在");
    const filePath = kind === "video"
      ? render.deliveryVideoPath ?? render.videoPath
      : kind === "subtitle"
        ? render.deliverySubtitlePath ?? render.subtitlePath
        : render.deliveryReportPath ?? render.reportPath;
    if (!filePath) throw new Error(kind === "subtitle" ? "该粗剪版本没有字幕文件" : "交付文件不存在");
    if (!isInside(project.projectDir, filePath)) throw new Error("交付文件路径越界");
    await fs.access(filePath);
    return { filePath, fileName: path.basename(filePath) };
  }

  private async promptPackageBlocker(project: Project, shot: ShotSpec, promptVersion: number): Promise<string | null> {
    try {
      const packageSummary = (await this.updreamPackages.listShotPackages(project, shot.id))
        .find((item) => item.version === promptVersion);
      if (!packageSummary) return `${shot.id} V${String(promptVersion).padStart(3, "0")} 缺少对应提示词投递包`;
      const bound = bindHandoffPackageToShot(packageSummary, shot);
      if (bound.isStale) return `${shot.id} V${String(promptVersion).padStart(3, "0")} 的提示词投递包已失效：${bound.staleReasons.join("；")}`;
      if (!isInside(project.projectDir, bound.promptPath)) return `${shot.id} 的提示词路径越界`;
      const prompt = (await fs.readFile(bound.promptPath, "utf8")).trim();
      if (!prompt) return `${shot.id} V${String(promptVersion).padStart(3, "0")} 的提示词为空`;
      return null;
    } catch (error) {
      return `${shot.id} V${String(promptVersion).padStart(3, "0")} 的提示词证据不可读取：${error instanceof Error ? error.message : String(error)}`;
    }
  }

  private isFullyAcceptedReview(review: QualityReview): boolean {
    return review.decision === "accepted"
      && review.dimensions.every((item) => item.status === "pass")
      && review.conditions.length === 0
      && review.unverifiedClaims.length === 0;
  }

  private async auditGenerationGate(
    project: Project,
    shotList: ShotSpec[],
    generationList: ImportedGeneration[],
    reviews: QualityReview[],
    options: { agentFirst?: boolean } = {},
  ): Promise<{ passed: boolean; acceptedShotIds: string[]; blockers: string[] }> {
    const blockers: string[] = [];
    const acceptedShotIds: string[] = [];
    if (!options.agentFirst && project.staleStages.length) blockers.push(`项目仍有失效环节：${project.staleStages.join("、")}`);
    if (!shotList.length) blockers.push("项目没有可用于生成的镜头");
    for (const shot of shotList) {
      const generation = generationList.find((item) => item.shotId === shot.id);
      if (!generation) {
        blockers.push(`${shot.id} 尚未导入生成视频`);
        continue;
      }
      const promptBlocker = await this.promptPackageBlocker(project, shot, generation.promptVersion);
      if (promptBlocker) blockers.push(promptBlocker);
      const latestReview = reviews.find((item) => item.jobId === generation.id);
      const versionLabel = `${shot.id} V${String(generation.generationVersion).padStart(3, "0")}`;
      if (!latestReview) {
        blockers.push(`${versionLabel} 尚未人工审核`);
        continue;
      }
      if (latestReview.decision === "conditional-pass") {
        blockers.push(`${versionLabel} 仅为有条件通过，条件未闭环`);
        continue;
      }
      if (!this.isFullyAcceptedReview(latestReview)) {
        blockers.push(`${versionLabel} 最新结论为“${latestReview.decision}”，不是九维全部正式通过`);
        continue;
      }
      if (generation.status !== "accepted") {
        blockers.push(`${versionLabel} 审核记录与生成状态不一致`);
        continue;
      }
      acceptedShotIds.push(shot.id);
    }
    return { passed: blockers.length === 0, acceptedShotIds, blockers };
  }

  private async listShots(projectId: string): Promise<ShotSpec[]> {
    const rows = await this.studio.db.select().from(shots).where(eq(shots.projectId, projectId));
    return rows
      .map((row) => shotSpecSchema.parse({
        ...row.payload,
        id: row.id,
        projectId: row.projectId,
        sequence: row.sequence,
        status: row.status,
      }))
      .sort((left, right) => left.sequence - right.sequence);
  }

  private async setShotStatus(project: Project, shot: ShotSpec, status: ShotSpec["status"]): Promise<void> {
    const updatedShot = shotSpecSchema.parse({ ...shot, status });
    await this.studio.db.update(shots)
      .set({ status, payload: updatedShot })
      .where(and(eq(shots.projectId, project.id), eq(shots.id, shot.id)));
  }

  private async requireProject(id: string): Promise<Project> {
    const [row] = await this.studio.db.select().from(projects)
      .where(and(eq(projects.id, id), isNull(projects.archivedAt)))
      .limit(1);
    if (!row) throw new Error("项目不存在");
    return projectSchema.parse({
      ...row,
      sourceType: row.sourceType,
      currentStage: row.currentStage,
      staleStages: row.staleStages,
    });
  }

  private async transition(project: Project, target: ProjectStage, event: string): Promise<Project> {
    assertTransition(project.currentStage, target);
    const updatedAt = new Date().toISOString();
    const staleStages = project.staleStages.filter((stage) => stage !== project.currentStage && stage !== target);
    await this.studio.db.update(projects)
      .set({ currentStage: target, staleStages, updatedAt })
      .where(eq(projects.id, project.id));
    const updated = projectSchema.parse({ ...project, currentStage: target, staleStages, updatedAt });
    const manifestPath = path.join(project.projectDir, "project.yaml");
    const temporaryPath = `${manifestPath}.tmp`;
    await fs.writeFile(temporaryPath, toYaml(updated), "utf8");
    await fs.rename(temporaryPath, manifestPath);
    await this.appendLog(project.projectDir, "workflow.log.jsonl", {
      type: event,
      projectId: project.id,
      from: project.currentStage,
      to: target,
      createdAt: updatedAt,
    });
    return updated;
  }

  private async appendLog(projectDir: string, fileName: string, event: Record<string, unknown>): Promise<void> {
    await fs.appendFile(path.join(projectDir, "logs", fileName), `${JSON.stringify(event)}\n`, "utf8");
  }
}
