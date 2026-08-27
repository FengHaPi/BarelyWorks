import { deflateSync } from "node:zlib";

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

function chunk(type: string, payload = Buffer.alloc(0)): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const result = Buffer.alloc(12 + payload.length);
  result.writeUInt32BE(payload.length, 0);
  typeBytes.copy(result, 4);
  payload.copy(result, 8);
  result.writeUInt32BE(crc32(Buffer.concat([typeBytes, payload])), 8 + payload.length);
  return result;
}

export function createReferencePng(width = 128, height = 128, includePixels = true): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const chunks = [chunk("IHDR", header)];
  if (includePixels) {
    const scanlines = Buffer.alloc((1 + width * 3) * height);
    for (let row = 0; row < height; row += 1) scanlines[row * (1 + width * 3)] = 0;
    chunks.push(chunk("IDAT", deflateSync(scanlines)));
  }
  chunks.push(chunk("IEND"));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ...chunks]);
}

export const referencePngBase64 = createReferencePng().toString("base64");
