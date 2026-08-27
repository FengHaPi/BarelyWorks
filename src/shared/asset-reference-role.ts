import type { Asset, AssetReferenceRole } from "./schemas";

export const assetReferenceRoles: AssetReferenceRole[] = ["主参考", "正面", "侧面", "背面", "表情", "服装", "其他"];

const visualAssetTypes = new Set<Asset["type"]>(["character", "scene", "prop", "costume", "style", "reference"]);

const rolesByAssetType: Record<Asset["type"], AssetReferenceRole[]> = {
  character: assetReferenceRoles,
  costume: ["主参考", "正面", "侧面", "背面", "服装", "其他"],
  scene: ["主参考", "正面", "侧面", "背面", "其他"],
  prop: ["主参考", "正面", "侧面", "背面", "其他"],
  style: ["主参考", "其他"],
  reference: ["主参考", "正面", "侧面", "背面", "其他"],
  audio: [],
};

const roleDescriptions: Record<AssetReferenceRole, string> = {
  主参考: "整体视觉基准；锁定身份、主体轮廓、主要材质与色彩，其他专项参考只覆盖自己的维度。",
  正面: "只补充正面可见特征与比例；不锁定镜头构图、姿势或动作。",
  侧面: "只补充侧面轮廓、纵深和侧向结构；不覆盖正面身份特征。",
  背面: "只补充背面轮廓、背部结构、后侧发型或服装细节。",
  表情: "只约束表情形态和情绪强度；不得覆盖人物身份、发型、服装或体型。",
  服装: "只约束服装版型、层次、材质、配色与配饰；不得覆盖脸部身份、动作或场景。",
  其他: "仅作补充证据；除资产文字定义明确说明外，不得覆盖主参考或专项参考。",
};

export function supportsImageReferences(assetType: Asset["type"]): boolean {
  return visualAssetTypes.has(assetType);
}

export function allowedReferenceRoles(assetType: Asset["type"]): AssetReferenceRole[] {
  return rolesByAssetType[assetType];
}

export function isReferenceRoleAllowed(assetType: Asset["type"], role: string): role is AssetReferenceRole {
  return rolesByAssetType[assetType].includes(role as AssetReferenceRole);
}

export function referenceRoleDescription(role: AssetReferenceRole): string {
  return roleDescriptions[role];
}

export function referenceRoleDirective(role: string): string {
  return roleDescriptions[role as AssetReferenceRole] ?? "这是未识别用途的补充素材，不得覆盖已批准的身份、造型与空间设定。";
}

export function assertReferenceRoleAllowed(assetType: Asset["type"], role: string): asserts role is AssetReferenceRole {
  if (!supportsImageReferences(assetType)) throw new Error("该资产类型不支持图片参考");
  if (!isReferenceRoleAllowed(assetType, role)) {
    throw new Error(`${assetType} 资产不支持“${role}”参考角色；允许：${allowedReferenceRoles(assetType).join("、")}`);
  }
}
