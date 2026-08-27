import { constants as fsConstants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { TextGenerationTrace } from "../ai/text-provider";
import { assetReferencePackageFileName } from "../shared/asset-reference-naming";
import {
  handoffPackageSummarySchema,
  handoffRequiredAssetSchema,
  type GenerationResolution,
  type H3Preflight,
  type H3PromptOutput,
  type HandoffPackageSummary,
  type HandoffRequiredAsset,
} from "../shared/handoff-schemas";
import type { Asset, Project, ShotSpec } from "../shared/schemas";
import { H3_EXECUTION_POLICY_VERSION } from "../shared/h3-executability";
import type { SkillProvenance } from "../skills/skill-registry";
import { WindowsFileClipboard, type FileClipboard } from "./file-clipboard";

const assetFolders: Record<Asset["type"], string> = {
  character: "characters", scene: "scenes", prop: "props", costume: "costumes",
  style: "styles", audio: "audio", reference: "references",
};

const shotIdPattern = /^S\d{3}$/;

function sha256Json(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function shotSpecFingerprint(shot: ShotSpec): string {
  const { status: _operationalStatus, ...generationContract } = shot;
  return sha256Json(generationContract);
}

export function legacyShotSpecFingerprints(shot: ShotSpec): string[] {
  return [...new Set([
    sha256Json(shot),
    sha256Json({ ...shot, status: "approved" }),
  ])];
}

export function bindHandoffPackageToShot(summary: HandoffPackageSummary, shot: ShotSpec): HandoffPackageSummary {
  const staleReasons: string[] = [];
  if (summary.requestedDurationSec == null) {
    staleReasons.push("历史投递包未记录目标时长");
  } else if (Math.abs(summary.requestedDurationSec - shot.durationSec) > 0.001) {
    staleReasons.push(`投递包绑定 ${summary.requestedDurationSec} 秒，当前镜头为 ${shot.durationSec} 秒`);
  }
  const validFingerprints = [shotSpecFingerprint(shot), ...legacyShotSpecFingerprints(shot)];
  if (!summary.sourceShotSpecHash) {
    staleReasons.push("历史投递包未绑定来源 ShotSpec 指纹");
  } else if (!validFingerprints.includes(summary.sourceShotSpecHash)) {
    staleReasons.push("来源 ShotSpec 的动作、机位或物理计划已经变化");
  }
  if (summary.promptPolicyVersion !== H3_EXECUTION_POLICY_VERSION) {
    staleReasons.push(`投递包未通过当前 AI 模型可执行性策略 ${H3_EXECUTION_POLICY_VERSION}`);
  }
  return { ...summary, isStale: staleReasons.length > 0, staleReasons };
}

function requireSafeShotId(value: string): string {
  if (
    !shotIdPattern.test(value)
    || value === "."
    || value === ".."
    || value.includes("..")
    || /[\\/]/.test(value)
    || path.isAbsolute(value)
  ) {
    throw new Error("镜头 ID 无效：必须使用 S001 形式，且不得包含路径分隔符、.. 或绝对路径");
  }
  return value;
}

function requireSafePackageVersion(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 999) {
    throw new Error("镜头包版本无效：必须为 1–999 的整数");
  }
  return value;
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function resolveShotRoot(project: Project, shotId: string): { shotId: string; root: string } {
  const safeShotId = requireSafeShotId(shotId);
  const root = path.resolve(project.projectDir, "handoff", "updream", "shots", safeShotId);
  if (!isInside(project.projectDir, root)) throw new Error("镜头包路径越界");
  return { shotId: safeShotId, root };
}

function resolveShotPackage(project: Project, shotId: string, version: number): {
  shotId: string;
  version: number;
  packagePath: string;
  manifestPath: string;
  promptPath: string;
  statePath: string;
} {
  const resolvedShot = resolveShotRoot(project, shotId);
  const safeVersion = requireSafePackageVersion(version);
  const packagePath = path.resolve(resolvedShot.root, `v${String(safeVersion).padStart(3, "0")}`);
  if (!isInside(resolvedShot.root, packagePath)) throw new Error("镜头包路径越界");
  return {
    shotId: resolvedShot.shotId,
    version: safeVersion,
    packagePath,
    manifestPath: path.join(packagePath, "manifest.json"),
    promptPath: path.join(packagePath, "prompt.txt"),
    statePath: path.join(packagePath, "upload-state.json"),
  };
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function detectPromptLanguage(prompt: string): "zh" | "en" | "mixed" {
  const hanCharacters = prompt.match(/[\u3400-\u9fff]/g)?.length ?? 0;
  const latinCharacters = prompt.match(/[A-Za-z]/g)?.length ?? 0;
  if (!hanCharacters) return "en";
  if (!latinCharacters || hanCharacters >= latinCharacters * 0.4) return "zh";
  return "mixed";
}

function normalizeRequiredAssets(value: unknown): HandoffRequiredAsset[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    const row = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
    return handoffRequiredAssetSchema.parse({
      assetId: row.asset_id,
      name: row.name,
      labels: row.labels,
      kinds: row.kinds,
      roles: row.roles,
      bootstrapFiles: row.bootstrap_files,
    });
  });
}

async function writeJsonExclusive(filePath: string, value: unknown): Promise<void> {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
}

export interface BootstrapSummary { path: string; createdAt: string; assetCount: number }

export interface CopiedMaterialSummary {
  count: number;
  files: Array<{ label: string; assetId: string; name: string; fileName: string }>;
}

export class UpdreamPackageBuilder {
  constructor(private readonly fileClipboard: FileClipboard = new WindowsFileClipboard()) {}

  async readBootstrap(project: Project): Promise<BootstrapSummary | null> {
    const bootstrapPath = path.join(project.projectDir, "handoff", "updream", "bootstrap");
    const indexPath = path.join(bootstrapPath, "asset-index.json");
    const index = await fs.readFile(indexPath, "utf8").then((content) => JSON.parse(content) as { created_at?: unknown; assets?: unknown[] }).catch(() => null);
    if (!index || typeof index.created_at !== "string" || !Array.isArray(index.assets)) return null;
    return { path: bootstrapPath, createdAt: index.created_at, assetCount: index.assets.length };
  }

  async createBootstrap(project: Project, assets: Asset[], skill: SkillProvenance): Promise<BootstrapSummary> {
    const existing = await this.readBootstrap(project);
    if (existing) return existing;
    const bootstrapPath = path.join(project.projectDir, "handoff", "updream", "bootstrap");
    await Promise.all([...new Set(Object.values(assetFolders))].map((folder) => fs.mkdir(path.join(bootstrapPath, folder), { recursive: true })));
    const rows: Array<Record<string, unknown>> = [];
    for (const asset of assets) {
      const packagedFiles: string[] = [];
      for (const [index, sourcePath] of asset.localFiles.entries()) {
        const fileName = assetReferencePackageFileName(asset, index);
        const relativePath = path.join(assetFolders[asset.type], fileName);
        const destination = path.join(bootstrapPath, relativePath);
        await fs.copyFile(sourcePath, destination, fsConstants.COPYFILE_EXCL);
        packagedFiles.push(relativePath.split(path.sep).join("/"));
      }
      rows.push({
        asset_id: asset.id,
        type: asset.type,
        name: asset.name,
        approval_status: asset.approved ? "approved" : "unapproved",
        upload_state: "not-uploaded",
        local_files: asset.localFiles,
        packaged_files: packagedFiles,
      });
    }
    const createdAt = new Date().toISOString();
    await writeJsonExclusive(path.join(bootstrapPath, "asset-index.json"), {
      schema_version: "updream-bootstrap-v1",
      project_id: project.id,
      created_at: createdAt,
      skill_provenance: skill,
      assets: rows,
    });
    const htmlRows = rows.map((row) => `<tr><td>${escapeHtml(String(row.asset_id))}</td><td>${escapeHtml(String(row.type))}</td><td>${escapeHtml(String(row.name))}</td><td>not-uploaded</td></tr>`).join("\n");
    await fs.writeFile(path.join(bootstrapPath, "asset-index.html"), `<!doctype html><meta charset="utf-8"><title>Updream asset index</title><style>body{font:14px system-ui;background:#0b0f19;color:#e8ecf7;padding:28px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #30384c;padding:9px;text-align:left}</style><h1>${escapeHtml(project.title)} · Updream 素材初始化</h1><table><thead><tr><th>ID</th><th>类型</th><th>名称</th><th>上传状态</th></tr></thead><tbody>${htmlRows}</tbody></table>`, { encoding: "utf8", flag: "wx" });
    await fs.writeFile(path.join(bootstrapPath, "upload-checklist.md"), [
      "# Updream 素材初始化清单", "", "- [ ] 人工登录 Updream", "- [ ] 新建或打开目标项目",
      "- [ ] 逐项上传 asset-index.html 中列出的本地文件", "- [ ] 在 AI Video Studio 中手动标记已上传素材",
      "", "> 创建本地包不代表任何文件已经上传。",
    ].join("\n"), { encoding: "utf8", flag: "wx" });
    return { path: bootstrapPath, createdAt, assetCount: assets.length };
  }

  async listShotPackages(project: Project, shotId: string): Promise<HandoffPackageSummary[]> {
    const resolvedShot = resolveShotRoot(project, shotId);
    const { root } = resolvedShot;
    const entries = await fs.readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? [] : Promise.reject(error));
    const packages: HandoffPackageSummary[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^v\d{3}$/.test(entry.name)) continue;
      const packagePath = path.join(root, entry.name);
      const manifest = JSON.parse(await fs.readFile(path.join(packagePath, "manifest.json"), "utf8")) as Record<string, unknown>;
      const requestedSettings = manifest.requested_settings && typeof manifest.requested_settings === "object"
        ? manifest.requested_settings as Record<string, unknown>
        : {};
      const upload = await fs.readFile(path.join(packagePath, "upload-state.json"), "utf8")
        .then((content) => JSON.parse(content) as { state?: unknown }).catch(() => ({ state: "not-uploaded" }));
      const prompt = (await fs.readFile(path.join(packagePath, "prompt.txt"), "utf8")).trim();
      packages.push(handoffPackageSummarySchema.parse({
        id: typeof manifest.package_id === "string" ? manifest.package_id : null,
        shotId: resolvedShot.shotId,
        version: Number(entry.name.slice(1)),
        path: packagePath,
        promptPath: path.join(packagePath, "prompt.txt"),
        createdAt: manifest.created_at,
        mode: manifest.mode,
        generationResolution: requestedSettings.generation_resolution ?? "platform-default",
        requestedDurationSec: typeof requestedSettings.duration_sec === "number" ? requestedSettings.duration_sec : null,
        sourceShotSpecHash: typeof manifest.source_shot_spec_hash === "string" ? manifest.source_shot_spec_hash : null,
        sourceStoryboardArtifactId: typeof manifest.source_storyboard_artifact_id === "string" ? manifest.source_storyboard_artifact_id : null,
        promptPolicyVersion: typeof manifest.prompt_policy_version === "string" ? manifest.prompt_policy_version : null,
        isStale: false,
        staleReasons: [],
        uploadState: upload.state,
        promptCharacterCount: prompt.length,
        promptLanguage: detectPromptLanguage(prompt),
        requiredAssets: normalizeRequiredAssets(manifest.required_assets),
      }));
    }
    return packages.sort((left, right) => right.version - left.version);
  }

  async createShotPackage(input: {
    project: Project;
    shot: ShotSpec;
    assets: Asset[];
    preflight: H3Preflight;
    prompt: H3PromptOutput;
    trace: TextGenerationTrace;
    skills: SkillProvenance[];
    generationResolution: GenerationResolution;
    sourceStoryboardArtifactId: string;
    promptOptimization?: {
      strategy: string;
      targetCharacters: number;
      originalCharacters: number;
      finalCharacters: number;
      referenceOccurrences: Record<string, number>;
    };
  }): Promise<HandoffPackageSummary> {
    const { root } = resolveShotRoot(input.project, input.shot.id);
    await fs.mkdir(root, { recursive: true });
    const existing = await this.listShotPackages(input.project, input.shot.id);
    const version = (existing[0]?.version ?? 0) + 1;
    const packagePath = resolveShotPackage(input.project, input.shot.id, version).packagePath;
    await fs.mkdir(path.join(packagePath, "references"), { recursive: true });
    const createdAt = new Date().toISOString();
    const packageId = randomUUID();
    const requiredIds = [...new Set([input.shot.sceneId, ...input.shot.characterIds, ...input.shot.propIds, ...input.shot.styleIds])];
    const assetsById = new Map(input.assets.map((asset) => [asset.id, asset]));
    const requiredAssets = requiredIds.map((assetId) => {
      const asset = assetsById.get(assetId);
      const references = input.preflight.references.filter((reference) => reference.assetId === assetId);
      return {
        asset_id: assetId,
        name: asset?.name ?? assetId,
        labels: references.map((reference) => reference.label),
        kinds: references.map((reference) => reference.kind),
        roles: references.map((reference) => reference.role),
        bootstrap_files: references.map((reference) => {
          const fileIndex = asset?.localFiles.findIndex((filePath) => path.resolve(filePath) === path.resolve(reference.filePath)) ?? -1;
          const fileName = asset && fileIndex >= 0
            ? assetReferencePackageFileName(asset, fileIndex)
            : `${reference.assetId}_${path.basename(reference.filePath)}`;
          return asset ? `${assetFolders[asset.type]}/${fileName}` : fileName;
        }),
      };
    });
    const requiredAssetSummaries = normalizeRequiredAssets(requiredAssets);
    const manifest = {
      schema_version: "updream-shot-package-v1",
      package_id: packageId,
      project_id: input.project.id,
      shot_id: input.shot.id,
      package_version: version,
      created_at: createdAt,
      provider: "updream",
      model: "MiniMax H3",
      mode: input.prompt.mode,
      source_shot_spec_hash: shotSpecFingerprint(input.shot),
      source_storyboard_artifact_id: input.sourceStoryboardArtifactId,
      prompt_policy_version: H3_EXECUTION_POLICY_VERSION,
      requested_settings: {
        duration_sec: input.shot.durationSec,
        aspect_ratio: input.project.aspectRatio,
        generation_resolution: input.generationResolution,
        output_resolution: input.project.resolution,
      },
      preflight: input.preflight,
      required_assets: requiredAssets,
      packaged_files: ["prompt.txt", "settings.json", "manifest.json", "upload-state.json", "upload-checklist.md", "reused-assets.md"],
      upload_state: "not-uploaded",
      skill_provenance: input.skills,
      codex_trace: input.trace,
      prompt_optimization: input.promptOptimization ?? null,
    };
    await fs.writeFile(path.join(packagePath, "prompt.txt"), `${input.prompt.prompt.trim()}\n`, { encoding: "utf8", flag: "wx" });
    await writeJsonExclusive(path.join(packagePath, "settings.json"), manifest.requested_settings);
    await writeJsonExclusive(path.join(packagePath, "manifest.json"), manifest);
    await writeJsonExclusive(path.join(packagePath, "upload-state.json"), { state: "not-uploaded", updated_at: createdAt });
    await fs.writeFile(path.join(packagePath, "reused-assets.md"), [
      "# 复用初始化素材", "", ...requiredAssets.map((asset) => asset.bootstrap_files.length
        ? `- ${asset.labels.join(" / ")} → ${asset.asset_id} → ${asset.bootstrap_files.map((file) => `bootstrap/${file}`).join(" / ")}`
        : `- ${asset.asset_id}（逻辑定义，通过提示词描述，无本地参考文件）`),
      requiredAssets.length ? "" : "- 本镜头没有资产引用。",
    ].join("\n"), { encoding: "utf8", flag: "wx" });
    await fs.writeFile(path.join(packagePath, "upload-checklist.md"), [
      `# ${input.shot.id} / v${String(version).padStart(3, "0")} 人工投递`, "",
      "- [ ] 在 Updream 中选择 MiniMax H3", `- [ ] 模式：${input.prompt.mode}`,
      `- [ ] 时长：${input.shot.durationSec} 秒`, `- [ ] 画幅：${input.project.aspectRatio}`,
      `- [ ] 本次生成清晰度：${input.generationResolution}（在 Updream 生产页选择，不写入提示词）`,
      `- [ ] 本地成片输出规格：${input.project.resolution}（仅用于粗剪与交付）`,
      "- [ ] 按 reused-assets.md 选择已上传素材", "- [ ] 粘贴 prompt.txt 全文", "- [ ] 人工检查参数后提交",
      "- [ ] 提交成功后回到 AI Video Studio 手动标记状态", "", "> 本文件不会自动提交任务，也不会产生付费调用。",
    ].join("\n"), { encoding: "utf8", flag: "wx" });
    return handoffPackageSummarySchema.parse({
      id: packageId,
      shotId: input.shot.id,
      version,
      path: packagePath,
      promptPath: path.join(packagePath, "prompt.txt"),
      createdAt,
      mode: input.prompt.mode,
      generationResolution: input.generationResolution,
      requestedDurationSec: input.shot.durationSec,
      sourceShotSpecHash: shotSpecFingerprint(input.shot),
      sourceStoryboardArtifactId: input.sourceStoryboardArtifactId,
      promptPolicyVersion: H3_EXECUTION_POLICY_VERSION,
      isStale: false,
      staleReasons: [],
      uploadState: "not-uploaded",
      promptCharacterCount: input.prompt.prompt.trim().length,
      promptLanguage: detectPromptLanguage(input.prompt.prompt),
      requiredAssets: requiredAssetSummaries,
    });
  }

  async setPackageUploadState(project: Project, shotId: string, version: number, state: "not-uploaded" | "uploaded"): Promise<HandoffPackageSummary> {
    const resolved = resolveShotPackage(project, shotId, version);
    await fs.access(resolved.manifestPath);
    const temporaryPath = `${resolved.statePath}.tmp`;
    await fs.writeFile(temporaryPath, `${JSON.stringify({ state, updated_at: new Date().toISOString() }, null, 2)}\n`, "utf8");
    await fs.rename(temporaryPath, resolved.statePath);
    const packages = await this.listShotPackages(project, resolved.shotId);
    const result = packages.find((item) => item.version === resolved.version);
    if (!result) throw new Error("镜头包不存在");
    return result;
  }

  async copyPackageMaterials(project: Project, shotId: string, version: number, label?: string): Promise<CopiedMaterialSummary> {
    const resolved = resolveShotPackage(project, shotId, version);
    const bootstrap = await this.readBootstrap(project);
    if (!bootstrap) throw new Error("Updream 初始化包不存在");
    const packages = await this.listShotPackages(project, resolved.shotId);
    const packageSummary = packages.find((item) => item.version === resolved.version);
    if (!packageSummary) throw new Error("镜头包不存在");
    const requested = packageSummary.requiredAssets.flatMap((asset) => asset.labels.map((assetLabel, index) => ({
      label: assetLabel,
      assetId: asset.assetId,
      name: asset.name,
      relativePath: asset.bootstrapFiles[index],
    }))).filter((item) => !label || item.label === label);
    if (label && !requested.length) throw new Error(`镜头包中没有素材标签 ${label}`);
    if (!requested.length) throw new Error("本镜头没有需要复制的本地素材文件");

    const unique = new Map<string, { label: string; assetId: string; name: string; fileName: string; filePath: string }>();
    for (const item of requested) {
      if (!item.relativePath) throw new Error(`素材 ${item.assetId} 缺少初始化包文件映射`);
      const filePath = path.resolve(bootstrap.path, item.relativePath);
      if (!isInside(bootstrap.path, filePath)) throw new Error(`素材 ${item.assetId} 的初始化包路径越界`);
      const stat = await fs.stat(filePath).catch(() => null);
      if (!stat?.isFile()) throw new Error(`素材文件不存在：${path.basename(filePath)}`);
      unique.set(filePath, { ...item, fileName: path.basename(filePath), filePath });
    }
    const files = [...unique.values()];
    await this.fileClipboard.copyFiles(files.map((item) => item.filePath));
    return { count: files.length, files: files.map(({ label: itemLabel, assetId, name, fileName }) => ({ label: itemLabel, assetId, name, fileName })) };
  }

  async readPrompt(project: Project, shotId: string, version: number): Promise<{ prompt: string; path: string }> {
    const resolved = resolveShotPackage(project, shotId, version);
    return { prompt: await fs.readFile(resolved.promptPath, "utf8"), path: resolved.promptPath };
  }
}
