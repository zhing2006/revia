import { it, expect } from 'vitest';
import { align } from './alignment';
import { Engine } from './engine';
import { encodePng } from './image';
import { mapPoint } from './types';
import type { Matrix } from './types';

it('aligns rotated, scaled, and cropped texture without moving the original coordinate system', () => {
  const width = 192, height = 160, matrix: Matrix = [1.012, 0.018, -0.018, 1.012, 3.2, -2.4];
  const determinant = matrix[0] * matrix[3] - matrix[1] * matrix[2];
  const hash = (x: number, y: number) => { let value = Math.imul(x + 91, 73856093) ^ Math.imul(y + 13, 19349663); value = Math.imul(value ^ value >>> 16, 0x45d9f3b); value = Math.imul(value ^ value >>> 16, 0x45d9f3b); return ((value ^ value >>> 16) >>> 0) / 4294967295; };
  const signal = (x: number, y: number) => {
    const gx = Math.floor(x / 5), gy = Math.floor(y / 5), fx = x / 5 - gx, fy = y / 5 - gy;
    return hash(gx, gy) * (1 - fx) * (1 - fy) + hash(gx + 1, gy) * fx * (1 - fy) + hash(gx, gy + 1) * (1 - fx) * fy + hash(gx + 1, gy + 1) * fx * fy;
  };
  const a = new Float32Array(width * height * 4), b = new Float32Array(a.length);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const px = x + 0.5 - matrix[4], py = y + 0.5 - matrix[5], index = (y * width + x) * 4;
    const original = signal(x + 0.5, y + 0.5), edited = signal((matrix[3] * px - matrix[2] * py) / determinant, (-matrix[1] * px + matrix[0] * py) / determinant);
    a.set([original, original, original, 1], index); b.set([edited, edited, edited, 1], index);
  }
  const result = align({ width, height, pixels: a, scaleX: 1, scaleY: 1 }, { width, height, pixels: b, scaleX: 1, scaleY: 1 });
  expect(result.reliable).toBe(true);
  for (const point of [{ x: 24, y: 24 }, { x: 160, y: 130 }, { x: 90, y: 72 }]) {
    const expected = mapPoint(matrix, point.x, point.y), actual = mapPoint(result.matrix, point.x, point.y);
    expect(Math.hypot(actual.x - expected.x, actual.y - expected.y)).toBeLessThan(0.65);
  }
});

it('keeps a native one-pixel edit that disappears in a reduced preview', async () => {
  const width = 1600, height = 32, a = new Uint8Array(width * height * 4).fill(255), b = a.slice();
  for (let y = 10; y < 24; y++) b.set([0, 0, 0, 255], (y * width + 803) * 4);
  const engine = new Engine();
  await engine.load('original', encodePng(width, height, a, 8), 'original.png');
  await engine.load('modified', encodePng(width, height, b, 8), 'edited.png');
  await engine.analyze(() => {}, undefined, [1, 0, 0, 1, 0, 0]);
  for (let y = 10; y < 24; y++) expect(engine.mask!.sample(803, y)).toBeGreaterThan(0);
});

it('automatically masks both the old and new locations of a moved object', async () => {
  const width = 192, height = 96, a = new Uint8Array(width * height * 4).fill(255), b = a.slice();
  for (let y = 30; y < 54; y++) for (let x = 20; x < 44; x++) {
    const pixel = [30 + (x * y) % 50, 45, 160, 255];
    a.set(pixel, (y * width + x) * 4); b.set(pixel, (y * width + x + 110) * 4);
  }
  const engine = new Engine();
  await engine.load('original', encodePng(width, height, a, 8), 'original.png');
  await engine.load('modified', encodePng(width, height, b, 8), 'moved.png');
  await engine.analyze(() => {}, undefined, [1, 0, 0, 1, 0, 0]);
  const output = await engine.renderPixels(() => {});
  for (const x of [25, 135]) {
    const index = (40 * width + x) * 4;
    expect(engine.mask!.sample(x, 40)).toBe(1);
    expect(output.subarray(index, index + 4)).toEqual(b.subarray(index, index + 4));
  }
  expect(output.subarray(0, 4)).toEqual(a.subarray(0, 4));
});

it('aligns a low-contrast image without enough feature matches', () => {
  const width = 192, height = 160, a = new Float32Array(width * height * 4), b = a.slice();
  const signal = (x: number, y: number) => 0.3 + 0.08 * Math.exp(-((x - 55) ** 2 + (y - 45) ** 2) / 700) + 0.12 * Math.exp(-((x - 130) ** 2 + (y - 100) ** 2) / 400);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const original = signal(x, y), edited = signal(x - 3.2, y + 2.4) * 1.08 + 0.02;
    a.set([original, original, original, 1], (y * width + x) * 4);
    b.set([edited, edited, edited, 1], (y * width + x) * 4);
  }
  const result = align({ width, height, pixels: a, scaleX: 1, scaleY: 1 }, { width, height, pixels: b, scaleX: 1, scaleY: 1 });
  expect(result.reliable).toBe(true);
  for (const point of [{ x: 55, y: 45 }, { x: 130, y: 100 }]) {
    const actual = mapPoint(result.matrix, point.x, point.y);
    expect(Math.hypot(actual.x - point.x - 3.2, actual.y - point.y + 2.4)).toBeLessThan(0.3);
  }
});
