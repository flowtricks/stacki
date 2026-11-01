// Goal: acknowledged renders share work without leaving a canvas stuck forever.
// Method: run the real morph client in Astro and advance browser time to exercise
// the bounded watchdog, repeated acknowledgements, failure and disconnect recovery.
import assert from 'node:assert/strict';
import { chromium, type Page } from 'playwright';
import { startStyleFixture } from './stylePanelFixture';

const fixture = await startStyleFixture();
try {
  const browser = await chromium.launch({
    executablePath:
      process.env['CHROME_PATH'] ??
      (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : chromium.executablePath()),
    headless: true,
  });
  try {
    const page = await browser.newPage();
    await page.goto(fixture.url);
    await page.frameLocator('iframe[title="Site preview"]').locator('#target').waitFor();
    await page.clock.install();
    await page.clock.pauseAt(new Date());
    await checkDeadline(page);
    await checkDisconnect(page);
  } finally {
    await browser.close();
  }
} finally {
  await fixture.stop();
}

async function checkDeadline(page: Page) {
  let pulls = 0;
  page.on('request', (request) => {
    if (request.resourceType() === 'fetch' && new URL(request.url()).pathname === '/') {
      pulls++;
    }
  });
  const preview = page.frames().find((frame) => frame.url().includes('#avb-design'));
  assert.ok(preview, 'The real preview must be mounted');
  await preview.evaluate(() => {
    document.dispatchEvent(new CustomEvent('studio:render-push', { detail: true }));
    document.dispatchEvent(new Event('studio:render-pending'));
  });
  await page.clock.runFor(1600);
  assert.equal(pulls, 0, 'Acknowledged work suppresses the old 1500ms fallback');
  await preview.evaluate(() => document.dispatchEvent(new Event('studio:render-pending')));
  const request = page.waitForRequest((item) => item.resourceType() === 'fetch' && new URL(item.url()).pathname === '/');
  await page.clock.runFor(18_400);
  await request;
  assert.equal(pulls, 1, 'Repeated pending messages cannot postpone the 20-second watchdog');
}

async function checkDisconnect(page: Page) {
  const preview = page.frames().find((frame) => frame.url().includes('#avb-design'));
  assert.ok(preview);
  const request = page.waitForRequest((item) => item.resourceType() === 'fetch' && new URL(item.url()).pathname === '/');
  await preview.evaluate(() => {
    document.dispatchEvent(new Event('studio:render-pending'));
    document.dispatchEvent(new CustomEvent('studio:render-push', { detail: false }));
  });
  await request;
  console.log('Acknowledged render: no duplicate pull; bounded timeout and disconnect recover.');
}
