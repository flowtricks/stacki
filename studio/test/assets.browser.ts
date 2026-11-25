import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';

const browser = await chromium.launch({
  executablePath: process.env['CHROME_PATH'] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const url = process.env['STUDIO_URL'] ?? 'http://localhost:4357/studio';
const folder = 'asset-browser-' + Date.now();
const errors: string[] = [];
page.on('pageerror', (error) => errors.push(error.message));
page.setDefaultTimeout(20_000);
try {
  await page.goto(url);
  await page.getByRole('button', { name: 'Assets', exact: true }).click();
  await page
    .locator('.asset-folder')
    .filter({ hasText: /^public$/ })
    .waitFor();
  assert.equal(await page.locator('.panel-search').count(), 0);
  assert.equal(await page.locator('.asset-body .storage-panel').count(), 0);
  assert.equal(await page.getByRole('button', { name: 'New folder', exact: true }).isDisabled(), true);
  await page
    .locator('.asset-folder')
    .filter({ hasText: /^public$/ })
    .click();
  await page.getByRole('button', { name: 'New folder', exact: true }).click();
  await page.getByPlaceholder('Folder name').fill(folder);
  await page.getByPlaceholder('Folder name').press('Enter');
  await page.locator('.asset-folder').filter({ hasText: folder }).click();
  const upload = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Upload assets', exact: true }).click();
  await (
    await upload
  ).setFiles({
    name: 'sample.png',
    mimeType: 'image/png',
    buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64'),
  });
  await page
    .locator('.asset-name')
    .filter({ hasText: /^sample.png$/ })
    .waitFor();
  await page.waitForFunction(() =>
    [...document.querySelectorAll<HTMLImageElement>('.asset-thumb img')].every((image) => image.complete && image.naturalWidth > 0),
  );
  await page
    .locator('.asset-name')
    .filter({ hasText: /^sample.png$/ })
    .dblclick();
  await page.locator('.asset-tile input').fill('renamed.png');
  await page.locator('.asset-tile input').press('Enter');
  await page
    .locator('.asset-name')
    .filter({ hasText: /^renamed.png$/ })
    .waitFor();
  await page.keyboard.press('Meta+z');
  await page
    .locator('.asset-name')
    .filter({ hasText: /^sample.png$/ })
    .waitFor();
  await page.keyboard.press('Meta+Shift+z');
  await page
    .locator('.asset-name')
    .filter({ hasText: /^renamed.png$/ })
    .waitFor();
  await page.getByRole('button', { name: 'New folder', exact: true }).click();
  await page.getByPlaceholder('Folder name').fill('nested');
  await page.getByPlaceholder('Folder name').press('Enter');
  await page
    .locator('.asset-folder')
    .filter({ hasText: /^nested$/ })
    .waitFor();
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/assets.png' });
  const grid = await page.locator('.asset-grid').evaluate((element) => ({
    columns: getComputedStyle(element).gridTemplateColumns,
    gap: getComputedStyle(element).gap,
  }));
  assert.equal(grid.columns.split(' ').length, 2);
  assert.equal(grid.gap, '10px');
  await page.locator('.asset-tile').dragTo(page.locator('.asset-folder').filter({ hasText: /^nested$/ }));
  await page
    .locator('.asset-name')
    .filter({ hasText: /^renamed.png$/ })
    .waitFor({ state: 'hidden' });
  await page
    .locator('.asset-folder')
    .filter({ hasText: /^nested$/ })
    .click();
  await page.locator('.asset-tile').hover();
  await page.getByRole('button', { name: 'Options for renamed.png', exact: true }).click();
  await page.getByText('Delete', { exact: true }).click();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.getByText('Empty folder. Drop files here or use the upload button.', { exact: true }).waitFor();
  await page.reload();
  await page.getByRole('button', { name: 'Assets', exact: true }).click();
  await page
    .locator('.asset-folder')
    .filter({ hasText: /^public$/ })
    .click();
  await page.locator('.asset-folder').filter({ hasText: folder }).click();
  await page
    .locator('.asset-folder')
    .filter({ hasText: /^nested$/ })
    .click();
  await page.getByText('Empty folder. Drop files here or use the upload button.', { exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'test-results/assets-mobile.png' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
  console.log('Assets: Stacki layout, folder creation, upload, thumbnail, rename, drag move, delete, reload, and mobile passed.');
} finally {
  await browser.close();
}
