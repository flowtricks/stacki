import { chromium, type Page } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { record, string } from '../src/shared/validation';

const browser = await chromium.launch({
  executablePath: process.env['CHROME_PATH'] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(20000);
const errors: string[] = [];
page.on('pageerror', (error) => errors.push(error.message));
const url = process.env['STUDIO_URL'] ?? 'http://localhost:4351/studio';
const row = (name: string) => page.locator('.structure-node').filter({ has: page.locator('.label', { hasText: new RegExp(`^${name}$`) }) });
let original: string | undefined;
try {
  await page.goto(url);
  await page.locator('.save-state').filter({ hasText: 'Saved' }).waitFor();
  original = await source(page, 'src/pages/index.astro');
  await page.getByRole('button', { name: 'Expand all', exact: true }).click();
  await row('Heading').click();
  const frame = page.frameLocator('iframe[title="Site preview"]');
  await page.locator('.node-outline.sel').waitFor();
  assert.equal(await page.locator('.node-outline.sel').evaluate((node) => getComputedStyle(node).outlineWidth), '2px');
  assert.equal(await page.locator('.node-outline.sel .node-outline-tag svg').count(), 1);
  await row('Eyebrow').hover();
  await page.locator('.node-outline.hover').waitFor();
  assert.equal(await page.locator('.node-outline.hover').evaluate((node) => getComputedStyle(node).outlineWidth), '1px');
  assert.equal(await page.locator('.node-outline.hover .node-outline-tag').evaluate((node) => getComputedStyle(node).backgroundColor), 'rgba(0, 0, 0, 0)');
  assert.equal(await page.locator('.node-outline.hover .node-outline-tag svg').count(), 1);
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/outline-states.png' });
  await page.locator('.right-tabs').hover();
  await page.locator('.node-outline.hover').waitFor({ state: 'detached' });
  assert.equal(await page.locator('.node-outline.sel').count(), 1);
  const variant = page
    .locator('.props-field')
    .filter({ has: page.locator('.prop-label', { hasText: /^variant$/ }) })
    .locator('.dd-trigger');
  await variant.click();
  await page.locator('.dd-option').filter({ hasText: /^h2$/ }).hover();
  await frame.locator('h1.text-style-h2').waitFor();
  await page.keyboard.press('Escape');
  await frame.locator('h1.text-style-display').waitFor();
  await page.locator('.save-state').filter({ hasText: 'Saved' }).waitFor();
  assert.equal(await source(page, 'src/pages/index.astro'), original, 'Cancelling a hover preview must restore exact source');
  await page.getByTitle('Phone (375px) — 3', { exact: true }).click();
  await page.waitForFunction(() => document.querySelector('iframe')?.clientWidth === 375);
  await page.getByLabel('Canvas width', { exact: true }).fill('1200');
  await page.getByLabel('Canvas width', { exact: true }).press('Enter');
  await page.waitForFunction(() => document.querySelector('iframe')?.clientWidth === 1200);
  await page.getByTitle('Canvas — all breakpoints — 4', { exact: true }).click();
  await page.getByTitle('Fit all breakpoints', { exact: true }).waitFor();
  assert.equal(await page.locator('.canvas-frame iframe').count(), 3);
  await page.getByTitle('Desktop — 1', { exact: true }).click();
  await frame.locator('h1').waitFor();
  await page.getByRole('button', { name: 'Style', exact: true }).click();
  await page.getByText('All changes saved', { exact: true }).waitFor();
  const css = await source(page, 'src/styles/patterns.css');
  await page.locator('input[aria-label="Opacity"]').fill('0.45');
  await page.locator('input[aria-label="Opacity"]').press('Enter');
  await page.waitForFunction(() => {
    const frame = document.querySelector('iframe');
    const heading = frame?.contentDocument?.querySelector('h1');
    return heading && frame?.contentWindow?.getComputedStyle(heading).opacity === '0.45';
  });
  await page.getByText('All changes saved', { exact: true }).waitFor();
  assert.ok((await source(page, 'src/styles/patterns.css')) !== css, 'Style edit must be persisted');
  await page.keyboard.press('Meta+z');
  await page.waitForFunction(() => {
    const frame = document.querySelector('iframe');
    const heading = frame?.contentDocument?.querySelector('h1');
    return heading && frame?.contentWindow?.getComputedStyle(heading).opacity === '1';
  });
  assert.equal(await source(page, 'src/styles/patterns.css'), css, 'Undo must restore the exact stylesheet');
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/parity.png' });
  assert.deepEqual(errors, []);
  console.log('Navigator hover, retained selection, prop hover/revert, responsive width and multi-breakpoint canvas passed.');
} finally {
  await browser.close();
}
async function source(page: Page, file: string) {
  const response = await page.request.get(new URL('/studio/api/file?file=' + encodeURIComponent(file), url).href);
  const data: unknown = await response.json();
  return string(record(data)['source']);
}
