import { expect, it, vi } from 'vitest';
import type { TestContext } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { availableParallelism, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { decode } from 'fast-png';
import { initializeCanvas, readPsd } from 'ag-psd';
import sharp from 'sharp';
import { Engine } from '../src/core/engine';
import { encodePng, readEmbeddedProfile } from '../src/core/image';
import { imagePair } from './fixtures';

// Allow for native process startup on shared runners without oversubscribing their CPUs.
vi.setConfig({ testTimeout: 30000, maxConcurrency: Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2))) });

const execute = promisify(execFile), entry = resolve('scripts/cli.mjs');
const run = (...args: string[]) => execute(process.execPath, [entry, ...args], { timeout: 20000 });
const pixel = (data: ArrayLike<number>, width: number, x: number, y: number) => Array.from({ length: 4 }, (_, c) => data[(y * width + x) * 4 + c]);

async function fixture(context: TestContext, original?: Uint8Array, edited?: Uint8Array) {
  const directory = await mkdtemp(join(tmpdir(), 'revia cli '));
  context.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const pair = imagePair(), a = original ?? pair.original.buffer, b = edited ?? pair.edited.buffer;
  const input = join(directory, 'original.png'), modified = join(directory, 'edited.png');
  await Promise.all([writeFile(input, a), writeFile(modified, b)]);
  return { directory, a, b, input, modified, args: ['-i', input, '-e', modified] };
}

it.concurrent('exports the same automatic composite as the editor with no processing flags', async context => {
  const f = await fixture(context), output = join(f.directory, 'result.png'), engine = new Engine();
  await engine.load('original', f.a, 'original.png'); await engine.load('modified', f.b, 'edited.png');
  await engine.analyze(() => {});
  const { stdout, stderr } = await run(...f.args, '-o', output, '--quiet');
  const actual = decode(await readFile(output));
  const expected = decode(await engine.export('png', () => {})).data;
  expect(Buffer.from(actual.data.buffer).equals(Buffer.from(expected.buffer))).toBe(true);
  expect(pixel(actual.data, actual.width, 48, 48)).toEqual([30, 90, 210, 255]);
  expect(stdout + stderr).toBe('');
});

it.concurrent('writes a 16-bit mask and a PSD with an editable mask and the correct composite', async context => {
  const f = await fixture(context), maskPath = join(f.directory, 'mask.png'), psdPath = join(f.directory, 'result.psd');
  await Promise.all([run(...f.args, '-o', maskPath, '--format', 'mask'), run(...f.args, '-o', psdPath)]);
  const mask = decode(await readFile(maskPath));
  expect(mask.depth).toBe(16); expect(mask.channels).toBe(1);
  expect(mask.data[48 * 96 + 48]).toBe(65535); expect(mask.data[0]).toBe(0);
  initializeCanvas(() => { throw new Error('Unexpected canvas conversion'); }, (width, height) => ({ width, height, colorSpace: 'srgb', data: new Uint8ClampedArray(width * height * 4) }));
  const psd = readPsd(await readFile(psdPath), { useImageData: true, skipThumbnail: true });
  expect(psd.children?.map(layer => layer.name)).toEqual(['Original', 'Modified', 'Result']);
  expect(psd.children![1].mask!.imageData!.data[(48 * 96 + 48) * 4]).toBe(255);
  expect(pixel(psd.imageData!.data, psd.width, 48, 48)).toEqual([30, 90, 210, 255]);
});

it.concurrent('applies clockwise rotation and centered scaling before translation, even for identical inputs', async context => {
  const data = new Uint8Array(96 * 96 * 4).fill(255);
  for (let y = 32; y < 40; y++) for (let x = 60; x < 68; x++) data.set([30, 90, 210, 255], (y * 96 + x) * 4);
  const bytes = encodePng(96, 96, data, 8), f = await fixture(context, bytes, bytes), output = join(f.directory, 'transformed.png');
  await run(...f.args, '-o', output, '--align', 'none', '--rotation', '90', '--scale', '1.5', '--offset-x', '-10', '--offset-y', '4', '--feather', '0', '--color-strength', '0');
  const actual = decode(await readFile(output));
  expect(pixel(actual.data, 96, 56, 76)).toEqual([30, 90, 210, 255]);
  expect(pixel(actual.data, 96, 64, 36)).toEqual([255, 255, 255, 255]);
  expect(pixel(actual.data, 96, 48, 76)).toEqual([255, 255, 255, 255]);
});

