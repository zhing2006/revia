import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { decode } from 'fast-png';
import sharp from 'sharp';
import { readFile } from 'node:fs/promises';
import { dictionaries } from '../src/i18n';
import { imagePair } from './fixtures';

async function exportImage(page: Page, format = 'png') {
  await page.getByLabel('Export format').selectOption(format);
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  return decode(await readFile((await (await downloading).path())!));
}

async function loadPair(page: Page, pair = imagePair()) {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Add original image', exact: true }).first()).toBeVisible();
  const opening = page.waitForEvent('filechooser');
  await page.keyboard.press('ControlOrMeta+O');
  await (await opening).setFiles(pair.original);
  const editing = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Add edited image', exact: true }).click();
  await (await editing).setFiles(pair.edited);
  await expect(page.getByRole('button', { name: 'Export', exact: true })).toBeEnabled();
  return pair;
}

test('automatically creates a mask, allows erasing and undo, exports native pixels, and restarts empty', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const { width } = await loadPair(page), center = (48 * width + 48) * 4;
  const visible = sharp(await page.locator('.viewport').screenshot());
  const { width: renderedWidth, height: renderedHeight } = await visible.metadata();
  const centerPixel = await visible.extract({ left: Math.floor(renderedWidth! / 2), top: Math.floor(renderedHeight! / 2), width: 1, height: 1 }).raw().toBuffer();
  expect(centerPixel[2] - centerPixel[0]).toBeGreaterThan(100);
  const initial = await exportImage(page);
  expect([...initial.data.subarray(center, center + 4)]).toEqual([30, 90, 210, 255]);
  expect([...initial.data.subarray(0, 4)]).toEqual([255, 255, 255, 255]);
  const mask = await exportImage(page, 'mask');
  expect(mask.data[48 * width + 48]).toBe(65535);
  expect(mask.data[0]).toBe(0);
  await page.getByRole('tab', { name: 'Mask', exact: true }).click();
  await page.getByRole('button', { name: 'Erase', exact: true }).click();
  await page.locator('#brush-size').fill('8');
  const box = (await page.locator('.viewport').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await expect.poll(async () => {
    const image = sharp(await page.locator('.viewport canvas').screenshot());
    const { width, height } = await image.metadata();
    const pixel = await image.extract({ left: Math.floor(width! / 2), top: Math.floor(height! / 2), width: 1, height: 1 }).raw().toBuffer();
    return pixel[0];
  }).toBe(0);
  await page.mouse.up();
  const erased = await exportImage(page);
  expect([...erased.data.subarray(center, center + 4)]).toEqual([255, 255, 255, 255]);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect((await exportImage(page)).data).toEqual(initial.data);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Add original image', exact: true }).first()).toBeVisible();
  await expect(page.locator('.source-card img')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Export', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  expect(errors).toEqual([]);
});

test('keeps language and theme when reopening offline', async ({ page, context }) => {
  await page.goto('/');
  await page.getByLabel('Language', { exact: true }).selectOption('ja');
  await expect(page.getByRole('button', { name: dictionaries.ja.addOriginal, exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: dictionaries.ja.theme, exact: true }).click();
  const theme = await page.locator('html').getAttribute('data-theme');
  await expect(page.locator('.statusbar')).toContainText(dictionaries.ja.offline);
  await context.setOffline(true); await page.reload();
  await expect(page.getByRole('button', { name: dictionaries.ja.addOriginal, exact: true }).first()).toBeVisible();
  expect(await page.locator('html').getAttribute('data-theme')).toBe(theme);
});

test('loads ICC and WebP resources in the browser and preserves the output profile', async ({ page }) => {
  const pair = imagePair();
  pair.original.buffer = await sharp(pair.original.buffer).withIccProfile('srgb').png().toBuffer();
  pair.edited = { name: 'edited.webp', mimeType: 'image/webp', buffer: await sharp(pair.edited.buffer).webp({ lossless: true }).toBuffer() };
  await loadPair(page, pair);
  const result = await exportImage(page);
  expect(result.iccEmbeddedProfile?.profile).toEqual(decode(pair.original.buffer).iccEmbeddedProfile?.profile);
  const center = (48 * 96 + 48) * 4;
  expect(result.data[center + 2] - result.data[center]).toBeGreaterThan(150);
  expect([...result.data.subarray(0, 4)]).toEqual([255, 255, 255, 255]);
});

test('paints the same image coordinates after zooming on the WebGL2 fallback', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'gpu', { value: undefined }));
  await loadPair(page);
  await expect(page.locator('.statusbar')).toContainText('WebGL2');
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await page.getByRole('button', { name: 'Erase', exact: true }).click();
  await page.locator('#brush-size').fill('8');
  const box = (await page.locator('.viewport').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2 - 50, box.y + box.height / 2);
  await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + 50, box.y + box.height / 2, { steps: 8 }); await page.mouse.up();
  const result = await exportImage(page);
  const pixel = (x: number, y: number) => [...result.data.subarray((y * 96 + x) * 4, (y * 96 + x) * 4 + 4)];
  expect(pixel(48, 48)).toEqual([255, 255, 255, 255]);
  expect(pixel(48, 35)).toEqual([30, 90, 210, 255]);
  expect(pixel(0, 0)).toEqual([255, 255, 255, 255]);
});

