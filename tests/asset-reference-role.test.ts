import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { preflightH3Shot } from "../src/handoff/h3-preflight";
import type { H3Capabilities } from "../src/shared/handoff-schemas";
import {
  allowedReferenceRoles,
  assertReferenceRoleAllowed,
  referenceRoleDirective,
  supportsImageReferences,
} from "../src/shared/asset-reference-role";
import { shotSpecSchema, type Asset } from "../src/shared/schemas";
import { createReferencePng } from "./fixtures/reference-image";

const projectId = "11111111-1111-4111-8111-111111111111";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

function asset(input: Partial<Asset> & Pick<Asset, "id" | "type" | "name">): Asset {
  return {
    id: input.id,
    projectId,
    type: input.type,
    name: input.name,
    version: 1,
    localFiles: input.localFiles ?? [],
    sha256: input.sha256 ?? [],
    approved: true,
    authorizationState: "confirmed",
    uploadState: {},
    referencedBy: ["S001"],
    identity: "已批准身份",
    appearance: "已批准外观",
    designBasis: "source-grounded",
    productionReady: true,
    designSummary: "已批准并可制作的视觉定义",
    distinctiveFeatures: ["固定轮廓", "固定色彩"],
    negativeConstraints: ["不得漂移"],
    fileRoles: input.fileRoles ?? [],
    referencePrompts: [],
    referenceBaseline: null,
    continuityRules: ["保持连续"],
    usage: ["S001"],
    sourceEvidence: ["测试"],
    unknowns: [],
  };
}

const shot = shotSpecSchema.parse({
  id: "S001",
  projectId,
  sequence: 1,
  startTimeSec: 0,
  endTimeSec: 5,
  durationSec: 5,
  purpose: "建立人物与场景",
  characterIds: ["CHAR-001"],
  sceneId: "SCENE-001",
  propIds: [],
  styleIds: [],
  shotSize: "中景",
  camera: { position: "正面", movement: "缓慢推进" },
  action: "人物站在房间内抬头。",
  dialogue: [],
  sound: ["室内环境声"],
  startState: "人物低头",
  endState: "人物抬头",
  physicalPlan: null,
  status: "approved",
});

const capabilities: H3Capabilities = {
  provider: "minimax",
  model: "MiniMax H3",
  modes: ["T2VA", "Ref2VA"],
  durationMinSec: 4,
  durationMaxSec: 10,
  aspectRatios: ["16:9"],
  defaultShortSide: 768,
  maxReferenceImages: 9,
  maxReferenceVideos: 1,
  maxReferenceAudioFiles: 1,
  maxMixedReferences: 9,
  supportsAudioInput: true,
  supportsReferenceVideo: true,
  verifiedAt: "2026-08-27T00:00:00.000Z",
  source: "https://example.com/h3",
};

describe("asset reference roles", () => {
  it("restricts roles by asset type and rejects image roles for audio", () => {
    expect(supportsImageReferences("audio")).toBe(false);
    expect(allowedReferenceRoles("style")).toEqual(["主参考", "其他"]);
    expect(allowedReferenceRoles("character")).toContain("表情");
    expect(() => assertReferenceRoleAllowed("audio", "主参考")).toThrow(/不支持图片参考/);
    expect(() => assertReferenceRoleAllowed("style", "表情")).toThrow(/不支持“表情”/);
    expect(referenceRoleDirective("服装")).toMatch(/不得覆盖脸部身份/);
  });

  it("uses T2VA without uploaded references", async () => {
    const result = await preflightH3Shot(shot, [
      asset({ id: "CHAR-001", type: "character", name: "人物" }),
      asset({ id: "SCENE-001", type: "scene", name: "房间" }),
    ], capabilities, "16:9");
    expect(result).toMatchObject({ passed: true, mode: "T2VA", references: [] });
    expect(result.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/只有逻辑定义/) ]));
  });

  it("preserves the selected role in Ref2VA and blocks an unlabelled image", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ai-video-role-"));
    temporaryDirectories.push(directory);
    const imagePath = path.join(directory, "face.png");
    const bytes = createReferencePng();
    await fs.writeFile(imagePath, bytes);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const scene = asset({ id: "SCENE-001", type: "scene", name: "房间" });

    const labelled = await preflightH3Shot(shot, [
      asset({ id: "CHAR-001", type: "character", name: "人物", localFiles: [imagePath], sha256: [digest], fileRoles: ["表情"] }),
      scene,
    ], capabilities, "16:9");
    expect(labelled).toMatchObject({ passed: true, mode: "Ref2VA" });
    expect(labelled.references[0]).toMatchObject({ assetId: "CHAR-001", role: "表情", kind: "image" });

    const unlabelled = await preflightH3Shot(shot, [
      asset({ id: "CHAR-001", type: "character", name: "人物", localFiles: [imagePath], sha256: [digest], fileRoles: [] }),
      scene,
    ], capabilities, "16:9");
    expect(unlabelled.passed).toBe(false);
    expect(unlabelled.errors).toEqual(expect.arrayContaining([expect.stringMatching(/没有参考角色/) ]));
  });
});
