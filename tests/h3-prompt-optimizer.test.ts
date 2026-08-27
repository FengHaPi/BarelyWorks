import { describe, expect, it } from "vitest";
import { optimizeH3Prompt } from "../src/handoff/h3-prompt-optimizer";
import { h3PromptTargetCharacters } from "../src/shared/h3-prompt-budget";
import type { H3PromptOutput } from "../src/shared/handoff-schemas";

const references = [
  { label: "<Subject 1>", name: "阿宁", assetType: "character", role: "主参考" },
  { label: "<Subject 2>", name: "朋友", assetType: "character", role: "表情" },
];

function refPrompt(detailedDescription: string): H3PromptOutput {
  return {
    mode: "Ref2VA",
    prompt: `subject_definitions:\n<Subject 1> 是阿宁的唯一身份母版，锁定脸型、发型与服装。\n<Subject 2> 是视频通话中的朋友，显示在 <Subject 1> 所持手机中。\n\nsummary:\n[reference generation] <Subject 1> 与 <Subject 2> 通话后发现镜中异常。\n\nretention_analysis:\n<Subject 1> (appears throughout [Shot 1]): fully_preserved - 阿宁的脸型、发型、服装和身份在所有阶段保持不变。\n<Subject 2> (appears beside <Subject 1> in [Shot 1]): fully_preserved - 朋友的发型、耳饰、服装与表演保持不变。\n\ndetailed_description:\n${detailedDescription}\n\noverall_soundscape:\n<Subject 2> 的手机窄带声音清晰可辨。\n\nnon_diegetic_music:\nN/A`,
    referenceLabels: [
      { assetId: "CHAR-001", label: "<Subject 1>", kind: "image", filePath: "a.png", role: "character" },
      { assetId: "CHAR-002", label: "<Subject 2>", kind: "image", filePath: "b.png", role: "character" },
    ],
    notes: [],
  };
}

describe("H3 prompt optimization", () => {
  it("uses a short-video budget instead of treating the platform limit as the writing target", () => {
    expect(h3PromptTargetCharacters(9, 4)).toBe(2_220);
    expect(h3PromptTargetCharacters(6, 5)).toBe(2_040);
    expect(h3PromptTargetCharacters(30, 8)).toBe(3_200);
  });

  it("keeps definitions but removes repeated labels and verbose fully-preserved restatements", () => {
    const result = optimizeH3Prompt({
      value: refPrompt("[Shot 1] <Subject 1> 进入电梯并看向 <Subject 2>。随后 <Subject 1> 回头，<Subject 2> 再次提醒 <Subject 1>。"),
      durationSec: 9,
      references,
    });
    expect(result.value.prompt).toContain("summary:\n[reference generation] 阿宁 与 朋友 通话后发现镜中异常。");
    expect(result.value.prompt).toContain("<Subject 2> 是视频通话中的朋友，显示在 阿宁 所持手机中；参考职责：");
    expect(result.value.prompt).toContain("参考职责：整体视觉基准");
    expect(result.value.prompt).toContain("参考职责：只约束表情形态和情绪强度");
    expect(result.value.prompt).toContain("<Subject 1> (appears throughout [Shot 1]): fully_preserved - 整体视觉基准");
    expect(result.value.prompt).toContain("<Subject 2> (appears beside 阿宁 in [Shot 1]): fully_preserved - 只约束表情形态和情绪强度");
    expect(result.value.prompt).toContain("随后 阿宁 回头，朋友 再次提醒 阿宁");
    expect(result.referenceOccurrences).toEqual({ "<Subject 1>": 3, "<Subject 2>": 3 });
    expect(result.finalCharacters).toBeLessThanOrEqual(result.targetCharacters);
    expect(result.value.notes.at(-1)).toContain("参考标签最多出现 3 次");
  });

  it("rejects a still-overlong prompt before a new package version is written", () => {
    expect(() => optimizeH3Prompt({
      value: refPrompt(`[Shot 1] <Subject 1> 进入电梯。${"持续描述动作、机位与外观。".repeat(260)}`),
      durationSec: 9,
      references,
    })).toThrow(/超过本镜头精简目标 2220 字符/);
  });
});
