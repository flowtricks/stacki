// Goal: failed preview documents remain recoverable after their entry grant expires.
// Method: return an error for the first iframe entry in a real Studio fixture,
// advance past expiry, then require a fresh URL and the preview client's readiness
// message. Also verify that the three-breakpoint canvas can confirm readiness.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { record, string } from '../src/shared/validation';
import { startStyleFixture } from './stylePanelFixture';

const fixture = await startStyleFixture({ page: '<main><h1>Preview recovered</h1></main>' });
const browser = await chromium.launch({
  executablePath: process.env['CHROME_PATH'] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(20_000);
  await page.clock.install();
  let grants = 0;
  await page.route('**/studio/api/preview-url?*', async (route) => {
    grants++;
    assert.ok(grants <= 5, 'Preview recovery has bounded entry requests');
    const response = await route.fetch();
    const target = record(await response.json());
    const url = new URL(string(target['url']), fixture.url);
    url.searchParams.set('preview-attempt', String(grants));
    await route.fulfill({ response, json: { ...target, url: url.href } });
  });
  await page.route('**/*preview-attempt=1*', async (route) => {
    await route.fulfill({
      status: 403,
      contentType: 'text/html',
      body: '<p>Preview sign-in expired</p>',
    });
  });
  await page.goto(fixture.url, { waitUntil: 'domcontentloaded' });
  const preview = page.frameLocator('iframe[title="Site preview"]');
  await preview.getByText('Preview sign-in expired', { exact: true }).waitFor({ state: 'attached' });
  assert.equal(
    await page.locator('.preview-frame-wrap').getAttribute('data-preview-loading'),
    'true',
    'An iframe error document must not be treated as a working preview',
  );
  await page.clock.fastForward(31_000);
  await page.getByRole('button', { name: 'Retry preview', exact: true }).click();
  await preview.getByRole('heading', { name: 'Preview recovered', exact: true }).waitFor();
  await page.locator('.preview-frame-wrap[data-preview-loading="false"]').waitFor();
  assert.equal(grants, 2, 'Retry obtains a new entry instead of replaying the expired grant');
  await page.getByRole('button', { name: 'Canvas — all breakpoints — 4', exact: true }).click();
  await page.locator('.preview-frame-wrap[data-preview-loading="false"]').waitFor();
  assert.equal(await page.locator('.canvas-view iframe').count(), 3);
  console.log('Preview errors stay recoverable; retry renews entry; all-breakpoint readiness works.');
} finally {
  await browser.close();
  await fixture.stop();
}
