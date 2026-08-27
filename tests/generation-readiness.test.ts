import { describe, expect, it } from "vitest";
import { inspectOutlineFeasibility, inspectScreenplayFeasibility } from "../src/shared/generation-readiness";

describe("paid generation narrative readiness", () => {
  it("blocks a fifteen-second outline that needs more product shots than the duration can hold", () => {
    const report = inspectOutlineFeasibility({
      title: "电梯里只有我",
      logline: "镜面和门后同时出现复制体。",
      themes: ["恐惧"],
      targetDurationSec: 15,
      structure: Array.from({ length: 5 }, (_, index) => ({
        sequence: index + 1,
        heading: `段落${index + 1}`,
        purpose: "递进",
        events: ["动作一", "动作二", "动作三"],
        estimatedDurationSec: 3,
      })),
      lockedFacts: [],
      proposedChanges: [{ change: "延长到20秒", reason: "事件过多" }],
      approvalNotes: ["请人工确认15秒或20秒"],
    }, 15);

    expect(report.status).toBe("blocked");
    expect(report.estimatedMajorBeats).toBe(15);
    expect(report.recommendedMinimumShots).toBe(4);
    expect(report.maximumProductShots).toBe(3);
    expect(report.minimumReliableDurationSec).toBe(20);
    expect(report.acknowledgementRequired).toBe(true);
    expect(report.issues.map((issue) => issue.code)).toContain("NARRATIVE_COMPLEXITY_EXCEEDS_DURATION");
  });

  it("keeps a compact screenplay ready and exposes unresolved choices for explicit approval", () => {
    const report = inspectScreenplayFeasibility({
      title: "短片",
      version: 1,
      basedOnApprovedArtifact: "outline-v001:hash",
      sourcePreserved: true,
      scenes: [{
        sequence: 1,
        heading: "室内",
        location: "房间",
        timeOfDay: "夜",
        action: ["人物进入", "人物发现异常", "人物离开"],
        dialogue: [{ speaker: "甲", text: "你听见了吗？" }],
      }],
      unresolvedQuestions: ["是否保留最后一句对白"],
    }, 15);

    expect(report.status).toBe("ready");
    expect(report.recommendedMinimumShots).toBe(1);
    expect(report.acknowledgementRequired).toBe(true);
  });
});
