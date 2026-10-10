import { decode, decodeApng, encode } from 'fast-png';
import type { DecodedPng } from 'fast-png';
import jpeg from 'jpeg-js';
import { unzlibSync, zlibSync } from 'fflate';
import exifr from 'exifr';
import type { ColorProfile, NativeImage, PixelData, PhotoMetadata } from './types.ts';

const text = new TextDecoder();
const ascii = new TextEncoder();
export type ImageProbe = { format: 'png' | 'jpeg' | 'webp'; frames: number; width?: number; height?: number; depth?: number };
export type Chunk = { type: string; data: Uint8Array };

export function pngChunks(bytes: Uint8Array): Chunk[] {
  const chunks: Chunk[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const size = view.getUint32(offset);
    chunks.push({ type: text.decode(bytes.subarray(offset + 4, offset + 8)), data: bytes.subarray(offset + 8, offset + 8 + size) });
    offset += size + 12;
  }
  return chunks;
}

export function probeImage(bytes: Uint8Array): ImageProbe {
  if (bytes[0] === 137 && text.decode(bytes.subarray(1, 4)) === 'PNG') {
    const chunks = pngChunks(bytes), animation = chunks.find(chunk => chunk.type === 'acTL');
    const header = new DataView(bytes.buffer, bytes.byteOffset + 16, 8);
    return { format: 'png', frames: animation ? new DataView(animation.data.buffer, animation.data.byteOffset).getUint32(0) : 1, width: header.getUint32(0), height: header.getUint32(4), depth: bytes[24] };
  }
  if (bytes[0] === 255 && bytes[1] === 216) {
    for (let offset = 2; offset + 9 < bytes.length;) {
      const marker = bytes[offset + 1], size = (bytes[offset + 2] << 8) | bytes[offset + 3];
      if ([192, 193, 194].includes(marker)) return { format: 'jpeg', frames: 1, depth: 8, width: (bytes[offset + 7] << 8) | bytes[offset + 8], height: (bytes[offset + 5] << 8) | bytes[offset + 6] };
      if (marker === 218 || size < 2) break;
      offset += size + 2;
    }
    return { format: 'jpeg', frames: 1 };
  }
  if (text.decode(bytes.subarray(8, 12)) === 'WEBP') {
    const chunks = webpChunks(bytes), header = chunks.find(chunk => ['VP8X', 'VP8 ', 'VP8L'].includes(chunk.type));
    let width: number | undefined, height: number | undefined;
    if (header?.type === 'VP8X') { const d = header.data; width = 1 + d[4] + (d[5] << 8) + (d[6] << 16); height = 1 + d[7] + (d[8] << 8) + (d[9] << 16); }
    if (header?.type === 'VP8 ') { const d = header.data; width = (d[6] | d[7] << 8) & 0x3fff; height = (d[8] | d[9] << 8) & 0x3fff; }
    if (header?.type === 'VP8L') { const d = new DataView(header.data.buffer, header.data.byteOffset).getUint32(1, true); width = (d & 0x3fff) + 1; height = ((d >>> 14) & 0x3fff) + 1; }
    return { format: 'webp', frames: chunks.filter(chunk => chunk.type === 'ANMF').length || 1, width, height, depth: 8 };
  }
  throw new Error('unsupportedFormat');
}

export function webpChunks(bytes: Uint8Array): Chunk[] {
  const chunks: Chunk[] = [], view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const size = view.getUint32(offset + 4, true);
    chunks.push({ type: text.decode(bytes.subarray(offset, offset + 4)), data: bytes.subarray(offset + 8, offset + 8 + size) });
    offset += 8 + size + (size % 2);
  }
  return chunks;
}

