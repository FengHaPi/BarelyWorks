import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { and, desc, eq } from "drizzle-orm";
import { stringify as toYaml } from "yaml";
import type { StudioDatabase } from "../database/client";
import { approvals, artifacts, assets as assetRecords, projects, shots } from "../database/schema";
import {
  renderAssetBible,
  renderContinuityReport,
  renderOutline,
  renderScreenplay,
  renderShootingScript,
  renderStoryboard,
} from "../ai/artifact-renderers";
import type {
  AssetBible,
  AssetDesignMode,
  ContinuityReport,
  ShootingScript,
  Storyboard,
  StoryOutline,
  TextGenerationTrace,
  TextIntelligenceProvider,
} from "../ai/text-provider";
import { preflightH3Shot } from "../handoff/h3-preflight";
import { UpdreamPackageBuilder, type BootstrapSummary } from "../handoff/updream-package-builder";
import {
  generationCenterSchema,
  h3CapabilitiesSchema,
  h3PromptOutputSchema,
  type GenerationCenter,
  type HandoffPackageSummary,
} from "../shared/handoff-schemas";
import {
  assetBibleSchema,
  screenplaySchema,
  shootingScriptSchema,
  storyboardSchema,
  storyOutlineSchema,
} from "../shared/skill-schemas";
import {
  approvalRecordSchema,
  artifactSchema,
  assetSchema,
  createProjectInputSchema,
  projectSchema,
  shotSpecSchema,
  type ApprovalRecord,
  type Artifact,
  type ArtifactType,
  type Asset,
  type CreateProjectInput,
  type Project,
  type ProjectStage,
  type ShotSpec,
} from "../shared/schemas";
import {
  assertTransition,
  downstreamStages,
  initialStageBySourceType,
  nextStage,
  stageOrder,
} from "../workflow/state-machine";
import { ProviderSkillRegistry } from "../skills/provider-skill-registry";

const PROJECT_DIRECTORIES = [
  "source", "outline", "screenplay", "assets/characters", "assets/scenes", "assets/props",
  "assets/costumes", "assets/styles", "assets/audio", "assets/references", "shooting-script",
  "storyboard", "prompts", "handoff/updream/bootstrap", "handoff/updream/shots", "generated/inbox",
  "audio", "edit", "qa", "deliverables", "logs",
];

const reviewStageByType: Record<ArtifactType, ProjectStage> = {
  outline: "OUTLINE_REVIEW",
  screenplay: "SCREENPLAY_REVIEW",
  "asset-bible": "ASSET_BIBLE_REVIEW",
  "shooting-script": "SHOOTING_SCRIPT_REVIEW",
  storyboard: "STORYBOARD_REVIEW",
};

const artifactTypeByReviewStage: Partial<Record<ProjectStage, ArtifactType>> = Object.fromEntries(
  Object.entries(reviewStageByType).map(([type, stage]) => [stage, type]),
) as Partial<Record<ProjectStage, ArtifactType>>;

const artifactDirectoryByType: Record<ArtifactType, string> = {
  outline: "outline",
  screenplay: "screenplay",
  "asset-bible": "assets",
  "shooting-script": "shooting-script",
  storyboard: "storyboard",
};

const dependentArtifactTypes: Record<ArtifactType, ArtifactType[]> = {
  outline: ["screenplay", "asset-bible", "shooting-script", "storyboard"],
  screenplay: ["asset-bible", "shooting-script", "storyboard"],
  "asset-bible": ["shooting-script", "storyboard"],
  "shooting-script": ["storyboard"],
  storyboard: [],
};

const assetFolderByType: Record<Asset["type"], string> = {
  character: "characters",
  scene: "scenes",
  prop: "props",
  costume: "costumes",
  style: "styles",
  audio: "audio",
  reference: "references",
};

const assetReferenceMimeExtensions: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};

const visualAssetTypes = new Set<Asset["type"]>(["character", "scene", "prop", "costume", "style", "reference"]);
const unresolvedVisualPattern = /(尚未确定|未确定|待定|未描述|具体[^，。；]*未知|需要补充|等待参考)/;

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function mapProjectRow(row: typeof projects.$inferSelect): Project {
  return projectSchema.parse({ ...row, sourceType: row.sourceType, currentStage: row.currentStage, staleStages: row.staleStages });
}

function mapArtifactRow(row: typeof artifacts.$inferSelect): Artifact {
  return artifactSchema.parse({ ...row, structuredPath: row.structuredPath ?? null, sourceArtifactId: row.sourceArtifactId ?? null });
}

function generationMetadata(trace: TextGenerationTrace, relatedTraces: TextGenerationTrace[] = []): Record<string, unknown> {
  const allSkills = [trace, ...relatedTraces].flatMap((item) => item.skills);
  const skills = [...new Map(allSkills.map((skill) => [`${skill.name}:${skill.sha256}`, skill])).values()];
  return {
    origin: trace.provider,
    schema: trace.schemaVersion,
    route: trace.route,
    skills,
    providerRun: {
      runId: trace.runId,
      threadId: trace.threadId,
      usage: trace.usage,
      durationMs: trace.durationMs ?? null,
      eventTypes: trace.eventTypes,
      completedAt: trace.completedAt,
    },
    relatedRuns: relatedTraces.map((item) => ({
      runId: item.runId,
      threadId: item.threadId,
      usage: item.usage,
      eventTypes: item.eventTypes,
      schema: item.schemaVersion,
      route: item.route,
      completedAt: item.completedAt,
    })),
  };
}

export interface ArtifactWithContent extends Artifact {
  content: string;
}

export class ProjectService {
  private readonly providerSkills: ProviderSkillRegistry;
  private readonly updreamPackages = new UpdreamPackageBuilder();

  constructor(
    private readonly studio: StudioDatabase,
    private readonly textProvider: TextIntelligenceProvider,
  ) {
    this.providerSkills = new ProviderSkillRegistry(studio.runtimeRoot);
  }

  async list(): Promise<Project[]> {
    const rows = await this.studio.db.select().from(projects).orderBy(desc(projects.updatedAt));
    return rows.map(mapProjectRow);
  }

  async get(id: string): Promise<Project | null> {
    const [row] = await this.studio.db.select().from(projects).where(eq(projects.id, id)).limit(1);
    return row ? mapProjectRow(row) : null;
  }

  async readSource(id: string): Promise<{ sourceText: string; sourcePath: string }> {
    const project = await this.requireProject(id);
    return { sourceText: await fs.readFile(project.sourcePath, "utf8"), sourcePath: project.sourcePath };
  }

