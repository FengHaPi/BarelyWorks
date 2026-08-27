import { describe, expect, it } from "vitest";
import { inspectPhysicalPlan, inspectPhysicalVerification, shotPhysicalPlanSchema } from "../src/shared/physical-plan";
import { shootingScriptSchema } from "../src/shared/skill-schemas";

function validPlan() {
  return shotPhysicalPlanSchema.parse({
    schemaVersion: "shot-physical-plan-v1",
    applicability: { displaySurfaces: true, reflectiveSurfaces: true, delayedStateChanges: true },
    entities: [
      { instanceId: "hero-real", assetId: "CHAR-001", domain: "real-space", role: "现实人物" },
      { instanceId: "friend-screen", assetId: "CHAR-002", domain: "screen-space", role: "屏幕内人物" },
      { instanceId: "hero-normal-reflection", assetId: "CHAR-001", domain: "reflection-only", role: "正常镜像" },
      { instanceId: "hero-mirror-double", assetId: "CHAR-001", domain: "reflection-only", role: "镜面独有复制体" },
    ],
    cameraSegments: [
      { startOffsetSec: 0, endOffsetSec: 7, viewpoint: "over-shoulder", screenDirection: "从人物左后肩观察人物与设备" },
      { startOffsetSec: 7, endOffsetSec: 9, viewpoint: "reflection-view", screenDirection: "镜面位于画面右侧并保留边界" },
    ],
    subjectOrientations: [
      { startOffsetSec: 0, endOffsetSec: 9, instanceId: "hero-real", bodyFaces: "前方", headFaces: "前方", gazeTarget: "先看设备后看镜面" },
    ],
    displayRelations: [
      { startOffsetSec: 0, endOffsetSec: 5, propId: "PROP-001", holderInstanceId: "hero-real", surfaceType: "single-sided", interactionMode: "user-reading", displayFaces: "holder", visibleToInstanceIds: ["hero-real"], cameraReadable: true, readabilityMethod: "over-shoulder" },
    ],
    reflectionRelations: [
      { surfaceId: "SCENE-001:right-mirror", normalReflectionPairs: [{ realInstanceId: "hero-real", reflectionInstanceId: "hero-normal-reflection" }], mirrorOnlyInstanceIds: ["hero-mirror-double"], realSpaceInstanceIds: ["hero-real"], boundaryVisibleInFrame: true },
    ],
    timedStateGates: [
      { stateId: "ceiling-light-flicker", startsAtOffsetSec: 4.3, beforeState: "顶灯稳定常亮", afterState: "顶灯开始闪烁", noEarlyOccurrence: true },
    ],
    feasibilityNotes: ["设备屏幕通过越肩机位读取，不翻转给镜头"],
  });
}

describe("global physical planning rules", () => {
  it("accepts an executable screen, mirror, and timed-state plan", () => {
    expect(inspectPhysicalPlan(validPlan(), 9, ["CHAR-001", "CHAR-002"], ["PROP-001"])).toEqual([]);
  });

  it("rejects turning a single-sided user-read display toward the camera", () => {
    const plan = validPlan();
    plan.displayRelations[0] = {
      ...plan.displayRelations[0],
      displayFaces: "camera",
      readabilityMethod: "intentional-presentation",
    };
    const codes = inspectPhysicalPlan(plan, 9, ["CHAR-001", "CHAR-002"], ["PROP-001"]).map((problem) => problem.code);
    expect(codes).toContain("PHYSICAL_DISPLAY_FACING_CONFLICT");
    expect(codes).toContain("PHYSICAL_DISPLAY_SINGLE_SIDE_IMPOSSIBLE");
    expect(codes).toContain("PHYSICAL_DISPLAY_PRESENTATION_CONFLICT");
  });

  it("rejects merging a mirror-only entity into real space or hiding the mirror boundary", () => {
    const plan = validPlan();
    plan.reflectionRelations[0] = {
      ...plan.reflectionRelations[0],
      realSpaceInstanceIds: ["hero-real", "hero-mirror-double"],
      boundaryVisibleInFrame: false,
    };
    const codes = inspectPhysicalPlan(plan, 9, ["CHAR-001", "CHAR-002"], ["PROP-001"]).map((problem) => problem.code);
    expect(codes).toContain("PHYSICAL_REFLECTION_DOMAIN_CONFLICT");
    expect(codes).toContain("PHYSICAL_REFLECTION_BOUNDARY_MISSING");
  });

  it("rejects unguarded early state changes", () => {
    const plan = validPlan();
    plan.timedStateGates[0].noEarlyOccurrence = false;
    expect(inspectPhysicalPlan(plan, 9, ["CHAR-001", "CHAR-002"], ["PROP-001"]).map((problem) => problem.code))
      .toContain("PHYSICAL_TIMED_GATE_EARLY_OCCURRENCE_UNGUARDED");
  });

  it("blocks a storyboard that marks an applicable physical check as failed", () => {
    expect(inspectPhysicalVerification(validPlan(), {
      cameraBlocking: "pass",
      displayGeometry: "fail",
      reflectionTopology: "pass",
      timedStateGates: "pass",
      notes: ["显示面方向与人物读取关系不成立"],
    }).map((problem) => problem.code)).toContain("PHYSICAL_DISPLAY_STORYBOARD_FAILED");
  });

  it("requires physicalPlan only for new shooting-script-v2 artifacts", () => {
    const legacyShot = {
      id: "S001",
      projectId: "019c9a68-6d6e-7cf1-b9cc-0caa79d9887a",
      sequence: 1,
      startTimeSec: 0,
      endTimeSec: 9,
      durationSec: 9,
      purpose: "测试",
      characterIds: ["CHAR-001"],
      sceneId: "SCENE-001",
      propIds: [],
      styleIds: [],
      shotSize: "中景",
      camera: { position: "平视", movement: "固定" },
      action: "人物站立",
      dialogue: [],
      sound: [],
      startState: "人物入画",
      endState: "人物仍在画面内",
      status: "draft",
    };
    expect(shootingScriptSchema.safeParse({ targetDurationSec: 9, shots: [legacyShot], validationNotes: [] }).success).toBe(true);
    expect(shootingScriptSchema.safeParse({ schemaVersion: "shooting-script-v2", targetDurationSec: 9, shots: [legacyShot], validationNotes: [] }).success).toBe(false);
  });
});
