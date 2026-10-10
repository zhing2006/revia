import { expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { Engine } from '../src/core/engine';
import { decodeImage } from '../src/core/image';

it('automatically masks the edited mug and preserves unmasked detail', async () => {
  const engine = new Engine();
  await engine.load('original', await readFile('images/mug-original.png'), 'original.png');
  await engine.load('modified', await readFile('images/mug-edited-degraded.jpg'), 'edited.jpg');
  await engine.analyze(() => {});
  expect(engine.mask!.sample(720, 530)).toBe(1);
  const png = await engine.export('png', () => {});
  const output = await decodeImage(png, 'result.png'), original = engine.original!.native;
  const center = (530 * original.width + 720) * 4;
  expect(output.data[center + 2]).toBeGreaterThan(output.data[center]);
  let unexpected = 0, backgroundMask = 0, backgroundArea = 0;
  for (let y = 0; y < output.height; y++) for (let x = 0; x < output.width; x++) {
    const weight = engine.mask!.sample(x, y);
    if (x < 450 || x > 1190 || y < 200 || y > 870) { backgroundArea++; if (weight > 0) backgroundMask++; }
    if (weight > 0) continue;
    const index = (y * output.width + x) * 4;
    for (let channel = 0; channel < 4; channel++) if (original.data[index + channel] !== output.data[index + channel]) unexpected++;
  }
  expect(unexpected).toBe(0);
  expect(backgroundMask / backgroundArea).toBeLessThan(0.003);
  expect(engine.mask!.sample(1040, 500)).toBe(0);
});
