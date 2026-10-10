import { encode } from 'fast-png';

export function imagePair() {
  const width = 96, originalPixels = new Uint8Array(width * width * 4).fill(255), editedPixels = originalPixels.slice();
  for (let y = 24; y < 72; y++) for (let x = 24; x < 72; x++) editedPixels.set([30, 90, 210, 255], (y * width + x) * 4);
  const file = (name: string, data: Uint8Array) => ({ name, mimeType: 'image/png', buffer: Buffer.from(encode({ width, height: width, data, channels: 4 })) });
  return { original: file('original.png', originalPixels), edited: file('edited.png', editedPixels), width, originalPixels, editedPixels };
}
