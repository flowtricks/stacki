import { chromium, type Page } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';

const browser = await chromium.launch({
  executablePath: process.env['CHROME_PATH'] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const url = process.env['STUDIO_URL'] ?? 'http://localhost:4360/studio';
page.setDefaultTimeout(15000);
const errors: string[] = [];
page.on('pageerror', (error) => errors.push(error.message));
try {
  await page.goto(url);
  await saved(page);
  const preview = page.frameLocator('iframe[title="Site preview"]');
  await preview.locator('h1').dblclick();
  const back = page.getByTitle('Back to page', { exact: true });
  await back.waitFor();
  await saved(page);
  const initial = await centered(page);
  const other = await browser.newContext();
  const otherPage = await other.newPage();
  await otherPage.goto(url);
  await saved(otherPage);
  await page.waitForFunction(() => document.querySelectorAll('.collaborators > button').length === 2);
  assert.equal(await centered(page), initial);
  await other.close();
  await page.waitForFunction(() => document.querySelectorAll('.collaborators > button').length === 1);
  assert.equal(await centered(page), initial);
  await page.getByRole('button', { name: 'Current page', exact: true }).click();
  await page.getByRole('listbox', { name: 'Pages' }).waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('listbox', { name: 'Pages' }).waitFor({ state: 'hidden' });
  await back.waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await centered(page);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/component-header.png' });
  await preview.locator('h1').click();
  await page.keyboard.press('Escape');
  await back.waitFor({ state: 'hidden' });
  await saved(page);
  await preview.locator('h1').dblclick();
  await back.waitFor();
  await saved(page);
  await back.focus();
  await page.keyboard.press('Escape');
  await back.waitFor({ state: 'hidden' });
  assert.deepEqual(errors, []);
  console.log('Component Escape works from preview and header; menus keep Escape; the back button stays centered as editors join/leave and on mobile.');
} finally {
  await browser.close();
}

async function saved(page: Page) {
  await page.locator('.save-state').filter({ hasText: 'Saved' }).waitFor({ state: 'attached' });
}

async function centered(page: Page) {
  const header = await page.locator('.studio-titlebar').boundingBox();
  const back = await page.getByTitle('Back to page', { exact: true }).boundingBox();
  const switcher = await page.getByRole('button', { name: 'Current page', exact: true }).boundingBox();
  const publish = await page.getByRole('button', { name: 'Publish', exact: true }).boundingBox();
  assert.ok(header && back && switcher && publish);
  const center = back.x + back.width / 2;
  assert.ok(Math.abs(center - header.x - header.width / 2) < 1, 'Back button is centered in the header');
  assert.ok(switcher.x + switcher.width <= back.x && back.x + back.width <= publish.x, 'Header controls do not overlap');
  return center;
}