  async create(rawInput: CreateProjectInput): Promise<Project> {
    const input = createProjectInputSchema.parse(rawInput);
    const id = randomUUID();
    const now = new Date().toISOString();
    const projectDir = path.join(this.studio.projectsRoot, id);
    if (!isInside(this.studio.projectsRoot, projectDir)) throw new Error("项目路径越界");

    await fs.mkdir(projectDir, { recursive: false });
    try {
      await Promise.all(PROJECT_DIRECTORIES.map((directory) => fs.mkdir(path.join(projectDir, directory), { recursive: true })));
      const sourcePath = path.join(projectDir, "source", "original-v001.txt");
      await fs.writeFile(sourcePath, input.sourceText, { encoding: "utf8", flag: "wx" });
      const project = projectSchema.parse({
        id,
        title: input.title,
        sourceType: input.sourceType,
        targetDurationSec: input.targetDurationSec,
        aspectRatio: input.aspectRatio,
        resolution: input.resolution,
        videoType: input.videoType ?? null,
        visualStyle: input.visualStyle ?? null,
        releasePlatform: input.releasePlatform ?? null,
        targetAudience: input.targetAudience ?? null,
        allowStorySuggestions: input.allowStorySuggestions,
        currentStage: initialStageBySourceType[input.sourceType],
        staleStages: [],
        sourcePath,
        projectDir,
        createdAt: now,
        updatedAt: now,
      });
      await this.studio.db.insert(projects).values(project);
      await this.writeProjectManifest(project);
      await this.appendLog(projectDir, "app.log.jsonl", { type: "project.created", projectId: id, sourceType: project.sourceType, createdAt: now });

      if (input.sourceType === "screenplay") {
        return (await this.createArtifactVersion(id, "screenplay", input.sourceText, { metadata: { origin: "imported-source" } })).project;
      }
      return project;
    } catch (error) {
      await fs.rm(projectDir, { recursive: true, force: true });
      throw error;
    }
  }

  async listArtifacts(projectId: string, type: ArtifactType): Promise<ArtifactWithContent[]> {
    await this.requireProject(projectId);
    const rows = await this.studio.db.select().from(artifacts)
      .where(and(eq(artifacts.projectId, projectId), eq(artifacts.type, type)))
      .orderBy(desc(artifacts.version));
    return Promise.all(rows.map(async (row) => ({ ...mapArtifactRow(row), content: await fs.readFile(row.filePath, "utf8") })));
  }