function rgba(image: DecodedPng): PixelData {
  const depth = image.depth === 16 ? 16 : 8, max = depth === 16 ? 65535 : 255;
  const result = depth === 16 ? new Uint16Array(image.width * image.height * 4) : new Uint8Array(image.width * image.height * 4);
  for (let pixel = 0; pixel < image.width * image.height; pixel++) {
    const out = pixel * 4, start = pixel * image.channels;
    const packedIndex = Math.floor(pixel / image.width) * Math.ceil(image.width * image.depth / 8) + Math.floor((pixel % image.width) * image.depth / 8);
    const sample = image.depth < 8 ? (image.data[packedIndex] >>> (8 - image.depth - ((pixel % image.width) * image.depth) % 8)) & ((1 << image.depth) - 1) : image.data[start];
    if (image.palette) {
      const color = image.palette[sample];
      result[out] = color[0]; result[out + 1] = color[1]; result[out + 2] = color[2]; result[out + 3] = color[3] ?? 255;
    } else if (image.channels <= 2) {
      const gray = sample, scaled = Math.round(gray * max / ((1 << image.depth) - 1));
      result[out] = result[out + 1] = result[out + 2] = scaled;
      result[out + 3] = image.channels === 2 ? image.data[start + 1] : image.transparency?.[0] === gray ? 0 : max;
    } else {
      result[out] = image.data[start]; result[out + 1] = image.data[start + 1]; result[out + 2] = image.data[start + 2];
      result[out + 3] = image.channels === 4 ? image.data[start + 3] : image.transparency && image.transparency.every((v, c) => v === image.data[start + c]) ? 0 : max;
    }
  }
  return result;
}

export function orient(data: PixelData, width: number, height: number, orientation: number) {
  if (orientation === 1) return { data, width, height };
  const swap = orientation >= 5, outWidth = swap ? height : width, outHeight = swap ? width : height;
  const output = data instanceof Uint16Array ? new Uint16Array(data.length) : new Uint8Array(data.length);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let ox = x, oy = y;
    if (orientation === 2) ox = width - 1 - x;
    if (orientation === 3) { ox = width - 1 - x; oy = height - 1 - y; }
    if (orientation === 4) oy = height - 1 - y;
    if (orientation === 5) { ox = y; oy = x; }
    if (orientation === 6) { ox = height - 1 - y; oy = x; }
    if (orientation === 7) { ox = height - 1 - y; oy = width - 1 - x; }
    if (orientation === 8) { ox = y; oy = width - 1 - x; }
    const from = (y * width + x) * 4, to = (oy * outWidth + ox) * 4;
    output.set(data.subarray(from, from + 4), to);
  }
  return { data: output, width: outWidth, height: outHeight };
}

function jpegProfile(bytes: Uint8Array): Uint8Array | undefined {
  const parts: { index: number; data: Uint8Array }[] = [];
  for (let offset = 2; offset + 4 < bytes.length;) {
    if (bytes[offset] !== 255 || bytes[offset + 1] === 218) break;
    const marker = bytes[offset + 1], size = (bytes[offset + 2] << 8) | bytes[offset + 3];
    if (marker === 226 && text.decode(bytes.subarray(offset + 4, offset + 15)) === 'ICC_PROFILE') parts.push({ index: bytes[offset + 16], data: bytes.subarray(offset + 18, offset + 2 + size) });
    offset += size + 2;
  }
  if (!parts.length) return;
  return join(parts.sort((a, b) => a.index - b.index).map(part => part.data));
}

export const join = (parts: Uint8Array[]): Uint8Array => {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
};

