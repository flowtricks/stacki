import { chromium, type Page } from 'playwright';
import { checkEditingStability } from './styleEditingStability.browser';
import { startStyleFixture } from './stylePanelFixture';
import { record, string } from '../src/shared/validation';
import assert from 'node:assert/strict';

const fixture = await startStyleFixture();
const browser = await chromium.launch({
  executablePath: process.env['CHROME_PATH'] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1500, height: 1050 } });
page.setDefaultTimeout(20000);
const errors: string[] = [];
page.on('pageerror', (error) => errors.push(error.message));
try {
  await page.addInitScript(() => {
    Reflect.set(window, '__name', (value: unknown) => value);
  });
  await page.goto(fixture.url);
  await page.locator('.save-state').filter({ hasText: 'Saved' }).waitFor();
  await page
    .frameLocator('iframe[title="Site preview"]')
    .locator('#target')
    .click({ position: { x: 5, y: 5 } });
  await page.getByRole('button', { name: 'Style', exact: true }).click();
  const chip = page.locator('.embed-editor_selector-chip').filter({ hasText: /^\.component$/ });
  await chip.waitFor();
  await page.waitForFunction(() => document.querySelector<HTMLInputElement>('input[aria-label="Opacity"]')?.value === '0.9');
  await page.waitForTimeout(2000);
  await observePanel(page);
  // Cross two normal refresh intervals, then move between canvas and inspector.
  await page.waitForTimeout(9500);
  for (let index = 0; index < 8; index++) {
    await page.frameLocator('iframe[title="Site preview"]').locator('#child').hover();
    await page.locator('.embed-editor_selector-well').hover();
  }
  let failures = 0;
  const fileRoute = '**/studio/api/file?file=src%2Fcomponents%2FCard.astro';
  await page.route(fileRoute, (route) => {
    failures++;
    return route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Restarting' }),
    });
  });
  await page.waitForTimeout(9500);
  assert.ok(failures > 0, 'The background scan must actually encounter a failed HTTP read');
  assert.ok(failures <= 3, 'Failed scans must remain throttled');
  assert.equal(await chip.count(), 1, 'Failed background reads must retain the visible selector');
  assert.equal(await page.locator('input[aria-label="Opacity"]').inputValue(), '0.9');
  assert.equal(await page.locator('html').getAttribute('data-style-removals'), '0');
  assert.equal(await page.locator('html').getAttribute('data-style-value-flashes'), '0');
  await page.unroute(fileRoute);
  await checkRecovery(page, fixture.url);
  await checkEditingStability(page);
  assert.deepEqual(errors, []);
  console.log('Stable idle/hover panel; failed stylesheet reads retain chips and values; successful background reads still update styles.');
} finally {
  await browser.close();
  await fixture.stop();
}
async function observePanel(page: Page) {
  await page.evaluate(() => {
    const panel = document.querySelector('.style-panel-host');
    if (!panel) {
      throw new Error('No style panel');
    }
    let removals = 0;
    let flashes = 0;
    document.documentElement.dataset['styleRemovals'] = '0';
    document.documentElement.dataset['styleValueFlashes'] = '0';
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.removedNodes) {
          if (node instanceof Element && (node.matches('.embed-editor_selector-chip') || node.querySelector('.embed-editor_selector-chip'))) {
            removals++;
          }
        }
      }
      const value = panel.querySelector<HTMLInputElement>('input[aria-label="Opacity"]')?.value;
      if (value !== '0.9') {
        flashes++;
      }
      document.documentElement.dataset['styleRemovals'] = String(removals);
      document.documentElement.dataset['styleValueFlashes'] = String(flashes);
    }).observe(panel, { subtree: true, childList: true, attributes: true });
  });
}
async function checkRecovery(page: Page, url: string) {
  const file = 'src/components/Card.astro';
  const response = await page.request.get(new URL('/studio/api/file?file=' + encodeURIComponent(file), url).href);
  assert.ok(response.ok());
  const base = string(record(await response.json())['source']);
  const write = await page.request.post(new URL('/studio/api/source', url).href, {
    data: { file, base, source: base.replace('opacity: 0.9', 'opacity: 0.55') },
  });
  assert.ok(write.ok());
  await page.waitForFunction(() => document.querySelector<HTMLInputElement>('input[aria-label="Opacity"]')?.value === '0.55');
}
