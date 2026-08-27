import { describe, expect, it } from "vitest";
import { buildH3ExecutionBrief } from "../src/handoff/h3-execution-brief";
import { shotSpecSchema, type Asset } from "../src/shared/schemas";

const projectId = "11111111-1111-4111-8111-111111111111";

describe("H3 execution brief", () => {
  it("keeps only paid-generation facts instead of forwarding the complete director payload", () => {
    const shot = shotSpecSchema.parse({
      id: "S001", projectId, sequence: 1, startTimeSec: 0, endTimeSec: 8, durationSec: 8,
      purpose: "人物接到电话后发现门外异常",
      characterIds: ["CHAR-001"], sceneId: "SCENE-001", propIds: ["PROP-001"], styleIds: ["STYLE-001"],
      shotSize: "中景",
      camera: { position: "人物后侧", movement: "一次横移", lens: "35mm", composition: "人物偏左" },
      action: "0至3秒，人物进入并接听电话。3至6秒，她看向门口。6至8秒，门打开并露出异常空间。",
      dialogue: [{ speakerId: "CHAR-001", text: "谁在那里？", language: "Chinese" }],
      sound: ["0至8秒保持低声环境底噪。"],
      startState: "门关闭。", endState: "门已打开。", status: "approved",
      physicalPlan: {
        schemaVersion: "shot-physical-plan-v1",
        cameraContinuityMode: "single-take",
        spaceTopology: {
          spaces: [{ spaceId: "room", label: "门内房间" }],
          boundaries: [],
        },
        applicability: { displaySurfaces: true, reflectiveSurfaces: false, delayedStateChanges: true },
        entities: [
          { instanceId: "person", assetId: "CHAR-001", domain: "real-space", role: "现实人物" },
          { instanceId: "phone", assetId: "PROP-001", domain: "real-space", role: "人物正常阅读的手机" },
        ],
        cameraSegments: [
          { startOffsetSec: 0, endOffsetSec: 4, viewpoint: "over-shoulder", screenDirection: "越肩建立", spaceId: "room", positionAnchor: "人物左后肩", lookAt: "人物与手机", transitionFromPrevious: "initial", boundaryId: null },
          { startOffsetSec: 4, endOffsetSec: 8, viewpoint: "profile", screenDirection: "横移到门口", spaceId: "room", positionAnchor: "人物左侧门内", lookAt: "人物与门", transitionFromPrevious: "continuous", boundaryId: null, transitionPath: "沿人物身后半步横移到左侧，不绕到门外" },
        ],
        subjectOrientations: [{
          startOffsetSec: 0, endOffsetSec: 8, instanceId: "person",
          bodyFaces: "门口", headFaces: "先看手机后看门口", gazeTarget: "手机和门口",
        }],
        displayRelations: [{
          startOffsetSec: 0, endOffsetSec: 4, propId: "PROP-001", holderInstanceId: "person",
          surfaceType: "single-sided", interactionMode: "user-reading", displayFaces: "holder",
          visibleToInstanceIds: ["person"], cameraReadable: true, readabilityMethod: "over-shoulder",
        }],
        reflectionRelations: [],
        timedStateGates: [
          { stateId: "door", startsAtOffsetSec: 6, beforeState: "门关闭", afterState: "门开始打开", noEarlyOccurrence: true },
        ],
        feasibilityNotes: ["摄影机不穿越门体。"],
      },
    });
    const asset = {
      id: "CHAR-001", projectId, type: "character", name: "主角", version: 1, localFiles: [], sha256: [], approved: true,
      authorizationState: "not-required", uploadState: {}, referencedBy: ["S001"], identity: "唯一主角",
      appearance: "黑发灰衣", designBasis: "source-grounded", productionReady: true, designSummary: "主角",
      distinctiveFeatures: ["黑发", "灰衣", "左眉痣", "不应继续传入第四项"], negativeConstraints: ["不换脸"], fileRoles: [],
      referencePrompts: [], referenceBaseline: null, continuityRules: ["保持身份", "保持服装", "保持发型", "不应继续传入第四项"], usage: [], sourceEvidence: [], unknowns: [],
    } satisfies Asset;
    const brief = buildH3ExecutionBrief({
      shot,
      assets: [asset],
      storyboardShot: {
        shotId: "S001", startFrame: "门关闭", endFrame: "门打开", composition: "人物偏左，门在中间",
        motionPlan: "一次横移", characterIds: ["CHAR-001"], sceneId: "SCENE-001",
        requiredAssetIds: ["CHAR-001", "SCENE-001", "PROP-001", "STYLE-001"], continuityRisks: [],
        physicalVerification: null, approved: false,
      },
    });

    expect(brief.visibleBeats).toHaveLength(3);
    expect(brief.cameraPhases).toHaveLength(2);
    expect(brief.cameraContinuityMode).toBe("single-take");
    expect(brief.cameraPhases[1]).toMatchObject({ spaceId: "room", transitionFromPrevious: "continuous", transitionPath: "沿人物身后半步横移到左侧，不绕到门外" });
    expect(brief.referencedAssets[0].fixedFeatures).toHaveLength(3);
    expect(brief.referencedAssets[0].constraints).toHaveLength(3);
    expect(JSON.stringify(brief)).not.toContain("feasibilityNotes");
  });
});
