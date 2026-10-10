import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { Engine } from './engine';
import { decodeImage, encodePng, readEmbeddedProfile } from './image';
import type { Brush, PixelData } from './types';
import { initializeCanvas, readPsd } from 'ag-psd';
import { probeImage } from './image';

async function editor(a: PixelData, b: PixelData, width = a.length / 4) {
  const engine = new Engine(), depth = a instanceof Uint16Array ? 16 : 8;
  await engine.load('original', encodePng(width, a.length / 4 / width, a, depth), 'original.png');
  await engine.load('modified', encodePng(width, b.length / 4 / width, b, depth), 'modified.png');
  return engine;
}
const brush: Brush = { mode: 'add', size: 1, opacity: 0.5, hardness: 1, pressure: false };
const nothing = () => {};

describe('image editing and export', () => {
  it('preserves untouched 16-bit samples including invisible RGB while mixing active pixels in linear light', async () => {
    const a = new Uint16Array([1345, 5627, 49201, 0, 65535, 0, 0, 32768, 1039, 3231, 60023, 65535]);
    const b = new Uint16Array([0, 0, 0, 65535, 0, 0, 65535, 32768, 65535, 65535, 65535, 0]);
    const engine = await editor(a, b);
    await engine.previewStroke([{ x: 1.5, y: 0.5 }], brush, 'result', 3, false);
    expect(await engine.renderPixels(nothing)).toEqual(a);
    engine.stroke([{ x: 1.5, y: 0.5 }], brush);
    const bytes = await engine.export('png', nothing), decoded = await decodeImage(bytes, 'result.png');
    expect(decoded.depth).toBe(16);
    expect([...decoded.data.subarray(0, 4)]).toEqual([...a.subarray(0, 4)]);
    expect([...decoded.data.subarray(8, 12)]).toEqual([...a.subarray(8, 12)]);
    expect(decoded.data[7]).toBe(32768);
    expect(decoded.data[4]).toBeCloseTo(48192, -1);
    expect(decoded.data[6]).toBeCloseTo(48192, -1);
    const metadata = await sharp(bytes).metadata();
    expect([metadata.width, metadata.height, metadata.depth]).toEqual([3, 1, 'ushort']);
  });

  it('matches incremental preview patches to the committed mask without losing an interrupted update', async () => {
    const width = 320, height = 192, a = new Uint8Array(width * height * 4).fill(255), b = a.slice().fill(0);
    for (let i = 3; i < b.length; i += 4) b[i] = 255;
    const engine = await editor(a, b, width);
    const region = { x: 17, y: 11, width: 280, height: 160 };
    const base = (await engine.preview('mask', 173, false, undefined, region))!;
    const points = [{ x: 100.5, y: 80.5 }, { x: 145.5, y: 82.5, pressure: 0.6 }, { x: 175.5, y: 90.5 }];
    const painting: Brush = { ...brush, size: 24, pressure: true };
    const abort = new AbortController(); abort.abort();
    await expect(engine.previewStroke(points.slice(0, 1), painting, 'mask', 173, false, region, abort.signal, 42)).rejects.toThrow();
    for (const count of [2, 3]) {
      const patch = (await engine.previewStroke(points.slice(0, count), painting, 'mask', 173, false, region, undefined, 42))!;
      expect(patch.data.length).toBeLessThan(base.data.length / 4);
      const { x, y, width: w, height: h } = patch.update!;
      for (let row = 0; row < h; row++) base.data.set(patch.data.subarray(row * w * 4, (row + 1) * w * 4), ((y + row) * base.width + x) * 4);
    }
    expect(engine.mask!.sample(100, 80)).toBe(0);
    engine.stroke(points, painting, 42);
    const committed = (await engine.preview('mask', 173, false, undefined, region))!;
    expect(base.data).toEqual(committed.data);
    expect(engine.mask!.sample(100, 80)).toBe(0.5);
    await engine.undo(); expect(engine.mask!.sample(100, 80)).toBe(0);
    await engine.redo(); expect(engine.mask!.sample(100, 80)).toBe(0.5);
  });

  it('keeps the edited reference unchanged when the result uses color correction and manual masking', async () => {
    const engine = await editor(new Uint8Array([240, 180, 150, 255, 230, 160, 140, 255]), new Uint8Array([30, 90, 210, 255, 50, 120, 180, 255]));
    const before = (await engine.preview('modified', 2))!;
    engine.update({ colorStrength: 1, correction: { gain: [1.2, 0.9, 0.8], offset: [0.04, 0.01, 0], reliable: true } });
    engine.stroke([{ x: 0.5, y: 0.5 }], { ...brush, opacity: 1 });
    expect((await engine.preview('modified', 2))!.data).toEqual(before.data);
    expect((await engine.preview('result', 2))!.data).not.toEqual(before.data);
  });

  it('keeps erased pixels and valid transparent replacements distinct from out-of-bounds samples', async () => {
    const a = new Uint8Array([123, 54, 76, 255, 7, 66, 5, 255, 199, 99, 21, 255]);
    const engine = await editor(a, new Uint8Array(a.length));
    engine.stroke([{ x: 1.5, y: 0.5 }], { ...brush, size: 10, opacity: 1 });
    engine.stroke([{ x: 0.5, y: 0.5 }], { ...brush, mode: 'erase', opacity: 1 });
    engine.update({ matrix: [1, 0, 0, 1, 1, 0] });
    expect([...await engine.renderPixels(nothing)]).toEqual([123, 54, 76, 255, 0, 0, 0, 0, 199, 99, 21, 255]);
  });

  it('keeps manual weights when rebuilding the automatic mask and undoing compressed history', async () => {
    const width = 96, a = new Uint8Array(width * width * 4).fill(255), b = a.slice();
    for (let y = 30; y < 60; y++) for (let x = 30; x < 60; x++) b.set([30, 60, 160, 255], (y * width + x) * 4);
    const engine = await editor(a, b, width);
    engine.stroke([{ x: 40.5, y: 40.5 }], brush);
    await engine.analyze(nothing, undefined, [1, 0, 0, 1, 0, 0]);
    expect(engine.mask!.sample(40, 40)).toBe(0.5);
    expect(engine.mask!.sample(50, 50)).toBe(1);
    engine.stroke([{ x: 50.5, y: 50.5 }], { ...brush, mode: 'erase', opacity: 1 });
    const erased = await engine.renderPixels(nothing);
    engine.limitHistory(1);
    await engine.undo(); expect(engine.mask!.sample(50, 50)).toBe(1);
    await engine.redo(); expect(await engine.renderPixels(nothing)).toEqual(erased);
  });

  it('leaves identical inputs unchanged after automatic analysis', async () => {
    const pixels = new Uint8Array([8, 45, 92, 0, 99, 13, 63, 255, 74, 28, 14, 128]);
    const engine = await editor(pixels, pixels);
    await engine.analyze(nothing);
    expect(engine.parameters.regions).toEqual([]);
    expect(await engine.renderPixels(nothing)).toEqual(pixels);
  });

  it('discards analysis that finishes after a newer alignment and brush edit', async () => {
    const a = new Uint8Array(32 * 32 * 4), b = new Uint8Array(a.length);
    for (let i = 0; i < a.length; i += 4) { a.set([i % 251, (i * 3) % 251, (i * 7) % 251, 255], i); b.set([i % 239, (i * 3) % 251, (i * 7) % 251, 255], i); }
    const engine = await editor(a, b, 32);
    await engine.analyze(progress => {
      if (progress.stage === 'color') { engine.update({ matrix: [1, 0, 0, 1, 5, 0] }); engine.stroke([{ x: 1.5, y: 1.5 }], brush); }
    });
    expect(engine.parameters.matrix[4]).toBe(5);
    expect(engine.mask!.sample(1, 1)).toBe(0.5);
    expect(engine.analysis).toBeUndefined();
  });

  it('reads indexed transparency and applies orientation exactly once', async () => {
    const source = await sharp({ create: { width: 3, height: 2, channels: 4, background: { r: 23, g: 46, b: 87, alpha: 0.4 } } }).png({ palette: true }).toBuffer();
    const image = await decodeImage(source, 'indexed.png');
    const independent = await sharp(source).ensureAlpha().raw().toBuffer();
    expect(image.data).toEqual(new Uint8Array(independent));
    const jpeg = await sharp({ create: { width: 5, height: 3, channels: 3, background: '#987653' } }).withMetadata({ orientation: 6 }).jpeg().toBuffer();
    const rotated = await decodeImage(jpeg, 'rotated.jpg');
    const roundTrip = await decodeImage(encodePng(rotated.width, rotated.height, rotated.data, rotated.depth, rotated.profile, 4, rotated.metadata), 'roundtrip.png');
    expect([roundTrip.width, roundTrip.height]).toEqual([3, 5]);
    expect(roundTrip.data).toEqual(rotated.data);
    expect(roundTrip.orientation).toBe(1);
    expect(roundTrip.metadata?.exif?.length).toBeGreaterThan(0);
  });

  it('retains the embedded wide-gamut profile and untouched pixels through an edited export', async () => {
    const source = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#cc2255' } }).withIccProfile('p3').png().toBuffer();
    const modified = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#2255cc' } }).withIccProfile('p3').png().toBuffer();
    const engine = new Engine(); await engine.load('original', source, 'p3.png'); await engine.load('modified', modified, 'edit.png');
    engine.stroke([{ x: 1.5, y: 1.5 }], brush);
    const exported = await engine.export('png', nothing), decoded = await decodeImage(exported, 'result.png');
    expect(readEmbeddedProfile(exported)).toEqual(readEmbeddedProfile(source));
    expect(decoded.data.subarray(0, 4)).toEqual(engine.original!.native.data.subarray(0, 4));
    expect(decoded.data.subarray(20, 24)).not.toEqual(engine.original!.native.data.subarray(20, 24));
  });

  it('exports an exact visible PSD result with hidden editable material and a mask', async () => {
    const engine = await editor(new Uint8Array([255, 0, 0, 128, 90, 32, 11, 255]), new Uint8Array([0, 0, 255, 128, 0, 0, 0, 0]));
    engine.stroke([{ x: 0.5, y: 0.5 }], brush);
    const bytes = await engine.export('psd', nothing);
    initializeCanvas(() => { throw new Error('Unexpected canvas conversion'); }, (width, height) => ({ width, height, colorSpace: 'srgb', data: new Uint8ClampedArray(width * height * 4) }));
    const psd = readPsd(bytes, { useImageData: true, skipThumbnail: true });
    const expected = await engine.renderPixels(nothing);
    expect(new Uint8Array(psd.children!.at(-1)!.imageData!.data)).toEqual(expected);
    for (let i = 0; i < expected.length; i++) expect(Math.abs(psd.imageData!.data[i] - expected[i])).toBeLessThanOrEqual(i % 4 === 3 ? 0 : 1);
    expect(psd.children?.map(layer => Boolean(layer.hidden))).toEqual([true, true, false]);
    expect(psd.children?.[1].mask?.imageData?.data[0]).toBe(128);
  });

  it('decodes the explicitly selected animated WebP frame including its alpha', async () => {
    const data = new Uint8Array(8 * 8 * 4 * 2);
    for (let i = 0; i < data.length; i += 4) data.set(i < data.length / 2 ? [210, 20, 30, 255] : [20, 50, 220, 128], i);
    const bytes = await sharp(data, { raw: { width: 8, height: 16, channels: 4, pageHeight: 8 } }).webp({ lossless: true, delay: [100, 100], loop: 0 }).toBuffer();
    expect(probeImage(bytes).frames).toBe(2);
    const frame = await decodeImage(bytes, 'animated.webp', 1);
    const independent = await sharp(bytes, { page: 1 }).ensureAlpha().raw().toBuffer();
    expect(frame.data).toEqual(new Uint8Array(independent));
  });
});
