import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { record, string } from '../src/shared/validation';

const browser = await chromium.launch({
  executablePath: process.env['CHROME_PATH'] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const url = process.env['STUDIO_URL'] ?? 'http://localhost:4360/studio';
const queued: (() => void)[] = [];
let holding = false;
let silent = false;
let connections = 0;
const errors: string[] = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.routeWebSocket('**/studio/sync?*', (socket) => {
  const server = socket.connectToServer();
  connections++;
  server.onMessage((data) => {
    if (silent) {
      return;
    }
    if (holding) {
      queued.push(() => socket.send(data));
    } else {
      socket.send(data);
    }
  });
});
try {
  await page.clock.install();
  await page.goto(url);
  await page.locator('.save-state').filter({ hasText: 'Saved' }).waitFor();
  const original = await source();
  await page.getByRole('button', { name: 'Expand all', exact: true }).click();
  const frame = page.frameLocator('iframe[title="Site preview"]');
  await frame.locator('h1').click();
  await selected('Heading');
  const heading = await page.locator('.rich-content').innerText();
  await frame.getByText('v1.0.0', { exact: true }).click();
  await selected('Eyebrow');
  const eyebrow = await page.locator('.rich-content').innerText();
  await frame.locator('h1').click();
  await selected('Heading');
  holding = true;
  await page.locator('.rich-content').fill('Edited heading');
  await frame.getByText(eyebrow, { exact: true }).click();
  await selected('Eyebrow', 500);
  assert.equal(await page.locator('.rich-content').innerText(), eyebrow);
  await page.locator('.rich-content').fill('Edited eyebrow');
  await frame.locator('h1').click();
  await selected('Heading', 500);
  assert.equal(await page.locator('.rich-content').innerText(), 'Edited heading');
  holding = false;
  for (const reply of queued.splice(0)) {
    reply();
  }
  await page.locator('.save-state').filter({ hasText: 'Saved' }).waitFor();
  await selected('Heading');
  assert.match(await source(), /Edited heading/);
  assert.match(await source(), /Edited eyebrow/);
  await page.locator('.rich-content').fill(heading);
  await frame.getByText('Edited eyebrow', { exact: true }).click();
  await selected('Eyebrow');
  await page.locator('.rich-content').fill(eyebrow);
  await page.locator('.save-state').filter({ hasText: 'Saved' }).waitFor();
  assert.equal(await source(), original);
  await recoverSilentConnection();
  assert.deepEqual(errors, []);
  console.log('Immediate selection during delayed edits, stale reply protection, correct edit targets and silent socket recovery passed.');
} finally {
  await browser.close();
}

async function selected(name: string, timeout = 5000) {
  await page
    .locator('.structure-node.selected')
    .filter({
      has: page.locator('.label', { hasText: new RegExp(`^${name}$`) }),
    })
    .waitFor({ timeout });
}

async function source() {
  const response = await page.request.get(new URL('/studio/api/file?file=src/pages/index.astro', url).href);
  assert.equal(response.status(), 200);
  return string(record(await response.json())['source']);
}

async function recoverSilentConnection() {
  const before = connections;
  const content = page.locator('.rich-content');
  const original = await content.innerText();
  silent = true;
  await content.fill('Pending edit survives reconnect');
  await page.clock.fastForward(76_000);
  silent = false;
  await page.clock.resume();
  await page.waitForFunction(() => document.querySelector('.save-state')?.textContent === 'Saved');
  assert.ok(connections > before, 'A stalled OPEN socket reconnects without a reload');
  assert.equal(await content.innerText(), 'Pending edit survives reconnect');
  assert.match(await source(), /Pending edit survives reconnect/);
  await content.fill(original);
  await page.locator('.save-state').filter({ hasText: 'Saved' }).waitFor();
  await page.frameLocator('iframe[title="Site preview"]').locator('h1').click();
  await selected('Heading');
}
