// Goal: preserve shell navigation and asset picking across desktop and phone layouts.
// Method: drive the running editor through real menus, keyboard shortcuts, and file controls.
import { chromium, type Page } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { switchPage } from './pageNavigation';

const browser = await chromium.launch({
  executablePath:
    process.env['CHROME_PATH'] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(20000);
const errors: string[] = [];
page.on('pageerror', (error) => errors.push(error.message));
try {
  await page.goto(process.env['STUDIO_URL'] ?? 'http://localhost:4351/studio');
  await page.locator('.save-state').filter({ hasText: 'Saved' }).waitFor();
  assert.equal(await page.title(), `Stacki - ${await page.locator('.project-name').innerText()}`);
  await railAndPages(page);
  await switcherAndState(page);
  await assetsAndPicker(page);
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/shell-parity.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await mobilePicker(page);
  await page.getByLabel('Current page', { exact: true }).click();
  const menu = await page.locator('.page-menu').boundingBox();
  assert.ok(menu && menu.x >= 0 && menu.x + menu.width <= 390, 'Page menu fits on a phone');
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
  console.log(
    'Stacki rail shortcuts, page ordering/search, modal cancellation, persistent shell, code width, asset folders/picker and mobile menu passed.',
  );
} finally {
  await browser.close();
}

async function railAndPages(page: Page) {
  const pages = page.getByRole('button', { name: 'Pages', exact: true });
  await pages.hover();
  await page.getByRole('tooltip').filter({ hasText: 'Pages (P)' }).waitFor();
  assert.equal(await pages.evaluate((node) => getComputedStyle(node).borderRadius), '8px');
  await page.keyboard.press('p');
  await page.getByRole('heading', { name: 'Pages', exact: true }).waitFor();
  assert.equal(
    await page.locator('.file-row').first().getAttribute('data-file'),
    'src/pages/index.astro',
  );
  await page.getByLabel('Search files').fill('no-page-matches');
  await page.getByText('No matching pages', { exact: true }).waitFor();
  await page.getByLabel('Search files').press('j');
  assert.equal(await pages.getAttribute('aria-pressed'), 'true', 'Typing must not switch panels');
  await page.getByLabel('Search files').fill('');
  await page.getByRole('button', { name: 'Create page', exact: true }).click();
  await page.getByRole('dialog').waitFor();
  await page.getByLabel('New file name').fill('cancelled-page');
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'Create page', exact: true }).click();
  await page.getByLabel('New file name').fill('index');
  await page.getByLabel('New file name').press('Enter');
  await page.getByRole('dialog').locator('.toast.error').waitFor();
  await page.keyboard.press('Escape');
  await page.getByLabel('Dismiss notification').click();
  await pages.click();
  await page.locator('.studio-left').waitFor({ state: 'detached' });
}
async function switcherAndState(page: Page) {
  await page.getByRole('button', { name: 'Pages', exact: true }).click();
  await page.getByTitle('Phone (375px) — 3', { exact: true }).click();
  await page.getByRole('button', { name: 'Style', exact: true }).click();
  await page.getByLabel('Current page', { exact: true }).click();
  await page.getByLabel('Search pages', { exact: true }).fill('404');
  await page.getByLabel('Search pages', { exact: true }).press('Enter');
  await page.locator('.save-state').filter({ hasText: 'Saved' }).waitFor();
  assert.equal(
    await page.getByLabel('Current page', { exact: true }).getAttribute('data-file'),
    'src/pages/404.astro',
  );
  assert.equal(
    await page.getByRole('button', { name: 'Pages', exact: true }).getAttribute('aria-pressed'),
    'true',
  );
  assert.equal(await page.locator('.right-tabs button.on').innerText(), 'Style');
  await page.waitForFunction(() => document.querySelector('iframe')?.clientWidth === 375);
  await page.getByLabel('Canvas width', { exact: true }).fill('1200');
  await page.getByLabel('Canvas width', { exact: true }).press('Enter');
  await switchPage(page, 'src/pages/index.astro');
  await page.waitForFunction(() => document.querySelector('iframe')?.clientWidth === 1200);
  await page.getByTitle('Desktop — 1', { exact: true }).click();
  await page.getByRole('button', { name: 'Code', exact: true }).click();
  const panel = await page.locator('.studio-left').boundingBox();
  assert.ok(panel && panel.width >= 360, 'Code panel uses Stacki’s wider shell');
  await page.getByRole('button', { name: 'Navigator', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
}
async function assetsAndPicker(page: Page) {
  await page.getByRole('button', { name: 'Assets', exact: true }).click();
  await page
    .locator('.asset-folder')
    .filter({ hasText: /^public$/ })
    .click();
  await page.getByRole('button', { name: 'Upload assets', exact: true }).waitFor();
  assert.equal(
    await page.getByRole('button', { name: 'Upload assets', exact: true }).isEnabled(),
    true,
  );
  await page.getByLabel('Search assets').fill('no-asset-matches');
  await page.getByText('No matching assets', { exact: true }).waitFor();
  await page.getByLabel('Search assets').fill('');
  await page.locator('.asset-crumbs').getByRole('button', { name: 'Assets', exact: true }).click();
  await page
    .locator('.asset-folder')
    .filter({ hasText: /^public$/ })
    .waitFor();
  await page.getByRole('button', { name: 'Navigator', exact: true }).click();
  await page.getByRole('button', { name: 'Choose Image…', exact: true }).click();
  await page.locator('.asset-picking').waitFor();
  await page.locator('.asset-picking').getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('heading', { name: 'Navigator', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Choose Image…', exact: true }).click();
  await page.getByLabel('Search assets').fill('.');
  const titles = await page
    .locator('.asset-tile')
    .evaluateAll((tiles) => tiles.map((tile) => tile.getAttribute('title')));
  assert.ok(titles.length > 0);
  assert.ok(
    titles.every((title) => /\.(png|jpe?g|gif|webp|avif|svg|ico|bmp)$/i.test(title ?? '')),
    'Image picker excludes other asset kinds',
  );
  await page.locator('.asset-picking').getByRole('button', { name: 'Cancel' }).click();
}

async function mobilePicker(page: Page) {
  await page.getByLabel('Close panel').click();
  await page
    .locator('.preview-toolbar')
    .getByRole('button', { name: 'Settings', exact: true })
    .click();
  await page.getByRole('button', { name: 'Choose Image…', exact: true }).click();
  await page.locator('.asset-picking').waitFor();
  assert.equal(
    await page.locator('.studio-right.mobile-open').count(),
    0,
    'Asset picker must be above the inspector',
  );
  await page.locator('.asset-picking').getByRole('button', { name: 'Cancel' }).click();
  await page.locator('.studio-right.mobile-open').waitFor();
  await page.getByLabel('Close settings', { exact: true }).click();
}
