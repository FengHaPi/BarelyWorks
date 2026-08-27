import path from "node:path";
import type { Asset } from "./schemas";

const invalidFileSegmentPattern = /[<>:"/\\|?*\u0000-\u001f]/g;

export function safeAssetFileSegment(value: string, fallback: string): string {
  const normalized = value
    .normalize("NFC")
    .replace(invalidFileSegmentPattern, "-")
    .replace(/\s+/g, "_")
    .replace(/-+/g, "-")
    .replace(/^[. _-]+|[. _-]+$/g, "")
    .slice(0, 48);
  return normalized || fallback;
}

function normalizedExtension(extension: string): string {
  const value = extension.startsWith(".") ? extension : `.${extension}`;
  return /^\.[a-z0-9]{1,8}$/i.test(value) ? value.toLowerCase() : ".bin";
}

function referenceStem(input: {
  assetId: string;
  assetName: string;
  role: string;
  version: number;
  index: number;
}): string {
  return [
    safeAssetFileSegment(input.assetId, "ASSET"),
    safeAssetFileSegment(input.assetName, "未命名"),
    safeAssetFileSegment(input.role, "参考"),
    `V${String(input.version).padStart(3, "0")}`,
    String(input.index + 1).padStart(2, "0"),
  ].join("_");
}

export function assetReferenceStorageFileName(input: {
  assetId: string;
  assetName: string;
  role: string;
  version: number;
  index: number;
  extension: string;
  uniqueSuffix: string;
}): string {
  const suffix = safeAssetFileSegment(input.uniqueSuffix, "unique").slice(0, 12);
  return `${referenceStem(input)}_${suffix}${normalizedExtension(input.extension)}`;
}

export function assetReferencePackageFileName(asset: Asset, index: number): string {
  const sourcePath = asset.localFiles[index] ?? "reference.bin";
  const role = asset.fileRoles[index] ?? `参考${index + 1}`;
  return `${referenceStem({ assetId: asset.id, assetName: asset.name, role, version: asset.version, index })}${normalizedExtension(path.extname(sourcePath))}`;
}
