export const MAX_REFERENCE_UPLOAD_BYTES = 4 * 1024 * 1024;

type UploadCandidate = Pick<File, "name" | "size" | "type">;

export function validateReferenceUpload(file: UploadCandidate): void {
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) throw new Error("仅支持 PNG、JPEG、WebP 图片");
  if (file.size > MAX_REFERENCE_UPLOAD_BYTES) {
    throw new Error(`参考图不能超过 4 MB（当前文件：${(file.size / 1024 / 1024).toFixed(1)} MB）`);
  }
}
