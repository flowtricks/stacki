// Goal: measure complete structural updates on the real site's render workload.
// Method: duplicate and delete an existing heading in an explicitly disposable copy,
// recording collaboration and render delivery separately from visible DOM completion.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const url = process.env['STUDIO_URL'];
assert.ok(url, 'Provide the Studio URL of the isolated site copy');
assert.equal(new URL(url).hostname, '127.0.0.1');
assert.ok(process.env['STUDIO_FIXTURE_ROOT']?.includes('/.studio/'), 'Use a disposable copy');
const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1920, height: 1100 } });
page.setDefaultTimeout(60_000);
let started = 0;
let dropPush = false;
const events: { readonly at: number; readonly type: string }[] = [];
await page.routeWebSocket('**/*', (socket) => {
  const server = socket.connectToServer();
  server.onMessage((message) => {
    const raw = String(message);
    if (started && events.length < 100) {
      const type = raw.includes('"event":"studio:render"')
        ? 'render'
        : raw.includes('"type":"update"')
          ? 'source'
          : undefined;
      if (type) {
        events.push({ at: Math.round(performance.now() - started), type });
      }
    }
    if (!dropPush || !raw.includes('"event":"studio:render"')) {
      socket.send(message);
    }
  });
});
try {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.locator('.save-state').filter({ hasText: 'Saved' }).waitFor();
  const frame = page.frameLocator('iframe[title="Site preview"]');
  const heading = frame.getByRole('heading', { name: /Find hope. Live with purpose/ });
  await heading.waitFor();
  await page.getByRole('button', { name: 'Expand all', exact: true }).click();
  await page
    .locator('.structure-node')
    .filter({
      has: page.locator('.label', { hasText: /^Heading$/ }),
    })
    .first()
    .click();
  for (const mode of ['push', 'fallback']) {
    dropPush = mode === 'fallback';
    started = performance.now();
    events.length = 0;
    await page.keyboard.press('ControlOrMeta+d');
    await heading.nth(1).waitFor();
    assert.ok(performance.now() - started < 1200, 'Adding must bypass the 1500ms grace period');
    console.log(mode, 'duplicate', Math.round(performance.now() - started), events);
    started = performance.now();
    events.length = 0;
    await page.keyboard.press('Delete');
    await heading.nth(1).waitFor({ state: 'detached' });
    assert.ok(performance.now() - started < 1200, 'Deleting must bypass the 1500ms grace period');
    console.log(mode, 'delete', Math.round(performance.now() - started), events);
    started = 0;
    await page
      .locator('.structure-node')
      .filter({
        has: page.locator('.label', { hasText: /^Heading$/ }),
      })
      .first()
      .click();
  }
} catch (error: unknown) {
  await page.screenshot({ path: '/tmp/stacki-structural-latency-failure.png' });
  console.log((await page.locator('body').innerText()).slice(0, 1500));
  throw error;
} finally {
  await browser.close();
}
