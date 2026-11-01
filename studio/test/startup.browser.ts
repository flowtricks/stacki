import assert from 'node:assert/strict';
import { chromium, type Page } from 'playwright';
import { mkdir } from 'node:fs/promises';

const browser = await chromium.launch({
  executablePath: process.env['CHROME_PATH'] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
const url = process.env['STUDIO_URL'] ?? 'http://localhost:4373/studio';
try {
  await delayedStartup();
  await interruptedStartup();
  console.log('Startup progress, elapsed-time feedback, aborting a stalled request, automatic reconnect, bounded failures and manual recovery passed.');
} finally {
  await browser.close();
}

async function delayedStartup() {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  await page.route('**/studio/api/project', async (route) => {
    if (++calls === 1) {
      await gate;
    }
    await route.continue().catch(() => {});
  });
  try {
    await page.clock.install();
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    const bar = page.getByRole('progressbar', { name: 'Opening Studio' });
    await bar.waitFor();
    assert.equal(await bar.getAttribute('aria-valuenow'), null, 'No invented percentage');
    await page.clock.fastForward(11000);
    await page.getByRole('button', { name: 'Retry opening Studio' }).waitFor();
    await page.getByText('This is taking longer than usual.', { exact: false }).waitFor();
    await mkdir('test-results', { recursive: true });
    await page.screenshot({ path: 'test-results/startup-progress.png' });
    await page.getByRole('button', { name: 'Retry opening Studio' }).click();
    await page.clock.resume();
    await editorReady(page);
    release();
    assert.equal(calls, 2);
    assert.equal(await page.getByRole('alert').count(), 0, 'Canceled request cannot report a stale error');
  } finally {
    release();
    await page.close();
  }
}

async function interruptedStartup() {
  const page = await browser.newPage();
  let fail = true;
  let calls = 0;
  await page.route('**/studio/api/project', async (route) => {
    calls++;
    if (fail) {
      await route.abort('connectionreset');
    } else {
      await route.continue();
    }
  });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.getByText('Unable to open your studio.', { exact: true }).waitFor();
  assert.equal(calls, 3, 'Startup retries stop after three attempts');
  fail = false;
  await page.getByRole('button', { name: 'Retry opening Studio' }).click();
  await editorReady(page);
  assert.equal(calls, 4);
  await page.close();
}

async function editorReady(page: Page) {
  await page.locator('.save-state').filter({ hasText: 'Saved' }).waitFor();
  await page.frameLocator('iframe[title="Site preview"]').locator('h1').waitFor();
  assert.equal(await page.getByRole('progressbar', { name: 'Opening Studio' }).count(), 0);
}
