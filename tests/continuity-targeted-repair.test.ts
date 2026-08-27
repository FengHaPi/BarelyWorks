import { describe, expect, it } from "vitest";
import {
  MIRROR_PARITY_CONTINUITY_RULE,
  repairCausalRevealText,
  repairPropHandoffText,
  repairSoundTimingText,
  repairStoryboardContinuityIssues,
  type ContinuityIssue,
} from "../src/projects/project-service";
import { continuityRepairKindForIssue, isContinuityIssueRepairable } from "../src/shared/continuity-repair";
import type { Storyboard } from "../src/ai/text-provider";

const storyboard: Storyboard = {
  schemaVersion: "storyboard-v1",
  shots: [
    {
      shotId: "S001",
      startFrame: "阿宁站在近端轿厢内。",
      endFrame: "顶灯熄灭，手机画面冻结，绿色压缩块固定在右下角。",
      composition: "近端电梯右墙镜面与阿宁同框。",
      motionPlan: "0.0—8.0秒保持近端机位。",
      characterIds: ["CHAR-001", "CHAR-003"],
      sceneId: "SCENE-001",
      requiredAssetIds: ["CHAR-001", "CHAR-003", "SCENE-001"],
      continuityRisks: [],
      physicalVerification: null,
      approved: false,
    },
    {
      shotId: "S002",
      startFrame: "顶灯仍在闪烁，通话严重卡顿。",
      endFrame: "门后复制电梯完全显露。",
      composition: "摄影机仍在近端轿厢，门后出现第二部电梯。",
      motionPlan: "8.0—15.0秒向门后空间推进。",
      characterIds: ["CHAR-001", "CHAR-003"],
      sceneId: "SCENE-002",
      requiredAssetIds: ["CHAR-001", "CHAR-003", "SCENE-002"],
      continuityRisks: [],
      physicalVerification: null,
      approved: false,
    },
  ],
  globalContinuityNotes: [],
};

const issues: ContinuityIssue[] = [
  {
    severity: "error",
    code: "SECONDARY_SCENE_REFERENCE_MISSING",
    message: "S002近端空间仍属于SCENE-001。",
    affectedIds: ["S002", "SCENE-001", "SCENE-002", "CHAR-003"],
    suggestedFix: "保持sceneId为SCENE-002，在requiredAssetIds加入SCENE-001，并明确近端结构继续引用SCENE-001。",
    requiresReapproval: false,
  },
  {
    severity: "warning",
    code: "SHOT_BOUNDARY_FRAME_STATE_UNDERSPECIFIED",
    message: "S001尾帧与S002首帧没有逐项锁定。",
    affectedIds: ["S001", "S002"],
    suggestedFix: "把S001尾帧曝光、冻结帧及压缩块布局逐项复制到S002首帧。",
    requiresReapproval: false,
  },
  {
    severity: "warning",
    code: "MIRROR_PARITY_RULE_UNDEFINED",
    message: "镜中复制体的左右规则未定义。",
    affectedIds: ["CHAR-001", "CHAR-003", "COSTUME-001", "S001", "S002"],
    suggestedFix: "锁定正常镜面左右反转。",
    requiresReapproval: true,
  },
];

