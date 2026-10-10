import { WorkImage, toSrgb } from './color.ts';
import { align, median } from './alignment.ts';
import type { Alignment, Thumbnail } from './alignment.ts';
import { clamp, mapPoint, multiplyMatrices } from './types.ts';
import type { Region, Correction, Matrix, ProgressCallback, Run } from './types.ts';

export const checkpoint = async (signal?: AbortSignal) => { signal?.throwIfAborted(); await new Promise<void>(resolve => setTimeout(resolve, 0)); signal?.throwIfAborted(); };

export async function thumbnail(image: WorkImage, longest = 768, signal?: AbortSignal): Promise<Thumbnail> {
  const scale = Math.min(1, longest / Math.max(image.native.width, image.native.height));
  const width = Math.max(1, Math.round(image.native.width * scale)), height = Math.max(1, Math.round(image.native.height * scale));
  const scaleX = image.native.width / width, scaleY = image.native.height / height, pixels = new Float32Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) image.sample((x + 0.5) * scaleX - 0.5, (y + 0.5) * scaleY - 0.5, pixels, (y * width + x) * 4);
    if (y % 64 === 0) await checkpoint(signal);
  }
  return { width, height, pixels, scaleX, scaleY };
}

function smoothPixels(pixels: Float32Array, width: number, height: number, radius = 3): Float32Array {
  const horizontal = new Float32Array(pixels.length), output = new Float32Array(pixels.length);
  for (let y = 0; y < height; y++) for (let c = 0; c < 4; c++) {
    let sum = 0;
    for (let x = -radius; x <= radius; x++) sum += pixels[(y * width + clamp(x, 0, width - 1)) * 4 + c];
    for (let x = 0; x < width; x++) {
      horizontal[(y * width + x) * 4 + c] = sum / (radius * 2 + 1);
      sum += pixels[(y * width + Math.min(width - 1, x + radius + 1)) * 4 + c] - pixels[(y * width + Math.max(0, x - radius)) * 4 + c];
    }
  }
  for (let x = 0; x < width; x++) for (let c = 0; c < 4; c++) {
    let sum = 0;
    for (let y = -radius; y <= radius; y++) sum += horizontal[(clamp(y, 0, height - 1) * width + x) * 4 + c];
    for (let y = 0; y < height; y++) {
      output[(y * width + x) * 4 + c] = sum / (radius * 2 + 1);
      sum += horizontal[(Math.min(height - 1, y + radius + 1) * width + x) * 4 + c] - horizontal[(Math.max(0, y - radius) * width + x) * 4 + c];
    }
  }
  return output;
}

export const identityCorrection = (): Correction => ({ gain: [1, 1, 1], offset: [0, 0, 0], reliable: false });
const residual = (a: Float32Array, b: Float32Array, ai: number, bi: number) => {
  const alpha = Math.abs(a[ai + 3] - b[bi + 3]);
  if (Math.min(a[ai + 3], b[bi + 3]) < 0.05) return alpha;
  return Math.max(alpha, Math.hypot(toSrgb(Math.max(0, a[ai])) - toSrgb(Math.max(0, b[bi])), toSrgb(Math.max(0, a[ai + 1])) - toSrgb(Math.max(0, b[bi + 1])), toSrgb(Math.max(0, a[ai + 2])) - toSrgb(Math.max(0, b[bi + 2]))) / Math.sqrt(3));
};

function fitColor(a: Float32Array, b: Float32Array, valid: Uint8Array, width: number, height: number): Correction {
  const differences: number[] = [];
  for (let i = 0; i < valid.length; i += 3) if (valid[i] && a[i * 4 + 3] > 0.9 && b[i * 4 + 3] > 0.9) differences.push(residual(a, b, i * 4, i * 4));
  const limit = Math.max(0.015, median(differences) * 1.8), indices: number[] = [], cells = new Set<number>();
  for (let i = 0; i < valid.length; i += 3) {
    if (!valid[i] || a[i * 4 + 3] < 0.9 || b[i * 4 + 3] < 0.9 || residual(a, b, i * 4, i * 4) > limit) continue;
    const cell = Math.floor((i % width) * 4 / width) + Math.floor(Math.floor(i / width) * 4 / height) * 4;
    indices.push(i); cells.add(cell);
  }
  const result = identityCorrection();
  if (indices.length < 64 || cells.size < 8) return result;
  for (let c = 0; c < 3; c++) {
    let gain = 1, offset = 0;
    for (let iteration = 0; iteration < 5; iteration++) {
      let xx = 0.05, x = 0, one = 0.05, xy = 0.05, y = 0;
      for (const index of indices) {
        if ((Math.floor((index % width) / 32) + Math.floor(index / width / 32)) % 3 === 0) continue;
        const source = b[index * 4 + c], target = a[index * 4 + c];
        if (source < 0.01 || source > 0.95 || target < 0.01 || target > 0.95) continue;
        const error = target - source * gain - offset, weight = Math.min(1, 0.025 / Math.max(1e-8, Math.abs(error)));
        xx += weight * source * source; x += weight * source; one += weight; xy += weight * source * target; y += weight * target;
      }
      const det = xx * one - x * x;
      if (det <= 0.01) break;
      gain = clamp((xy * one - x * y) / det, 0.75, 1.3); offset = clamp((xx * y - x * xy) / det, -0.08, 0.08);
    }
    result.gain[c] = gain; result.offset[c] = offset;
  }
  let before = 0, after = 0, count = 0;
  for (const index of indices) if ((Math.floor((index % width) / 32) + Math.floor(index / width / 32)) % 3 === 0) {
    for (let c = 0; c < 3; c++) { before += Math.abs(a[index * 4 + c] - b[index * 4 + c]); after += Math.abs(a[index * 4 + c] - (b[index * 4 + c] * result.gain[c] + result.offset[c])); count++; }
  }
  result.reliable = count > 32 && after < before * 0.8;
  return result.reliable ? result : identityCorrection();
}

