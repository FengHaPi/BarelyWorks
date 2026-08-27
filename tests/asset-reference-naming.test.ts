import { describe, expect, it } from "vitest";
import { assetReferencePackageFileName, assetReferenceStorageFileName, safeAssetFileSegment } from "../src/shared/asset-reference-naming";
import type { Asset } from "../src/shared/schemas";

describe("asset reference naming", () => {
  it("keeps the prompt identity keys visible in stored reference names", () => {
    expect(assetReferenceStorageFileName({
      assetId: "CHAR-001",
      assetName: "阿宁（现实本体）",
      role: "主参考",
      version: 1,
      index: 0,
      extension: ".PNG",
      uniqueSuffix: "a1b2c3d4",
    })).toBe("CHAR-001_阿宁（现实本体）_主参考_V001_01_a1b2c3d4.png");
  });

  it("creates stable semantic package names even when the stored file is an old UUID", () => {
    const asset = {
      id: "SCENE-002",
      name: "门后的复制电梯空间",
      version: 3,
      localFiles: ["C:/project/assets/scenes/SCENE-002/v003/550e8400-e29b-41d4-a716-446655440000.webp"],
      fileRoles: ["主参考"],
    } as Asset;
    expect(assetReferencePackageFileName(asset, 0)).toBe("SCENE-002_门后的复制电梯空间_主参考_V003_01.webp");
  });

  it("removes path separators and Windows-invalid filename characters", () => {
    expect(safeAssetFileSegment("阿宁 / 镜中:本体?", "未命名")).toBe("阿宁_-_镜中-本体");
  });
});
