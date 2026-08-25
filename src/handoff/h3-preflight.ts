import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type { H3Capabilities, H3Preflight, H3ReferenceLabel } from "../shared/handoff-schemas";
import { h3PreflightSchema } from "../shared/handoff-schemas";
import type { Asset, ShotSpec } from "../shared/schemas";

const imageExtensions = new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp"]);
const videoExtensions = new Set([".mp4", ".mov", ".webm", ".mkv"]);
const audioExtensions = new Set([".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg"]);

export function referencedAssetIds(shot: ShotSpec): string[] {
  return [...new Set([shot.sceneId, ...shot.characterIds, ...shot.propIds, ...shot.styleIds])];
}

function classifyFile(filePath: string): H3ReferenceLabel["kind"] | null {
  const extension = path.extname(filePath).toLowerCase();
  if (imageExtensions.has(extension)) return "image";
  if (videoExtensions.has(extension)) return "video";
  if (audioExtensions.has(extension)) return "audio";
  return null;
}

export async function preflightH3Shot(
  shot: ShotSpec,
  assets: Asset[],
  capabilities: H3Capabilities,
  aspectRatio: string,
): Promise<H3Preflight> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const requiredIds = referencedAssetIds(shot);
  const assetsById = new Map(assets.map((asset) => [asset.id, asset]));
  const requiredAssets = requiredIds.flatMap((id) => {
    const asset = assetsById.get(id);
    if (!asset) errors.push(`${shot.id} 引用了不存在的资产 ${id}`);
    return asset ? [asset] : [];
  });

  if (shot.status !== "approved") errors.push(`${shot.id} 尚未批准`);
  for (const asset of requiredAssets) {
    if (!asset.approved) errors.push(`资产 ${asset.id} 尚未批准`);
  }
  if (shot.durationSec < capabilities.durationMinSec || shot.durationSec > capabilities.durationMaxSec) {
    errors.push(`H3 单镜头时长必须为 ${capabilities.durationMinSec}–${capabilities.durationMaxSec} 秒，当前为 ${shot.durationSec} 秒`);
  }
  if (!capabilities.aspectRatios.includes(aspectRatio)) {
    errors.push(`画幅 ${aspectRatio} 不在已核实的 H3 画幅清单中`);
  }
  warnings.push(`生成清晰度不会写入 H3 提示词；创建镜头投递包时单独选择，并以 Updream 生产页实际选项为准。H3 资料中的默认短边 ${capabilities.defaultShortSide}px 只作能力参考，不是项目最低限制`);

  const references: H3ReferenceLabel[] = [];
  const counters = { image: 0, video: 0, audio: 0 };
  const seenFiles = new Set<string>();
  for (const asset of requiredAssets) {
    if (!asset.localFiles.length) warnings.push(`资产 ${asset.id} 目前只有逻辑定义，没有本地参考文件；将使用文字描述`);
    for (const [fileIndex, filePath] of asset.localFiles.entries()) {
      const resolved = path.resolve(filePath);
      if (seenFiles.has(resolved)) continue;
      seenFiles.add(resolved);
      const kind = classifyFile(resolved);
      if (!kind) {
        warnings.push(`资产 ${asset.id} 的文件类型未识别，未加入 H3 引用：${path.basename(resolved)}`);
        continue;
      }
      const exists = await fs.stat(resolved).then((value) => value.isFile()).catch(() => false);
      if (!exists) {
        errors.push(`资产 ${asset.id} 的本地文件不存在：${resolved}`);
        continue;
      }
      const bytes = await fs.readFile(resolved);
      const actualHash = createHash("sha256").update(bytes).digest("hex");
      if (!asset.sha256[fileIndex] || asset.sha256[fileIndex] !== actualHash) {
        errors.push(`资产 ${asset.id} 的本地文件哈希不匹配：${path.basename(resolved)}`);
        continue;
      }
      counters[kind] += 1;
      const label = kind === "image"
        ? `<Subject ${counters.image}>`
        : kind === "video"
          ? `<Video ${counters.video}>`
          : `<Audio ${counters.audio}>`;
      references.push({ assetId: asset.id, label, kind, filePath: resolved, role: `${asset.type} reference for ${shot.id}` });
    }
  }
  if (counters.image > capabilities.maxReferenceImages) errors.push(`参考图片 ${counters.image} 张，超过 H3 已核实上限 ${capabilities.maxReferenceImages} 张`);
  if (counters.video > capabilities.maxReferenceVideos) errors.push(`参考视频 ${counters.video} 个，超过 H3 已核实上限 ${capabilities.maxReferenceVideos} 个`);
  if (counters.audio > capabilities.maxReferenceAudioFiles) errors.push(`参考音频 ${counters.audio} 个，超过 H3 已核实上限 ${capabilities.maxReferenceAudioFiles} 个`);
  if (references.length > capabilities.maxMixedReferences) errors.push(`混合参考 ${references.length} 个，超过 H3 已核实上限 ${capabilities.maxMixedReferences} 个`);
  const mode = references.length ? "Ref2VA" : "T2VA";
  return h3PreflightSchema.parse({ passed: errors.length === 0, mode, errors, warnings, references });
}