export type Analysis = { alignment: Alignment; regions: Region[]; correction: Correction; changedFraction: number | null; noise: number; needsReview: boolean };

export async function analyze(original: WorkImage, modified: WorkImage, options: { matrix?: Matrix; sensitivity: number; adjustment?: Matrix }, progress: ProgressCallback, signal?: AbortSignal): Promise<Analysis> {
  progress({ stage: 'alignment', fraction: 0 });
  const a = await thumbnail(original, 768, signal), b = await thumbnail(modified, 768, signal);
  const alignment: Alignment = options.matrix ? { matrix: options.matrix, model: 'affine', reliable: true, error: 0, inliers: 0, coverage: 1 } : align(a, b);
  if (options.adjustment) alignment.matrix = multiplyMatrices(alignment.matrix, options.adjustment);
  const aligned = new Float32Array(a.pixels.length), valid = new Uint8Array(a.width * a.height);
  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      const p = mapPoint(alignment.matrix, (x + 0.5) * a.scaleX, (y + 0.5) * a.scaleY), i = y * a.width + x;
      valid[i] = Number(modified.sample(p.x - 0.5, p.y - 0.5, aligned, i * 4));
    }
    if (y % 64 === 0) await checkpoint(signal);
  }
  progress({ stage: 'color', fraction: 0.2 });
  const correction = fitColor(a.pixels, aligned, valid, a.width, a.height), compensated = aligned.slice();
  if (correction.reliable) for (let i = 0; i < valid.length; i++) for (let c = 0; c < 3; c++) compensated[i * 4 + c] = compensated[i * 4 + c] * correction.gain[c] + correction.offset[c];
  const smoothA = smoothPixels(a.pixels, a.width, a.height), smoothB = smoothPixels(compensated, a.width, a.height);
  const block = 48, columns = Math.ceil(a.width / block), rows = Math.ceil(a.height / block);
  const samples = Array.from({ length: columns * rows }, () => [] as number[]), all: number[] = [];
  for (let y = 0; y < a.height; y += 2) for (let x = 0; x < a.width; x += 2) {
    const i = y * a.width + x;
    if (!valid[i]) continue;
    const difference = residual(smoothA, smoothB, i * 4, i * 4);
    samples[Math.floor(y / block) * columns + Math.floor(x / block)].push(difference); all.push(difference);
  }
  const globalMedian = median(all), globalMad = 1.4826 * median(all.map(value => Math.abs(value - globalMedian)));
  const noise = samples.map(values => {
    const center = median(values), deviation = 1.4826 * median(values.map(value => Math.abs(value - center)));
    const trusted = values.length > 20 && center < Math.max(0.04, globalMedian * 1.5);
    return { center: trusted ? Math.min(center, globalMedian + 0.025) : Math.min(globalMedian, 0.02), deviation: Math.max(0.008, trusted ? Math.min(deviation, Math.max(globalMad, 0.015)) : Math.min(globalMad, 0.015)) };
  });
  const coarse = new Float32Array(valid.length);
  for (let y = 1; y < a.height - 1; y++) for (let x = 1; x < a.width - 1; x++) {
    const i = y * a.width + x;
    if (!valid[i]) continue;
    const local = noise[Math.floor(y / block) * columns + Math.floor(x / block)];
    coarse[i] = Math.max(0, (residual(smoothA, smoothB, i * 4, i * 4) - local.center) / local.deviation);
  }

  const width = original.native.width, height = original.native.height, scores = new Uint8Array(width * height), av = new Float32Array(4), bv = new Float32Array(4);
  const nativeBlock = 64, nativeColumns = Math.ceil(width / nativeBlock);
  const nativeSamples = Array.from({ length: nativeColumns * Math.ceil(height / nativeBlock) }, () => [] as number[]), stableDifferences: number[] = [];
  for (let y = 0; y < height; y += 4) {
    for (let x = 0; x < width; x += 4) {
      const cx = Math.min(a.width - 1, Math.floor(x / a.scaleX)), cy = Math.min(a.height - 1, Math.floor(y / a.scaleY));
      if (coarse[cy * a.width + cx] > 2.5) continue;
      const point = mapPoint(alignment.matrix, x + 0.5, y + 0.5);
      if (!modified.sample(point.x - 0.5, point.y - 0.5, bv)) continue;
      original.pixel(x, y, av);
      if (correction.reliable) for (let c = 0; c < 3; c++) bv[c] = bv[c] * correction.gain[c] + correction.offset[c];
      const difference = residual(av, bv, 0, 0);
      nativeSamples[Math.floor(y / nativeBlock) * nativeColumns + Math.floor(x / nativeBlock)].push(difference); stableDifferences.push(difference);
    }
    if (y % 64 === 0) await checkpoint(signal);
  }
  const nativeMedian = median(stableDifferences), nativeMad = Math.max(0.008, 1.4826 * median(stableDifferences.map(value => Math.abs(value - nativeMedian))));
  const nativeNoise = nativeSamples.map(values => {
    if (values.length < 24) return { center: nativeMedian, deviation: nativeMad };
    const center = median(values), deviation = 1.4826 * median(values.map(value => Math.abs(value - center)));
    return { center: 0.8 * center + 0.2 * nativeMedian, deviation: Math.max(0.008, 0.8 * deviation + 0.2 * nativeMad) };
  });
  let validCount = 0, changed = 0;
  const low = 2.5 / options.sensitivity, high = 5 / options.sensitivity;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = mapPoint(alignment.matrix, x + 0.5, y + 0.5);
      if (!modified.sample(p.x - 0.5, p.y - 0.5, bv)) continue;
      validCount++;
      original.pixel(x, y, av);
      if (correction.reliable) for (let c = 0; c < 3; c++) bv[c] = bv[c] * correction.gain[c] + correction.offset[c];
      const cx = Math.min(a.width - 1, Math.floor(x / a.scaleX)), cy = Math.min(a.height - 1, Math.floor(y / a.scaleY));
      const local = nativeNoise[Math.floor(y / nativeBlock) * nativeColumns + Math.floor(x / nativeBlock)];
      const fine = Math.max(0, (residual(av, bv, 0, 0) - local.center) / local.deviation), coarseScore = coarse[cy * a.width + cx], score = fine * 0.35 + coarseScore * 0.65;
      const fineDetail = fine >= high * 5;
      const consistent = coarseScore >= low || fineDetail || Math.abs(av[3] - bv[3]) > 0.04;
      if (score >= low && consistent) { scores[y * width + x] = score >= high && consistent ? 2 : 1; changed++; }
    }
    if (y % 16 === 0) { progress({ stage: 'detection', fraction: 0.25 + 0.65 * y / height }); await checkpoint(signal); }
  }
  const regions = groupNearby(connectedRegions(scores, width, height), Math.max(8, Math.round(Math.max(width, height) / 48)));
  estimateSeams(regions, original, modified, alignment.matrix, correction, scores);
  const changedFraction = validCount ? changed / validCount : null;
  progress({ stage: 'detection', fraction: 1 });
  return { alignment, regions, correction, changedFraction, noise: globalMad, needsReview: !alignment.reliable || changedFraction === null || changedFraction > 0.45 };
}

