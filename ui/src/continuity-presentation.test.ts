import { describe, expect, it } from "vitest";
import { continuityIssueGroupTitle, groupContinuityIssues } from "./continuity-presentation";

describe("continuity issue presentation", () => {
  it("groups repeated shot-level evidence into one root problem", () => {
    const groups = groupContinuityIssues([
      { severity: "error", code: "PHYSICAL_CAMERA_BLOCKING_FAILED", message: "S001 不可执行", affectedIds: ["S001"], suggestedFix: "返回导演脚本修正", requiresReapproval: true },
      { severity: "error", code: "PHYSICAL_CAMERA_BLOCKING_FAILED", message: "S002 不可执行", affectedIds: ["S002"], suggestedFix: "返回导演脚本修正", requiresReapproval: true },
      { severity: "warning", code: "PHYSICAL_REFLECTION_PLAN_MISMATCH", message: "反射结构冲突", affectedIds: ["S002"], suggestedFix: "统一反射结构", requiresReapproval: false },
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ code: "PHYSICAL_CAMERA_BLOCKING_FAILED", affectedIds: ["S001", "S002"], suggestedFixes: ["返回导演脚本修正"] });
    expect(groups[0].issues).toHaveLength(2);
    expect(continuityIssueGroupTitle(groups[0])).toBe("2 个镜头的摄影机调度不可执行");
  });

  it("uses a concise human title for known structural conflicts", () => {
    const [group] = groupContinuityIssues([
      { severity: "error", code: "PHYSICAL_CAMERA_CONTINUITY_TASK_SPLIT", message: "很长的技术说明", affectedIds: ["S001"], suggestedFix: "修改执行方式", requiresReapproval: true },
    ]);
    expect(continuityIssueGroupTitle(group)).toBe("一镜到底要求与分段生成方式冲突");
  });
});
