import { clamp, mapPoint } from './types.ts';
import type { Matrix, Point } from './types.ts';

export type Thumbnail = { width: number; height: number; pixels: Float32Array; scaleX: number; scaleY: number };
export type Match = { a: Point; b: Point; error?: number };
export type Alignment = { matrix: Matrix; model: 'identity' | 'translation' | 'similarity' | 'affine'; reliable: boolean; error: number; inliers: number; coverage: number };

export function solve(matrix: number[][], vector: number[]): number[] | undefined {
  const size = vector.length, rows = matrix.map((row, i) => [...row, vector[i]]);
  for (let i = 0; i < size; i++) {
    let pivot = i;
    for (let j = i + 1; j < size; j++) if (Math.abs(rows[j][i]) > Math.abs(rows[pivot][i])) pivot = j;
    if (Math.abs(rows[pivot][i]) < 1e-10) return;
    [rows[i], rows[pivot]] = [rows[pivot], rows[i]];
    const divisor = rows[i][i];
    for (let j = i; j <= size; j++) rows[i][j] /= divisor;
    for (let k = 0; k < size; k++) if (k !== i) {
      const factor = rows[k][i];
      for (let j = i; j <= size; j++) rows[k][j] -= factor * rows[i][j];
    }
  }
  return rows.map(row => row[size]);
}

function fit(matches: Match[], model: Alignment['model']): Matrix | undefined {
  if (model === 'identity') return [1, 0, 0, 1, 0, 0];
  if (model === 'translation') return [1, 0, 0, 1, median(matches.map(m => m.b.x - m.a.x)), median(matches.map(m => m.b.y - m.a.y))];
  const size = model === 'similarity' ? 4 : 6;
  const normal = Array.from({ length: size }, () => new Array<number>(size).fill(0)), rhs = new Array<number>(size).fill(0);
  const add = (row: number[], value: number) => {
    for (let i = 0; i < size; i++) { rhs[i] += row[i] * value; for (let j = 0; j < size; j++) normal[i][j] += row[i] * row[j]; }
  };
  for (const { a, b } of matches) {
    if (size === 4) { add([a.x, -a.y, 1, 0], b.x); add([a.y, a.x, 0, 1], b.y); }
    else { add([a.x, a.y, 1, 0, 0, 0], b.x); add([0, 0, 0, a.x, a.y, 1], b.y); }
  }
  const p = solve(normal, rhs);
  if (!p) return;
  return size === 4 ? [p[0], p[1], -p[1], p[0], p[2], p[3]] : [p[0], p[3], p[1], p[4], p[2], p[5]];
}

export function median(values: number[]): number {
  if (!values.length) return 0;
  values.sort((a, b) => a - b);
  const i = Math.floor(values.length / 2);
  return values.length % 2 ? values[i] : (values[i - 1] + values[i]) / 2;
}

export const luminance = (pixels: Float32Array, index: number) => pixels[index] * 0.2126 + pixels[index + 1] * 0.7152 + pixels[index + 2] * 0.0722;
export function grayImage(image: Thumbnail): Float32Array {
  return Float32Array.from({ length: image.width * image.height }, (_, i) => luminance(image.pixels, i * 4));
}

function interpolate(data: Float32Array, width: number, height: number, x: number, y: number): number {
  x = clamp(x, 0, width - 1); y = clamp(y, 0, height - 1);
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  return data[iy * width + ix] * (1 - fx) * (1 - fy) + data[iy * width + Math.min(ix + 1, width - 1)] * fx * (1 - fy) + data[Math.min(iy + 1, height - 1) * width + ix] * (1 - fx) * fy + data[Math.min(iy + 1, height - 1) * width + Math.min(ix + 1, width - 1)] * fx * fy;
}

type Feature = { point: Point; descriptor: Uint32Array; score: number };
function features(image: Thumbnail): Feature[] {
  const data = grayImage(image), { width, height } = image;
  const cells = new Map<number, Feature[]>();
  for (let y = 10; y < height - 10; y += 2) for (let x = 10; x < width - 10; x += 2) {
    if (image.pixels[(y * width + x) * 4 + 3] < 0.8) continue;
    let xx = 0, yy = 0, xy = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const i = (y + dy) * width + x + dx, gx = data[i + 1] - data[i - 1], gy = data[i + width] - data[i - width];
      xx += gx * gx; yy += gy * gy; xy += gx * gy;
    }
    const score = xx * yy - xy * xy - 0.045 * (xx + yy) ** 2;
    if (score < 0.000002) continue;
    const cell = Math.floor(y / 40) * Math.ceil(width / 40) + Math.floor(x / 40), list = cells.get(cell) ?? [];
    list.push({ point: { x, y }, score, descriptor: new Uint32Array(8) });
    list.sort((a, b) => b.score - a.score);
    if (list.length > 5) list.length = 5;
    cells.set(cell, list);
  }
  const result = [...cells.values()].flat().sort((a, b) => b.score - a.score).slice(0, 800);
  for (const feature of result) {
    const { x, y } = feature.point;
    let seed = 72831;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return (seed % 17) - 8; };
    for (let bit = 0; bit < 256; bit++) {
      const ax = random(), ay = random(), bx = random(), by = random();
      if (data[(y + ay) * width + x + ax] < data[(y + by) * width + x + bx]) feature.descriptor[bit >>> 5] |= 1 << (bit & 31);
    }
  }
  return result;
}

