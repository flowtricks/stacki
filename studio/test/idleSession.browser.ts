// Goal: switching tabs keeps editing connected; genuine inactivity releases saved sessions.
// Method: run the real draft editor, hold a sync request, and observe socket close events.
import assert from 'node:assert/strict';
import { chromium, type Page, type WebSocket } from 'playwright';

const browser = await chromium.launch({
  executablePath:
    process.env['CHROME_PATH'] ?? (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : chromium.executablePath()),
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(20_000);
const sockets = new Set<WebSocket>();
page.on('websocket', (socket) => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
});
let release = () => {};
try {
  await page.clock.install();
  let syncStarted = false;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/studio/api/sync', async (route) => {
    syncStarted = true;
    await pending;
    await route.continue();
  });
  await page.goto(process.env['STUDIO_URL'] ?? 'http://localhost:4350/studio', {
    waitUntil: 'domcontentloaded',
  });
  await ready(page);
  assert.ok(sockets.size >= 2, 'the real document and preview sockets are connected');
  for (let attempt = 0; attempt < 100 && !syncStarted; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(syncStarted, 'the real sync request is in flight');
  await visibility(page, 'hidden');
  assert.equal(await page.getByRole('button', { name: 'Resume editing' }).count(), 0);
  assert.ok(sockets.size >= 2, 'pending work keeps the connections available');
  const synced = page.waitForResponse('**/studio/api/sync');
  release();
  await synced;
  await page.clock.fastForward('00:10');
  assert.equal(await page.getByRole('button', { name: 'Resume editing' }).count(), 0);
  assert.ok(sockets.size >= 2, 'finishing saved work in a background tab does not pause early');
  await visibility(page, 'hidden');
  await page.clock.fastForward('04:30');
  assert.equal(await page.getByRole('button', { name: 'Resume editing' }).count(), 0);
  assert.ok(sockets.size >= 2, 'switching tabs preserves the connections through the grace period');
  await visibility(page, 'visible');
  await page.clock.fastForward('00:20');
  assert.equal(await page.getByRole('button', { name: 'Resume editing' }).count(), 0);
  await visibility(page, 'hidden');
  await page.clock.fastForward('05:20');
  await page.getByRole('button', { name: 'Resume editing' }).waitFor();
  await released(page, sockets);
  console.log('Tab switching stays connected; idle saved sessions pause; pending work is protected.');
} finally {
  release();
  await browser.close();
}

async function ready(page: Page) {
  await page.locator('.save-state').filter({ hasText: 'Saved' }).waitFor();
  await page.frameLocator('iframe[title="Site preview"]').locator('h1').waitFor();
}

async function visibility(page: Page, state: 'hidden' | 'visible') {
  // Headless pages stay visible; deliver the browser's visibility transition explicitly.
  await page.evaluate((state) => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: state === 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  }, state);
}

async function released(page: Page, sockets: ReadonlySet<WebSocket>) {
  assert.equal(await page.locator('iframe').count(), 0, 'paused previews are unloaded');
  for (let attempt = 0; attempt < 100 && sockets.size > 0; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(sockets.size, 0, 'all proxied sockets close so the container can sleep');
}
