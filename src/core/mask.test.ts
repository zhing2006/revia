import { expect, it } from 'vitest';
import { Mask } from './mask';

it('interpolates a fast stroke across tile boundaries without accumulating overlap opacity', () => {
  const mask = new Mask(300, 8);
  mask.begin();
  mask.stroke([{ x: 1.5, y: 4.5 }, { x: 298.5, y: 4.5 }], { mode: 'add', size: 4, hardness: 1, opacity: 0.5, pressure: false });
  const incremental = new Mask(300, 8);
  const stroke = incremental.createStroke({ mode: 'add', size: 4, hardness: 1, opacity: 0.5, pressure: false });
  stroke.append([{ x: 1.5, y: 4.5 }]); stroke.append([{ x: 298.5, y: 4.5 }]);
  for (let x = 2; x < 298; x++) expect(incremental.sample(x, 4)).toBe(mask.sample(x, 4));
  const patches = mask.finish();
  for (let x = 2; x < 298; x++) expect(mask.sample(x, 4)).toBe(0.5);
  mask.apply(patches, 'before'); expect(mask.sample(128, 4)).toBe(0);
  mask.apply(patches, 'after'); expect(mask.sample(128, 4)).toBe(0.5);
});

it('keeps an erased hole while rebuilding a feathered automatic mask', () => {
  const mask = new Mask(16, 16);
  const regions = [{ bounds: { x: 3, y: 3, width: 10, height: 10 }, area: 100, runs: Array.from({ length: 10 }, (_, y) => ({ y: y + 3, start: 3, end: 13 })) }];
  mask.setRegions(regions, 2);
  mask.stroke([{ x: 8.5, y: 8.5 }], { mode: 'erase', size: 1, hardness: 1, opacity: 1, pressure: false });
  mask.setRegions([...regions], 3);
  expect(mask.sample(8, 8)).toBe(0);
  expect(mask.sample(6, 6)).toBe(1);
  expect(mask.sample(3, 4)).toBeGreaterThan(0);
  expect(mask.sample(3, 4)).toBeLessThan(1);
  expect(mask.sample(0, 0)).toBe(0);
});
