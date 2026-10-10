import { clamp, union } from './types.ts';
import type { Brush, Region, Point, Rect } from './types.ts';

export const TILE_SIZE = 128;
const TILE_PIXELS = TILE_SIZE * TILE_SIZE;
export type MaskTile = { values: Float32Array; flags: Uint8Array };
export type MaskPatch = { key: number; before?: MaskTile; after?: MaskTile };
const copyTile = (tile?: MaskTile): MaskTile | undefined => tile && { values: tile.values.slice(), flags: tile.flags.slice() };

export class Mask {
  readonly width: number;
  readonly height: number;
  readonly columns: number;
  tiles = new Map<number, MaskTile>();
  private transaction?: Map<number, MaskTile | undefined>;
  private rows = new Map<number, { start: number; end: number; region: Region }[]>();
  private edgeTiles = new Map<number, Float32Array>();
  private regions?: Region[];
  private feather = 0;
  private boundary?: { rect: Rect; distances: Uint8Array | Float32Array };
  private copyOnWrite = false;
  private detached = new Set<number>();

  constructor(width: number, height: number) {
    this.width = width; this.height = height;
    this.columns = Math.ceil(width / TILE_SIZE);
  }

  fork(): Mask {
    const copy = new Mask(this.width, this.height);
    copy.tiles = new Map(this.tiles); copy.rows = this.rows; copy.edgeTiles = this.edgeTiles; copy.regions = this.regions; copy.feather = this.feather; copy.boundary = this.boundary; copy.copyOnWrite = true;
    return copy;
  }

  setRegions(regions: Region[], feather = 0, guide?: (x: number, y: number) => number) {
    if (this.regions === regions && this.feather === feather) return;
    this.regions = regions; this.feather = feather;
    this.rows = new Map();
    for (const region of regions) {
      for (const run of region.runs) {
        const row = this.rows.get(run.y) ?? [];
        row.push({ ...run, region });
        this.rows.set(run.y, row);
      }
    }
    this.refineEdges(feather, guide);
  }

