import { expect, it } from 'vitest';
import { Engine } from '../src/core/engine';
import { encodePng } from '../src/core/image';
import { estimateWarp, warpOffset } from '../src/core/warp';

it('improves a bounded local displacement using stable texture outside an edited region', async () => {
  const width = 180, height = 180, a = new Uint8Array(width * height * 4), b = a.slice();
  const pattern = (x: number, y: number) => Math.round(128 + 17 * Math.sin(x * 0.37) + 15 * Math.cos(y * 0.29) + 8 * Math.sin((x + y) * 0.19));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const av = pattern(x, y), bv = pattern(x - 2.4, y);
    a.set([av, av, av, 255], (y * width + x) * 4); b.set([bv, bv, bv, 255], (y * width + x) * 4);
  }
  for (let y = 75; y < 105; y++) for (let x = 75; x < 105; x++) b.set([180, 60, 20, 255], (y * width + x) * 4);
  const engine = new Engine();
  await engine.load('original', encodePng(width, height, a, 8), 'original.png');
  await engine.load('modified', encodePng(width, height, b, 8), 'misregistered.png');
  const regions = [{ area: 900, bounds: { x: 75, y: 75, width: 30, height: 30 }, runs: Array.from({ length: 30 }, (_, y) => ({ y: y + 75, start: 75, end: 105 })) }];
  const warp = await estimateWarp(engine.original!, engine.modified!, engine.parameters.matrix, regions, () => {});
  engine.update({ regions, warp });
  const offset = warpOffset(engine.parameters.warp!, 30, 30, 0);
  expect(offset.x).toBeCloseTo(2.4, 1);
  expect(Math.abs(pattern(30 + offset.x - 2.4, 30 + offset.y) - pattern(30, 30))).toBeLessThan(Math.abs(pattern(27.6, 30) - pattern(30, 30)));
  const edited = await engine.renderPixels(() => {});
  expect([...edited.subarray(0, 4)]).toEqual([...a.subarray(0, 4)]);
});
