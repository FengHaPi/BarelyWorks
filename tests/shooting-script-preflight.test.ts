import { describe, expect, it } from "vitest";
import { inspectShootingScriptPreflight } from "../src/shared/shooting-script-preflight";

describe("shooting script semantic preflight", () => {
  it("rejects decimal and sub-five-second production durations", () => {
    const issues = inspectShootingScriptPreflight([
      { id: "S001", startTimeSec: 0, endTimeSec: 7.5, durationSec: 7.5, action: "连续动作", startState: "开始", endState: "结束", physicalPlan: null },
      { id: "S002", startTimeSec: 8, endTimeSec: 12, durationSec: 4, action: "连续动作", startState: "开始", endState: "结束", physicalPlan: null },
    ] as never);
    expect(issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "SHOT_DURATION_NOT_INTEGER",
      "SHOT_TIMECODE_NOT_INTEGER",
      "SHOT_DURATION_BELOW_PRODUCT_MIN",
    ]));
  });

  it("catches an impossible delayed reveal behind a door that is already opening", () => {
    const issues = inspectShootingScriptPreflight([{
      id: "S002",
      action: "两部电梯无楼道直接相连。0.35秒门开始打开，1.05秒复制空间首次显露。",
      startState: "门关闭",
      endState: "门开启",
      physicalPlan: {
        entities: [], feasibilityNotes: ["两个空间直接相连，没有其他遮挡"],
        timedStateGates: [
          { stateId: "DOOR", startsAtOffsetSec: 0.35, beforeState: "门关闭", afterState: "门开始打开并形成门缝" },
          { stateId: "REVEAL", startsAtOffsetSec: 1.05, beforeState: "空间完全被门遮挡", afterState: "复制空间首次显露" },
        ],
      },
    }] as never);
    expect(issues.map((issue) => issue.code)).toContain("PHYSICAL_TIMED_GATE_EARLY_REVEAL");
  });

  it("catches a prop height jump across a shot boundary", () => {
    const issues = inspectShootingScriptPreflight([
      { id: "S001", action: "人物僵住", startState: "手机在胸口", endState: "手机仍在胸口", physicalPlan: { entities: [{ assetId: "PROP-001", role: "胸口阅读高度" }], feasibilityNotes: [], timedStateGates: [] } },
      { id: "S002", action: "承接上一镜", startState: "镜头切换", endState: "黑场", physicalPlan: { entities: [{ assetId: "PROP-001", role: "由人物低位持握" }], feasibilityNotes: [], timedStateGates: [] } },
    ] as never);
    expect(issues.map((issue) => issue.code)).toContain("PROP_POSITION_HANDOFF_DISCONTINUITY");
  });
});