it.concurrent('adds manual offsets after the automatic alignment instead of replacing it', async context => {
  const width = 180, height = 160, a = new Uint8Array(width * height * 4), b = a.slice();
  const pattern = (x: number, y: number) => Math.round(128 + 17 * Math.sin(x * 0.37) + 15 * Math.cos(y * 0.29) + 8 * Math.sin((x + y) * 0.19));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const av = pattern(x, y), bv = pattern(x - 8, y + 4), index = (y * width + x) * 4;
    a.set([av, av, av, 255], index);
    b.set(x >= 78 && x < 118 && y >= 56 && y < 96 ? [30, 90, 210, 255] : [bv, bv, bv, 255], index);
  }
  const f = await fixture(context, encodePng(width, height, a, 8), encodePng(width, height, b, 8)), output = join(f.directory, 'offset.png');
  await run(...f.args, '-o', output, '--offset-x', '6', '--offset-y', '-3', '--color-strength', '0', '--local-warp', 'off', '--feather', '0');
  const result = decode(await readFile(output));
  expect(pixel(result.data, width, 80, 77)).toEqual([30, 90, 210, 255]);
  const outside = pixel(result.data, width, 72, 80);
  expect(outside[2]).toBe(outside[0]);
});

it.concurrent('can disable local boundary warping while keeping automatic global alignment', async context => {
  const width = 180, height = 180, a = new Uint8Array(width * height * 4), b = a.slice();
  const pattern = (x: number, y: number) => Math.round(128 + 17 * Math.sin(x * 0.37) + 15 * Math.cos(y * 0.29) + 8 * Math.sin((x + y) * 0.19));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const av = pattern(x, y), bv = pattern(x - 1.5 * Math.sin(y * 0.035), y), index = (y * width + x) * 4;
    a.set([av, av, av, 255], index);
    b.set(x >= 75 && x < 105 && y >= 75 && y < 105 ? [180, 60, 20, 255] : [bv, bv, bv, 255], index);
  }
  const f = await fixture(context, encodePng(width, height, a, 8), encodePng(width, height, b, 8));
  const [automatic, disabled] = await Promise.all(['auto', 'off'].map(async mode => {
    const output = join(f.directory, `${mode}.png`);
    await run(...f.args, '-o', output, '--local-warp', mode);
    return decode(await readFile(output)).data;
  }));
  expect(Buffer.from(automatic.buffer).equals(Buffer.from(disabled.buffer))).toBe(false);
  expect(pixel(disabled, width, 90, 90)).toEqual(pixel(automatic, width, 90, 90));
});

it.concurrent('changes detection and edge weights when sensitivity and feathering are overridden', async context => {
  const a = new Uint8Array(96 * 96 * 4), b = a.slice();
  for (let y = 0; y < 96; y++) for (let x = 0; x < 96; x++) {
    a.set([128, 128, 128, 255], (y * 96 + x) * 4);
    const value = x >= 30 && x < 66 && y >= 30 && y < 66 ? 138 : 128;
    b.set([value, value, value, 255], (y * 96 + x) * 4);
  }
  const f = await fixture(context, encodePng(96, 96, a, 8), encodePng(96, 96, b, 8));
  const results = await Promise.all([['low', '0.5', '0'], ['high', '1.6', '0'], ['soft', '1.6', '8']].map(async ([name, sensitivity, feather]) => {
    const output = join(f.directory, `${name}.png`);
    await run(...f.args, '-o', output, '-f', 'mask', '--align', 'none', '--sensitivity', sensitivity, '--feather', feather);
    return decode(await readFile(output)).data;
  }));
  expect(results[0][48 * 96 + 48]).toBe(0);
  expect(results[1][48 * 96 + 48]).toBe(65535);
  expect(Array.from(results[1]).every(value => value === 0 || value === 65535)).toBe(true);
  expect(Array.from(results[2]).some(value => value > 0 && value < 65535)).toBe(true);
});