test('applies a position adjustment from the collapsed advanced section and can undo it', async ({ page }) => {
  await loadPair(page);
  const horizontal = page.getByLabel('Horizontal (px)', { exact: true });
  await expect(horizontal).not.toBeVisible();
  await page.locator('summary').filter({ hasText: 'Advanced' }).click();
  await horizontal.fill('8'); await horizontal.press('Tab');
  await expect(page.getByRole('button', { name: 'Export', exact: true })).toBeEnabled();
  const result = await exportImage(page), sample = (48 * 96 + 20) * 4;
  expect([...result.data.subarray(sample, sample + 4)]).toEqual([30, 90, 210, 255]);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  const restored = await exportImage(page);
  expect([...restored.data.subarray(sample, sample + 4)]).toEqual([255, 255, 255, 255]);
});

for (const fallback of [false, true]) test(`compares the result and edited image with a draggable divider on ${fallback ? 'WebGL2' : 'WebGPU'}`, async ({ page }) => {
  if (fallback) await page.addInitScript(() => Object.defineProperty(navigator, 'gpu', { value: undefined }));
  await loadPair(page);
  await page.getByRole('button', { name: 'Erase', exact: true }).click();
  await page.locator('#brush-size').fill('30');
  const box = (await page.locator('.viewport').boundingBox())!, cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await page.mouse.click(cx, cy);
  const before = await exportImage(page);
  await page.getByRole('button', { name: 'Split compare', exact: true }).click();
  const divider = page.getByRole('slider', { name: 'Comparison divider', exact: true });
  await expect(divider).toBeVisible();
  const read = async (offset: number) => {
    const screenshot = sharp(await page.locator('.viewport canvas').screenshot());
    const { width, height } = await screenshot.metadata();
    const { data, info } = await screenshot.extract({ left: Math.floor(width! / 2 + offset) - 4, top: Math.floor(height! / 2) - 4, width: 8, height: 8 }).raw().toBuffer({ resolveWithObject: true });
    // Sample the flat fill without mistaking the high-zoom pixel grid for image color.
    const colors = new Map<string, number>();
    for (let i = 0; i < data.length; i += info.channels) {
      const color = [...data.subarray(i, i + 3)].join(',');
      colors.set(color, (colors.get(color) ?? 0) + 1);
    }
    return [...colors].sort((a, b) => b[1] - a[1])[0][0].split(',').map(Number);
  };
  await expect.poll(() => read(-40)).toEqual([255, 255, 255]);
  await expect.poll(() => read(40)).toEqual([30, 90, 210]);
  await page.mouse.move(cx, cy); await page.mouse.down(); await page.mouse.move(cx + 100, cy, { steps: 5 }); await page.mouse.up();
  await expect.poll(() => read(40)).toEqual([255, 255, 255]);
  await divider.focus(); await divider.press('Home');
  await expect.poll(() => read(40)).toEqual([30, 90, 210]);
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await expect.poll(() => read(40)).toEqual([30, 90, 210]);
  await expect.poll(() => read(-180)).toEqual([30, 90, 210]);
  await page.mouse.move(cx, cy); await page.mouse.down(); await page.mouse.move(cx + 100, cy, { steps: 5 }); await page.mouse.up();
  await expect.poll(() => read(-180)).toEqual([255, 255, 255]);
  await divider.focus(); await divider.press('End');
  await expect.poll(() => read(40)).toEqual([255, 255, 255]);
  expect((await exportImage(page)).data).toEqual(before.data);
  await page.getByRole('button', { name: 'Erase', exact: true }).click();
  await expect(divider).not.toBeVisible();
});