describe("targeted continuity repair", () => {
  it("recognizes the current report codes as repairable", () => {
    for (const issue of issues) expect(isContinuityIssueRepairable(issue.code)).toBe(true);
    expect(isContinuityIssueRepairable("LIGHT_SOUND_SYNC_TIMECODE_CONFLICT")).toBe(true);
    expect(isContinuityIssueRepairable("CHARACTER_ORIENTATION_STATE_CONFLICT")).toBe(true);
    expect(isContinuityIssueRepairable("ASSET_VERSION_LOCK_UNVERIFIABLE")).toBe(true);
    expect(isContinuityIssueRepairable("PHYSICAL_TIMED_GATE_EARLY_REVEAL")).toBe(true);
    expect(isContinuityIssueRepairable("PROP_POSITION_HANDOFF_DISCONTINUITY")).toBe(true);
    expect(isContinuityIssueRepairable("PHYSICAL_TIMED_GATE_STORYBOARD_FAILED")).toBe(true);
    expect(isContinuityIssueRepairable("UNSUPPORTED_CREATIVE_DECISION")).toBe(false);
  });

  it("routes unknown actionable reports by repair scope instead of requiring a new code whitelist entry", () => {
    const storyboardIssue: ContinuityIssue = {
      severity: "error",
      code: "PHYSICAL_CAMERA_STARTFRAME_VISIBILITY_CONTRADICTION",
      message: "起始帧声称镜头后方可见。",
      affectedIds: ["S001"],
      suggestedFix: "删除起始帧的错误可见性声明并修订分镜。",
      requiresReapproval: false,
    };
    const shootingIssue: ContinuityIssue = {
      severity: "error",
      code: "PHYSICAL_CAMERA_SEGMENT_TRANSITION_CONTRADICTION",
      message: "摄影机过渡没有时长。",
      affectedIds: ["S001"],
      suggestedFix: "同步修正 ShotSpec 的 cameraSegments、action 与 physicalPlan。",
      requiresReapproval: true,
    };
    expect(continuityRepairKindForIssue(storyboardIssue)).toBe("generic-storyboard");
    expect(continuityRepairKindForIssue(shootingIssue)).toBe("generic-shooting-script");
    expect(isContinuityIssueRepairable(storyboardIssue)).toBe(true);
    expect(isContinuityIssueRepairable(shootingIssue)).toBe(true);
  });

  it("keeps every V006 physical error reachable through the generic repair button", () => {
    const currentIssues = [
      ["PHYSICAL_CAMERA_STARTFRAME_VISIBILITY_CONTRADICTION", "删除起始帧错误声明并修订分镜。", "generic-storyboard"],
      ["PHYSICAL_CAMERA_SHOULDER_SIDE_CONTRADICTION", "同步修改 ShotSpec、cameraSegments、composition 和分镜 motionPlan。", "generic-shooting-script"],
      ["PHYSICAL_CAMERA_SEGMENT_TRANSITION_CONTRADICTION", "更新 ShotSpec 和 cameraSegments，并同步分镜。", "generic-shooting-script"],
      ["PHYSICAL_ORIENTATION_HEAD_GAZE_SUBSTITUTION", "拆分 subjectOrientations 并修改 action 和分镜 motionPlan。", "generic-shooting-script"],
      ["PHYSICAL_TIMED_GATE_AUDIO_BEFORE_STATE_CONTRADICTION", "同步更新 action、sound、S2-BLACKOUT 及分镜声画门禁。", "generic-shooting-script"],
    ] as const;
    for (const [code, suggestedFix, expectedKind] of currentIssues) {
      const issue = { code, message: code, affectedIds: ["S001"], suggestedFix };
      expect(continuityRepairKindForIssue(issue)).toBe(expectedKind);
      expect(isContinuityIssueRepairable(issue)).toBe(true);
    }
  });

  it("repairs causal reveal wording and cross-shot prop height from explicit suggestions", () => {
    const revealIssue: ContinuityIssue = {
      severity: "error",
      code: "PHYSICAL_TIMED_GATE_EARLY_REVEAL",
      message: "S002在0.35秒开始开门，却要求空间在1.05秒前完全被门遮挡。",
      affectedIds: ["S002"],
      suggestedFix: "把0.35秒定义为复制空间首次部分显露，将1.05秒改为群体首次清晰可辨。",
      requiresReapproval: true,
    };
    const repairedReveal = repairCausalRevealText("0.35秒双门开始分离；1.05秒复制空间首次显露；无法保证空间不提前出现。", revealIssue);
    expect(repairedReveal).toContain("0.35秒首次部分显露");
    expect(repairedReveal).toContain("1.05秒主体首次清晰可辨");
    expect(repairedReveal).not.toContain("无法保证");

    const propIssue: ContinuityIssue = { ...revealIssue, code: "PROP_POSITION_HANDOFF_DISCONTINUITY", suggestedFix: "让S002沿用S001结束时的手机高度。" };
    expect(repairPropHandoffText("手机低位持握", propIssue)).not.toContain("低位");
  });

  it("moves only the conflicting sound cue to the suggested light-change timecode", () => {
    const issue: ContinuityIssue = {
      severity: "error",
      code: "LIGHT_SOUND_SYNC_TIMECODE_CONFLICT",
      message: "S001画面从4.30秒闪烁，但声音说明把电流噼啪推迟到5.70秒。",
      affectedIds: ["S001", "AUDIO-002"],
      suggestedFix: "将S001声音说明中的电流噼啪起点改为4.30秒，并保持逐次对应。",
      requiresReapproval: true,
    };
    expect(repairSoundTimingText("5.70秒开始电流噼啪，随后逐次同步。", issue)).toBe("4.30秒开始电流噼啪，随后逐次同步。");
    expect(repairSoundTimingText("0.00秒保持老旧电梯底噪。", issue)).toBe("0.00秒保持老旧电梯底噪。");
  });

  it("repairs only affected storyboard fields from the report suggestions", () => {
    const repaired = repairStoryboardContinuityIssues(storyboard, issues, "16:9");
    const shot2 = repaired.storyboard.shots.find((shot) => shot.shotId === "S002");

    expect(repaired.fixedIssueCodes).toEqual(issues.map((issue) => issue.code));
    expect(repaired.changedShotIds).toEqual(["S001", "S002"]);
    expect(shot2?.sceneId).toBe("SCENE-002");
    expect(shot2?.requiredAssetIds).toEqual(["CHAR-001", "CHAR-003", "SCENE-002", "SCENE-001"]);
    expect(shot2?.startFrame).toContain(storyboard.shots[0].endFrame.replace(/。$/, ""));
    expect(shot2?.composition).toContain("近端结构继续引用SCENE-001");
    expect(shot2?.composition).toContain(MIRROR_PARITY_CONTINUITY_RULE);
    expect(repaired.storyboard.globalContinuityNotes).toContain(MIRROR_PARITY_CONTINUITY_RULE);
  });

  it("locks a cross-shot character orientation and the approved asset version without regenerating other fields", () => {
    const orientationFix = "CHAR-001的躯干和头部保持朝向电梯门，仅眼睛看向右侧镜面；手机高度与僵硬姿态保持不变。";
    const newIssues: ContinuityIssue[] = [
      {
        severity: "error",
        code: "CHARACTER_ORIENTATION_STATE_CONFLICT",
        message: "S001尾状态与S002首状态的人物朝向冲突。",
        affectedIds: ["S001", "S002", "CHAR-001"],
        suggestedFix: orientationFix,
        requiresReapproval: true,
      },
      {
        severity: "warning",
        code: "ASSET_VERSION_LOCK_UNVERIFIABLE",
        message: "镜头尚未记录已批准资产版本。",
        affectedIds: ["S001", "S002"],
        suggestedFix: "锁定已批准 Asset Bible 的版本和哈希。",
        requiresReapproval: false,
      },
    ];

    const repaired = repairStoryboardContinuityIssues(storyboard, newIssues, "16:9", "asset-bible-v004:abc123");
    const shot1 = repaired.storyboard.shots[0];
    const shot2 = repaired.storyboard.shots[1];

    expect(shot1.endFrame).toContain(orientationFix);
    expect(shot2.startFrame).toContain(orientationFix);
    expect(shot1.startFrame).toBe(storyboard.shots[0].startFrame);
    expect(shot2.endFrame).toBe(storyboard.shots[1].endFrame);
    expect(repaired.storyboard.globalContinuityNotes).toContain("资产版本锁定：asset-bible-v004:abc123；该批准版本同时绑定导演脚本与当前分镜。");
    expect(repaired.changedShotIds).toEqual(["S001", "S002"]);
    expect(repaired.fixedIssueCodes).toEqual(newIssues.map((issue) => issue.code));
  });
});
