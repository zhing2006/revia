import { clamp } from './types.ts';
import type { ColorProfile, NativeImage, PixelData } from './types.ts';
import type { Lcms } from 'lcms-wasm';

export const toLinear = (value: number) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
export const toSrgb = (value: number) => value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055;
const xyzToRgb = [3.1338561, -1.6168667, -0.4906146, -0.9787684, 1.9161415, 0.033454, 0.0719453, -0.2289914, 1.4052427];
const rgbToXyz = [0.4360747, 0.3850649, 0.1430804, 0.2225045, 0.7168786, 0.0606169, 0.0139322, 0.0971045, 0.7141733];
let cmsPromise: Promise<{ cms: Lcms; rgbFormat: number; xyzFormat: number }> | undefined;

async function getCms() {
  cmsPromise ??= (async () => {
    const { instantiate, TYPE_RGB_DBL, TYPE_XYZ_DBL } = await import('lcms-wasm');
    let options: { wasmBinary?: Uint8Array; locateFile?: () => string };
    if (typeof process !== 'undefined' && process.versions?.node) {
      const path = (await import('node:module')).createRequire(import.meta.url).resolve('lcms-wasm/dist/lcms.wasm');
      options = { wasmBinary: new Uint8Array(await (await import('node:fs/promises')).readFile(path)) };
    } else {
      const { default: url } = await import('lcms-wasm/dist/lcms.wasm?url');
      options = { locateFile: () => url };
    }
    const cms = await instantiate(options);
    // The low three format bits specify bytes per channel; the wrapper supports Float32.
    return { cms, rgbFormat: TYPE_RGB_DBL | 4, xyzFormat: TYPE_XYZ_DBL | 4 };
  })();
  return cmsPromise;
}

function matrixAt(matrix: number[], input: Float32Array, index: number, output: Float32Array, target: number) {
  for (let channel = 0; channel < 3; channel++) output[target + channel] = matrix[channel * 3] * input[index] + matrix[channel * 3 + 1] * input[index + 1] + matrix[channel * 3 + 2] * input[index + 2];
}

export class ColorTransform {
  private cms?: Lcms;
  private forward = 0;
  private reverse = 0;
  private lookup: Float32Array;
  readonly profile: ColorProfile;
  readonly depth: 8 | 16;

  private constructor(profile: ColorProfile, depth: 8 | 16) {
    this.profile = profile; this.depth = depth;
    const max = depth === 16 ? 65535 : 255;
    this.lookup = Float32Array.from({ length: max + 1 }, (_, i) => profile.gamma ? (i / max) ** (1 / profile.gamma) : toLinear(i / max));
  }

  static async create(profile: ColorProfile, depth: 8 | 16) {
    const transform = new ColorTransform(profile, depth);
    if (profile.icc) {
      const { cms, rgbFormat, xyzFormat } = await getCms();
      const source = cms.cmsOpenProfileFromMem(profile.icc, profile.icc.byteLength), xyz = cms.cmsCreateXYZProfile();
      if (!source || cms.cmsGetColorSpaceASCII(source) !== 'RGB') {
        if (source) cms.cmsCloseProfile(source);
        cms.cmsCloseProfile(xyz);
        throw new Error('unsupportedColorProfile');
      }
      transform.cms = cms;
      transform.forward = cms.cmsCreateTransform(source, rgbFormat, xyz, xyzFormat, 1, 0);
      transform.reverse = cms.cmsCreateTransform(xyz, xyzFormat, source, rgbFormat, 1, 0);
      cms.cmsCloseProfile(source); cms.cmsCloseProfile(xyz);
      if (!transform.forward || !transform.reverse) throw new Error('unsupportedColorProfile');
    }
    return transform;
  }

  decode(data: PixelData): Float32Array {
    const output = new Float32Array(data.length), max = this.depth === 16 ? 65535 : 255;
    if (this.cms) {
      const rgb = new Float32Array(data.length / 4 * 3);
      for (let i = 0, j = 0; i < data.length; i += 4, j += 3) { rgb[j] = data[i] / max; rgb[j + 1] = data[i + 1] / max; rgb[j + 2] = data[i + 2] / max; }
      const xyz = this.cms.cmsDoTransform(this.forward, rgb, rgb.length / 3);
      for (let i = 0, j = 0; i < data.length; i += 4, j += 3) matrixAt(xyzToRgb, xyz, j, output, i);
    } else {
      for (let i = 0; i < data.length; i += 4) { output[i] = this.lookup[data[i]]; output[i + 1] = this.lookup[data[i + 1]]; output[i + 2] = this.lookup[data[i + 2]]; }
    }
    for (let i = 3; i < data.length; i += 4) output[i] = data[i] / max;
    return output;
  }

