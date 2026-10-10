export type PixelData = Uint8Array | Uint16Array;
export type Point = { x: number; y: number; pressure?: number };
export type Rect = { x: number; y: number; width: number; height: number };
export type Preview = { width: number; height: number; data: Uint8Array; region?: Rect; update?: Rect };
export type Matrix = [number, number, number, number, number, number];
export type ColorProfile = { icc?: Uint8Array; gamma?: number; name: string };
export type PhotoMetadata = { exif?: Uint8Array; xmp?: Uint8Array; resolution?: Uint8Array };
export type NativeImage = {
  width: number;
  height: number;
  depth: 8 | 16;
  data: PixelData;
  profile: ColorProfile;
  name: string;
  bytes: Uint8Array;
  hash: string;
  orientation: number;
  decoder: string;
  metadata?: PhotoMetadata;
};
export type Run = { y: number; start: number; end: number };
export type Region = { bounds: Rect; runs: Run[]; area: number; seam?: [number, number, number] };
export type Correction = { gain: [number, number, number]; offset: [number, number, number]; reliable: boolean };
export type Brush = { mode: 'add' | 'erase'; size: number; hardness: number; opacity: number; pressure: boolean };
export type Progress = { stage: string; fraction?: number };
export type ProgressCallback = (progress: Progress) => void;
export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
export const clamp = (value: number, min = 0, max = 1) => Math.max(min, Math.min(max, value));
export function mapPoint(matrix: Matrix, x: number, y: number): Point {
  return { x: matrix[0] * x + matrix[2] * y + matrix[4], y: matrix[1] * x + matrix[3] * y + matrix[5] };
}

export function multiplyMatrices(a: Matrix, b: Matrix): Matrix {
  return [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
}

export function union(a: Rect | undefined, b: Rect | undefined): Rect | undefined {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}
