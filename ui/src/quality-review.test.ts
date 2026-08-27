import { describe, expect, it } from "vitest";
import { createQuickAcceptedReview, createQuickRejectedReview } from "./quality-review";
import { reviewDimensions } from "./types";

describe("quick quality review", () => {
  it("creates a complete accepted nine-dimension review", () => {
    const review = createQuickAcceptedReview();
    expect(review.decision).toBe("accepted");
    expect(review.dimensions).toHaveLength(reviewDimensions.length);
    expect(review.dimensions.every((item) => item.status === "pass")).toBe(true);
  });

  it("maps unwanted text to a picture-quality failure and a concrete retry instruction", () => {
    const review = createQuickRejectedReview(["unwanted-text"], "画面右上角出现提示字");
    expect(review.decision).toBe("revise-prompt-retry");
    expect(review.dimensions.find((item) => item.dimension === "picture-quality")?.status).toBe("fail");
    expect(review.dimensions.filter((item) => item.dimension !== "picture-quality").every((item) => item.status === "pass")).toBe(true);
    expect(review.retryInstructions.join(" ")).toMatch(/字幕.*水印/);
    expect(review.summary).toContain("画面右上角出现提示字");
  });

  it("requires at least one issue before rejection", () => {
    expect(() => createQuickRejectedReview([], "")).toThrow("请至少选择一个问题类型");
  });
});
