import { checkpoint } from './analysis.ts';
import { clamp, mapPoint } from './types.ts';
import type { Region, Matrix, Point, ProgressCallback } from './types.ts';
import type { WorkImage } from './color.ts';

export type WarpField = { width: number; height: number; columns: number; rows: number; dx: number[]; dy: number[]; confidence: number[] };
const smooth = (value: number) => value * value * (3 - 2 * value);

export function warpOffset(field: WarpField, x: number, y: number, distance: number): Point {
  const gx = clamp(x / field.width * field.columns - 0.5, 0, field.columns - 1), gy = clamp(y / field.height * field.rows - 0.5, 0, field.rows - 1);
  const ix = Math.floor(gx), iy = Math.floor(gy), fx = gx - ix, fy = gy - iy;
  let dx = 0, dy = 0;
  for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) {
    const index = Math.min(field.rows - 1, iy + y) * field.columns + Math.min(field.columns - 1, ix + x);
    const weight = (x ? fx : 1 - fx) * (y ? fy : 1 - fy) * field.confidence[index];
    dx += field.dx[index] * weight; dy += field.dy[index] * weight;
  }
  const fade = 1 - smooth(clamp(distance / 32));
  return { x: dx * fade, y: dy * fade };
}

export async function estimateWarp(original: WorkImage, modified: WorkImage, matrix: Matrix, regions: Region[], progress: ProgressCallback, signal?: AbortSignal): Promise<WarpField | undefined> {
  const width = original.native.width, height = original.native.height;
  const columns = clamp(Math.ceil(width / 100), 3, 24), rows = clamp(Math.ceil(height / 100), 3, 24), count = columns * rows;
  const field: WarpField = { width, height, columns, rows, dx: new Array(count).fill(0), dy: new Array(count).fill(0), confidence: new Array(count).fill(0) };
  const displacement = Math.min(6, width / columns * 0.08, height / rows * 0.08), spacing = Math.max(1, Math.max(width, height) / 900);
  const edited = new Map<number, { start: number; end: number }[]>();
  for (const region of regions) for (const run of region.runs) { const row = edited.get(run.y) ?? []; row.push(run); edited.set(run.y, row); }
  const a = new Float32Array(4), b = new Float32Array(4);
  let supported = 0;
  for (let gy = 0; gy < rows; gy++) {
    for (let gx = 0; gx < columns; gx++) {
      const cx = (gx + 0.5) * width / columns, cy = (gy + 0.5) * height / rows, samples: { point: Point; a: number; parity: number }[] = [];
      for (let y = -2; y <= 2; y++) for (let x = -2; x <= 2; x++) {
        const ox = Math.round(cx + x * spacing * 2), oy = Math.round(cy + y * spacing * 2);
        if (ox < 0 || oy < 0 || ox >= width || oy >= height || edited.get(oy)?.some(run => ox >= run.start && ox < run.end)) continue;
        original.pixel(ox, oy, a); const point = mapPoint(matrix, ox + 0.5, oy + 0.5);
        if (!modified.sample(point.x - 0.5, point.y - 0.5, b) || Math.min(a[3], b[3]) < 0.9) continue;
        if (Math.max(...[0, 1, 2].map(c => Math.abs(a[c] - b[c]))) > 0.15) continue;
        samples.push({ point, a: a[0] * 0.2126 + a[1] * 0.7152 + a[2] * 0.0722, parity: (x + y + 4) % 2 });
      }
      if (samples.length < 18) continue;
      const loss = (dx: number, dy: number, parity: number) => {
        const pairs: [number, number][] = [];
        for (const sample of samples) if (sample.parity === parity && modified.sample(sample.point.x - 0.5 + dx, sample.point.y - 0.5 + dy, b)) pairs.push([sample.a, b[0] * 0.2126 + b[1] * 0.7152 + b[2] * 0.0722]);
        if (pairs.length < 7) return Infinity;
        const meanA = pairs.reduce((sum, p) => sum + p[0], 0) / pairs.length, meanB = pairs.reduce((sum, p) => sum + p[1], 0) / pairs.length;
        const variance = pairs.reduce((sum, p) => sum + (p[0] - meanA) ** 2, 0);
        if (variance < 0.0001) return Infinity;
        return pairs.reduce((sum, p) => sum + ((p[0] - meanA) - (p[1] - meanB)) ** 2, 0) / variance;
      };
      const baseline = loss(0, 0, 0); if (!Number.isFinite(baseline)) continue;
      let best = baseline, dx = 0, dy = 0;
      for (let oy = -2; oy <= 2; oy++) for (let ox = -2; ox <= 2; ox++) {
        const error = loss(ox * displacement / 2, oy * displacement / 2, 0);
        if (error < best) { best = error; dx = ox * displacement / 2; dy = oy * displacement / 2; }
      }
      const heldOut = loss(dx, dy, 1), originalError = loss(0, 0, 1), index = gy * columns + gx;
      if (heldOut < 0.2 && heldOut < originalError * 0.8) { field.dx[index] = dx; field.dy[index] = dy; field.confidence[index] = 1; supported++; }
      else if (originalError < 0.1) { field.confidence[index] = 1; supported++; }
    }
    progress({ stage: 'alignment', fraction: (gy + 1) / rows }); await checkpoint(signal);
  }
  if (supported < Math.max(3, count * 0.15)) return;
  return field;
}
