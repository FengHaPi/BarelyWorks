import { describe, expect, it } from "vitest";
import { conflictingOrientationTerms, extractAspectRatios, referenceCompatibilityKey, repairAspectText } from "../src/projects/project-service";

describe("aspect-ratio description semantics", () => {
  it("keeps prohibited ratios out of conflicts while recognizing a later positive target", () => {
    expect(extractAspectRatios("不要9:16但应为16:9横幅")).toEqual(["16:9"]);
    expect(extractAspectRatios("不能是9:16而应为16:9横幅")).toEqual(["16:9"]);
    expect(extractAspectRatios("禁止为了兼容错误模板而将最终成片裁切为9:16竖幅")).toEqual([]);
    expect(extractAspectRatios("非常稳定的9:16竖幅构图")).toEqual(["9:16"]);
    expect(extractAspectRatios("墙上有9:16竖屏显示器，最终构图采用16:9横幅")).toEqual(["16:9"]);
    expect(extractAspectRatios("墙上有竖屏显示器并采用9:16竖幅构图")).toEqual(["9:16"]);
    expect(extractAspectRatios("项目采用9:16")).toEqual(["9:16"]);
    expect(extractAspectRatios("不采用9:16竖幅，无需裁成4:3，勿用竖屏")).toEqual([]);
    expect(extractAspectRatios("不采用9:16而采用16:9横幅")).toEqual(["16:9"]);
    expect(extractAspectRatios("墙上显示器宽高比为9:16并采用16:9横幅构图")).toEqual(["16:9"]);
  });

  it("does not rewrite a negative constraint but repairs positive framing", () => {
    const repaired = repairAspectText("禁止为了兼容错误模板而将最终成片裁切为9:16竖幅，但最终采用9:16竖幅构图", "16:9");
    expect(repaired).toContain("禁止为了兼容错误模板而将最终成片裁切为9:16竖幅");
    expect(repaired).toContain("最终采用16:9横幅构图");
    expect(repairAspectText("墙上有9:16竖屏显示器，最终构图采用9:16竖幅", "16:9"))
      .toBe("墙上有9:16竖屏显示器，最终构图采用16:9横幅");
    expect(repairAspectText("墙上有竖屏显示器并采用9:16竖幅构图", "16:9"))
      .toBe("墙上有竖屏显示器并采用16:9横幅构图");
    expect(repairAspectText("墙上显示器宽高比为9:16并采用9:16竖幅构图", "16:9"))
      .toBe("墙上显示器宽高比为9:16并采用16:9横幅构图");
  });

  it("rejects directional framing for square output and preserves negative directions", () => {
    expect(conflictingOrientationTerms("最终采用竖幅构图", "1:1")).toEqual(["竖幅"]);
    expect(conflictingOrientationTerms("不得采用竖幅构图", "1:1")).toEqual([]);
    expect(repairAspectText("最终采用9:16竖幅构图", "1:1")).toBe("最终采用1:1方形画幅构图");
  });

  it("keeps object-screen geometry in reference identity while ignoring final-frame wording", () => {
    const scene = {
      type: "scene" as const,
      name: "控制室",
      identity: "控制室内景",
      appearance: "墙上有16:9显示器，最终构图采用16:9横幅",
      designSummary: "控制室与显示器位置固定",
      distinctiveFeatures: ["中央控制台", "墙上显示器"],
    };
    expect(referenceCompatibilityKey(scene)).not.toBe(referenceCompatibilityKey({
      ...scene,
      appearance: "墙上有9:16显示器，最终构图采用9:16竖幅",
    }));
    expect(referenceCompatibilityKey(scene)).toBe(referenceCompatibilityKey({
      ...scene,
      appearance: "墙上有16:9显示器，最终构图采用9:16竖幅",
    }));
  });
});
