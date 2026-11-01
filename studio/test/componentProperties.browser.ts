import { chromium, type Page } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { record, string } from '../src/shared/validation';

const browser = await chromium.launch({
  executablePath: process.env['CHROME_PATH'] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const peer = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(20000);
peer.setDefaultTimeout(20000);
const errors: string[] = [];
page.on('pageerror', (error) => errors.push(error.message));
peer.on('pageerror', (error) => errors.push(error.message));
const url = process.env['STUDIO_URL'] ?? 'http://localhost:4358/studio';
const file = 'src/components/typography/Heading.astro';
let original: string | undefined;
try {
  await page.goto(url);
  await saved(page);
  original = await readSource(page);
  assert.equal(await page.getByRole('button', { name: 'Properties', exact: true }).count(), 0);
  await enter(page);
  await page.locator('.project-name').click();
  await page.keyboard.press('k');
  await page.getByRole('region', { name: 'Component properties' }).waitFor();
  await page
    .locator('.property-row-main')
    .filter({ hasText: /^render$/ })
    .waitFor();
  await peer.goto(url);
  await saved(peer);
  await enter(peer);
  await peer.getByRole('button', { name: 'Properties', exact: true }).click();
  await peer
    .locator('.property-row-main')
    .filter({ hasText: /^render$/ })
    .waitFor();
  await page.getByRole('button', { name: 'Add property', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('studioTestLabel');
  await page.getByLabel('Default text', { exact: true }).fill('Default label');
  await page.getByLabel('Tooltip', { exact: true }).fill('Property manager browser verification');
  await page.getByRole('button', { name: 'Save property', exact: true }).click();
  await propertyRow(page).waitFor();
  await propertyRow(peer).waitFor();
  assert.match(await readSource(page), /studioTestLabel\?: string/);
  assert.match(await readSource(page), /Property manager browser verification/);
  await propertyRow(page).click();
  assert.equal(await page.getByLabel('Default text', { exact: true }).inputValue(), 'Default label');
  await page.getByRole('button', { name: 'Close property settings', exact: true }).click();
  const before = await page.locator('.property-row-main').allTextContents();
  await page.getByRole('button', { name: 'Reorder studioTestLabel', exact: true }).press('ArrowUp');
  await page.waitForFunction(() => !document.querySelector('.property-saving-overlay'));
  await waitForOrder(page, before.findIndex((name) => name.endsWith('studioTestLabel')) - 1);
  await page.getByRole('button', { name: 'Delete studioTestLabel', exact: true }).click();
  await propertyRow(page).waitFor({ state: 'detached' });
  await propertyRow(peer).waitFor({ state: 'detached' });
  await page.locator('.property-component').click();
  await page.keyboard.press('Meta+z');
  await propertyRow(page).waitFor();
  await propertyRow(peer).waitFor();
  await page.keyboard.press('Meta+Shift+z');
  await propertyRow(page).waitFor({ state: 'detached' });
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/component-properties.png' });
  await page.getByTitle('Back to page', { exact: true }).click();
  await saved(page);
  assert.equal(await page.getByRole('button', { name: 'Properties', exact: true }).count(), 0);
  await page.locator('.structure-node').first().waitFor();
  assert.equal(await page.getByRole('button', { name: 'Navigator', exact: true }).getAttribute('aria-pressed'), 'true');
  assert.deepEqual(errors, []);
  console.log('Component entry exposes Stacki Properties; K, add/default/tooltip, reorder, delete, collaboration, undo/redo and return-to-page passed.');
} catch (error) {
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/component-properties-failure.png' });
  throw error;
} finally {
  if (original !== undefined) {
    const current = await readSource(page);
    const response = await page.request.post(new URL('/studio/api/source', url).href, {
      data: { file, source: original, base: current },
    });
    assert.ok(response.ok(), 'Restore isolated test draft');
  }
  await browser.close();
}
function propertyRow(page: Page) {
  return page.getByRole('button', { name: 'studioTestLabel', exact: true });
}
async function saved(page: Page) {
  await page.locator('.save-state').filter({ hasText: 'Saved' }).waitFor();
}
async function enter(page: Page) {
  await page.frameLocator('iframe[title="Site preview"]').locator('h1').dblclick();
  await page.locator('.comp-back').filter({ hasText: 'Heading.astro' }).waitFor();
  await saved(page);
}
async function readSource(page: Page) {
  const response = await page.request.get(new URL('/studio/api/file?file=' + encodeURIComponent(file), url).href);
  return string(record(await response.json())['source']);
}
async function waitForOrder(page: Page, position: number) {
  await page.waitForFunction(
    (position) => [...document.querySelectorAll('.property-row-main')].findIndex((element) => element.textContent?.endsWith('studioTestLabel')) === position,
    position,
  );
}
