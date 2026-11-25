import { chromium, type Page } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';

const browser = await chromium.launch({
  executablePath: process.env['CHROME_PATH'] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
const auth = process.env['STUDIO_STORAGE_STATE'];
const page = await browser.newPage({
  viewport: { width: 1440, height: 1000 },
  ...(auth ? { storageState: auth } : {}),
});
page.setDefaultTimeout(20000);
const errors: string[] = [];
page.on('pageerror', (error) => errors.push(error.message));
const row = (name: string) =>
  page.locator('.palette-item').filter({
    has: page.locator('.label', { hasText: new RegExp(`^${name}(?:\\d+ instances?)?$`) }),
  });
let releaseCounts = () => {};
const countsGate = new Promise<void>((resolve) => {
  releaseCounts = resolve;
});
await page.route('**/studio/api/component-usage', async (route) => {
  await countsGate;
  await route.continue();
});
try {
  await page.goto(process.env['STUDIO_URL'] ?? 'http://localhost:4350/studio');
  await page.locator('.save-state').filter({ hasText: 'Saved' }).waitFor();
  const before = await source(page);
  await page.getByRole('button', { name: 'Components', exact: true }).click();
  const pendingBox = await row('Choice').boundingBox();
  releaseCounts();
  await row('Choice').locator('.palette-instances').waitFor();
  assert.deepEqual(await row('Choice').boundingBox(), pendingBox, 'Loading instance counts must not move or resize rows');
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  await row('Choice').hover();
  assert.equal(await page.locator('.comp-preview').isVisible(), true, 'The card opens without advancing any timer');
  await page.getByPlaceholder('Search components').hover();
  assert.equal(await page.locator('.comp-preview').count(), 0, 'Leaving dismisses the card immediately');
  await page.clock.resume();

  await row('Choice').hover();
  await page.locator('.comp-preview[aria-hidden="false"]').waitFor();
  const choice = page.frameLocator('iframe[title="Choice preview"]');
  await choice.getByText('Choice', { exact: true }).waitFor();
  assert.equal(await choice.getByRole('checkbox').isChecked(), false);
  const popup = await page.locator('.comp-preview').boundingBox();
  const anchor = await row('Choice').boundingBox();
  assert.ok(popup && anchor);
  assert.equal(popup.width, 360);
  assert.equal(popup.x, anchor.x + anchor.width + 10);
  await fitted(page, 'Choice');
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/component-hover.png' });

  await row('Button').hover();
  await page
    .locator('.comp-preview-title')
    .filter({ hasText: /^Button$/ })
    .waitFor();
  await page.locator('.comp-preview[aria-hidden="false"]').waitFor();
  assert.equal(await page.locator('.comp-preview').count(), 1);
  await fitted(page, 'Button');
  await page.getByPlaceholder('Search components').hover();
  await page.getByPlaceholder('Search components').fill('Nav');
  await row('Nav').hover();
  await page.locator('.comp-preview[aria-hidden="false"]').waitFor();
  await fitted(page, 'Nav');

  await page.getByPlaceholder('Search components').hover();
  await page.getByPlaceholder('Search components').fill('Img');
  await row('Img').hover();
  const empty = page.frameLocator('iframe[title="Img preview"]');
  await empty.locator('body.avb-is-empty').waitFor({ state: 'attached' });
  assert.equal(await page.locator('.comp-preview').isVisible(), false);
  await page.getByRole('button', { name: 'Navigator', exact: true }).click();
  assert.equal(await page.locator('.comp-preview').count(), 0);
  assert.equal(await source(page), before, 'Hover previews must never edit the page');
  assert.deepEqual(errors, []);
  console.log('Instant component hover, content, defaults, fitting, switching, empty suppression, and dismissal passed.');
} finally {
  releaseCounts();
  await browser.close();
}

async function source(page: Page) {
  const response = await page.request.get(new URL('/studio/api/file?file=src/pages/index.astro', page.url()).href);
  assert.ok(response.ok());
  return response.text();
}

async function fitted(page: Page, name: string) {
  const frame = page.frameLocator(`iframe[title="${name} preview"]`);
  await frame.locator('#avb-stage').waitFor();
  const fits = await frame.locator('#avb-stage').evaluate((stage) => {
    const children = [...stage.children].filter((child) => {
      const box = child.getBoundingClientRect();
      return box.width > 0 && box.height > 0;
    });
    return (
      children.length > 0 &&
      children.every((child) => {
        const box = child.getBoundingClientRect();
        return box.left >= 11 && box.top >= 11 && box.right <= innerWidth - 11 && box.bottom <= innerHeight - 11;
      })
    );
  });
  assert.equal(fits, true, `${name} fits inside Stacki's preview padding`);
}