function distance(a: Uint32Array, b: Uint32Array): number {
  let total = 0;
  for (let i = 0; i < a.length; i++) {
    let v = (a[i] ^ b[i]) >>> 0;
    v -= (v >>> 1) & 0x55555555;
    v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
    total += (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
  }
  return total;
}

function matchFeatures(a: Thumbnail, b: Thumbnail): Match[] {
  const fa = features(a), fb = features(b), matches: Match[] = [], reverse = new Map<number, { index: number; distance: number }>();
  const forward: { index: number; distance: number; second: number }[] = [];
  fa.forEach((feature, ai) => {
    let index = -1, best = 257, second = 257;
    fb.forEach((target, bi) => {
      const d = distance(feature.descriptor, target.descriptor);
      if (d < best) { second = best; best = d; index = bi; } else if (d < second) second = d;
      if (d < (reverse.get(bi)?.distance ?? Infinity)) reverse.set(bi, { index: ai, distance: d });
    });
    forward.push({ index, distance: best, second });
  });
  forward.forEach((match, i) => {
    if (match.distance < 64 && match.distance < 0.8 * match.second && reverse.get(match.index)?.index === i) matches.push({ a: fa[i].point, b: fb[match.index].point });
  });
  return matches;
}

const residual = (match: Match, matrix: Matrix) => { const p = mapPoint(matrix, match.a.x, match.a.y); return Math.hypot(p.x - match.b.x, p.y - match.b.y); };

export function align(a: Thumbnail, b: Thumbnail): Alignment {
  const all = matchFeatures(a, b);
  const training = all.filter(m => (Math.floor(m.a.x / 48) + Math.floor(m.a.y / 48)) % 3 !== 0);
  const validation = all.filter(m => !training.includes(m));
  let best: Alignment = { matrix: [1, 0, 0, 1, 0, 0], model: 'identity', reliable: false, error: Infinity, inliers: 0, coverage: 0 };
  let bestCost = Infinity, seed = 19384;
  for (const model of ['identity', 'translation', 'similarity', 'affine'] as const) {
    const count = model === 'affine' ? 3 : model === 'similarity' ? 2 : 1;
    if (training.length < count || validation.length < 4) continue;
    let inliers: Match[] = [];
    for (let iteration = 0; iteration < (model === 'identity' ? 1 : 350); iteration++) {
      const sample: Match[] = [];
      for (let i = 0; i < count; i++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; sample.push(training[seed % training.length]); }
      const matrix = fit(sample, model);
      if (!matrix) continue;
      const determinant = matrix[0] * matrix[3] - matrix[1] * matrix[2];
      if (determinant < 0.25 || determinant > 4) continue;
      const current = training.filter(match => residual(match, matrix) < 2.5);
      if (current.length > inliers.length) inliers = current;
    }
    if (inliers.length < Math.max(6, count * 3)) continue;
    const matrix = fit(inliers, model)!;
    const heldOut = validation.map(match => residual(match, matrix)), accepted = heldOut.filter(error => error < 3);
    const cells = new Set(inliers.map(match => `${Math.floor(match.a.x * 4 / a.width)},${Math.floor(match.a.y * 4 / a.height)}`));
    const coverage = cells.size / 16, error = median(accepted), ratio = accepted.length / heldOut.length;
    const cost = median(heldOut.map(error => Math.min(error, 12))) + count * 0.12;
    if (cost < bestCost && ratio >= 0.5 && coverage >= 0.25) {
      bestCost = cost;
      best = { matrix, model, error, coverage, inliers: inliers.length, reliable: true };
    }
  }
  if (!best.reliable) {
    const aa = reduce(a, 4), bb = reduce(b, 4);
    let initial: Matrix = [bb.width / aa.width, 0, 0, bb.height / aa.height, 0, 0];
    let score = photometricLoss(aa, bb, initial);
    const radius = Math.min(12, Math.floor(Math.min(aa.width, aa.height) / 5));
    for (let y = -radius; y <= radius; y += 2) for (let x = -radius; x <= radius; x += 2) {
      const trial: Matrix = [initial[0], 0, 0, initial[3], x, y], value = photometricLoss(aa, bb, trial);
      if (value + 0.0001 < score) { score = value; initial = trial; }
    }
    initial = refine(aa, bb, initial, 'similarity');
    score = photometricLoss(aa, bb, initial);
    if (score < 0.08) {
      const ax = a.width / aa.width, ay = a.height / aa.height, bx = b.width / bb.width, by = b.height / bb.height;
      best = { matrix: [initial[0] * bx / ax, initial[1] * by / ax, initial[2] * bx / ay, initial[3] * by / ay, initial[4] * bx, initial[5] * by], model: 'similarity', reliable: true, error: 0, inliers: 0, coverage: 1 };
    } else best.matrix = [b.width / a.width, 0, 0, b.height / a.height, 0, 0];
  }
  if (best.reliable) {
    for (const factor of [4, 2, 1]) {
      const aa = reduce(a, factor), bb = reduce(b, factor), ax = a.width / aa.width, ay = a.height / aa.height, bx = b.width / bb.width, by = b.height / bb.height, m = best.matrix;
      const scaled: Matrix = [m[0] * ax / bx, m[1] * ax / by, m[2] * ay / bx, m[3] * ay / by, m[4] / bx, m[5] / by];
      const result = refine(aa, bb, scaled, best.model === 'identity' ? 'translation' : best.model);
      best.matrix = [result[0] * bx / ax, result[1] * by / ax, result[2] * bx / ay, result[3] * by / ay, result[4] * bx, result[5] * by];
    }
  }
  const m = best.matrix;
  best.matrix = [m[0] * b.scaleX / a.scaleX, m[1] * b.scaleY / a.scaleX, m[2] * b.scaleX / a.scaleY, m[3] * b.scaleY / a.scaleY, m[4] * b.scaleX, m[5] * b.scaleY];
  return best;
}

function photometricLoss(a: Thumbnail, b: Thumbnail, matrix: Matrix): number {
  const ga = grayImage(a), gb = grayImage(b), samples: [number, number][] = [];
  let total = 0;
  for (let y = 2; y < a.height - 2; y += 3) for (let x = 2; x < a.width - 2; x += 3) {
    total++;
    const p = mapPoint(matrix, x, y);
    if (p.x < 1 || p.y < 1 || p.x >= b.width - 1 || p.y >= b.height - 1 || a.pixels[(y * a.width + x) * 4 + 3] < 0.9) continue;
    samples.push([ga[y * a.width + x], interpolate(gb, b.width, b.height, p.x, p.y)]);
  }
  if (samples.length < Math.max(20, total * 0.6)) return Infinity;
  const offsets = samples.map(([x, y]) => x - y), center = median(offsets), deviation = Math.max(0.015, 1.4826 * median(offsets.map(value => Math.abs(value - center))));
  const stable = samples.filter(([x, y]) => Math.abs(x - y - center) < deviation * 2.5);
  const meanA = stable.reduce((sum, p) => sum + p[0], 0) / stable.length, meanB = stable.reduce((sum, p) => sum + p[1], 0) / stable.length;
  let aa = 0, bb = 0, ab = 0;
  for (const [x, y] of stable) { aa += (x - meanA) ** 2; bb += (y - meanB) ** 2; ab += (x - meanA) * (y - meanB); }
  return Math.min(aa, bb) < 0.00001 * stable.length ? Infinity : 1 - ab / Math.sqrt(aa * bb);
}

function reduce(image: Thumbnail, factor: number): Thumbnail {
  if (factor === 1) return image;
  const width = Math.ceil(image.width / factor), height = Math.ceil(image.height / factor), pixels = new Float32Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    let count = 0, alpha = 0;
    for (let dy = 0; dy < factor; dy++) for (let dx = 0; dx < factor; dx++) {
      const sx = x * factor + dx, sy = y * factor + dy; if (sx >= image.width || sy >= image.height) continue;
      const j = (sy * image.width + sx) * 4, a = image.pixels[j + 3]; count++; alpha += a;
      for (let c = 0; c < 3; c++) pixels[i + c] += image.pixels[j + c] * a;
    }
    if (alpha) for (let c = 0; c < 3; c++) pixels[i + c] /= alpha;
    pixels[i + 3] = alpha / count;
  }
  return { width, height, pixels, scaleX: image.scaleX * image.width / width, scaleY: image.scaleY * image.height / height };
}