  private refineEdges(radius: number, guide?: (x: number, y: number) => number) {
    this.edgeTiles = new Map();
    this.boundary = undefined;
    if (!this.rows.size) return;
    const r = Math.max(32, Math.ceil(radius)), ys = [...this.rows.keys()];
    let left = this.width, right = 0;
    for (const runs of this.rows.values()) for (const run of runs) { left = Math.min(left, run.start); right = Math.max(right, run.end); }
    left = Math.max(0, left - r); right = Math.min(this.width, right + r);
    const top = Math.max(0, Math.min(...ys) - r), bottom = Math.min(this.height, Math.max(...ys) + r), width = right - left, height = bottom - top;
    const binary = new Uint8Array(width * height), distances = r < 255 ? new Uint8Array(binary.length).fill(r + 1) : new Float32Array(binary.length).fill(Infinity);
    for (const [y, runs] of this.rows) for (const run of runs) binary.fill(1, (y - top) * width + run.start - left, (y - top) * width + run.end - left);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const i = y * width + x, value = binary[i];
      if ((x && binary[i - 1] !== value) || (y && binary[i - width] !== value) || (x + 1 < width && binary[i + 1] !== value) || (y + 1 < height && binary[i + width] !== value)) distances[i] = 0;
      if (x) distances[i] = Math.min(distances[i], distances[i - 1] + 1);
      if (y) distances[i] = Math.min(distances[i], distances[i - width] + 1);
    }
    for (let y = height - 1; y >= 0; y--) for (let x = width - 1; x >= 0; x--) {
      const i = y * width + x;
      if (x + 1 < width) distances[i] = Math.min(distances[i], distances[i + 1] + 1);
      if (y + 1 < height) distances[i] = Math.min(distances[i], distances[i + width] + 1);
      if (distances[i] >= radius) continue;
      const ix = x + left, iy = y + top, gradient = guide?.(ix, iy) ?? 0;
      const spread = radius * Math.max(0.2, 1 - gradient * 6);
      const t = clamp(0.5 + (binary[i] ? 1 : -1) * (distances[i] + 0.5) / (2 * spread)), value = t * t * (3 - 2 * t);
      if (value === binary[i]) continue;
      const [key, index] = this.address(ix, iy);
      let tile = this.edgeTiles.get(key);
      if (!tile) { tile = new Float32Array(TILE_PIXELS).fill(NaN); this.edgeTiles.set(key, tile); }
      tile[index] = value;
    }
    this.boundary = { rect: { x: left, y: top, width, height }, distances };
  }

  boundaryDistance(x: number, y: number): number {
    if (!this.boundary) return Infinity;
    const { rect, distances } = this.boundary;
    if (x < rect.x || y < rect.y || x >= rect.x + rect.width || y >= rect.y + rect.height) return Infinity;
    return distances[(y - rect.y) * rect.width + x - rect.x];
  }

  regionAt(x: number, y: number, nearBoundary = false): Region | undefined {
    const found = this.rows.get(y)?.find(run => x >= run.start && x < run.end)?.region;
    if (found || !nearBoundary) return found;
    for (let radius = 1; radius <= Math.ceil(this.feather); radius++) for (const row of [y - radius, y + radius]) {
      const nearby = this.rows.get(row)?.find(run => x >= run.start - radius && x < run.end + radius)?.region;
      if (nearby) return nearby;
    }
  }

  private address(x: number, y: number): [number, number] {
    return [Math.floor(y / TILE_SIZE) * this.columns + Math.floor(x / TILE_SIZE), (y % TILE_SIZE) * TILE_SIZE + x % TILE_SIZE];
  }

  sample(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return 0;
    const key = Math.floor(y / TILE_SIZE) * this.columns + Math.floor(x / TILE_SIZE), index = (y % TILE_SIZE) * TILE_SIZE + x % TILE_SIZE, tile = this.tiles.get(key);
    if (tile && (tile.flags[index] & 1)) return tile.values[index];
    const edge = this.edgeTiles.get(key)?.[index];
    return edge !== undefined && !Number.isNaN(edge) ? edge : this.regionAt(x, y) ? 1 : 0;
  }

  isOwned(x: number, y: number): boolean {
    const [key, index] = this.address(x, y);
    return Boolean((this.tiles.get(key)?.flags[index] ?? 0) & 1);
  }

  begin() { this.transaction = new Map(); }

  private writable(key: number): MaskTile {
    if (this.transaction && !this.transaction.has(key)) this.transaction.set(key, copyTile(this.tiles.get(key)));
    let tile = this.tiles.get(key);
    if (tile && this.copyOnWrite && !this.detached.has(key)) { tile = copyTile(tile)!; this.tiles.set(key, tile); this.detached.add(key); }
    if (!tile) {
      tile = { values: new Float32Array(TILE_PIXELS), flags: new Uint8Array(TILE_PIXELS) };
      this.tiles.set(key, tile);
    }
    return tile;
  }

  set(x: number, y: number, value: number) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const [key, index] = this.address(x, y), tile = this.writable(key);
    tile.values[index] = clamp(value);
    tile.flags[index] |= 1;
  }

  finish(): MaskPatch[] {
    const patches = [...(this.transaction ?? [])].map(([key, before]) => ({ key, before, after: copyTile(this.tiles.get(key)) }));
    this.transaction = undefined;
    return patches;
  }

  apply(patches: MaskPatch[], direction: 'before' | 'after') {
    for (const patch of patches) {
      const tile = copyTile(patch[direction]);
      if (tile) this.tiles.set(patch.key, tile);
      else this.tiles.delete(patch.key);
    }
  }

  stroke(points: Point[], brush: Brush) { return this.createStroke(brush).append(points); }

  createStroke(brush: Brush) {
    const coverage = new Map<number, { initial: Float32Array; coverage: Float32Array }>();
    let last: Point | undefined;
    const stamp = (point: Point): Rect | undefined => {
      const pressure = brush.pressure ? (point.pressure ?? 1) : 1;
      const radius = Math.max(0.5, brush.size * Math.sqrt(pressure) / 2);
      const left = Math.max(0, Math.floor(point.x - radius)), right = Math.min(this.width, Math.ceil(point.x + radius));
      const top = Math.max(0, Math.floor(point.y - radius)), bottom = Math.min(this.height, Math.ceil(point.y + radius));
      let changed = false;
      for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
        const distance = Math.hypot(x + 0.5 - point.x, y + 0.5 - point.y) / radius;
        if (distance >= 1) continue;
        const falloff = distance <= brush.hardness ? 1 : (1 - distance) / (1 - brush.hardness);
        const strength = brush.opacity * pressure * falloff;
        const [key, index] = this.address(x, y);
        let covered = coverage.get(key);
        if (!covered) { covered = { initial: new Float32Array(TILE_PIXELS), coverage: new Float32Array(TILE_PIXELS) }; coverage.set(key, covered); }
        if (strength <= covered.coverage[index]) continue;
        if (covered.coverage[index] === 0) covered.initial[index] = this.sample(x, y);
        covered.coverage[index] = strength;
        const target = brush.mode === 'add' ? 1 : 0;
        this.set(x, y, covered.initial[index] * (1 - strength) + target * strength);
        changed = true;
      }
      return changed ? { x: left, y: top, width: right - left, height: bottom - top } : undefined;
    };
    return { append: (points: Point[]) => {
      let dirty: Rect | undefined;
      for (const point of points) {
        if (!last) dirty = union(dirty, stamp(point));
        else {
          const count = Math.max(1, Math.ceil(Math.hypot(point.x - last.x, point.y - last.y) / Math.max(0.25, brush.size * 0.08)));
          for (let step = 1; step <= count; step++) {
            const t = step / count;
            dirty = union(dirty, stamp({ x: last.x + (point.x - last.x) * t, y: last.y + (point.y - last.y) * t, pressure: (last.pressure ?? 1) + ((point.pressure ?? 1) - (last.pressure ?? 1)) * t }));
          }
        }
        last = point;
      }
      return dirty;
    } };
  }
}
