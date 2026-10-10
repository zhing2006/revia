import { expect, it } from 'vitest';
import { Engine } from '../src/core/engine';
import { encodePng, decodeImage } from '../src/core/image';
import { cpus, totalmem } from 'node:os';

it.each([[7680, 4320], [4320, 7680]])('automatically masks and exports a %i by %i local edit at native resolution', async (width, height) => {
  const cx = Math.floor(width / 2), cy = Math.floor(height / 2);
  const pixels = new Uint8Array(width * height * 4);
  for (let i = 0; i < pixels.length; i += 4) { pixels[i] = 61; pixels[i + 1] = 103; pixels[i + 2] = 179; pixels[i + 3] = 255; }
  const source = encodePng(width, height, pixels, 8), engine = new Engine(), started = performance.now();
  await engine.load('original', source, '8k.png');
  for (let y = cy - 32; y < cy + 32; y++) for (let x = cx - 32; x < cx + 32; x++) pixels.set([255, 255, 255, 255], (y * width + x) * 4);
  await engine.load('modified', encodePng(width, height, pixels, 8), 'edited-8k.png');
  const imported = performance.now();
  await engine.analyze(() => {});
  const analyzed = performance.now();
  const output = await engine.export('png', () => {}), exported = performance.now();
  const result = await decodeImage(output, 'result.png');
  expect([result.width, result.height]).toEqual([width, height]);
  expect([...result.data.subarray(0, 4)]).toEqual([61, 103, 179, 255]);
  expect([...result.data.subarray((cy * width + cx) * 4, (cy * width + cx) * 4 + 4)]).toEqual([255, 255, 255, 255]);
  console.info(JSON.stringify({ width, height, runtime: process.version, cpu: cpus()[0].model, memoryGiB: totalmem() / 1073741824, importMilliseconds: imported - started, analysisMilliseconds: analyzed - imported, exportMilliseconds: exported - analyzed, rssMiB: process.memoryUsage().rss / 1048576, peakProcessRssMiB: process.resourceUsage().maxRSS / 1024 }, null, 2));
});