  encode(data: Float32Array): PixelData {
    const output = this.depth === 16 ? new Uint16Array(data.length) : new Uint8Array(data.length), max = this.depth === 16 ? 65535 : 255;
    if (this.cms) {
      const xyz = new Float32Array(data.length / 4 * 3);
      for (let i = 0, j = 0; i < data.length; i += 4, j += 3) matrixAt(rgbToXyz, data, i, xyz, j);
      const rgb = this.cms.cmsDoTransform(this.reverse, xyz, xyz.length / 3);
      for (let i = 0, j = 0; i < data.length; i += 4, j += 3) for (let c = 0; c < 3; c++) output[i + c] = Math.round(clamp(rgb[j + c]) * max);
    } else {
      for (let i = 0; i < data.length; i += 4) for (let c = 0; c < 3; c++) output[i + c] = Math.round(clamp(this.profile.gamma ? Math.max(0, data[i + c]) ** this.profile.gamma : toSrgb(data[i + c])) * max);
    }
    for (let i = 3; i < data.length; i += 4) output[i] = Math.round(clamp(data[i]) * max);
    return output;
  }

  dispose() {
    if (this.forward) this.cms?.cmsDeleteTransform(this.forward);
    if (this.reverse) this.cms?.cmsDeleteTransform(this.reverse);
    this.forward = this.reverse = 0;
  }
}

const EDGE = 128;
export class WorkImage {
  private cache = new Map<number, Float32Array>();
  private columns: number;
  readonly native: NativeImage;
  readonly color: ColorTransform;
  constructor(native: NativeImage, color: ColorTransform) { this.native = native; this.color = color; this.columns = Math.ceil(native.width / EDGE); }

  private tile(x: number, y: number) {
    const tx = Math.floor(x / EDGE), ty = Math.floor(y / EDGE), key = ty * this.columns + tx;
    let tile = this.cache.get(key);
    if (!tile) {
      const raw = this.native.depth === 16 ? new Uint16Array(EDGE * EDGE * 4) : new Uint8Array(EDGE * EDGE * 4);
      const width = Math.min(EDGE, this.native.width - tx * EDGE), height = Math.min(EDGE, this.native.height - ty * EDGE);
      for (let row = 0; row < height; row++) {
        const from = ((ty * EDGE + row) * this.native.width + tx * EDGE) * 4;
        raw.set(this.native.data.subarray(from, from + width * 4), row * EDGE * 4);
      }
      tile = this.color.decode(raw);
      if (this.cache.size >= Math.max(8, Math.min(128, this.columns * 2))) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(key, tile);
    }
    return { tile, index: ((y % EDGE) * EDGE + x % EDGE) * 4 };
  }

  pixel(x: number, y: number, output: Float32Array, index = 0) {
    const sample = this.tile(x, y);
    for (let c = 0; c < 4; c++) output[index + c] = sample.tile[sample.index + c];
  }

  sample(x: number, y: number, output: Float32Array, index = 0): boolean {
    if (x < -0.5 || y < -0.5 || x > this.native.width - 0.5 || y > this.native.height - 0.5) { output.fill(0, index, index + 4); return false; }
    x = clamp(x, 0, this.native.width - 1); y = clamp(y, 0, this.native.height - 1);
    const left = Math.floor(x), top = Math.floor(y), fx = x - left, fy = y - top;
    output.fill(0, index, index + 4);
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      const weight = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy);
      if (!weight) continue;
      const sample = this.tile(Math.min(left + dx, this.native.width - 1), Math.min(top + dy, this.native.height - 1));
      const alpha = sample.tile[sample.index + 3];
      for (let c = 0; c < 3; c++) output[index + c] += weight * alpha * sample.tile[sample.index + c];
      output[index + 3] += weight * alpha;
    }
    const alpha = output[index + 3];
    if (alpha > 0) for (let c = 0; c < 3; c++) output[index + c] /= alpha;
    return true;
  }

  clear() { this.cache.clear(); }
}

export function mixLinear(a: Float32Array, b: Float32Array, weight: number, output: Float32Array, target = 0) {
  const alphaA = a[3] * (1 - weight), alphaB = b[3] * weight, alpha = alphaA + alphaB;
  for (let c = 0; c < 3; c++) output[target + c] = alpha ? (a[c] * alphaA + b[c] * alphaB) / alpha : 0;
  output[target + 3] = alpha;
}