function estimateSeams(regions: Region[], original: WorkImage, modified: WorkImage, matrix: Matrix, correction: Correction, scores: Uint8Array) {
  const a = new Float32Array(4), b = new Float32Array(4), width = original.native.width, height = original.native.height;
  for (const region of regions) {
    const residuals = [[], [], []] as number[][], quadrants = new Set<number>();
    const stride = Math.max(1, Math.floor(region.runs.length / 80));
    for (let index = 0; index < region.runs.length; index += stride) {
      const run = region.runs[index];
      for (const x of [run.start - 5, run.end + 5]) {
        if (x < 1 || x >= width - 1 || run.y < 1 || run.y >= height - 1 || scores[run.y * width + x]) continue;
        original.pixel(x, run.y, a); const p = mapPoint(matrix, x + 0.5, run.y + 0.5);
        if (!modified.sample(p.x - 0.5, p.y - 0.5, b) || Math.min(a[3], b[3]) < 0.9) continue;
        const delta = [0, 1, 2].map(c => a[c] - (b[c] * correction.gain[c] + correction.offset[c]));
        if (Math.max(...delta.map(Math.abs)) > 0.08) continue;
        quadrants.add(Number(x > region.bounds.x + region.bounds.width / 2) + Number(run.y > region.bounds.y + region.bounds.height / 2) * 2);
        for (let c = 0; c < 3; c++) residuals[c].push(delta[c]);
      }
    }
    if (residuals[0].length < 12 || quadrants.size < 3) continue;
    const center = residuals.map(values => median(values));
    if (residuals.some((values, c) => median(values.map(value => Math.abs(value - center[c]))) > 0.02)) continue;
    region.seam = center.map(value => clamp(value, -0.03, 0.03)) as [number, number, number];
  }
}