export async function decodeImage(bytes: Uint8Array, name: string, frame?: number): Promise<NativeImage> {
  const probe = probeImage(bytes);
  if (probe.frames > 1 && frame === undefined) throw new Error('chooseFrame');
  let data: PixelData, width: number, height: number, depth: 8 | 16 = 8;
  let profile: ColorProfile = { name: 'sRGB' };
  const metadata: PhotoMetadata = {};
  let decoder: string;
  if (probe.format === 'png') {
    const decoded = probe.frames > 1 ? decodeApng(bytes) : decode(bytes);
    const image: DecodedPng = 'frames' in decoded ? { ...decoded, data: decoded.frames[frame ?? 0].data } : decoded;
    data = rgba(image); width = image.width; height = image.height; depth = image.depth === 16 ? 16 : 8;
    if (image.iccEmbeddedProfile) profile = { icc: image.iccEmbeddedProfile.profile, name: image.iccEmbeddedProfile.name };
    const chunks = pngChunks(bytes);
    metadata.exif = chunks.find(chunk => chunk.type === 'eXIf')?.data.slice();
    metadata.resolution = chunks.find(chunk => chunk.type === 'pHYs')?.data.slice();
    const xmp = chunks.find(chunk => chunk.type === 'iTXt' && text.decode(chunk.data.subarray(0, 17)) === 'XML:com.adobe.xmp\0');
    if (xmp && xmp.data[17] === 0) {
      const languageEnd = xmp.data.indexOf(0, 19), translatedEnd = xmp.data.indexOf(0, languageEnd + 1);
      if (languageEnd >= 19 && translatedEnd > languageEnd) metadata.xmp = xmp.data.subarray(translatedEnd + 1).slice();
    }
    const cicp = chunks.find(chunk => chunk.type === 'cICP')?.data;
    if (cicp && (cicp[0] !== 1 || cicp[1] !== 13 || cicp[2] !== 0 || cicp[3] !== 1)) throw new Error('unsupportedColorProfile');
    if (cicp) profile = { name: 'sRGB' };
    const chromaticities = chunks.find(chunk => chunk.type === 'cHRM')?.data;
    if (!cicp && !profile.icc && chromaticities && !chunks.some(chunk => chunk.type === 'sRGB')) {
      const standard = [31270, 32900, 64000, 33000, 30000, 60000, 15000, 6000], values = new DataView(chromaticities.buffer, chromaticities.byteOffset);
      if (standard.some((value, index) => Math.abs(values.getUint32(index * 4) - value) > 20)) throw new Error('unsupportedColorProfile');
    }
    const gamma = chunks.find(chunk => chunk.type === 'gAMA');
    if (!cicp && !profile.icc && !chunks.some(chunk => chunk.type === 'sRGB') && gamma) profile.gamma = new DataView(gamma.data.buffer, gamma.data.byteOffset).getUint32(0) / 100000;
    decoder = 'fast-png@8.0.0';
  } else if (probe.format === 'jpeg') {
    for (let offset = 2; offset + 4 < bytes.length;) {
      if (bytes[offset] !== 255 || bytes[offset + 1] === 218) break;
      const marker = bytes[offset + 1], size = (bytes[offset + 2] << 8) | bytes[offset + 3], segment = bytes.subarray(offset + 4, offset + size + 2);
      if (marker === 225 && text.decode(segment.subarray(0, 6)) === 'Exif\0\0') metadata.exif = segment.subarray(6).slice();
      if (marker === 225 && text.decode(segment.subarray(0, 29)) === 'http://ns.adobe.com/xap/1.0/\0') metadata.xmp = segment.subarray(29).slice();
      if ([192, 193, 194].includes(marker) && segment[5] === 4) throw new Error('unsupportedColorProfile');
      offset += size + 2;
    }
    const image = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 2048 });
    data = new Uint8Array(image.data.buffer, image.data.byteOffset, image.data.byteLength); width = image.width; height = image.height;
    const icc = jpegProfile(bytes);
    if (icc) profile = { icc, name: 'ICC' };
    decoder = 'jpeg-js@0.4.4';
  } else {
    const { decodeWebp } = await import('./webp.ts');
    const image = await decodeWebp(bytes, frame ?? 0);
    data = image.data; width = image.width; height = image.height;
    const icc = webpChunks(bytes).find(chunk => chunk.type === 'ICCP')?.data;
    metadata.exif = webpChunks(bytes).find(chunk => chunk.type === 'EXIF')?.data.slice();
    metadata.xmp = webpChunks(bytes).find(chunk => chunk.type === 'XMP ')?.data.slice();
    if (icc) profile = { icc: icc.slice(), name: 'ICC' };
    decoder = '@jsquash/webp@1.5.0';
  }
  const orientation: number = await exifr.orientation(bytes).catch(() => 1) || 1;
  const normalized = orient(data, width, height, orientation);
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer);
  const hash = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('') + (probe.frames > 1 ? `:${frame ?? 0}` : '');
  return { ...normalized, depth, profile, name, bytes, hash, orientation, decoder, metadata };
}

