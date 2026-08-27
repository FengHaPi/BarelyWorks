import sharp from "sharp";

export interface ImageDimensions {
  width: number;
  height: number;
}

const minimumReferenceDimension = 128;
const maximumReferenceDimension = 8_192;
const maximumReferencePixels = 16_000_000;
const expectedFormatByMimeType: Record<string, "jpeg" | "png" | "webp"> = {
  "image/jpeg": "jpeg",
  "image/png": "png",
  "image/webp": "webp",
};

const crcTable = Array.from({ length: 256 }, (_unused, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function hasCompletePngContainer(bytes: Buffer): boolean {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (bytes.length < 57 || !bytes.subarray(0, 8).equals(signature)) return false;
  let offset = 8;
  let chunkIndex = 0;
  let imageDataSeen = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const typeStart = offset + 4;
    const dataStart = offset + 8;
    const crcOffset = dataStart + length;
    const nextOffset = crcOffset + 4;
    if (nextOffset > bytes.length) return false;
    const type = bytes.subarray(typeStart, dataStart).toString("ascii");
    if (crc32(bytes.subarray(typeStart, crcOffset)) !== bytes.readUInt32BE(crcOffset)) return false;
    if (chunkIndex === 0 && (type !== "IHDR" || length !== 13)) return false;
    if (chunkIndex > 0 && type === "IHDR") return false;
    if (type === "IDAT") imageDataSeen = true;
    if (type === "IEND") return length === 0 && imageDataSeen && nextOffset === bytes.length;
    offset = nextOffset;
    chunkIndex += 1;
  }
  return false;
}

function hasCompleteContainer(bytes: Buffer, format: "jpeg" | "png" | "webp"): boolean {
  if (format === "png") return hasCompletePngContainer(bytes);
  if (format === "jpeg") return bytes.length >= 4
    && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9;
  return bytes.length >= 20
    && bytes.subarray(0, 4).toString("ascii") === "RIFF"
    && bytes.subarray(8, 12).toString("ascii") === "WEBP"
    && bytes.readUInt32LE(4) + 8 === bytes.length;
}

function decodeFailure(): Error {
  return new Error("参考图文件已损坏、被截断、无法解码或内容与格式不匹配");
}

export async function validateImageBytes(bytes: Buffer, mimeType: string): Promise<ImageDimensions> {
  const expectedFormat = expectedFormatByMimeType[mimeType];
  if (!expectedFormat || !hasCompleteContainer(bytes, expectedFormat)) throw decodeFailure();

  let metadata: Awaited<ReturnType<ReturnType<typeof sharp>["metadata"]>>;
  try {
    metadata = await sharp(bytes, {
      failOn: "error",
      limitInputPixels: maximumReferencePixels,
      sequentialRead: true,
    }).metadata();
  } catch {
    throw decodeFailure();
  }

  const width = metadata.width;
  const height = metadata.height;
  if (metadata.format !== expectedFormat || !Number.isInteger(width) || !Number.isInteger(height) || !width || !height) {
    throw decodeFailure();
  }
  if (width < minimumReferenceDimension || height < minimumReferenceDimension) {
    throw new Error(`参考图尺寸至少需要 ${minimumReferenceDimension}x${minimumReferenceDimension} 像素`);
  }
  if (width > maximumReferenceDimension || height > maximumReferenceDimension || width * height > maximumReferencePixels) {
    throw new Error("参考图尺寸过大，最大边不得超过 8192 像素且总像素不得超过 1600 万");
  }

  try {
    await sharp(bytes, {
      failOn: "error",
      limitInputPixels: maximumReferencePixels,
      sequentialRead: true,
    }).raw().toBuffer();
  } catch {
    throw decodeFailure();
  }
  return { width, height };
}
