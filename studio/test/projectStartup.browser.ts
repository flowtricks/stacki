// Goal: keep cold startup work alive through connection and focus events while
// preserving refreshes for actual changes. Method: hold real project responses,
// advance browser time past the former timeout, then verify request counts and
// recovery through the real Studio UI. This is a scheduling test, not a benchmark.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startStyleFixture } from './stylePanelFixture';

const fixture = await startStyleFixture();
const browser = await chromium.launch({
  executablePath:
    process.env['CHROME_PATH'] ?? (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : chromium.executablePath()),
  headless: true,
});
let release = () => {};
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(20_000);
  await page.clock.install();
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requests = 0;
  await page.route('**/studio/api/project', async (route) => {
    requests++;
    assert.ok(requests <= 10, 'Startup refresh requests stay bounded');
    if (requests === 1) {
      await gate;
    }
    await route.continue();
  });
  const stream = page.waitForResponse('**/studio/api/astro-events');
  const started = page.waitForRequest('**/studio/api/project');
  await page.goto(fixture.url, { waitUntil: 'domcontentloaded' });
  await started;
  await stream;
  await page.evaluate(() => {
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.clock.fastForward(21_000);
  assert.equal(requests, 1, 'Focus, first stream connection and cold wait reuse the active load');
  await page.evaluate(() => {
    for (let index = 0; index < 20; index++) {
      window.dispatchEvent(new Event('studio:project-changed'));
    }
  });
  assert.equal(requests, 1, 'Changes queue one fresh scan instead of cancelling running work');
  const followup = page.waitForResponse((response) => requests === 2 && new URL(response.url()).pathname === '/studio/api/project');
  release();
  await followup;
  await page.locator('.save-state').filter({ hasText: 'Saved' }).waitFor();
  assert.equal(requests, 2, 'A burst schedules only one follow-up read');
  const refreshed = page.waitForResponse('**/studio/api/project');
  await page.evaluate(() => window.dispatchEvent(new Event('studio:project-changed')));
  await refreshed;
  assert.equal(requests, 3, 'A later project change still refreshes the project');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('.save-state').filter({ hasText: 'Saved' }).waitFor();
  console.log('Cold startup survives focus and stream connection without a duplicate request.');
} finally {
  release();
  await browser.close();
  await fixture.stop();
}
