import type { Asset, AssetReferencePromptRecord } from "./types";

const typeLabels: Record<Asset["type"], string> = {
  character: "角色",
  scene: "场景",
  prop: "道具",
  costume: "服装",
  style: "风格",
  audio: "声音",
  reference: "参考",
};

export function assetDefinitionClipboardText(asset: Asset): string {
  return [
    `[${asset.id}] ${asset.name} · ${typeLabels[asset.type]}`,
    `身份：${asset.identity}`,
    `完整设定：${asset.appearance}`,
    `固定识别特征：${asset.distinctiveFeatures.join("；") || "无"}`,
    `禁止漂移：${asset.negativeConstraints.join("；") || "无"}`,
    `连续性：${asset.continuityRules.join("；") || "无"}`,
    `参考图：${asset.localFiles.length} 张`,
  ].join("\n");
}

export function assetCollectionClipboardText(assets: Asset[]): string {
  return assets.map(assetDefinitionClipboardText).join("\n\n---\n\n");
}

export function latestAssetPrompts(asset: Asset): AssetReferencePromptRecord[] {
  const latestByRole = new Map<string, AssetReferencePromptRecord>();
  for (const prompt of asset.referencePrompts) {
    const previous = latestByRole.get(prompt.role);
    if (!previous || prompt.version > previous.version) latestByRole.set(prompt.role, prompt);
  }
  return [...latestByRole.values()].sort((left, right) => left.role.localeCompare(right.role, "zh-CN"));
}

export function assetPromptCollectionClipboardText(assets: Asset[], includeEnglish = false): string {
  return assets.flatMap((asset) => latestAssetPrompts(asset).map((prompt) => [
    `[${asset.id}] ${asset.name} · ${prompt.role} · V${String(prompt.version).padStart(3, "0")}`,
    `中文提示词：${prompt.promptZh}`,
    ...(includeEnglish ? [`英文提示词：${prompt.promptEn}`] : []),
    `负面提示词：${prompt.negativePrompt}`,
  ].join("\n"))).join("\n\n---\n\n");
}