function groupNearby(regions: Region[], cell: number): Region[] {
  const large = regions.filter(region => Math.max(region.bounds.width, region.bounds.height) >= cell * 4);
  const small = regions.filter(region => Math.max(region.bounds.width, region.bounds.height) < cell * 4);
  const parents = small.map((_, index) => index), occupied = new Map<string, number>();
  const root = (index: number): number => { while (parents[index] !== index) { parents[index] = parents[parents[index]]; index = parents[index]; } return index; };
  small.forEach((region, index) => {
    const box = region.bounds;
    for (let y = Math.floor(box.y / cell); y <= Math.floor((box.y + box.height - 1) / cell); y++) for (let x = Math.floor(box.x / cell); x <= Math.floor((box.x + box.width - 1) / cell); x++) {
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const neighbor = occupied.get(`${x + dx},${y + dy}`);
        if (neighbor !== undefined) parents[root(index)] = root(neighbor);
      }
      occupied.set(`${x},${y}`, index);
    }
  });
  const groups = new Map<number, Region>();
  small.forEach((region, index) => {
    const key = root(index), previous = groups.get(key);
    if (!previous) { groups.set(key, region); return; }
    const right = Math.max(previous.bounds.x + previous.bounds.width, region.bounds.x + region.bounds.width), bottom = Math.max(previous.bounds.y + previous.bounds.height, region.bounds.y + region.bounds.height);
    previous.bounds.x = Math.min(previous.bounds.x, region.bounds.x); previous.bounds.y = Math.min(previous.bounds.y, region.bounds.y);
    previous.bounds.width = right - previous.bounds.x; previous.bounds.height = bottom - previous.bounds.y;
    previous.runs.push(...region.runs); previous.area += region.area;
  });
  return [...large, ...groups.values()].sort((a, b) => b.area - a.area);
}

export function connectedRegions(scores: Uint8Array, width: number, height: number): Region[] {
  const parents: number[] = [], runs: (Run & { label: number; seed: boolean })[] = [];
  let previous: typeof runs = [];
  const root = (label: number): number => { while (parents[label] !== label) { parents[label] = parents[parents[label]]; label = parents[label]; } return label; };
  for (let y = 0; y < height; y++) {
    const current: typeof runs = [];
    let cursor = 0;
    for (let x = 0; x < width;) {
      if (!scores[y * width + x]) { x++; continue; }
      const start = x; let seed = false;
      while (x < width && scores[y * width + x]) { seed ||= scores[y * width + x] === 2; x++; }
      const label = parents.length; parents.push(label);
      const run = { y, start, end: x, label, seed };
      while (cursor < previous.length && previous[cursor].end < start) cursor++;
      for (let i = cursor; i < previous.length && previous[i].start <= x; i++) parents[root(previous[i].label)] = root(label);
      current.push(run); runs.push(run);
    }
    previous = current;
  }
  const groups = new Map<number, { region: Region; seed: boolean }>();
  for (const run of runs) {
    const key = root(run.label);
    let group = groups.get(key);
    if (!group) {
      group = { seed: false, region: { bounds: { x: run.start, y: run.y, width: run.end - run.start, height: 1 }, runs: [], area: 0 } };
      groups.set(key, group);
    }
    const { region } = group, bounds = region.bounds;
    const right = Math.max(bounds.x + bounds.width, run.end); bounds.x = Math.min(bounds.x, run.start); bounds.width = right - bounds.x; bounds.height = run.y - bounds.y + 1;
    region.runs.push({ y: run.y, start: run.start, end: run.end }); region.area += run.end - run.start;
    group.seed ||= run.seed;
  }
  return [...groups.values()].filter(group => group.seed).map(group => group.region).sort((a, b) => b.area - a.area);
}