  async listAssets(projectId: string): Promise<Asset[]> {
    await this.requireProject(projectId);
    const rows = await this.studio.db.select().from(assetRecords).where(eq(assetRecords.projectId, projectId));
    const latestById = new Map<string, Asset>();
    for (const row of rows.sort((left, right) => right.version - left.version)) {
      if (latestById.has(row.id)) continue;
      latestById.set(row.id, assetSchema.parse({
        ...row.payload,
        id: row.id,
        projectId: row.projectId,
        type: row.type,
        name: row.name,
        version: row.version,
        approved: row.approved,
      }));
    }
    const currentShots = await this.listShots(projectId);
    return [...latestById.values()]
      .map((asset) => ({
        ...asset,
        referencedBy: currentShots
          .filter((shot) => [shot.sceneId, ...shot.characterIds, ...shot.propIds, ...shot.styleIds].includes(asset.id))
          .map((shot) => shot.id),
      }))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  async addAssetReferenceFile(projectId: string, assetId: string, input: {
    fileName: string;
    mimeType: string;
    dataBase64: string;
    role: string;
    authorizationConfirmed: true;
  }): Promise<Asset> {
    const project = await this.requireProject(projectId);
    if (project.currentStage !== "ASSET_BIBLE_REVIEW") throw new Error("只有资产定义待审核时才能添加参考图；请先重做资产定义版本");
    const [row] = await this.studio.db.select().from(assetRecords)
      .where(and(eq(assetRecords.projectId, projectId), eq(assetRecords.id, assetId)))
      .orderBy(desc(assetRecords.version)).limit(1);
    if (!row) throw new Error("资产不存在");
    const extension = assetReferenceMimeExtensions[input.mimeType];
    if (!extension) throw new Error("人物参考图仅支持 JPG、PNG 或 WebP");
    const bytes = Buffer.from(input.dataBase64, "base64");
    if (!bytes.length || bytes.length > 4 * 1024 * 1024) throw new Error("参考图必须小于 4 MB");
    const validMagic = input.mimeType === "image/png"
      ? bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      : input.mimeType === "image/jpeg"
        ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
        : bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
    if (!validMagic) throw new Error("参考图文件内容与格式不匹配");
    const current = assetSchema.parse({ ...row.payload, id: row.id, projectId: row.projectId, type: row.type, name: row.name, version: row.version, approved: row.approved });
    if (!visualAssetTypes.has(current.type)) throw new Error("该资产类型不支持图片参考");
    const destinationDirectory = path.join(project.projectDir, "assets", assetFolderByType[current.type], current.id, `v${String(current.version).padStart(3, "0")}`);
    const destinationPath = path.join(destinationDirectory, `${randomUUID()}${extension}`);
    if (!isInside(project.projectDir, destinationPath)) throw new Error("参考图路径越界");
    await fs.mkdir(destinationDirectory, { recursive: true });
    await fs.writeFile(destinationPath, bytes, { flag: "wx" });
    const digest = createHash("sha256").update(bytes).digest("hex");
    const updated = assetSchema.parse({
      ...current,
      localFiles: [...current.localFiles, destinationPath],
      sha256: [...current.sha256, digest],
      fileRoles: [...current.fileRoles, input.role],
      authorizationState: input.authorizationConfirmed ? "confirmed" : current.authorizationState,
      designBasis: "reference-guided",
      productionReady: current.type === "character" ? true : current.productionReady,
      designSummary: current.designSummary || `以已上传的${input.role}参考图为视觉身份基准。`,
      approved: false,
    });
    try {
      await this.studio.db.update(assetRecords).set({ payload: updated, approved: false })
        .where(and(eq(assetRecords.projectId, projectId), eq(assetRecords.id, assetId), eq(assetRecords.version, row.version)));
    } catch (error) {
      await fs.rm(destinationPath, { force: true });
      throw error;
    }
    await this.appendLog(project.projectDir, "workflow.log.jsonl", {
      type: "asset.reference.added", projectId, assetId, version: row.version, role: input.role,
      fileName: path.basename(destinationPath), sha256: digest, createdAt: new Date().toISOString(),
    });
    return updated;
  }

  async readAssetReferenceFile(projectId: string, assetId: string, index: number): Promise<{ filePath: string; fileName: string }> {
    const project = await this.requireProject(projectId);
    const asset = (await this.listAssets(projectId)).find((item) => item.id === assetId);
    if (!asset) throw new Error("资产不存在");
    const filePath = asset.localFiles[index];
    if (!filePath || !isInside(project.projectDir, filePath)) throw new Error("参考图不存在或路径无效");
    await fs.access(filePath);
    return { filePath, fileName: path.basename(filePath) };
  }

  async listShots(projectId: string): Promise<ShotSpec[]> {
    await this.requireProject(projectId);
    const rows = await this.studio.db.select().from(shots).where(eq(shots.projectId, projectId));
    return rows
      .map((row) => shotSpecSchema.parse({ ...row.payload, id: row.id, projectId: row.projectId, sequence: row.sequence, status: row.status }))
      .sort((left, right) => left.sequence - right.sequence);
  }

  async getGenerationCenter(projectId: string): Promise<GenerationCenter> {
    const project = await this.requireProject(projectId);
    const [capabilities, skills, bootstrap, assets, shotList] = await Promise.all([
      this.loadH3Capabilities(),
      this.providerSkills.loadMany(["h3-prompt-writing", "updream-handoff"]),
      this.updreamPackages.readBootstrap(project),
      this.listAssets(projectId),
      this.listShots(projectId),
    ]);
    const shotsWithStatus = await Promise.all(shotList.map(async (shot) => ({
      shot,
      preflight: await preflightH3Shot(shot, assets, capabilities, project.aspectRatio, project.resolution),
      packages: await this.updreamPackages.listShotPackages(project, shot.id),
    })));
    return generationCenterSchema.parse({
      project,
      capabilities,
      skills: skills.map((skill) => skill.provenance),
      bootstrap,
      assets,
      shots: shotsWithStatus,
    });
  }

  async lockAssets(projectId: string): Promise<Project> {
    const project = await this.requireProject(projectId);
    if (project.currentStage !== "STORYBOARD_APPROVED") throw new Error("只有分镜批准后才能锁定素材");
    const [storyboard, currentAssets, currentShots] = await Promise.all([
      this.latestApprovedArtifact(projectId, "storyboard"),
      this.listAssets(projectId),
      this.listShots(projectId),
    ]);
    if (!storyboard?.structuredPath) throw new Error("没有可用的已批准结构化分镜");
    if (!currentAssets.length || currentAssets.some((asset) => !asset.approved)) throw new Error("所有被使用的素材定义都必须先批准");
    if (!currentShots.length || currentShots.some((shot) => shot.status !== "approved")) throw new Error("所有 ShotSpec 都必须先批准");
    return this.transition(project, "ASSETS_LOCKED", "assets.locked");
  }

  async createUpdreamBootstrap(projectId: string): Promise<{ project: Project; bootstrap: BootstrapSummary }> {
    const project = await this.requireProject(projectId);
    if (!(["ASSETS_LOCKED", "READY_FOR_GENERATION"] as ProjectStage[]).includes(project.currentStage)) {
      throw new Error("必须先锁定素材，才能创建 Updream 初始化包");
    }
    const currentAssets = await this.listAssets(projectId);
    if (currentAssets.some((asset) => !asset.approved)) throw new Error("存在未批准素材，不能创建初始化包");
    const skill = await this.providerSkills.load("updream-handoff");
    const bootstrap = await this.updreamPackages.createBootstrap(project, currentAssets, skill.provenance);
    const updated = project.currentStage === "ASSETS_LOCKED"
      ? await this.transition(project, "READY_FOR_GENERATION", "updream.bootstrap.created")
      : project;
    await this.appendLog(project.projectDir, "handoff.log.jsonl", {
      type: "updream.bootstrap.ready", projectId, bootstrapPath: bootstrap.path,
      skill: skill.provenance, createdAt: new Date().toISOString(),
    });
    return { project: updated, bootstrap };
  }

  async createUpdreamShotPackage(projectId: string, shotId: string): Promise<{ project: Project; package: HandoffPackageSummary }> {
    const project = await this.requireProject(projectId);
    if (!(project.currentStage === "READY_FOR_GENERATION" || project.currentStage === "GENERATING")) {
      throw new Error("只有等待生成或重试生成阶段可以创建 Updream 镜头包");
    }
    if (!await this.updreamPackages.readBootstrap(project)) throw new Error("Updream 初始化包不存在");
    const [currentAssets, currentShots, storyboardArtifact, capabilities, providerSkills] = await Promise.all([
      this.listAssets(projectId),
      this.listShots(projectId),
      this.latestApprovedArtifact(projectId, "storyboard"),
      this.loadH3Capabilities(),
      this.providerSkills.loadMany(["h3-prompt-writing", "updream-handoff"]),
    ]);
    const shot = currentShots.find((item) => item.id === shotId);
    if (!shot) throw new Error("镜头不存在");
    if (!storyboardArtifact?.structuredPath) throw new Error("没有可用的已批准结构化分镜");
    const storyboard = storyboardSchema.parse(JSON.parse(await fs.readFile(storyboardArtifact.structuredPath, "utf8")));
    const storyboardShot = storyboard.shots.find((item) => item.shotId === shotId);
    if (!storyboardShot) throw new Error("已批准分镜中缺少该镜头");
    const preflight = await preflightH3Shot(shot, currentAssets, capabilities, project.aspectRatio, project.resolution);
    if (!preflight.passed) throw new Error(`H3 参数预检未通过：${preflight.errors.join("；")}`);
    const generated = await this.textProvider.generateH3Prompt({
      project,
      shot,
      storyboardShot,
      assets: currentAssets.filter((asset) => [shot.sceneId, ...shot.characterIds, ...shot.propIds, ...shot.styleIds].includes(asset.id)),
      mode: preflight.mode,
      referenceLabels: preflight.references,
    });
    const prompt = h3PromptOutputSchema.parse(generated.value);
    const packageSummary = await this.updreamPackages.createShotPackage({
      project, shot, assets: currentAssets, preflight, prompt, trace: generated.trace,
      skills: providerSkills.map((skill) => skill.provenance),
    });
    await this.appendLog(project.projectDir, "handoff.log.jsonl", {
      type: "updream.shot-package.created", projectId, shotId, version: packageSummary.version,
      path: packageSummary.path, mode: packageSummary.mode, createdAt: packageSummary.createdAt,
    });
    return { project, package: packageSummary };
  }

  async setAssetUploadState(projectId: string, assetId: string, state: "not-uploaded" | "uploaded"): Promise<Asset> {
    const project = await this.requireProject(projectId);
    if (stageOrder.indexOf(project.currentStage) < stageOrder.indexOf("ASSETS_LOCKED")) throw new Error("素材锁定后才能记录 Updream 上传状态");
    const rows = await this.studio.db.select().from(assetRecords)
      .where(and(eq(assetRecords.projectId, projectId), eq(assetRecords.id, assetId)))
      .orderBy(desc(assetRecords.version)).limit(1);
    const row = rows[0];
    if (!row) throw new Error("素材不存在");
    const asset = assetSchema.parse({ ...row.payload, id: row.id, projectId: row.projectId, type: row.type, name: row.name, version: row.version, approved: row.approved });
    const updated = assetSchema.parse({ ...asset, uploadState: { ...asset.uploadState, updream: state } });
    await this.studio.db.update(assetRecords).set({ payload: updated })
      .where(and(eq(assetRecords.projectId, projectId), eq(assetRecords.id, assetId), eq(assetRecords.version, row.version)));
    await this.appendLog(project.projectDir, "handoff.log.jsonl", {
      type: "updream.asset-upload-state.changed", projectId, assetId, state, createdAt: new Date().toISOString(),
    });
    return updated;
  }

  async setShotPackageUploadState(projectId: string, shotId: string, version: number, state: "not-uploaded" | "uploaded"): Promise<HandoffPackageSummary> {
    const project = await this.requireProject(projectId);
    if (!(project.currentStage === "READY_FOR_GENERATION" || project.currentStage === "GENERATING")) {
      throw new Error("当前阶段不能修改镜头投递状态");
    }
    const summary = await this.updreamPackages.setPackageUploadState(project, shotId, version, state);
    await this.appendLog(project.projectDir, "handoff.log.jsonl", {
      type: "updream.shot-upload-state.changed", projectId, shotId, version, state, createdAt: new Date().toISOString(),
    });
    return summary;
  }

  async readShotPackagePrompt(projectId: string, shotId: string, version: number): Promise<{ prompt: string; path: string }> {
    const project = await this.requireProject(projectId);
    return this.updreamPackages.readPrompt(project, shotId, version);
  }

  async updateShot(projectId: string, shotId: string, rawShot: unknown): Promise<{ project: Project; artifact: ArtifactWithContent; shot: ShotSpec }> {
    const project = await this.requireProject(projectId);
    this.assertArtifactRoute(project, "shooting-script");
    const replacement = shotSpecSchema.parse({ ...(rawShot as Record<string, unknown>), id: shotId, projectId, status: "draft" });
    const [latestRow] = await this.studio.db.select().from(artifacts)
      .where(and(eq(artifacts.projectId, projectId), eq(artifacts.type, "shooting-script")))
      .orderBy(desc(artifacts.version)).limit(1);
    if (!latestRow?.structuredPath) throw new Error("没有可编辑的结构化导演脚本");
    const current = shootingScriptSchema.parse(JSON.parse(await fs.readFile(latestRow.structuredPath, "utf8")));
    if (!current.shots.some((shot) => shot.id === shotId)) throw new Error("镜头不存在");
    const updatedScript = shootingScriptSchema.parse({
      ...current,
      shots: current.shots.map((shot) => shot.id === shotId ? replacement : shot),
    });
    const approvedAssetBible = await this.latestApprovedArtifact(projectId, "asset-bible");
    if (!approvedAssetBible?.structuredPath) throw new Error("没有可用于校验的已批准资产定义");
    const assetBible = assetBibleSchema.parse(JSON.parse(await fs.readFile(approvedAssetBible.structuredPath, "utf8")));
    this.assertShotAssetReferences(assetBible, updatedScript);
    const result = await this.createArtifactVersion(projectId, "shooting-script", renderShootingScript(updatedScript), {
      structured: updatedScript,
      sourceArtifactId: latestRow.id,
      metadata: { origin: "manual-shot-edit", editedShotId: shotId, basedOnArtifactId: latestRow.id },
    });
    await this.syncShotProjection(project, updatedScript);
    return { ...result, shot: replacement };
  }

  async createArtifactVersion(
    projectId: string,
    type: ArtifactType,
    content: string,
    options: { structured?: unknown; sourceArtifactId?: string | null; metadata?: Record<string, unknown> } = {},
  ): Promise<{ project: Project; artifact: ArtifactWithContent }> {
    const project = await this.requireProject(projectId);
    this.assertArtifactRoute(project, type);
    if (!(["outline", "screenplay"] as ArtifactType[]).includes(type) && options.structured === undefined) {
      throw new Error(`${type} 必须通过结构化编辑器或对应 Skill 创建`);
    }
    const existing = await this.studio.db.select().from(artifacts)
      .where(and(eq(artifacts.projectId, projectId), eq(artifacts.type, type)))
      .orderBy(desc(artifacts.version));
    const contentHash = createHash("sha256").update(content, "utf8").digest("hex");
    if (existing[0]?.contentHash === contentHash) {
      throw new Error("内容与当前最新版本完全相同，未创建重复版本");
    }
    const version = (existing[0]?.version ?? 0) + 1;
    const now = new Date().toISOString();
    const stem = `${type}-v${String(version).padStart(3, "0")}`;
    const artifactDirectory = artifactDirectoryByType[type];
    const filePath = path.join(project.projectDir, artifactDirectory, `${stem}.md`);
    const structuredPath = options.structured === undefined ? null : path.join(project.projectDir, artifactDirectory, `${stem}.json`);
    if (!isInside(project.projectDir, filePath) || (structuredPath && !isInside(project.projectDir, structuredPath))) throw new Error("产物路径越界");

    await fs.writeFile(filePath, content, { encoding: "utf8", flag: "wx" });
    try {
      if (structuredPath) await fs.writeFile(structuredPath, `${JSON.stringify(options.structured, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      const artifact = artifactSchema.parse({
        id: randomUUID(), projectId, type, version, filePath, structuredPath,
        contentHash,
        status: "draft", sourceArtifactId: options.sourceArtifactId ?? null, metadata: options.metadata ?? {}, createdAt: now, updatedAt: now,
      });
      await this.studio.db.update(artifacts).set({ status: "stale", updatedAt: now })
        .where(and(eq(artifacts.projectId, projectId), eq(artifacts.type, type)));
      for (const dependentType of dependentArtifactTypes[type]) {
        await this.studio.db.update(artifacts).set({ status: "stale", updatedAt: now })
          .where(and(eq(artifacts.projectId, projectId), eq(artifacts.type, dependentType)));
      }
      if (dependentArtifactTypes[type].includes("asset-bible")) {
        await this.studio.db.update(assetRecords).set({ approved: false }).where(eq(assetRecords.projectId, projectId));
      }
      if (dependentArtifactTypes[type].includes("shooting-script") || type === "shooting-script") {
        await this.studio.db.update(shots).set({ status: "stale" }).where(eq(shots.projectId, projectId));
      }
      await this.studio.db.insert(artifacts).values(artifact);
      const updatedProject = await this.moveToReview(project, type, artifact.id);
      return { project: updatedProject, artifact: { ...artifact, content } };
    } catch (error) {
      await Promise.all([fs.rm(filePath, { force: true }), structuredPath ? fs.rm(structuredPath, { force: true }) : Promise.resolve()]);
      throw error;
    }
  }

  async generateOutline(id: string): Promise<{ project: Project; artifact: ArtifactWithContent }> {
    const project = await this.requireProject(id);
    this.assertArtifactRoute(project, "outline");
    const sourceText = await fs.readFile(project.sourcePath, "utf8");
    const generated = await this.textProvider.generateOutline({ project, sourceText });
    const parsed = storyOutlineSchema.parse(generated.value);
    return this.createArtifactVersion(id, "outline", renderOutline(parsed), {
      structured: parsed,
      metadata: generationMetadata(generated.trace),
    });
  }

  async generateScreenplay(id: string): Promise<{ project: Project; artifact: ArtifactWithContent }> {
    const project = await this.requireProject(id);
    if (!(["OUTLINE_APPROVED", "SCREENPLAY_REVIEW"] as ProjectStage[]).includes(project.currentStage)) {
      throw new Error("必须先批准剧情大纲，才能生成影视剧本");
    }
    const approved = await this.latestApprovedArtifact(id, "outline");
    if (!approved) throw new Error("没有可用的已批准剧情大纲");
    const sourceText = await fs.readFile(project.sourcePath, "utf8");
    let approvedOutline: StoryOutline | string = await fs.readFile(approved.filePath, "utf8");
    if (approved.structuredPath) approvedOutline = storyOutlineSchema.parse(JSON.parse(await fs.readFile(approved.structuredPath, "utf8")));
    const generated = await this.textProvider.generateScreenplay({
      project,
      approvedOutline,
      approvedOutlineRef: `outline-v${String(approved.version).padStart(3, "0")}:${approved.contentHash}`,
      sourceText,
    });
    const screenplay = screenplaySchema.parse(generated.value);
    const existing = await this.listArtifacts(id, "screenplay");
    const versioned = screenplaySchema.parse({ ...screenplay, version: (existing[0]?.version ?? 0) + 1 });
    return this.createArtifactVersion(id, "screenplay", renderScreenplay(versioned), {
      structured: versioned,
      sourceArtifactId: approved.id,
      metadata: generationMetadata(generated.trace),
    });
  }

  async generateAssetBible(id: string, designMode: AssetDesignMode = "original-proposal"): Promise<{ project: Project; artifact: ArtifactWithContent }> {
    const project = await this.requireProject(id);
    this.assertArtifactRoute(project, "asset-bible");
    const approvedScreenplay = await this.latestApprovedArtifact(id, "screenplay");
    if (!approvedScreenplay) throw new Error("必须先批准影视剧本，才能生成资产定义");
    const sourceText = await fs.readFile(project.sourcePath, "utf8");
    const screenplay = approvedScreenplay.structuredPath
      ? screenplaySchema.parse(JSON.parse(await fs.readFile(approvedScreenplay.structuredPath, "utf8")))
      : await fs.readFile(approvedScreenplay.filePath, "utf8");
    const screenplayRef = `screenplay-v${String(approvedScreenplay.version).padStart(3, "0")}:${approvedScreenplay.contentHash}`;
    const generated = await this.textProvider.generateAssetBible({
      project,
      approvedScreenplay: screenplay,
      approvedScreenplayRef: screenplayRef,
      sourceText,
      designMode,
    });
    const assetBible = assetBibleSchema.parse(generated.value);
    const result = await this.createArtifactVersion(id, "asset-bible", renderAssetBible(assetBible), {
      structured: assetBible,
      sourceArtifactId: approvedScreenplay.id,
      metadata: { ...generationMetadata(generated.trace), inputArtifacts: [screenplayRef], designMode },
    });
    await this.syncAssetProjection(project, result.artifact.version, assetBible);
    return result;
  }

  async generateShootingScript(id: string): Promise<{ project: Project; artifact: ArtifactWithContent }> {
    const project = await this.requireProject(id);
    this.assertArtifactRoute(project, "shooting-script");
    const approvedScreenplay = await this.latestApprovedArtifact(id, "screenplay");
    const approvedAssetBible = await this.latestApprovedArtifact(id, "asset-bible");
    if (!approvedScreenplay || !approvedAssetBible?.structuredPath) {
      throw new Error("必须先批准影视剧本和资产定义，才能生成导演脚本");
    }
    const screenplay = approvedScreenplay.structuredPath
      ? screenplaySchema.parse(JSON.parse(await fs.readFile(approvedScreenplay.structuredPath, "utf8")))
      : await fs.readFile(approvedScreenplay.filePath, "utf8");
    const assetBible = assetBibleSchema.parse(JSON.parse(await fs.readFile(approvedAssetBible.structuredPath, "utf8")));
    const screenplayRef = `screenplay-v${String(approvedScreenplay.version).padStart(3, "0")}:${approvedScreenplay.contentHash}`;
    const assetBibleRef = `asset-bible-v${String(approvedAssetBible.version).padStart(3, "0")}:${approvedAssetBible.contentHash}`;
    const capabilities = await this.loadH3Capabilities();
    const generated = await this.textProvider.generateShootingScript({
      project,
      approvedScreenplay: screenplay,
      approvedScreenplayRef: screenplayRef,
      approvedAssetBible: assetBible,
      approvedAssetBibleRef: assetBibleRef,
      generationConstraints: {
        provider: capabilities.provider,
        model: capabilities.model,
        durationMinSec: capabilities.durationMinSec,
        durationMaxSec: capabilities.durationMaxSec,
        maxShotsForTargetDuration: Math.floor(project.targetDurationSec / capabilities.durationMinSec),
        taskGranularity: "one-shot-per-generation-task",
      },
    });
    const shootingScript = shootingScriptSchema.parse({
      ...generated.value,
      targetDurationSec: project.targetDurationSec,
      shots: generated.value.shots.map((shot) => ({ ...shot, projectId: project.id, status: "draft" })),
    });
    this.assertShotAssetReferences(assetBible, shootingScript);
    const result = await this.createArtifactVersion(id, "shooting-script", renderShootingScript(shootingScript), {
      structured: shootingScript,
      sourceArtifactId: approvedAssetBible.id,
      metadata: { ...generationMetadata(generated.trace), inputArtifacts: [screenplayRef, assetBibleRef] },
    });
    await this.syncShotProjection(project, shootingScript);
    return result;
  }

  async generateStoryboard(id: string): Promise<{ project: Project; artifact: ArtifactWithContent }> {
    const project = await this.requireProject(id);
    this.assertArtifactRoute(project, "storyboard");
    const approvedScreenplay = await this.latestApprovedArtifact(id, "screenplay");
    const approvedAssetBible = await this.latestApprovedArtifact(id, "asset-bible");
    const approvedShootingScript = await this.latestApprovedArtifact(id, "shooting-script");
    if (!approvedScreenplay || !approvedAssetBible?.structuredPath || !approvedShootingScript?.structuredPath) {
      throw new Error("必须先批准剧本、资产定义和导演脚本，才能生成分镜");
    }
    const screenplay = approvedScreenplay.structuredPath
      ? screenplaySchema.parse(JSON.parse(await fs.readFile(approvedScreenplay.structuredPath, "utf8")))
      : await fs.readFile(approvedScreenplay.filePath, "utf8");
    const assetBible = assetBibleSchema.parse(JSON.parse(await fs.readFile(approvedAssetBible.structuredPath, "utf8")));
    const shootingScript = shootingScriptSchema.parse(JSON.parse(await fs.readFile(approvedShootingScript.structuredPath, "utf8")));
    const shootingScriptRef = `shooting-script-v${String(approvedShootingScript.version).padStart(3, "0")}:${approvedShootingScript.contentHash}`;
    const assetBibleRef = `asset-bible-v${String(approvedAssetBible.version).padStart(3, "0")}:${approvedAssetBible.contentHash}`;
    const generated = await this.textProvider.generateStoryboard({
      project,
      approvedShootingScript: shootingScript,
      approvedShootingScriptRef: shootingScriptRef,
      approvedAssetBible: assetBible,
      approvedAssetBibleRef: assetBibleRef,
    });
    const storyboard = storyboardSchema.parse(generated.value);
    this.assertStoryboardCoverage(assetBible, shootingScript, storyboard);
    const continuity = await this.textProvider.reviewContinuity({
      project,
      approvedScreenplay: screenplay,
      approvedAssetBible: assetBible,
      approvedShootingScript: shootingScript,
      storyboard,
    });
    this.assertContinuityCoverage(shootingScript, continuity.value);
    const existing = await this.listArtifacts(id, "storyboard");
    const nextVersion = (existing[0]?.version ?? 0) + 1;
    const reportStem = `continuity-storyboard-v${String(nextVersion).padStart(3, "0")}`;
    const reportPath = path.join(project.projectDir, "qa", `${reportStem}.md`);
    const reportStructuredPath = path.join(project.projectDir, "qa", `${reportStem}.json`);
    if (!isInside(project.projectDir, reportPath) || !isInside(project.projectDir, reportStructuredPath)) throw new Error("连续性报告路径越界");
    await fs.writeFile(reportPath, renderContinuityReport(continuity.value), { encoding: "utf8", flag: "wx" });
    try {
      await fs.writeFile(reportStructuredPath, `${JSON.stringify(continuity.value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      return await this.createArtifactVersion(id, "storyboard", renderStoryboard(storyboard), {
        structured: storyboard,
        sourceArtifactId: approvedShootingScript.id,
        metadata: {
          ...generationMetadata(generated.trace, [continuity.trace]),
          inputArtifacts: [shootingScriptRef, assetBibleRef],
          continuityReportPath: reportPath,
          continuityReportStructuredPath: reportStructuredPath,
          continuityPassed: continuity.value.passed,
          continuityIssueCount: continuity.value.issues.length,
        },
      });
    } catch (error) {
      await Promise.all([fs.rm(reportPath, { force: true }), fs.rm(reportStructuredPath, { force: true })]);
      throw error;
    }
  }

  async startNextStage(id: string): Promise<Project> {
    const project = await this.requireProject(id);
    const target = nextStage(project.currentStage);
    if (!target || target.endsWith("_APPROVED") || target === "DELIVERED") throw new Error("当前阶段需要先审批或人工决策，不能自动推进");
    return this.transition(project, target, "stage.started");
  }

  async recordDecision(input: {
    projectId: string;
    stage: ProjectStage;
    decision: "approved" | "rejected";
    artifactId?: string;
    artifactPath?: string;
    artifactVersion?: number;
    comment?: string;
  }): Promise<{ project: Project; approval: ApprovalRecord }> {
    const project = await this.requireProject(input.projectId);
    if (project.currentStage !== input.stage) throw new Error(`项目当前阶段为 ${project.currentStage}，不能审批 ${input.stage}`);
    if (!input.stage.endsWith("_REVIEW")) throw new Error("只有 REVIEW 阶段可以审批");

    const managedType: ArtifactType | null = artifactTypeByReviewStage[input.stage] ?? null;
    let managedArtifact: Artifact | null = null;
    let artifactPath: string;
    let artifactVersion: number;
    if (managedType) {
      if (!input.artifactId) throw new Error("必须选择要审批的产物版本");
      const [row] = await this.studio.db.select().from(artifacts).where(eq(artifacts.id, input.artifactId)).limit(1);
      if (!row || row.projectId !== project.id || row.type !== managedType) throw new Error("审批产物与当前阶段不匹配");
      const [latest] = await this.studio.db.select().from(artifacts)
        .where(and(eq(artifacts.projectId, project.id), eq(artifacts.type, managedType)))
        .orderBy(desc(artifacts.version)).limit(1);
      if (!latest || latest.id !== row.id) throw new Error("只能审批当前最新版本");
      managedArtifact = mapArtifactRow(row);
      if (managedArtifact.status !== "draft") {
        if (managedArtifact.status === "rejected") throw new Error("该版本已被驳回，必须修改或重新生成新版本后才能审批");
        throw new Error(`该版本当前状态为 ${managedArtifact.status}，不能重复审批`);
      }
      if (input.decision === "rejected" && !input.comment?.trim()) {
        throw new Error("驳回时必须填写修改意见");
      }
      if (input.decision === "approved" && managedType === "storyboard" && managedArtifact.metadata.continuityPassed !== true) {
        throw new Error("连续性检查尚未通过，不能批准当前分镜版本");
      }
      if (input.decision === "approved" && managedType === "asset-bible") {
        const readinessIssues = await this.assetReadinessIssues(project, await this.listAssets(project.id));
        if (readinessIssues.length) {
          throw new Error(`资产定义不能批准：仍有 ${readinessIssues.length} 项制作缺口。${readinessIssues.slice(0, 8).join("；")}。请选择原创完整设定重新生成，或上传参考图后再批准。`);
        }
      }
      if (input.decision === "approved" && managedType === "shooting-script") {
        const [currentShots, capabilities] = await Promise.all([this.listShots(project.id), this.loadH3Capabilities()]);
        const incompatible = currentShots.filter((shot) => shot.durationSec < capabilities.durationMinSec || shot.durationSec > capabilities.durationMaxSec);
        if (incompatible.length) {
          const details = incompatible.map((shot) => `${shot.id}=${shot.durationSec}秒`).join("、");
          const maximum = Math.floor(project.targetDurationSec / capabilities.durationMinSec);
          throw new Error(`导演脚本不能批准：当前 H3 一镜一任务要求每镜 ${capabilities.durationMinSec}–${capabilities.durationMaxSec} 秒；不兼容镜头：${details}。${project.targetDurationSec} 秒项目最多建议 ${maximum} 镜，请驳回并重新生成。`);
        }
      }
      artifactPath = row.filePath;
      artifactVersion = row.version;
    } else {
      artifactPath = input.artifactPath ? path.resolve(project.projectDir, input.artifactPath) : project.sourcePath;
      artifactVersion = input.artifactVersion ?? 1;
    }
    if (!isInside(project.projectDir, artifactPath)) throw new Error("审批文件必须位于项目目录内");
    const artifactBytes = await fs.readFile(artifactPath);
    const currentHash = createHash("sha256").update(artifactBytes).digest("hex");
    if (managedArtifact && currentHash !== managedArtifact.contentHash) throw new Error("产物文件已在数据库外被修改，请另存为新版本后再审批");
    const approval = approvalRecordSchema.parse({
      id: randomUUID(), projectId: project.id, stage: input.stage, artifactPath, artifactHash: currentHash,
      artifactVersion, decision: input.decision, comment: input.comment ?? null, createdAt: new Date().toISOString(),
    });
    await this.studio.db.insert(approvals).values(approval);
    if (managedArtifact) {
      await this.studio.db.update(artifacts).set({ status: input.decision, updatedAt: approval.createdAt }).where(eq(artifacts.id, managedArtifact.id));
      if (managedType === "asset-bible") {
        await this.studio.db.update(assetRecords).set({ approved: input.decision === "approved" })
          .where(and(eq(assetRecords.projectId, project.id), eq(assetRecords.version, managedArtifact.version)));
      }
      if (managedType === "shooting-script") {
        await this.studio.db.update(shots).set({ status: input.decision === "approved" ? "approved" : "rejected" })
          .where(eq(shots.projectId, project.id));
      }
    }

    let updated = project;
    if (input.decision === "approved") {
      const target = nextStage(project.currentStage);
      if (!target || !target.endsWith("_APPROVED")) throw new Error("当前审核阶段没有对应的批准状态");
      updated = await this.transition(project, target, "stage.approved");
    } else {
      await this.appendLog(project.projectDir, "workflow.log.jsonl", {
        type: "stage.rejected", projectId: project.id, stage: project.currentStage, approvalId: approval.id,
        artifactId: managedArtifact?.id, createdAt: approval.createdAt,
      });
    }
    return { project: updated, approval };
  }

  private async syncAssetProjection(project: Project, version: number, assetBible: AssetBible): Promise<void> {
    await this.studio.db.update(assetRecords).set({ approved: false }).where(eq(assetRecords.projectId, project.id));
    for (const logical of assetBible.assets) {
      const asset = assetSchema.parse({
        ...logical,
        projectId: project.id,
        version,
        localFiles: [],
        sha256: [],
        approved: false,
        authorizationState: "unknown",
        uploadState: {},
        referencedBy: [],
        fileRoles: [],
      });
      await this.studio.db.insert(assetRecords).values({
        id: asset.id,
        projectId: asset.projectId,
        type: asset.type,
        name: asset.name,
        version: asset.version,
        payload: asset,
        approved: false,
      });
    }
  }

  private async syncShotProjection(project: Project, shootingScript: ShootingScript): Promise<void> {
    await this.studio.db.delete(shots).where(eq(shots.projectId, project.id));
    for (const candidate of shootingScript.shots) {
      const shot = shotSpecSchema.parse({ ...candidate, projectId: project.id, status: "draft" });
      await this.studio.db.insert(shots).values({
        id: shot.id,
        projectId: project.id,
        sequence: shot.sequence,
        payload: shot,
        status: shot.status,
      });
    }
  }

  private assertShotAssetReferences(assetBible: AssetBible, shootingScript: ShootingScript): void {
    const assetsById = new Map(assetBible.assets.map((asset) => [asset.id, asset]));
    const missing = new Set<string>();
    const typeErrors = new Set<string>();
    for (const shot of shootingScript.shots) {
      const references: Array<[string, Asset["type"]]> = [
        [shot.sceneId, "scene"],
        ...shot.characterIds.map((id) => [id, "character"] as [string, Asset["type"]]),
        ...shot.propIds.map((id) => [id, "prop"] as [string, Asset["type"]]),
        ...shot.styleIds.map((id) => [id, "style"] as [string, Asset["type"]]),
        ...shot.dialogue.map((line) => [line.speakerId, "character"] as [string, Asset["type"]]),
      ];
      for (const [id, expectedType] of references) {
        const asset = assetsById.get(id);
        if (!asset) missing.add(id);
        else if (asset.type !== expectedType) typeErrors.add(`${id} 应为 ${expectedType}，实际为 ${asset.type}`);
      }
    }
    if (missing.size) throw new Error(`导演脚本引用了不存在的资产：${[...missing].join("、")}`);
    if (typeErrors.size) throw new Error(`导演脚本资产类型不匹配：${[...typeErrors].join("；")}`);
  }

  private async assetReadinessIssues(project: Project, currentAssets: Asset[]): Promise<string[]> {
    const issues: string[] = [];
    for (const asset of currentAssets) {
      if (!visualAssetTypes.has(asset.type)) continue;
      const hasReference = asset.localFiles.length > 0 && asset.sha256.length === asset.localFiles.length;
      if (!asset.productionReady && !hasReference) {
        issues.push(`${asset.id} ${asset.name} 尚未形成可制作视觉设定`);
        continue;
      }
      if (hasReference) {
        for (const [index, filePath] of asset.localFiles.entries()) {
          if (!isInside(project.projectDir, filePath)) {
            issues.push(`${asset.id} 参考图路径不在项目目录内`);
            continue;
          }
          const bytes = await fs.readFile(filePath).catch(() => null);
          if (!bytes) issues.push(`${asset.id} 参考图不存在`);
          else if (createHash("sha256").update(bytes).digest("hex") !== asset.sha256[index]) issues.push(`${asset.id} 参考图哈希已变化`);
        }
        continue;
      }
      if (asset.designSummary.trim().length < 20) issues.push(`${asset.id} 缺少可执行的视觉摘要`);
      if (asset.appearance.trim().length < 30 || unresolvedVisualPattern.test(asset.appearance)) issues.push(`${asset.id} 外观仍是占位或过于简略`);
      if (asset.distinctiveFeatures.filter((item) => item.trim()).length < 2) issues.push(`${asset.id} 至少需要两个固定识别特征`);
      if (asset.negativeConstraints.filter((item) => item.trim()).length < 1) issues.push(`${asset.id} 缺少禁止漂移约束`);
      const unresolvedCritical = asset.unknowns.some((item) => /(颜色|色板|服装|头饰|发型|面部|脸型|体型|身形|外貌|外观|形态|材质|比例|光照|地貌)/.test(item));
      if (unresolvedCritical) issues.push(`${asset.id} 仍把关键可视信息留在未知项`);
    }
    return [...new Set(issues)];
  }

  private assertStoryboardCoverage(assetBible: AssetBible, shootingScript: ShootingScript, storyboard: Storyboard): void {
    const expected = shootingScript.shots.map((shot) => shot.id).sort();
    const actual = storyboard.shots.map((shot) => shot.shotId).sort();
    if (new Set(actual).size !== actual.length || expected.join("|") !== actual.join("|")) {
      throw new Error("分镜必须与已批准导演脚本保持一镜一项且镜头编号完全一致");
    }
    if (storyboard.shots.some((shot) => shot.approved)) {
      throw new Error("新生成分镜不得伪造批准状态");
    }
    const assetIds = new Set(assetBible.assets.map((asset) => asset.id));
    for (const board of storyboard.shots) {
      const shot = shootingScript.shots.find((item) => item.id === board.shotId);
      const required = new Set(shot ? [shot.sceneId, ...shot.characterIds, ...shot.propIds, ...shot.styleIds] : []);
      const boardAssets = new Set(board.requiredAssetIds);
      const missing = [...required].filter((id) => !boardAssets.has(id));
      const unknown = [...boardAssets].filter((id) => !assetIds.has(id));
      if (missing.length) throw new Error(`${board.shotId} 分镜缺少导演脚本资产：${missing.join("、")}`);
      if (unknown.length) throw new Error(`${board.shotId} 分镜引用未知资产：${unknown.join("、")}`);
      if (shot && (board.sceneId !== shot.sceneId || [...board.characterIds].sort().join("|") !== [...shot.characterIds].sort().join("|"))) {
        throw new Error(`${board.shotId} 分镜的人物或场景引用与导演脚本不一致`);
      }
    }
  }

  private assertContinuityCoverage(shootingScript: ShootingScript, report: ContinuityReport): void {
    const expected = shootingScript.shots.map((shot) => shot.id).sort();
    const checked = [...new Set(report.checkedShotIds)].sort();
    if (expected.join("|") !== checked.join("|")) {
      throw new Error("连续性报告必须覆盖全部已批准镜头");
    }
  }

  private assertArtifactRoute(project: Project, type: ArtifactType): void {
    const minimumIndex: Record<ArtifactType, number> = {
      outline: stageOrder.indexOf("SOURCE_IMPORTED"),
      screenplay: stageOrder.indexOf("OUTLINE_APPROVED"),
      "asset-bible": stageOrder.indexOf("SCREENPLAY_APPROVED"),
      "shooting-script": stageOrder.indexOf("ASSET_BIBLE_APPROVED"),
      storyboard: stageOrder.indexOf("SHOOTING_SCRIPT_APPROVED"),
    };
    if (stageOrder.indexOf(project.currentStage) < minimumIndex[type]) {
      throw new Error(`当前 ${project.currentStage} 阶段不能新建 ${type} 版本`);
    }
  }

  private async latestApprovedArtifact(projectId: string, type: ArtifactType): Promise<Artifact | null> {
    const [row] = await this.studio.db.select().from(artifacts)
      .where(and(eq(artifacts.projectId, projectId), eq(artifacts.type, type), eq(artifacts.status, "approved")))
      .orderBy(desc(artifacts.version)).limit(1);
    return row ? mapArtifactRow(row) : null;
  }

  private async loadH3Capabilities() {
    const configPath = path.join(this.studio.runtimeRoot, "configs", "providers", "minimax-h3.json");
    return h3CapabilitiesSchema.parse(JSON.parse(await fs.readFile(configPath, "utf8")));
  }

  private async moveToReview(project: Project, type: ArtifactType, artifactId: string): Promise<Project> {
    const target = reviewStageByType[type];
    const oldIndex = stageOrder.indexOf(project.currentStage);
    const newlyStale = downstreamStages(target).filter((stage) => stageOrder.indexOf(stage) <= oldIndex);
    const staleStages = Array.from(new Set([...project.staleStages, ...newlyStale])).filter((stage) => stage !== target);
    const updatedAt = new Date().toISOString();
    await this.studio.db.update(projects).set({ currentStage: target, staleStages, updatedAt }).where(eq(projects.id, project.id));
    const updated = projectSchema.parse({ ...project, currentStage: target, staleStages, updatedAt });
    await this.writeProjectManifest(updated);
    await this.appendLog(project.projectDir, "workflow.log.jsonl", {
      type: "artifact.version.created", projectId: project.id, artifactId, artifactType: type,
      from: project.currentStage, to: target, invalidatedStages: newlyStale, createdAt: updatedAt,
    });
    return updated;
  }

  private async transition(project: Project, target: ProjectStage, event: string): Promise<Project> {
    assertTransition(project.currentStage, target);
    const updatedAt = new Date().toISOString();
    const staleStages = project.staleStages.filter((stage) => stage !== project.currentStage && stage !== target);
    await this.studio.db.update(projects).set({ currentStage: target, staleStages, updatedAt }).where(eq(projects.id, project.id));
    const updated = projectSchema.parse({ ...project, currentStage: target, staleStages, updatedAt });
    await this.writeProjectManifest(updated);
    await this.appendLog(project.projectDir, "workflow.log.jsonl", { type: event, projectId: project.id, from: project.currentStage, to: target, createdAt: updatedAt });
    return updated;
  }

  private async requireProject(id: string): Promise<Project> {
    const project = await this.get(id);
    if (!project) throw new Error("项目不存在");
    return project;
  }

  private async writeProjectManifest(project: Project): Promise<void> {
    const manifestPath = path.join(project.projectDir, "project.yaml");
    const temporaryPath = `${manifestPath}.tmp`;
    await fs.writeFile(temporaryPath, toYaml(project), "utf8");
    await fs.rename(temporaryPath, manifestPath);
  }

  private async appendLog(projectDir: string, fileName: string, event: Record<string, unknown>): Promise<void> {
    await fs.appendFile(path.join(projectDir, "logs", fileName), `${JSON.stringify(event)}\n`, "utf8");
  }
}
