import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { H3_PROMPT_PLATFORM_MAX_CHARACTERS, h3PromptOutputSchema } from "../src/shared/handoff-schemas";
import { createProjectInputSchema, providerCapabilitiesSchema, shotSpecSchema } from "../src/shared/schemas";

describe("shared contracts", () => {
  it("declares a type for every const in Codex output schemas", () => {
    const schemaNames = ["shooting-script", "storyboard"];
    const visit = (value: unknown, path: string): void => {
      if (!value || typeof value !== "object") return;
      const node = value as Record<string, unknown>;
      if (Object.hasOwn(node, "const")) expect(node.type, `${path} const must declare type`).toBeDefined();
      for (const [key, child] of Object.entries(node)) visit(child, `${path}.${key}`);
    };
    for (const name of schemaNames) {
      const schema = JSON.parse(fs.readFileSync(new URL(`../templates/schemas/${name}.schema.json`, import.meta.url), "utf8")) as unknown;
      visit(schema, name);
    }
  });

  it("keeps unverified provider capabilities unknown", () => {
    const result = providerCapabilitiesSchema.parse({
      provider: "minimax",
      model: "h3",
      modes: ["text-to-video", "image-to-video", "reference-to-video"],
      durations: [],
      aspectRatios: [],
      resolutions: [],
      maxReferenceImages: null,
      supportsAudioInput: null,
      supportsReferenceVideo: null,
      verifiedAt: null,
    });
    expect(result.supportsAudioInput).toBeNull();
  });

  it("rejects inconsistent shot duration", () => {
    const result = shotSpecSchema.safeParse({
      id: "S001",
      projectId: "019c9a68-6d6e-7cf1-b9cc-0caa79d9887a",
      sequence: 1,
      startTimeSec: 0,
      endTimeSec: 5,
      durationSec: 4,
      purpose: "建立场景",
      characterIds: [],
      sceneId: "SCENE-001",
      propIds: [],
      styleIds: ["STYLE-001"],
      shotSize: "全景",
      camera: { position: "平视", movement: "固定" },
      action: "雨落在屋檐上",
      dialogue: [],
      sound: ["雨声"],
      startState: "空镜",
      endState: "人物入画",
      status: "draft",
    });
    expect(result.success).toBe(false);
  });

  it("accepts 480p output and rejects lower final output specifications", () => {
    const base = {
      title: "480p 项目",
      sourceType: "story",
      sourceText: "测试",
      targetDurationSec: 10,
      aspectRatio: "16:9",
      videoType: "测试",
      visualStyle: "",
      releasePlatform: "",
      targetAudience: "",
      allowStorySuggestions: true,
    };
    expect(createProjectInputSchema.safeParse({ ...base, resolution: "854x480" }).success).toBe(true);
    expect(createProjectInputSchema.safeParse({ ...base, resolution: "640x360" }).success).toBe(false);
  });

  it("rejects malformed aspect ratios and mismatched output orientation", () => {
    const base = {
      title: "画幅校验",
      sourceType: "story",
      sourceText: "测试",
      targetDurationSec: 10,
      videoType: "测试",
      visualStyle: "",
      releasePlatform: "",
      targetAudience: "",
      allowStorySuggestions: true,
    };
    expect(createProjectInputSchema.safeParse({ ...base, aspectRatio: "banana", resolution: "1280x720" }).success).toBe(false);
    expect(createProjectInputSchema.safeParse({ ...base, aspectRatio: "16:9", resolution: "720x1280" }).success).toBe(false);
    expect(createProjectInputSchema.safeParse({ ...base, aspectRatio: "9：16", resolution: "720x1280" }).success).toBe(true);
    expect(createProjectInputSchema.safeParse({ ...base, targetDurationSec: 3, aspectRatio: "16:9", resolution: "1280x720" }).success).toBe(false);
    expect(createProjectInputSchema.safeParse({ ...base, sourceType: "storyboard", aspectRatio: "16:9", resolution: "1280x720" }).success).toBe(false);
  });

  it("enforces the MiniMax H3 7000-character platform limit", () => {
    const prefix = "integrated_multimodal_description:\n[Shot 1] ";
    const suffix = "\n\noverall_soundscape:\n安静环境声。\n\nnon_diegetic_music:\nN/A";
    const promptAtLimit = `${prefix}${"中".repeat(H3_PROMPT_PLATFORM_MAX_CHARACTERS - prefix.length - suffix.length)}${suffix}`;
    expect(promptAtLimit.length).toBe(H3_PROMPT_PLATFORM_MAX_CHARACTERS);
    expect(h3PromptOutputSchema.safeParse({ mode: "T2VA", prompt: promptAtLimit, referenceLabels: [], notes: [] }).success).toBe(true);
    expect(h3PromptOutputSchema.safeParse({ mode: "T2VA", prompt: `${promptAtLimit}中`, referenceLabels: [], notes: [] }).success).toBe(false);
  });
});
