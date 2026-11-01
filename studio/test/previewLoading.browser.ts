import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';

const browser = await chromium.launch({
  executablePath: process.env['CHROME_PATH'] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(20000);
const url = process.env['STUDIO_URL'] ?? 'http://localhost:4373/studio';
let release = () => {};
const gate = new Promise<void>((resolve) => {
  release = resolve;
});
let requests = 0;
await page.route('**/*', async (route) => {
  const request = route.request();
  if (request.isNavigationRequest() && request.frame().parentFrame()) {
    requests++;
    await gate;
  }
  await route.continue().catch(() => {});
});
try {
  await page.clock.install();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  const loading = page.getByRole('status').filter({ hasText: 'Loading your preview' });
  await loading.waitFor();
  await page.locator('iframe[title="Site preview"]').waitFor({ state: 'attached' });
  assert.equal(await page.locator('.frame-sized').evaluate((node) => getComputedStyle(node).visibility), 'hidden');
  assert.notEqual(await loading.evaluate((node) => getComputedStyle(node).backgroundColor), 'rgb(255, 255, 255)');
  await page.clock.fastForward(16000);
  const retry = page.getByRole('button', { name: 'Retry preview' });
  await retry.waitFor();
  const first = requests;
  await retry.click();
  await page.clock.resume();
  await loading.waitFor();
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/preview-loading.png' });
  release();
  await page.frameLocator('iframe[title="Site preview"]').locator('h1').waitFor();
  await page.locator('.studio-preview-loading').waitFor({ state: 'detached' });
  assert.ok(requests > first, 'Retry starts a fresh preview request');
  assert.equal(await page.locator('.frame-sized').evaluate((node) => getComputedStyle(node).visibility), 'visible');
  console.log('Delayed real preview shows a dark loading state, exposes retry, and becomes visible when ready.');
} finally {
  release();
  await browser.close();
}
