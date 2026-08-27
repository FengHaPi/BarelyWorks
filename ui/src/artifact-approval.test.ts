import { describe, expect, it } from "vitest";
import { artifactApprovalBlockers } from "./features/artifacts/ArtifactEditor";

describe("artifact approval feedback", () => {
  it("explains open validation errors and storyboard gates before approval", () => {
    const detail: Parameters<typeof artifactApprovalBlockers>[0] = {
      artifact: {
        type: "storyboard",
        metadata: { continuityPassed: false, verification: { modelExecutability: "passed" } },
      },
      issues: [{
        status: "open",
        severity: "error",
        title: "分镜文字结构一致性未通过",
        code: "storyboard-structure-blocked",
      }],
    };

    expect(artifactApprovalBlockers(detail)).toEqual([
      "分镜文字结构一致性未通过（storyboard-structure-blocked）",
      "分镜连续性检查尚未通过",
    ]);
  });

  it("does not treat closed issues as approval blockers", () => {
    const detail: Parameters<typeof artifactApprovalBlockers>[0] = {
      artifact: { type: "screenplay", metadata: {} },
      issues: [{ status: "resolved", severity: "error", title: "旧问题", code: "old" }],
    };
    expect(artifactApprovalBlockers(detail)).toEqual([]);
  });
});
