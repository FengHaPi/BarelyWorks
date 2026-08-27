import { describe, expect, it } from "vitest";
import { hasMeaningfulCreateProjectDraft, parseCreateProjectDraft, serializeCreateProjectDraft } from "./create-project-draft";
import type { CreateProjectInput } from "./types";

const form: CreateProjectInput = {
  title: "电梯里只有我",
  sourceType: "story",
  sourceText: "测试故事",
  targetDurationSec: 15,
  aspectRatio: "16:9",
  resolution: "1280x720",
  videoType: "都市恐怖短片",
  visualStyle: "冷绿色监控色调",
  releasePlatform: "",
  targetAudience: "",
  allowStorySuggestions: true,
};

describe("create project draft", () => {
  it("round-trips a valid form without losing multiline content", () => {
    const input = { ...form, sourceText: "第一行\n第二行\n第三行" };
    expect(parseCreateProjectDraft(serializeCreateProjectDraft(input))).toEqual(input);
  });

  it("rejects corrupted or incompatible session values", () => {
    expect(parseCreateProjectDraft("not-json")).toBeNull();
    expect(parseCreateProjectDraft(JSON.stringify({ version: 2, form }))).toBeNull();
    expect(parseCreateProjectDraft(JSON.stringify({ version: 1, form: { ...form, targetDurationSec: 0 } }))).toBeNull();
  });

  it("stores only forms that differ from the defaults", () => {
    expect(hasMeaningfulCreateProjectDraft(form, form)).toBe(false);
    expect(hasMeaningfulCreateProjectDraft({ ...form, title: "新项目" }, form)).toBe(true);
  });
});
