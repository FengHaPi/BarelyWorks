import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { qualityReviewInputSchema, reviewDimensions } from "../src/shared/quality-schemas";
import { skillOutputSchemas } from "../src/shared/skill-schemas";

const fixtures = JSON.parse(
  fs.readFileSync(path.resolve("tests/fixtures/skills/p0-valid.json"), "utf8"),
) as Record<string, Record<string, unknown>>;

describe("core Skill contract EVAL matrix", () => {
  it("rejects missing required information for every structured core Skill", () => {
    const requiredFields: Record<keyof typeof skillOutputSchemas, string> = {
      "ai-video-producer": "currentStage",
      "project-intake": "constraints",
      "story-architect": "structure",
      "screenplay-writer": "scenes",
      "asset-bible-builder": "assets",
      "shooting-script-director": "shots",
      "storyboard-director": "shots",
      "continuity-supervisor": "checkedShotIds",
    };
    for (const [name, schema] of Object.entries(skillOutputSchemas)) {
      const candidate = structuredClone(fixtures[name]);
      delete candidate[requiredFields[name as keyof typeof skillOutputSchemas]];
      expect(schema.safeParse(candidate).success, `${name} should reject missing required information`).toBe(false);
    }
  });

  it("rejects conflicting asset identity and type contracts", () => {
    const candidate = structuredClone(fixtures["asset-bible-builder"]) as { assets: Array<{ id: string; type: string }> };
    candidate.assets[0].id = "SCENE-999";
    candidate.assets[0].type = "character";
    expect(skillOutputSchemas["asset-bible-builder"].safeParse(candidate).success).toBe(false);
  });

  it("rejects a passed continuity report that still contains an error", () => {
    const candidate = structuredClone(fixtures["continuity-supervisor"]) as {
      passed: boolean;
      issues: Array<Record<string, unknown>>;
    };
    candidate.passed = true;
    candidate.issues = [{
      severity: "error",
      code: "DIRECTION_BREAK",
      message: "人物方向冲突",
      affectedIds: ["S001"],
      suggestedFix: "修正人物朝向",
      requiresReapproval: true,
    }];
    expect(skillOutputSchemas["continuity-supervisor"].safeParse(candidate).success).toBe(false);
  });

  it("preserves a long screenplay action without truncation", () => {
    const candidate = structuredClone(fixtures["screenplay-writer"]) as {
      scenes: Array<{ action: string[] }>;
    };
    const longAction = "人物沿走廊持续前进，摄影机保持完整动作与空间关系。".repeat(2_000);
    candidate.scenes[0].action = [longAction];
    const parsed = skillOutputSchemas["screenplay-writer"].parse(candidate);
    expect(parsed.scenes[0].action[0]).toBe(longAction);
  });

  it("blocks accepted quality reviews when any dimension was not inspected", () => {
    const candidate = {
      dimensions: reviewDimensions.map((dimension, index) => ({
        dimension,
        status: index === 0 ? "not-reviewed" : "pass",
        note: "人工检查记录",
        evidence: index === 0 ? "未检查" : "00:00-00:02",
      })),
      decision: "accepted",
      summary: "存在未检查维度",
      conditions: [],
      retryInstructions: [],
      unverifiedClaims: ["身份一致性未检查"],
    };
    expect(qualityReviewInputSchema.safeParse(candidate).success).toBe(false);
  });

  it("requires conditions for conditional pass and failed evidence for retry", () => {
    const dimensions = reviewDimensions.map((dimension) => ({
      dimension,
      status: "pass" as const,
      note: "人工检查通过",
      evidence: "00:00-00:02",
    }));
    expect(qualityReviewInputSchema.safeParse({
      dimensions,
      decision: "conditional-pass",
      summary: "缺少条件",
      conditions: [],
      retryInstructions: [],
      unverifiedClaims: [],
    }).success).toBe(false);
    expect(qualityReviewInputSchema.safeParse({
      dimensions,
      decision: "retry-same-model",
      summary: "没有失败证据",
      conditions: [],
      retryInstructions: ["重新生成"],
      unverifiedClaims: [],
    }).success).toBe(false);
  });
});
