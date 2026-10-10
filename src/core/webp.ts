import decode, { init } from '@jsquash/webp/decode.js';
import { join, webpChunks } from './image.ts';

let ready: Promise<void> | undefined;
const uint24 = (bytes: Uint8Array, offset: number) => bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
function riff(chunks: Uint8Array): Uint8Array {
  const header = new Uint8Array(12);
  header.set(new TextEncoder().encode('RIFF'), 0); header.set(new TextEncoder().encode('WEBP'), 8);
  new DataView(header.buffer).setUint32(4, chunks.length + 4, true);
  return join([header, chunks]);
}

export async function decodeWebp(bytes: Uint8Array, frameIndex: number) {
  ready ??= (async () => {
    if (typeof process !== 'undefined' && process.versions?.node) {
      const path = (await import('node:module')).createRequire(import.meta.url).resolve('@jsquash/webp/codec/dec/webp_dec.wasm');
      const binary = await (await import('node:fs/promises')).readFile(path);
      await init(await WebAssembly.compile(new Uint8Array(binary)));
    } else {
      const { default: url } = await import('@jsquash/webp/codec/dec/webp_dec.wasm?url');
      await init({ locateFile: () => url });
    }
  })();
  await ready;
  const chunks = webpChunks(bytes), frames = chunks.filter(chunk => chunk.type === 'ANMF');
  if (!frames.length) {
    const image = await decode(new Uint8Array(bytes).buffer);
    return { width: image.width, height: image.height, data: new Uint8Array(image.data.buffer) };
  }
  const header = chunks.find(chunk => chunk.type === 'VP8X')!.data;
  const width = uint24(header, 4) + 1, height = uint24(header, 7) + 1, data = new Uint8Array(width * height * 4);
  const animation = chunks.find(chunk => chunk.type === 'ANIM')!.data;
  const background = [animation[2], animation[1], animation[0], animation[3]];
  for (let i = 0; i < data.length; i += 4) data.set(background, i);
  for (let index = 0; index <= frameIndex; index++) {
    const frame = frames[index].data, x = uint24(frame, 0) * 2, y = uint24(frame, 3) * 2;
    const image = await decode(riff(frame.subarray(16)).buffer as ArrayBuffer);
    for (let sy = 0; sy < image.height; sy++) for (let sx = 0; sx < image.width; sx++) {
      const from = (sy * image.width + sx) * 4, to = ((sy + y) * width + sx + x) * 4;
      const alpha = image.data[from + 3] / 255, oldAlpha = data[to + 3] / 255;
      if (frame[15] & 2) data.set(image.data.subarray(from, from + 4), to);
      else {
        const resultAlpha = alpha + oldAlpha * (1 - alpha);
        for (let c = 0; c < 3; c++) data[to + c] = resultAlpha ? Math.round((image.data[from + c] * alpha + data[to + c] * oldAlpha * (1 - alpha)) / resultAlpha) : 0;
        data[to + 3] = Math.round(resultAlpha * 255);
      }
    }
    if (index < frameIndex && (frame[15] & 1)) for (let sy = 0; sy < image.height; sy++) for (let sx = 0; sx < image.width; sx++) data.set(background, ((sy + y) * width + sx + x) * 4);
  }
  return { width, height, data };
}
