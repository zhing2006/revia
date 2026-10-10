import { Mask } from './mask.ts';
import { ColorTransform, WorkImage, mixLinear, toSrgb } from './color.ts';
import { analyze, checkpoint, identityCorrection, thumbnail } from './analysis.ts';
import type { Analysis } from './analysis.ts';
import { decodeImage, encodePng, probeImage } from './image.ts';
import { clamp, IDENTITY, mapPoint, union } from './types.ts';
import { encodeHistory, decodeHistory, historySize } from './history.ts';
import type { HistoryEntry, HistoryRecord } from './history.ts';
import { embedPsdProfile, replacePsdComposite } from './psd.ts';
import { estimateWarp, warpOffset } from './warp.ts';
import type { WarpField } from './warp.ts';
import type { Brush, Region, Correction, Matrix, PixelData, Point, ProgressCallback, Rect } from './types.ts';

export type ViewMode = 'result' | 'original' | 'modified' | 'mask';
export type Parameters = { matrix: Matrix; correction: Correction; regions: Region[]; sensitivity: number; colorStrength: number; feather: number; warp?: WarpField };
export type EditorInfo = { width: number; height: number; depth: number; psdSupported: boolean; original: string; modified?: string; revision: number; canUndo: boolean; canRedo: boolean; settings: { matrix: Matrix; sensitivity: number; colorStrength: number }; analyzed: boolean; alignmentReliable: boolean; hasChanges: boolean };
const initialParameters = (): Parameters => ({ matrix: [...IDENTITY], correction: identityCorrection(), regions: [], sensitivity: 1, colorStrength: 1, feather: 2 });

export class Engine {
  original?: WorkImage;
  modified?: WorkImage;
  mask?: Mask;
  parameters = initialParameters();
  revision = 0;
  private strokePreview?: { id: number; revision: number; mask: Mask; draw: ReturnType<Mask['createStroke']>; count: number; bounds?: Rect; pending?: Rect };

  history: HistoryRecord[] = [];
  future: HistoryRecord[] = [];
  analysis?: Omit<Analysis, 'regions' | 'correction'>;

