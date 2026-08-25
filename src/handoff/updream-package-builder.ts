import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { TextGenerationTrace } from "../ai/text-provider";
import { handoffPackageSummarySchema, type GenerationResolution, type H3Preflight, type H3PromptOutput, type HandoffPackageSummary } from "../shared/handoff-schemas";
import type { Asset, Project, ShotSpec } from "../shared/schemas";
import type { SkillProvenance } from "../skills/skill-registry";

const assetFolders: Record<Asset["type"], string> = {
  character: "characters", scene: "scenes", prop: "props", costume: "costumes",
  style: "styles", audio: "audio", reference: "references",
};

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

async function writeJsonExclusive(filePath: string, value: unknown): Promise<void> {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
}

export interface BootstrapSummary { path: string; createdAt: string; assetCount: number }

export class UpdreamPackageBuilder {
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
      for (const sourcePath of asset.localFiles) {
        const fileName = `${asset.id}_${path.basename(sourcePath)}`;
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
    const root = path.join(project.projectDir, "handoff", "updream", "shots", shotId);
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
      packages.push(handoffPackageSummarySchema.parse({
        shotId,
        version: Number(entry.name.slice(1)),
        path: packagePath,
        promptPath: path.join(packagePath, "prompt.txt"),
        createdAt: manifest.created_at,
        mode: manifest.mode,
        generationResolution: requestedSettings.generation_resolution ?? "platform-default",
        uploadState: upload.state,
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
  }): Promise<HandoffPackageSummary> {
    const root = path.join(input.project.projectDir, "handoff", "updream", "shots", input.shot.id);
    await fs.mkdir(root, { recursive: true });
    const existing = await this.listShotPackages(input.project, input.shot.id);
    const version = (existing[0]?.version ?? 0) + 1;
    const packagePath = path.join(root, `v${String(version).padStart(3, "0")}`);
    await fs.mkdir(path.join(packagePath, "references"), { recursive: true });
    const createdAt = new Date().toISOString();
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
        bootstrap_files: references.map((reference) => `${reference.assetId}_${path.basename(reference.filePath)}`),
      };
    });
    const manifest = {
      schema_version: "updream-shot-package-v1",
      project_id: input.project.id,
      shot_id: input.shot.id,
      package_version: version,
      created_at: createdAt,
      provider: "updream",
      model: "MiniMax H3",
      mode: input.prompt.mode,
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
    return handoffPackageSummarySchema.parse({ shotId: input.shot.id, version, path: packagePath, promptPath: path.join(packagePath, "prompt.txt"), createdAt, mode: input.prompt.mode, generationResolution: input.generationResolution, uploadState: "not-uploaded" });
  }

  async setPackageUploadState(project: Project, shotId: string, version: number, state: "not-uploaded" | "uploaded"): Promise<HandoffPackageSummary> {
    const packagePath = path.join(project.projectDir, "handoff", "updream", "shots", shotId, `v${String(version).padStart(3, "0")}`);
    const manifestPath = path.join(packagePath, "manifest.json");
    await fs.access(manifestPath);
    const statePath = path.join(packagePath, "upload-state.json");
    const temporaryPath = `${statePath}.tmp`;
    await fs.writeFile(temporaryPath, `${JSON.stringify({ state, updated_at: new Date().toISOString() }, null, 2)}\n`, "utf8");
    await fs.rename(temporaryPath, statePath);
    const packages = await this.listShotPackages(project, shotId);
    const result = packages.find((item) => item.version === version);
    if (!result) throw new Error("镜头包不存在");
    return result;
  }

  async readPrompt(project: Project, shotId: string, version: number): Promise<{ prompt: string; path: string }> {
    const promptPath = path.join(project.projectDir, "handoff", "updream", "shots", shotId, `v${String(version).padStart(3, "0")}`, "prompt.txt");
    return { prompt: await fs.readFile(promptPath, "utf8"), path: promptPath };
  }
}
