import { describe, expect, it } from "vitest";
import { DisabledImageGenerationProvider } from "../src/ai/image-provider";

describe("reserved image generation provider", () => {
  it("advertises a paid API slot without enabling or invoking it", async () => {
    const provider = new DisabledImageGenerationProvider();
    await expect(provider.getCapabilities()).resolves.toMatchObject({
      provider: "unconfigured",
      configured: false,
      enabled: false,
      requiresPayment: true,
      supportsTextToImage: true,
    });
    await expect(provider.generateAssetReferenceImage()).rejects.toThrow(/Codex.*提示词.*不能输出图片/);
  });
});