  async load(slot: 'original' | 'modified', bytes: Uint8Array, name: string, frame?: number) {
    const probe = probeImage(bytes);
    const deviceGiB = typeof navigator !== 'undefined' ? (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 4 : 4;
    const budget = Math.min(2, deviceGiB / 2) * 1024 ** 3;
    const resident = (this.original?.native.data.byteLength ?? 0) + (this.modified?.native.data.byteLength ?? 0);
    const decodeBytes = (probe.width ?? 0) * (probe.height ?? 0) * 4 * (probe.depth === 16 ? 2 : 1);
    const frameCopies = probe.format === 'png' ? Math.max(4, probe.frames + 2) : 4;
    if (resident + decodeBytes * frameCopies > budget) throw new Error('imageMemoryLimit');
    const native = await decodeImage(bytes, name, frame), image = new WorkImage(native, await ColorTransform.create(native.profile, native.depth));
    this[slot]?.color.dispose(); this[slot] = image;
    this.reset();
  }

  reset() {
    this.cancelStroke(); this.parameters = initialParameters(); this.analysis = undefined; this.history = []; this.future = [];
    if (this.original) this.mask = new Mask(this.original.native.width, this.original.native.height);
    if (this.original && this.modified) this.parameters.matrix = [this.modified.native.width / this.original.native.width, 0, 0, this.modified.native.height / this.original.native.height, 0, 0];
    this.revision++;
  }

  info(): EditorInfo | undefined {
    if (!this.original) return;
    return { width: this.original.native.width, height: this.original.native.height, depth: this.original.native.depth, psdSupported: this.original.native.depth === 8 && !this.original.native.profile.gamma, original: this.original.native.name, modified: this.modified?.native.name, revision: this.revision, canUndo: this.history.length > 0, canRedo: this.future.length > 0, settings: { matrix: this.parameters.matrix, sensitivity: this.parameters.sensitivity, colorStrength: this.parameters.colorStrength }, analyzed: Boolean(this.analysis), alignmentReliable: this.analysis?.alignment.reliable ?? false, hasChanges: this.parameters.regions.length > 0 };
  }

  async sources() {
    const result: { slot: 'original' | 'modified'; name: string; width: number; height: number; hash: string; bytes: Uint8Array }[] = [];
    for (const slot of ['original', 'modified'] as const) {
      const image = this[slot]; if (!image) continue;
      const small = await thumbnail(image, 240), rgba = new Uint8Array(small.pixels.length);
      for (let i = 0; i < rgba.length; i += 4) { for (let c = 0; c < 3; c++) rgba[i + c] = Math.round(clamp(toSrgb(small.pixels[i + c])) * 255); rgba[i + 3] = Math.round(small.pixels[i + 3] * 255); }
      result.push({ slot, name: image.native.name, width: image.native.width, height: image.native.height, hash: image.native.hash, bytes: encodePng(small.width, small.height, rgba, 8, { name: 'sRGB' }) });
    }
    return result;
  }

  private change(action: () => void) {
    if (!this.mask) return;
    this.cancelStroke();
    const before = structuredClone(this.parameters);
    this.mask.begin(); action();
    this.refreshMask();
    const patches = this.mask.finish();
    this.history.push({ before, after: structuredClone(this.parameters), patches }); this.future = []; this.revision++;
  }

  refreshMask(mask = this.mask, regions = this.parameters.regions) {
    const a = new Float32Array(4), b = new Float32Array(4);
    const guide = this.modified ? (x: number, y: number) => {
      const point = mapPoint(this.parameters.matrix, x + 0.5, y + 0.5);
      this.modified!.sample(point.x - 1.5, point.y - 0.5, a); this.modified!.sample(point.x + 0.5, point.y - 0.5, b);
      let difference = 0;
      for (let c = 0; c < 4; c++) difference = Math.max(difference, Math.abs(a[c] - b[c]));
      this.modified!.sample(point.x - 0.5, point.y - 1.5, a); this.modified!.sample(point.x - 0.5, point.y + 0.5, b);
      for (let c = 0; c < 4; c++) difference = Math.max(difference, Math.abs(a[c] - b[c]));
      return difference;
    } : undefined;
    mask?.setRegions(regions, this.parameters.feather, guide);
  }

  private appendStroke(id: number, points: Point[], brush: Brush) {
    if (!this.mask) return;
    if (this.strokePreview?.id !== id || this.strokePreview.revision !== this.revision) {
      const mask = this.mask.fork(); mask.begin();
      this.strokePreview = { id, revision: this.revision, mask, draw: mask.createStroke(brush), count: 0 };
    }
    const stroke = this.strokePreview;
    const dirty = stroke.draw.append(points.slice(stroke.count));
    stroke.count = points.length; stroke.bounds = union(stroke.bounds, dirty); stroke.pending = union(stroke.pending, dirty);
    return dirty;
  }

  cancelStroke() { this.strokePreview = undefined; }

  stroke(points: Point[], brush: Brush, id = -1) {
    this.appendStroke(id, points, brush);
    const stroke = this.strokePreview;
    if (!stroke || !this.mask) return;
    const patches = stroke.mask.finish(), parameters = structuredClone(this.parameters);
    this.mask.apply(patches, 'after');
    if (patches.length) { this.history.push({ before: parameters, after: parameters, patches }); this.future = []; this.revision++; }
    this.cancelStroke();
    return stroke.bounds;
  }

  update(patch: Partial<Parameters>) { this.change(() => { Object.assign(this.parameters, patch); if (patch.matrix) { this.parameters.warp = undefined; this.parameters.regions = [...this.parameters.regions]; } }); }

  async undo() {
    this.cancelStroke();
    const record = this.history.at(-1); if (!record || !this.mask) return;
    const entry = await this.readHistory(record); this.history.pop();
    this.mask.apply(entry.patches, 'before'); this.parameters = { ...initialParameters(), ...structuredClone(entry.before) }; this.refreshMask(); this.future.push(entry); this.revision++;
  }

  async redo() {
    this.cancelStroke();
    const record = this.future.at(-1); if (!record || !this.mask) return;
    const entry = await this.readHistory(record); this.future.pop();
    this.mask.apply(entry.patches, 'after'); this.parameters = { ...initialParameters(), ...structuredClone(entry.after) }; this.refreshMask(); this.history.push(entry); this.revision++;
  }

  private async readHistory(record: HistoryRecord): Promise<HistoryEntry> {
    return record instanceof Uint8Array ? decodeHistory(record) : record;
  }

  limitHistory(budget = 32 * 1024 * 1024) {
    let total = [...this.history, ...this.future].reduce((sum, entry) => sum + historySize(entry), 0);
    for (const stack of [this.history, this.future]) for (let index = 0; index < stack.length && total > budget; index++) {
      const entry = stack[index]; if (entry instanceof Uint8Array) continue;
      stack[index] = encodeHistory(entry);
      total += historySize(stack[index]) - historySize(entry);
    }
  }

  async analyze(progress: ProgressCallback, signal?: AbortSignal, matrix?: Matrix, sensitivity = this.parameters.sensitivity, options: { adjustment?: Matrix; localWarp?: boolean } = {}) {
    if (!this.original || !this.modified || !this.mask) return;
    const version = this.revision;
    if (this.original.native.hash === this.modified.native.hash && !matrix && !options.adjustment) {
      this.change(() => { this.parameters.regions = []; this.parameters.matrix = [...IDENTITY]; this.parameters.correction = identityCorrection(); this.parameters.sensitivity = sensitivity; this.parameters.warp = undefined; });
      this.analysis = { alignment: { matrix: [...IDENTITY], model: 'identity', reliable: true, error: 0, inliers: 0, coverage: 1 }, changedFraction: 0, noise: 0, needsReview: false };
      return;
    }
    const result = await analyze(this.original, this.modified, { matrix, sensitivity, adjustment: options.adjustment }, progress, signal);
    const warp = options.localWarp !== false && result.alignment.reliable ? await estimateWarp(this.original, this.modified, result.alignment.matrix, result.regions, progress, signal) : undefined;
    if (this.revision !== version) return;
    this.change(() => { this.parameters.matrix = result.alignment.matrix; this.parameters.correction = result.correction; this.parameters.regions = result.regions; this.parameters.sensitivity = sensitivity; this.parameters.warp = warp; });
    const { regions: _, correction: __, ...diagnostics } = result; this.analysis = diagnostics;
  }

  private values(x: number, y: number, a: Float32Array, b: Float32Array, mask = this.mask!): number {
    this.original!.pixel(x, y, a);
    if (!this.modified) { b.set(a); return 0; }
    const p = mapPoint(this.parameters.matrix, x + 0.5, y + 0.5);
    const weight = mask.sample(x, y);
    if (weight > 0 && this.parameters.warp && !mask.isOwned(x, y)) {
      const offset = warpOffset(this.parameters.warp, x, y, mask.boundaryDistance(x, y)); p.x += offset.x; p.y += offset.y;
    }
    if (!this.modified.sample(p.x - 0.5, p.y - 0.5, b)) { b.set(a); return 0; }
    const region = mask.regionAt(x, y, weight > 0), strength = this.parameters.colorStrength;
    if (this.parameters.correction.reliable && strength > 0) for (let c = 0; c < 3; c++) b[c] += strength * (b[c] * (this.parameters.correction.gain[c] - 1) + this.parameters.correction.offset[c]);
    if (region?.seam && strength > 0) {
      const distance = mask.boundaryDistance(x, y), fade = clamp(1 - distance / 32);
      for (let c = 0; c < 3; c++) b[c] += region.seam[c] * fade * fade * strength;
    }
    return weight;
  }

  private maskWeight(x: number, y: number, mask: Mask) {
    if (!this.modified) return 0;
    const weight = mask.sample(x, y), p = mapPoint(this.parameters.matrix, x + 0.5, y + 0.5);
    if (weight > 0 && this.parameters.warp && !mask.isOwned(x, y)) {
      const offset = warpOffset(this.parameters.warp, x, y, mask.boundaryDistance(x, y)); p.x += offset.x; p.y += offset.y;
    }
    return p.x < 0 || p.y < 0 || p.x > this.modified.native.width || p.y > this.modified.native.height ? 0 : weight;
  }

  async previewStroke(points: Point[], brush: Brush, view: ViewMode, maxEdge: number, overlay: boolean, region?: Rect, signal?: AbortSignal, id = 0) {
    this.appendStroke(id, points, brush);
    const stroke = this.strokePreview;
    if (!stroke?.pending) return;
    const result = await this.preview(view, maxEdge, overlay, signal, region, stroke.mask, stroke.pending);
    stroke.pending = undefined;
    return result;
  }

  async preview(view: ViewMode, maxEdge = 1400, overlay = false, signal?: AbortSignal, requestedRegion?: Rect, mask = this.strokePreview?.mask ?? this.mask, dirty?: Rect) {
    if (!this.original || !mask) return;
    const region = requestedRegion ?? { x: 0, y: 0, width: mask.width, height: mask.height };
    const width = Math.max(1, Math.round(region.width * Math.min(1, maxEdge / Math.max(region.width, region.height))));
    const height = Math.max(1, Math.round(region.height * width / region.width));
    const left = dirty ? clamp(Math.floor((dirty.x - region.x) * width / region.width), 0, width) : 0;
    const top = dirty ? clamp(Math.floor((dirty.y - region.y) * height / region.height), 0, height) : 0;
    const right = dirty ? clamp(Math.ceil((dirty.x + dirty.width - region.x) * width / region.width), 0, width) : width;
    const bottom = dirty ? clamp(Math.ceil((dirty.y + dirty.height - region.y) * height / region.height), 0, height) : height;
    if (right <= left || bottom <= top) return;
    const data = new Uint8Array((right - left) * (bottom - top) * 4), a = new Float32Array(4), b = new Float32Array(4), out = new Float32Array(4);
    let yielded = performance.now();
    for (let y = top; y < bottom; y++) {
      for (let x = left; x < right; x++) {
        const ox = clamp(Math.floor(region.x + (x + 0.5) * region.width / width), 0, mask.width - 1), oy = clamp(Math.floor(region.y + (y + 0.5) * region.height / height), 0, mask.height - 1);
        const i = ((y - top) * (right - left) + x - left) * 4;
        let weight = 0;
        if (view === 'mask') {
          weight = this.maskWeight(ox, oy, mask);
          data[i] = data[i + 1] = data[i + 2] = Math.round(weight * 255); data[i + 3] = 255;
        } else {
          if (view === 'original') { this.original.pixel(ox, oy, out); if (overlay) weight = this.maskWeight(ox, oy, mask); }
          else if (view === 'modified' && this.modified) {
            const position = mapPoint(this.parameters.matrix, ox + 0.5, oy + 0.5);
            this.modified.sample(position.x - 0.5, position.y - 0.5, out);
            if (overlay) weight = this.maskWeight(ox, oy, mask);
          } else { weight = this.values(ox, oy, a, b, mask); mixLinear(a, b, weight, out); }
          for (let c = 0; c < 3; c++) data[i + c] = Math.round(clamp(toSrgb(out[c])) * 255);
          data[i + 3] = Math.round(clamp(out[3]) * 255);
        }
        if (overlay) {
          const tint = [76, 221, 175], amount = weight * 0.35;
          for (let c = 0; c < 3; c++) data[i + c] = Math.round(data[i + c] * (1 - amount) + tint[c] * amount);
        }
      }
      signal?.throwIfAborted();
      if (performance.now() - yielded > 8) { await checkpoint(signal); yielded = performance.now(); }
    }
    return { width, height, data, region, ...(dirty ? { update: { x: left, y: top, width: right - left, height: bottom - top } } : {}) };
  }

  async renderPixels(progress: ProgressCallback, signal?: AbortSignal): Promise<PixelData> {
    const original = this.original!, { width, height, data } = original.native, output = data.slice();
    const a = new Float32Array(4), b = new Float32Array(4), stripeRows = 16;
    for (let top = 0; top < height; top += stripeRows) {
      const rows = Math.min(stripeRows, height - top), indices: number[] = [], working = new Float32Array(width * rows * 4);
      let count = 0;
      for (let y = top; y < top + rows; y++) for (let x = 0; x < width; x++) {
        if (this.mask!.sample(x, y) === 0) continue;
        const weight = this.values(x, y, a, b);
        if (weight === 0) continue;
        mixLinear(a, b, weight, working, count * 4); indices.push((y * width + x) * 4); count++;
      }
      if (count) {
        const encoded = original.color.encode(working.subarray(0, count * 4));
        for (let j = 0; j < count; j++) for (let c = 0; c < 4; c++) output[indices[j] + c] = encoded[j * 4 + c];
      }
      progress({ stage: 'export', fraction: 0.85 * (top + rows) / height }); await checkpoint(signal);
    }
    return output;
  }

  async export(format: 'png' | 'mask' | 'psd', progress: ProgressCallback, signal?: AbortSignal): Promise<Uint8Array> {
    const { width, height, depth, profile } = this.original!.native;
    if (format === 'mask') {
      const values = new Uint16Array(width * height), a = new Float32Array(4), b = new Float32Array(4);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) values[y * width + x] = Math.round(this.values(x, y, a, b) * 65535);
        if (y % 32 === 0) { progress({ stage: 'export', fraction: 0.85 * y / height }); await checkpoint(signal); }
      }
      return encodePng(width, height, values, 16, undefined, 1);
    }
    const pixels = await this.renderPixels(progress, signal);
    progress({ stage: 'encoding' });
    if (format === 'png') return encodePng(width, height, pixels, depth, profile, 4, undefined);
    if (depth !== 8) throw new Error('psdDepthUnsupported');
    if (profile.gamma) throw new Error('psdProfileUnsupported');
    const { writePsdUint8Array } = await import('ag-psd');
    const modified = new Uint8ClampedArray(pixels.length), weights = new Uint8ClampedArray(pixels.length), work = new Float32Array(width * 4), a = new Float32Array(4), b = new Float32Array(4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const weight = this.values(x, y, a, b); work.set(b, x * 4);
        const i = (y * width + x) * 4; weights[i] = weights[i + 1] = weights[i + 2] = Math.round(weight * 255); weights[i + 3] = 255;
      }
      modified.set(this.original!.color.encode(work), y * width * 4);
      if (y % 32 === 0) await checkpoint(signal);
    }
    const imageData = { width, height, data: new Uint8ClampedArray(pixels) };
    const encodedPsd = writePsdUint8Array({ width, height, imageData, children: [
      { name: 'Original', hidden: true, imageData: { width, height, data: new Uint8ClampedArray(this.original!.native.data) } },
      { name: 'Modified', hidden: true, imageData: { width, height, data: modified }, mask: { top: 0, left: 0, right: width, bottom: height, defaultColor: 0, imageData: { width, height, data: weights } } },
      { name: 'Result', imageData },
    ] }, { generateThumbnail: false, noBackground: true });
    const psd = replacePsdComposite(encodedPsd, width, height, new Uint8Array(pixels));
    return profile.icc ? embedPsdProfile(psd, profile.icc) : psd;
  }

}
