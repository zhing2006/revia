import { _electron as electron, test, expect } from '@playwright/test';
import type { ElectronApplication } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decode } from 'fast-png';
import { imagePair } from './fixtures';

test('exports edited pixels on desktop and starts empty after restarting', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'revia-desktop-'));
  let application: ElectronApplication | undefined;
  const executablePath = process.env.REVIA_ELECTRON_EXECUTABLE;
  const launch = () => electron.launch({ executablePath, args: executablePath ? [] : [join(process.cwd(), 'electron/main.mjs')], env: { ...process.env, REVIA_USER_DATA: profile } });
  try {
    application = await launch();
    let page = await application.firstWindow();
    await page.getByLabel('Language', { exact: true }).selectOption('en');
    const { original, edited, width } = imagePair();
    const originalChooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Add original image', exact: true }).first().click();
    await (await originalChooser).setFiles(original);
    const editedChooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Add edited image', exact: true }).click();
    await (await editedChooser).setFiles(edited);
    await expect(page.getByRole('button', { name: 'Export', exact: true })).toBeEnabled();
    const output = join(profile, 'result.png');
    const writing = application.evaluate(({ session }, target) => new Promise<string>(resolve => {
      session.defaultSession.once('will-download', (_event, item) => {
        item.setSavePath(target); item.once('done', (_event, state) => resolve(state));
      });
    }), output);
    await page.getByRole('button', { name: 'Export', exact: true }).first().click();
    expect(await writing).toBe('completed');
    const result = decode(await readFile(output)).data, center = (48 * width + 48) * 4;
    expect([...result.subarray(center, center + 4)]).toEqual([30, 90, 210, 255]);
    expect([...result.subarray(0, 4)]).toEqual([255, 255, 255, 255]);
    const closed = page.waitForEvent('close'); const nativeWindow = await application.browserWindow(page); await nativeWindow.evaluate(window => window.close()); await closed;
    await application.close(); application = undefined;
    application = await launch(); page = await application.firstWindow();
    await expect(page.getByRole('button', { name: 'Add original image', exact: true }).first()).toBeVisible();
    await expect(page.locator('.source-card img')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Export', exact: true }).first()).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  } finally {
    if (application) { await application.close(); }
    await rm(profile, { recursive: true, force: true });
  }
});
