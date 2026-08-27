import { describe, expect, it } from "vitest";
import { validateImageBytes } from "../src/media/image-validation";
import { createReferencePng } from "./fixtures/reference-image";

const referencePng = createReferencePng();

describe("reference image validation", () => {
  it("reads dimensions from a fully decodable PNG", async () => {
    await expect(validateImageBytes(referencePng, "image/png")).resolves.toEqual({ width: 128, height: 128 });
  });

  it("rejects files that only contain a valid-looking signature", async () => {
    await expect(validateImageBytes(referencePng.subarray(0, 8), "image/png")).rejects.toThrow(/损坏|截断/);
    await expect(validateImageBytes(Buffer.from([0xff, 0xd8, 0xff]), "image/jpeg")).rejects.toThrow(/损坏|截断/);
    await expect(validateImageBytes(Buffer.from("RIFF0000WEBP"), "image/webp")).rejects.toThrow(/损坏|截断/);
  });

  it("rejects header-shaped JPEG and WebP payloads that have no decodable pixels", async () => {
    const fakeJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x07, 0x08, 0x00, 0x80, 0x00, 0x80, 0xff, 0xda, 0x00, 0x02, 0x00, 0xff, 0xd9]);
    const fakeWebp = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x16, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20, 0x0a, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x9d, 0x01, 0x2a, 0x80, 0x00, 0x80, 0x00]);
    await expect(validateImageBytes(fakeJpeg, "image/jpeg")).rejects.toThrow(/无法解码|损坏/);
    await expect(validateImageBytes(fakeWebp, "image/webp")).rejects.toThrow(/无法解码|损坏/);
  });

  it("rejects truncated image payloads even when the header and dimensions remain", async () => {
    await expect(validateImageBytes(referencePng.subarray(0, referencePng.length - 6), "image/png")).rejects.toThrow(/损坏|截断/);
  });

  it("rejects a header-only PNG and unreasonable dimensions", async () => {
    await expect(validateImageBytes(createReferencePng(128, 128, false), "image/png")).rejects.toThrow(/损坏|截断/);
    await expect(validateImageBytes(createReferencePng(1, 1), "image/png")).rejects.toThrow(/至少/);
    await expect(validateImageBytes(createReferencePng(20_000, 128), "image/png")).rejects.toThrow(/损坏|过大/);
  });
});
