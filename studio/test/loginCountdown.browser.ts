// Goal: the login countdown runs under the real response's Content Security Policy.
// Method: serve the generated page in Chromium and advance its clock without contacting GitHub.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { loginPage } from '../src/features/auth/githubLogin';

const browser = await chromium.launch({
  executablePath:
    process.env['CHROME_PATH'] ?? (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : chromium.executablePath()),
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1200, height: 960 } });
page.setDefaultTimeout(10_000);
let requests = 0;
try {
  await page.clock.install({ time: new Date('2026-10-25T11:00:00Z') });
  await page.route('https://studio.test/**', async (route) => {
    requests++;
    const response = loginPage('rate-limit', 429, '', 266);
    await route.fulfill({
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: await response.text(),
    });
  });
  await page.goto('https://studio.test/studio/auth/login', { waitUntil: 'load' });
  const countdown = page.locator('#login-countdown');
  assert.match((await countdown.textContent()) ?? '', /266 seconds/);
  await page.clock.runFor(1000);
  assert.match((await countdown.textContent()) ?? '', /265 seconds/);
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/login-countdown.png' });
  await page.clock.fastForward(264_000);
  assert.match((await countdown.textContent()) ?? '', /1 second,/);
  await page.clock.fastForward(2000);
  assert.equal(await page.getByRole('status').textContent(), 'You can try signing in again below.');
  await page.clock.fastForward(60_000);
  assert.equal(await page.getByRole('status').textContent(), 'You can try signing in again below.');
  assert.equal(await page.getByRole('link').getAttribute('href'), '/studio/auth/login');
  assert.equal(requests, 1);
  console.log('Login countdown, background catch-up, expiry, and script policy passed.');
} finally {
  await browser.close();
}
