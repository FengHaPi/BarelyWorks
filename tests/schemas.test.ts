import { describe, expect, it } from "vitest";
import { providerCapabilitiesSchema, shotSpecSchema } from "../src/shared/schemas";

describe("shared contracts", () => {
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
});
