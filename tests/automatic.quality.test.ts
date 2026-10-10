import { expect, it } from 'vitest';
import sharp from 'sharp';
import { Engine } from '../src/core/engine';
import { encodePng } from '../src/core/image';
import { toSrgb } from '../src/core/color';
import { mapPoint } from '../src/core/types';
import type { Matrix } from '../src/core/types';

const width = 192, height = 160;
function texture(x: number, y: number) {
  const hash = (x: number, y: number) => {
    let n = Math.imul(x + 91, 73856093) ^ Math.imul(y + 13, 19349663);
    n = Math.imul(n ^ n >>> 16, 0x45d9f3b); n = Math.imul(n ^ n >>> 16, 0x45d9f3b);
    return ((n ^ n >>> 16) >>> 0) / 4294967295;
  };
  const gx = Math.floor(x / 5), gy = Math.floor(y / 5), fx = x / 5 - gx, fy = y / 5 - gy;
  return hash(gx, gy) * (1 - fx) * (1 - fy) + hash(gx + 1, gy) * fx * (1 - fy) + hash(gx, gy + 1) * (1 - fx) * fy + hash(gx + 1, gy + 1) * fx * fy;
}
const toByte = (value: number) => Math.round(toSrgb(Math.max(0, Math.min(1, value))) * 255);

it.each([
  { name: 'subpixel translation and color cast', matrix: [1, 0, 0, 1, 2.3, -1.7] as Matrix, jpeg: false },
  { name: 'rotation, scale, and color cast', matrix: [1.012, 0.018, -0.018, 1.012, 3.2, -2.4] as Matrix, jpeg: false },
  { name: 'blurred JPEG with color cast', matrix: [1, 0, 0, 1, 0, 0] as Matrix, jpeg: true },
])('automatically aligns and masks $name without adopting surrounding damage', async ({ matrix, jpeg }) => {
  const a = new Uint8Array(width * height * 4), b = a.slice(), determinant = matrix[0] * matrix[3] - matrix[1] * matrix[2];
  const edit = [0.06, 0.15, 0.65], gains = [1.08, 0.94, 1.04], offsets = [0.018, -0.012, 0.008];
  const color = (x: number, y: number) => { const t = texture(x, y); return [0.15 + t * 0.45, 0.13 + t * 0.4, 0.1 + t * 0.37]; };
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const px = x + 0.5 - matrix[4], py = y + 0.5 - matrix[5];
    const ox = (matrix[3] * px - matrix[2] * py) / determinant, oy = (-matrix[1] * px + matrix[0] * py) / determinant;
    const original = color(x + 0.5, y + 0.5), modified = ox >= 70 && ox < 118 && oy >= 55 && oy < 103 ? edit : color(ox, oy);
    const i = (y * width + x) * 4;
    a.set([...original.map(toByte), 255], i); b.set([...modified.map((v, c) => toByte(v * gains[c] + offsets[c])), 255], i);
  }
  const engine = new Engine();
  await engine.load('original', encodePng(width, height, a, 8), 'original.png');
  const encoded = jpeg ? await sharp(b, { raw: { width, height, channels: 4 } }).blur(0.6).jpeg({ quality: 55 }).toBuffer() : encodePng(width, height, b, 8);
  await engine.load('modified', encoded, jpeg ? 'edited.jpg' : 'edited.png');
  await engine.analyze(() => {});
  for (const point of [{ x: 30, y: 30 }, { x: 155, y: 125 }]) {
    const expected = mapPoint(matrix, point.x, point.y), actual = mapPoint(engine.parameters.matrix, point.x, point.y);
    expect(Math.hypot(actual.x - expected.x, actual.y - expected.y)).toBeLessThan(0.8);
  }
  let extra = 0, background = 0, missed = 0;
  for (let y = 10; y < height - 10; y++) for (let x = 10; x < width - 10; x++) {
    if (x < 64 || x > 124 || y < 49 || y > 109) { background++; if (engine.mask!.sample(x, y) > 0) extra++; }
    if (x >= 77 && x < 111 && y >= 62 && y < 96 && engine.mask!.sample(x, y) < 0.95) missed++;
  }
  expect(extra / background).toBeLessThan(0.01);
  expect(missed).toBe(0);
  const output = await engine.renderPixels(() => {}), center = (80 * width + 94) * 4;
  for (let c = 0; c < 3; c++) expect(Math.abs(output[center + c] - toByte(edit[c]))).toBeLessThan(12);
  expect(output.subarray(0, 4)).toEqual(a.subarray(0, 4));
});
