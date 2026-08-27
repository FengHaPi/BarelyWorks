import { describe, expect, it } from "vitest";
import { MAX_REFERENCE_UPLOAD_BYTES, validateReferenceUpload } from "./upload";

describe("validateReferenceUpload", () => {
  it("accepts an image exactly at the 4 MB boundary", () => {
    expect(() => validateReferenceUpload({ name: "reference.png", type: "image/png", size: MAX_REFERENCE_UPLOAD_BYTES })).not.toThrow();
  });

  it("rejects an image larger than 4 MB before upload", () => {
    expect(() => validateReferenceUpload({ name: "large.png", type: "image/png", size: MAX_REFERENCE_UPLOAD_BYTES + 1 })).toThrow("不能超过 4 MB");
  });

  it("rejects non-image files", () => {
    expect(() => validateReferenceUpload({ name: "notes.txt", type: "text/plain", size: 10 })).toThrow("仅支持 PNG、JPEG、WebP 图片");
  });

  it("rejects image formats the server cannot store", () => {
    expect(() => validateReferenceUpload({ name: "animated.gif", type: "image/gif", size: 10 })).toThrow("仅支持 PNG、JPEG、WebP 图片");
  });
});
