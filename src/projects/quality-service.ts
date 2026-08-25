import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { and, desc, eq } from "drizzle-orm";
import { stringify as toYaml } from "yaml";
import type { StudioDatabase } from "../database/client";
import { approvals, generationJobs, projects, qualityReviews, renders, shots } from "../database/schema";
import { FfmpegMediaToolchain, type MediaToolchain } from "../media/media-toolchain";
import {
  importedGenerationSchema,
  qualityCenterSchema,
  qualityReviewInputSchema,
  qualityReviewSchema,
  renderRecordSchema,
  type ImportedGeneration,
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

  constructor(
    private readonly studio: StudioDatabase,
    private readonly mediaToolchain: MediaToolchain = new FfmpegMediaToolchain(),
  ) {
    this.studioSkills = new SkillRegistry(studio.runtimeRoot);
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

  async getQualityCenter(projectId: string): Promise<QualityCenter> {
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
    return qualityCenterSchema.parse({
      project,
      mediaTools,
      inboxPath,
      skill: skill.provenance,
      shots: shotList,
      generations,
      reviews,
      renders: renderList,
    });
  }

  async scanGenerationInbox(projectId: string, minimumAgeMs = 0): Promise<{
    project: Project;
    imported: ImportedGeneration[];
    skipped: Array<{ fileName: string; reason: string }>;
    errors: Array<{ fileName: string; reason: string }>;
  }> {
    let project = await this.requireProject(projectId);
    if (!(["READY_FOR_GENERATION", "GENERATING", "GENERATION_REVIEW"] as ProjectStage[]).includes(project.currentStage)) {
      throw new Error("只有等待生成、生成中或生成质检阶段才能导入视频");
    }
    const mediaTools = await this.mediaToolchain.getStatus();
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
      const sourcePath = path.join(inboxPath, entry.name);
      try {
        const stat = await fs.stat(sourcePath);
        if (Date.now() - stat.mtimeMs < minimumAgeMs) {
          skipped.push({ fileName: entry.name, reason: "文件仍可能在下载，稍后自动重试" });
          continue;
        }
        const sourceHash = await sha256File(sourcePath);
        if ([...existing, ...imported].some((job) => job.sourceHash === sourceHash)) {
          skipped.push({ fileName: entry.name, reason: "相同文件哈希已经导入" });
          continue;
        }
        if ([...existing, ...imported].some((job) => job.shotId === shotId && job.generationVersion === generationVersion)) {
          errors.push({ fileName: entry.name, reason: `${shotId} V${String(generationVersion).padStart(3, "0")} 已存在，历史版本不会被覆盖` });
          continue;
        }
        const media = await this.mediaToolchain.probe(sourcePath);
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
          generationVersion,
          media,
          createdAt: now,
          updatedAt: now,
        });
        if (!imported.length && project.currentStage !== "GENERATING") {
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
          media,
          createdAt: now,
        });
      } catch (error) {
        errors.push({ fileName: entry.name, reason: error instanceof Error ? error.message : String(error) });
      }
    }

    if (imported.length) {
      const allJobs = [...existing, ...imported];
      if (shotList.length > 0 && shotList.every((shot) => allJobs.some((job) => job.shotId === shot.id)) && project.currentStage === "GENERATING") {
        project = await this.transition(project, "GENERATION_REVIEW", "generation.import.completed");
      }
    }
    return { project, imported, skipped, errors };
  }

  async scanAllGenerationInboxes(): Promise<void> {
    const status = await this.mediaToolchain.getStatus();
    if (!status.ffprobeAvailable) return;
    const rows = await this.studio.db.select().from(projects);
    const candidates = rows.map((row) => projectSchema.parse(row)).filter((project) =>
      (["READY_FOR_GENERATION", "GENERATING", "GENERATION_REVIEW"] as ProjectStage[]).includes(project.currentStage));
    await Promise.all(candidates.map(async (project) => {
      try {
        await this.scanGenerationInbox(project.id, 2_000);
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
  }> {
    let project = await this.requireProject(projectId);
    if (project.currentStage !== "GENERATING" && project.currentStage !== "GENERATION_REVIEW") {
      throw new Error("只有生成中或生成质检阶段才能提交质量结论");
    }
    const input = qualityReviewInputSchema.parse(rawInput);
    const generations = await this.listGenerations(projectId);
    const generation = generations.find((item) => item.id === jobId);
    if (!generation) throw new Error("生成任务不存在");
    if (generation.status !== "review") throw new Error(`该生成版本当前状态为 ${generation.status}，不能重复质检`);
    const latestForShot = generations.find((item) => item.shotId === generation.shotId);
    if (latestForShot?.id !== generation.id) throw new Error("只能质检该镜头的最新生成版本");
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
      const accepted = review.decision === "accepted" || review.decision === "conditional-pass";
      const jobStatus: ImportedGeneration["status"] = accepted
        ? "accepted"
        : review.decision === "manual-fix" ? "review" : "failed";
      const updatedGeneration = importedGenerationSchema.parse({ ...generation, status: jobStatus, updatedAt: now });
      await this.studio.db.update(generationJobs)
        .set({ status: jobStatus, payload: updatedGeneration })
        .where(eq(generationJobs.id, jobId));
      const shot = (await this.listShots(projectId)).find((item) => item.id === generation.shotId);
      if (!shot) throw new Error("生成任务对应镜头不存在");
      await this.setShotStatus(project, shot, accepted ? "accepted" : review.decision === "manual-fix" ? "generated" : "rejected");
      if (!accepted && review.decision !== "manual-fix" && project.currentStage === "GENERATION_REVIEW") {
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

  async renderRoughCut(projectId: string): Promise<{ project: Project; render: RenderRecord }> {
    let project = await this.requireProject(projectId);
    if (project.currentStage !== "GENERATION_REVIEW" && project.currentStage !== "EDITING") {
      throw new Error("只有生成质检完成后才能创建粗剪");
    }
    const mediaTools = await this.mediaToolchain.getStatus();
    if (!mediaTools.ffmpegAvailable || !mediaTools.ffprobeAvailable) {
      throw new Error("粗剪需要 FFmpeg 和 ffprobe；当前工具未就绪，未创建虚假成片");
    }
    const [shotList, generationList, existingRenders] = await Promise.all([
      this.listShots(projectId),
      this.listGenerations(projectId),
      this.listRenders(projectId),
    ]);
    const acceptedByShot = new Map<string, ImportedGeneration>();
    for (const shot of shotList) {
      const accepted = generationList
        .filter((item) => item.shotId === shot.id && item.status === "accepted")
        .sort((left, right) => right.generationVersion - left.generationVersion)[0];
      if (accepted) acceptedByShot.set(shot.id, accepted);
    }
    const missing = shotList.filter((shot) => !acceptedByShot.has(shot.id)).map((shot) => shot.id);
    if (!shotList.length || missing.length) {
      throw new Error(`所有镜头必须有已通过的生成版本；待完成：${missing.join("、") || "无镜头"}`);
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
      payload: render,
      createdAt: now,
      updatedAt: now,
    });
    if (project.currentStage === "GENERATION_REVIEW") {
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
      });
      const media = await this.mediaToolchain.probe(videoPath);
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
      project = await this.transition(project, "FINAL_REVIEW", "rough-cut.completed");
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
  ): Promise<{ project: Project; render: RenderRecord; approval: ApprovalRecord }> {
    let project = await this.requireProject(projectId);
    if (project.currentStage !== "FINAL_REVIEW") {
      throw new Error("只有成片终审阶段可以批准或驳回交付版本");
    }
    if (decision === "rejected" && !comment?.trim()) throw new Error("驳回成片时必须填写修改意见");
    const renderList = await this.listRenders(projectId);
    const current = renderList.find((item) => item.id === renderId);
    if (!current || current.status !== "review") throw new Error("只能审核当前待终审粗剪版本");
    if (renderList[0]?.id !== current.id) throw new Error("只能审核最新粗剪版本");
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
    project = await this.transition(
      project,
      decision === "approved" ? "DELIVERED" : "EDITING",
      decision === "approved" ? "delivery.approved" : "delivery.rejected",
    );
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

  async readRenderMedia(projectId: string, renderId: string): Promise<{ filePath: string; fileName: string }> {
    const project = await this.requireProject(projectId);
    const render = (await this.listRenders(projectId)).find((item) => item.id === renderId);
    if (!render) throw new Error("粗剪版本不存在");
    const filePath = render.deliveryVideoPath ?? render.videoPath;
    if (!isInside(project.projectDir, filePath)) throw new Error("粗剪视频路径越界");
    await fs.access(filePath);
    return { filePath, fileName: path.basename(filePath) };
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
    const [row] = await this.studio.db.select().from(projects).where(eq(projects.id, id)).limit(1);
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
