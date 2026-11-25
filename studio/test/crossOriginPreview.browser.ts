// Goal: cloud previews become ready while their cross-origin frame is hidden.
// Method: serve the real preview on a different loopback host, matching the cloud
// parent-origin metadata. Use the browser's real animation clock: mocked animation
// frames would hide Chromium's visibility throttling and miss this deadlock.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { record, string } from '../src/shared/validation';
import { startStyleFixture } from './stylePanelFixture';

const fixture = await startStyleFixture({ page: '<main><h1>Cross-origin preview</h1></main>' });
const browser = await chromium.launch({
  executablePath: process.env['CHROME_PATH'] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(10_000);
  const parent = new URL(fixture.url).origin;
  const preview = new URL(fixture.url);
  preview.hostname = '127.0.0.1';
  await page.route('**/studio/api/preview-url?*', async (route) => {
    const response = await route.fetch();
    const target = record(await response.json());
    const url = new URL(string(target['url']), fixture.url);
    url.hostname = preview.hostname;
    await route.fulfill({ response, json: { ...target, url: url.href, origin: url.origin } });
  });
  await page.route(`${preview.origin}/`, async (route) => {
    const response = await route.fetch();
    const body = await response.text();
    assert.ok(body.length < 100_000, 'The preview fixture remains small');
    const marker = '<meta name="studio-parent-origin" content="">';
    assert.ok(body.includes(marker), 'The fixture has the real preview parent-origin marker');
    await route.fulfill({
      response,
      body: body.replace(marker, `<meta name="studio-parent-origin" content="${parent}">`),
    });
  });
  await page.goto(fixture.url, { waitUntil: 'domcontentloaded' });
  await page.locator('.preview-frame-wrap[data-preview-loading="false"]').waitFor();
  await page.frameLocator('iframe[title="Site preview"]').getByRole('heading', { name: 'Cross-origin preview', exact: true }).waitFor();
  console.log('Hidden cross-origin preview initializes without waiting for animation frames.');
} finally {
  await browser.close();
  await fixture.stop();
}
