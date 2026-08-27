import { describe, expect, it } from "vitest";
import { assetCollectionClipboardText, assetDefinitionClipboardText, assetPromptCollectionClipboardText, latestAssetPrompts } from "./asset-summary";
import type { Asset } from "./types";

const baseAsset: Asset = {
  id: "CHAR-001",
  projectId: "019c9a68-6d6e-7cf1-b9cc-0caa79d9887a",
  type: "character",
  name: "阿宁",
  version: 1,
  localFiles: ["character.png"],
  sha256: ["a".repeat(64)],
  approved: false,
  authorizationState: "confirmed",
  uploadState: {},
  referencedBy: [],
  identity: "现实中的阿宁本体",
  appearance: "锁骨黑发、冷灰蓝外套和黑色斜挎带。",
  designBasis: "reference-guided",
  productionReady: true,
  designSummary: "固定阿宁的面部、发型和深夜通勤服装。",
  distinctiveFeatures: ["左眉浅痣", "右侧外翘发尾"],
  negativeConstraints: ["不得改变发长"],
  fileRoles: ["主参考"],
  referencePrompts: [
    { id: "019c9a68-6d6e-7cf1-b9cc-0caa79d98871", schemaVersion: "asset-reference-prompt-v1", version: 1, assetId: "CHAR-001", role: "主参考", promptZh: "中".repeat(80), promptEn: "English prompt ".repeat(8), negativePrompt: "负面".repeat(20), compositionNotes: ["正面"], continuityLocks: ["脸型", "发型"], provider: "codex-cli", providerRunId: "run-1", createdAt: "2026-08-25T00:00:00.000Z" },
    { id: "019c9a68-6d6e-7cf1-b9cc-0caa79d98872", schemaVersion: "asset-reference-prompt-v1", version: 2, assetId: "CHAR-001", role: "主参考", promptZh: "新".repeat(80), promptEn: "Updated prompt ".repeat(8), negativePrompt: "不要".repeat(20), compositionNotes: ["全身"], continuityLocks: ["脸型", "服装"], provider: "codex-cli", providerRunId: "run-2", createdAt: "2026-08-25T00:01:00.000Z" },
  ],
  continuityRules: ["全片造型一致"],
  usage: [],
  sourceEvidence: [],
  unknowns: [],
};

describe("asset summary clipboard helpers", () => {
  it("formats one asset and an asset collection for direct copying", () => {
    expect(assetDefinitionClipboardText(baseAsset)).toContain("[CHAR-001] 阿宁 · 角色");
    expect(assetDefinitionClipboardText(baseAsset)).toContain("参考图：1 张");
    expect(assetCollectionClipboardText([baseAsset, { ...baseAsset, id: "SCENE-001", type: "scene", name: "电梯" }])).toContain("[SCENE-001] 电梯 · 场景");
  });

  it("keeps only the newest prompt for each role", () => {
    expect(latestAssetPrompts(baseAsset)).toHaveLength(1);
    expect(latestAssetPrompts(baseAsset)[0].version).toBe(2);
    const copied = assetPromptCollectionClipboardText([baseAsset]);
    expect(copied).toContain("主参考 · V002");
    expect(copied).not.toContain("V001");
    expect(copied).toContain("中文提示词：");
    expect(copied).toContain("负面提示词：");
    expect(copied).not.toContain("英文提示词：");
    expect(assetPromptCollectionClipboardText([baseAsset], true)).toContain("英文提示词：Updated prompt");
  });
});