it.concurrent('uses color strength to control the actual exported edit', async context => {
  const a = new Uint8Array(96 * 96 * 4), b = a.slice();
  for (let y = 0; y < 96; y++) for (let x = 0; x < 96; x++) {
    const value = Math.round(80 + x * 0.7 + y * 0.5), index = (y * 96 + x) * 4;
    a.set([value, value, value, 255], index);
    b.set(x >= 35 && x < 61 && y >= 35 && y < 61 ? [30, 90, 210, 255] : [value + 15, value + 5, value + 8, 255], index);
  }
  const f = await fixture(context, encodePng(96, 96, a, 8), encodePng(96, 96, b, 8));
  const [uncorrected, corrected] = await Promise.all(['0', '1'].map(async strength => {
    const output = join(f.directory, `strength-${strength}.png`);
    await run(...f.args, '-o', output, '--align', 'none', '--color-strength', strength);
    const image = decode(await readFile(output)); return pixel(image.data, 96, 48, 48);
  }));
  expect(uncorrected).toEqual([30, 90, 210, 255]);
  expect(corrected).not.toEqual(uncorrected);
  expect(corrected[0]).toBeLessThan(uncorrected[0]);
});

it.concurrent('selects different original and edited frames from the same animated WebP file', async context => {
  const pair = imagePair(), data = new Uint8Array(pair.originalPixels.length * 2);
  data.set(pair.originalPixels); data.set(pair.editedPixels, pair.originalPixels.length);
  const animated = await sharp(data, { raw: { width: 96, height: 192, channels: 4, pageHeight: 96 } }).webp({ lossless: true, delay: [100, 100] }).toBuffer();
  const f = await fixture(context, animated, animated), output = join(f.directory, 'frame.png');
  await run(...f.args, '-o', output, '--original-frame', '1', '--edited-frame', '2');
  const actual = decode(await readFile(output));
  expect([actual.width, actual.height]).toEqual([96, 96]);
  expect(pixel(actual.data, 96, 48, 48)).toEqual([30, 90, 210, 255]);
  expect(pixel(actual.data, 96, 0, 0)).toEqual([255, 255, 255, 255]);
});

it.concurrent('preserves 16-bit native pixels and the embedded ICC profile in a Node export', async context => {
  const profiled = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#225599' } }).withIccProfile('p3').png().toBuffer();
  const data = new Uint16Array([1039, 3231, 60023, 65535, 1357, 5921, 47931, 0]);
  const source = encodePng(2, 1, data, 16, { name: 'P3', icc: readEmbeddedProfile(profiled) });
  const f = await fixture(context, source, source), output = join(f.directory, 'wide.png');
  await run(...f.args, '-o', output);
  const bytes = await readFile(output), result = decode(bytes);
  expect(result.depth).toBe(16); expect(result.data).toEqual(data);
  expect(readEmbeddedProfile(bytes)).toEqual(readEmbeddedProfile(source));
});

it.concurrent('preserves existing output on refusal or export failure and replaces it only on success', async context => {
  const f = await fixture(context), output = join(f.directory, 'existing.png'), sentinel = 'keep this file';
  await writeFile(output, sentinel);
  await expect(run(...f.args, '-o', output)).rejects.toMatchObject({ code: 2 });
  expect(await readFile(output, 'utf8')).toBe(sentinel);
  const source = encodePng(1, 1, new Uint16Array([1039, 3231, 60023, 65535]), 16);
  await writeFile(f.input, source);
  await expect(run(...f.args, '-o', output, '-f', 'psd', '--overwrite')).rejects.toMatchObject({ code: 1 });
  expect(await readFile(output, 'utf8')).toBe(sentinel);
  await writeFile(f.input, f.a);
  await run(...f.args, '-o', output, '--overwrite');
  expect(decode(await readFile(output)).width).toBe(96);
  expect((await readdir(f.directory)).some(name => name.startsWith('.revia-'))).toBe(false);
});
