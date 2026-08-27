import { describe, expect, it } from "vitest";
import { inspectH3PromptExecutability, inspectShotModelExecutability } from "../src/shared/h3-executability";

describe("H3 model executability policy", () => {
  it("blocks an unexplained jump from outside to inside", () => {
    const issues = inspectShotModelExecutability({
      durationSec: 10,
      action: "人物从电梯门外进入轿厢，摄影机保持连续。",
      dialogue: [],
      sound: [],
      startState: "人物与摄影机在门外",
      endState: "人物与摄影机在轿厢内",
      physicalPlan: {
        cameraContinuityMode: "single-take",
        spaceTopology: {
          spaces: [{ spaceId: "hall", label: "电梯厅" }, { spaceId: "cab", label: "电梯轿厢" }],
          boundaries: [{ boundaryId: "door", fromSpaceId: "hall", toSpaceId: "cab", traversalAllowed: true, label: "电梯门槛" }],
        },
        applicability: { displaySurfaces: false, reflectiveSurfaces: false, delayedStateChanges: false },
        entities: [],
        cameraSegments: [
          { startOffsetSec: 0, endOffsetSec: 4, viewpoint: "rear", screenDirection: "门外跟随", spaceId: "hall", positionAnchor: "人物后方", lookAt: "人物", transitionFromPrevious: "initial", boundaryId: null },
          { startOffsetSec: 4, endOffsetSec: 10, viewpoint: "rear", screenDirection: "轿厢内跟随", spaceId: "cab", positionAnchor: "人物后方", lookAt: "人物", transitionFromPrevious: "continuous", boundaryId: null, transitionPath: "未经过门槛却直接改到轿厢内" },
        ],
        subjectOrientations: [], displayRelations: [], reflectionRelations: [], timedStateGates: [], feasibilityNotes: [],
      },
    } as never);
    expect(issues.map((issue) => issue.code)).toContain("H3_CAMERA_SPACE_TELEPORT");
  });

  it("accepts a continuous doorway crossing with explicit topology", () => {
    const issues = inspectShotModelExecutability({
      durationSec: 10,
      action: "人物与摄影机连续穿过电梯门槛进入轿厢。",
      dialogue: [], sound: [], startState: "门外", endState: "轿厢内",
      physicalPlan: {
        cameraContinuityMode: "single-take",
        spaceTopology: {
          spaces: [{ spaceId: "hall", label: "电梯厅" }, { spaceId: "cab", label: "电梯轿厢" }],
          boundaries: [{ boundaryId: "door", fromSpaceId: "hall", toSpaceId: "cab", traversalAllowed: true, label: "电梯门槛" }],
        },
        applicability: { displaySurfaces: false, reflectiveSurfaces: false, delayedStateChanges: false }, entities: [],
        cameraSegments: [
          { startOffsetSec: 0, endOffsetSec: 4, viewpoint: "rear", screenDirection: "门外跟随", spaceId: "hall", positionAnchor: "门外人物后方", lookAt: "人物", transitionFromPrevious: "initial", boundaryId: null },
          { startOffsetSec: 4, endOffsetSec: 10, viewpoint: "rear", screenDirection: "跨过门槛后继续跟随", spaceId: "cab", positionAnchor: "轿厢内人物后方", lookAt: "人物", transitionFromPrevious: "boundary-crossing", boundaryId: "door", transitionPath: "沿人物后方直线穿过电梯门槛进入轿厢" },
        ],
        subjectOrientations: [], displayRelations: [], reflectionRelations: [], timedStateGates: [], feasibilityNotes: [],
      },
    } as never);
    expect(issues.filter((issue) => issue.severity === "error")).toEqual([]);
  });

  it("rejects an overloaded physical plan before prompt generation", () => {
    const issues = inspectShotModelExecutability({
      durationSec: 15,
      action: "手机通话后看镜中复制体，门外是无缝相接的另一电梯，里面挤满复制体群体。",
      sound: [
        "AUDIO-002 00:00.000—00:13.800 持续机械底噪",
        "AUDIO-002 00:12.800 机械底噪迅速抽空",
      ],
      startState: "手机通话正常",
      endState: "复制体群体同步转头",
      physicalPlan: {
        applicability: { displaySurfaces: true, reflectiveSurfaces: true, delayedStateChanges: true },
        entities: [],
        cameraSegments: Array.from({ length: 5 }, (_, index) => ({ startOffsetSec: index * 3, endOffsetSec: (index + 1) * 3, viewpoint: "other", screenDirection: "连续" })),
        subjectOrientations: [],
        displayRelations: [{ startOffsetSec: 0, endOffsetSec: 15, propId: "PROP-001", holderInstanceId: "A", surfaceType: "single-sided", interactionMode: "user-reading", displayFaces: "holder", visibleToInstanceIds: ["A"], cameraReadable: false, readabilityMethod: "not-required" }],
        reflectionRelations: [],
        timedStateGates: Array.from({ length: 17 }, (_, index) => ({ stateId: `G${index}`, startsAtOffsetSec: index * 0.8, beforeState: "通话正常", afterState: index === 7 ? "手机通话冻结并出现绿色压缩块" : "状态变化", noEarlyOccurrence: true })),
        feasibilityNotes: ["两座轿厢直接无缝相接"],
      },
    } as never);
    expect(issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "H3_CAMERA_PHASE_OVERLOAD",
      "H3_EXACT_TIMING_OVERLOAD",
      "H3_HIGH_RISK_LAYER_OVERLOAD",
      "H3_INVISIBLE_SCREEN_DETAIL",
      "H3_SOUND_TIMELINE_CONFLICT",
    ]));
  });

  it("detects conflicts in an over-controlled delivery prompt", () => {
    const prompt = `00:00—01:20跟拍；01:20—02:90绕到右后；02:90—04:30横移；04:30—05:70滑入左后角；05:70—07:00推进；07:00—09:00后撤。摄影机不再正面读屏，仅从斜侧屏幕边缘经过，手机画面冻结并出现绿色压缩块。右墙是雾面金属镜，但镜中人物必须清楚辨认。群体最终只同步转头，随后同时抬头并转头。复制体先紧贴背部，之后继续贴近耳侧。\nAUDIO-002 00:00—13.80持续机械底噪\nAUDIO-002 12.80机械底噪抽空。`;
    const codes = inspectH3PromptExecutability(prompt, 15).map((issue) => issue.code);
    expect(codes).toEqual(expect.arrayContaining([
      "H3_PROMPT_CAMERA_OVERLOAD",
      "H3_PROMPT_INVISIBLE_DETAIL",
      "H3_PROMPT_REFLECTION_CLARITY_CONFLICT",
      "H3_PROMPT_GROUP_ACTION_CONFLICT",
      "H3_SOUND_TIMELINE_CONFLICT",
    ]));
  });

  it("requires the final prompt to preserve an approved single-take lock", () => {
    const missing = inspectH3PromptExecutability("人物从电梯门外进入轿厢，镜头跟随。", 8, { cameraContinuityMode: "single-take" });
    expect(missing.map((issue) => issue.code)).toContain("H3_PROMPT_SINGLE_TAKE_LOCK_MISSING");
    const valid = inspectH3PromptExecutability("全程连续单镜头、一镜到底、不切镜；人物与摄影机从门外连续穿过门槛进入轿厢。", 8, { cameraContinuityMode: "single-take" });
    expect(valid.filter((issue) => issue.severity === "error")).toEqual([]);
  });

  it("accepts a compact three-phase prompt", () => {
    const prompt = "0—4秒跟入电梯，人物在胸前正常阅读手机；4—9秒镜头横移至左后方，现实身后始终无人，镜中复制体出现；9—15秒门外无缝连接另一轿厢，约十个复制体身体不动，仅同步转头。机械底噪持续至12秒，随后抽空。";
    expect(inspectH3PromptExecutability(prompt, 15).filter((issue) => issue.severity === "error")).toEqual([]);
  });
});