const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});
function packChunk(type: string, data: Uint8Array): Uint8Array {
  const result = new Uint8Array(data.length + 12), view = new DataView(result.buffer);
  view.setUint32(0, data.length); result.set(ascii.encode(type), 4); result.set(data, 8);
  let crc = 0xffffffff;
  for (let i = 4; i < result.length - 4; i++) crc = crcTable[(crc ^ result[i]) & 255] ^ (crc >>> 8);
  view.setUint32(result.length - 4, (crc ^ 0xffffffff) >>> 0);
  return result;
}

export function normalizedExif(bytes: Uint8Array, width: number, height: number): Uint8Array {
  const prefix = text.decode(bytes.subarray(0, 6)) === 'Exif\0\0' ? 6 : 0, result = new Uint8Array(bytes.subarray(prefix));
  if (result.length < 8) return result;
  const view = new DataView(result.buffer), little = result[0] === 73;
  const visited = new Set<number>();
  const walk = (offset: number) => {
    if (visited.has(offset) || offset + 2 > result.length) return;
    visited.add(offset);
    const count = view.getUint16(offset, little);
    for (let index = 0; index < count; index++) {
      const entry = offset + 2 + index * 12; if (entry + 12 > result.length) break;
      const tag = view.getUint16(entry, little), type = view.getUint16(entry + 2, little), count = view.getUint32(entry + 4, little);
      if (tag === 0x8769) walk(view.getUint32(entry + 8, little));
      const value = tag === 0x112 ? 1 : tag === 0x100 || tag === 0xa002 ? width : tag === 0x101 || tag === 0xa003 ? height : undefined;
      if (value !== undefined && count === 1) { if (type === 3) view.setUint16(entry + 8, value, little); if (type === 4) view.setUint32(entry + 8, value, little); }
    }
  };
  walk(view.getUint32(4, little));
  return result;
}

export function encodePng(width: number, height: number, data: PixelData, depth: 8 | 16, profile?: ColorProfile, channels = 4, metadata?: PhotoMetadata): Uint8Array {
  const png = encode({ width, height, data, depth, channels }, { zlib: { level: 3 } });
  const chunks: Uint8Array[] = [png.subarray(0, 33)];
  if (profile?.icc) chunks.push(packChunk('iCCP', join([ascii.encode('Revia profile'), new Uint8Array([0, 0]), zlibSync(profile.icc)])));
  else if (profile?.gamma) {
    const gamma = new Uint8Array(4); new DataView(gamma.buffer).setUint32(0, Math.round(profile.gamma * 100000)); chunks.push(packChunk('gAMA', gamma));
  } else if (profile) chunks.push(packChunk('sRGB', new Uint8Array([0])));
  if (metadata?.exif) chunks.push(packChunk('eXIf', normalizedExif(metadata.exif, width, height)));
  if (metadata?.resolution) chunks.push(packChunk('pHYs', metadata.resolution));
  if (metadata?.xmp) chunks.push(packChunk('iTXt', join([ascii.encode('XML:com.adobe.xmp'), new Uint8Array(5), metadata.xmp])));
  chunks.push(png.subarray(33));
  return join(chunks);
}

export function readEmbeddedProfile(bytes: Uint8Array): Uint8Array | undefined {
  const chunk = pngChunks(bytes).find(chunk => chunk.type === 'iCCP');
  if (!chunk) return;
  return unzlibSync(chunk.data.subarray(chunk.data.indexOf(0) + 2));
}