function refine(a: Thumbnail, b: Thumbnail, initial: Matrix, model: Alignment['model']): Matrix {
  if (model === 'identity') return initial;
  const ga = grayImage(a), gb = grayImage(b), dimensions = model === 'translation' ? 2 : model === 'similarity' ? 4 : 6;
  let current = [...initial] as Matrix;
  const evaluate = (matrix: Matrix, fit: boolean) => {
    const lhs = Array.from({ length: dimensions }, () => new Array<number>(dimensions).fill(0)), rhs = new Array<number>(dimensions).fill(0);
    const samples: { x: number; y: number; target: number; value: number; px: number; py: number }[] = [];
    for (let y = 4; y < a.height - 4; y += 4) for (let x = 4; x < a.width - 4; x += 4) {
      if (a.pixels[(y * a.width + x) * 4 + 3] < 0.8 || ((Math.floor(x / 48) + Math.floor(y / 48)) % 3 === 0) === fit) continue;
      const p = mapPoint(matrix, x, y);
      if (p.x < 2 || p.y < 2 || p.x >= b.width - 2 || p.y >= b.height - 2) continue;
      samples.push({ x, y, px: p.x, py: p.y, target: ga[y * a.width + x], value: interpolate(gb, b.width, b.height, p.x, p.y) });
    }
    const offsets = samples.map(s => s.target - s.value), center = median(offsets), scale = Math.max(0.01, 1.4826 * median(offsets.map(value => Math.abs(value - center))));
    const stable = samples.filter(sample => Math.abs(sample.target - sample.value - center) <= 2.5 * scale);
    if (stable.length < 12) return { lhs, rhs, error: Infinity };
    const meanA = stable.reduce((sum, sample) => sum + sample.target, 0) / stable.length, meanB = stable.reduce((sum, sample) => sum + sample.value, 0) / stable.length;
    const sigmaA = Math.sqrt(stable.reduce((sum, sample) => sum + (sample.target - meanA) ** 2, 0) / stable.length), sigmaB = Math.sqrt(stable.reduce((sum, sample) => sum + (sample.value - meanB) ** 2, 0) / stable.length);
    if (Math.min(sigmaA, sigmaB) < 0.0001) return { lhs, rhs, error: Infinity };
    const jacobians: number[][] = [], meanJacobian = new Array<number>(dimensions).fill(0), projectedJacobian = new Array<number>(dimensions).fill(0);
    let correlation = 0;
    for (const sample of stable) {
      const na = (sample.target - meanA) / sigmaA, nb = (sample.value - meanB) / sigmaB;
      correlation += na * nb / stable.length;
      if (!fit) continue;
      const gx = (interpolate(gb, b.width, b.height, sample.px + 1, sample.py) - interpolate(gb, b.width, b.height, sample.px - 1, sample.py)) / 2;
      const gy = (interpolate(gb, b.width, b.height, sample.px, sample.py + 1) - interpolate(gb, b.width, b.height, sample.px, sample.py - 1)) / 2;
      const row = dimensions === 2 ? [gx, gy] : dimensions === 4 ? [gx * sample.x + gy * sample.y, -gx * sample.y + gy * sample.x, gx, gy] : [gx * sample.x, gx * sample.y, gx, gy * sample.x, gy * sample.y, gy];
      jacobians.push(row);
      for (let i = 0; i < dimensions; i++) { meanJacobian[i] += row[i] / stable.length; projectedJacobian[i] += nb * row[i] / stable.length; }
    }
    if (fit) stable.forEach((sample, index) => {
      const na = (sample.target - meanA) / sigmaA, nb = (sample.value - meanB) / sigmaB, delta = na - nb;
      const row = jacobians[index].map((value, i) => (value - meanJacobian[i] - nb * projectedJacobian[i]) / sigmaB);
      for (let i = 0; i < dimensions; i++) { rhs[i] += row[i] * delta; for (let j = 0; j < dimensions; j++) lhs[i][j] += row[i] * row[j]; }
    });
    return { lhs, rhs, error: 1 - correlation };
  };
  let previous = evaluate(current, false).error;
  for (let i = 0; i < 8; i++) {
    const step = evaluate(current, true), p = solve(step.lhs, step.rhs);
    if (!p) break;
    const next = [...current] as Matrix;
    if (dimensions === 2) { next[4] += p[0]; next[5] += p[1]; }
    else if (dimensions === 4) { next[0] += p[0]; next[3] += p[0]; next[1] += p[1]; next[2] -= p[1]; next[4] += p[2]; next[5] += p[3]; }
    else { next[0] += p[0]; next[2] += p[1]; next[4] += p[2]; next[1] += p[3]; next[3] += p[4]; next[5] += p[5]; }
    const error = evaluate(next, false).error;
    if (error >= previous) break;
    current = next; previous = error;
  }
  return current;
}
