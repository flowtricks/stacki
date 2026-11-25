// Goal: exercise the shared toast stack in the real Studio, including live agent file activity.
// Method: change Astro files in an explicitly selected scratch draft and drive real pointer/keyboard
// input and real timer deadlines. Also verify startup recovery.
import { chromium, type Page, type Locator } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';

const workspace = process.env['STUDIO_NOTIFICATION_WORKSPACE'];
assert.ok(workspace, 'Set STUDIO_NOTIFICATION_WORKSPACE to the running scratch draft');
const directory = path.join(workspace, 'src/components/ToastRegression');
const browser = await chromium.launch({
  executablePath: process.env['CHROME_PATH'] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
const url = process.env['STUDIO_URL'] ?? 'http://localhost:4350/studio';
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(15000);
const errors: string[] = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.route('**/studio/api/sync', (route) => route.fulfill({ json: { kind: 'synced', sha: 'b'.repeat(40) } }));
try {
  await page.goto(url);
  await page.locator('.save-state').filter({ hasText: 'Saved' }).waitFor();
  assert.equal(await page.locator('.toast').count(), 0, 'Opening a project is silent');
  await mkdir(directory, { recursive: true });
  await add('First');
  await add('Second');
  const cards = page.locator('.toast');
  assert.equal(await cards.count(), 2);
  assert.match(await cards.first().innerText(), /Second/);
  await verifyOverlap(cards);
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/notifications-desktop.png', animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  await bottomToast(page);
  await page.screenshot({ path: 'test-results/notifications-mobile.png', animations: 'disabled' });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await drag(cards.first(), 25);
  assert.equal(await cards.count(), 2, 'Short drags snap back');
  await cards.first().hover();
  await page.waitForTimeout(250);
  await verifyExpansion(cards);
  await page.waitForTimeout(6000);
  assert.equal(await cards.count(), 2, 'Reading the expanded stack pauses every card');
  await drag(cards.first(), 120);
  await page.waitForTimeout(250);
  assert.equal(await cards.count(), 1, 'Dragging dismisses only the selected card');
  await cards.first().getByLabel('Dismiss notification').click();
  await page.waitForTimeout(250);
  assert.equal(await cards.count(), 0, 'Dragging dismisses the card');
  await add('Third');
  await cards.first().getByLabel('Dismiss notification').focus();
  await page.waitForTimeout(6000);
  assert.equal(await cards.count(), 1, 'Keyboard focus pauses expiration');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  assert.equal(await cards.count(), 0);
  await page.mouse.move(10, 10);
  await add('Fourth');
  await writeFile(path.join(directory, 'Fourth.astro'), '<p>Ordinary edit</p>');
  await page.waitForTimeout(500);
  assert.equal(await cards.count(), 1, 'Editing an existing Astro file adds no notice');
  await page.waitForTimeout(5500);
  assert.equal(await cards.count(), 0, 'Unattended cards expire');
  await rm(path.join(directory, 'Fourth.astro'));
  await cards.filter({ hasText: 'Removed src/components/ToastRegression/Fourth.astro' }).waitFor();
  await cards.first().getByLabel('Dismiss notification').click();
  await page.waitForTimeout(250);
  assert.equal(await cards.count(), 0);
  await bootFailure();
  assert.deepEqual(errors, []);
  console.log('Toast stacking, overlap, drag, timers, hover/focus, mobile, Astro add/remove/edit, and startup retry passed.');
} finally {
  await browser.close();
  await rm(directory, { recursive: true, force: true });
}

async function add(name: string) {
  await writeFile(path.join(directory, `${name}.astro`), `<p>${name}</p>`);
  await page
    .locator('.toast')
    .filter({ hasText: `Added src/components/ToastRegression/${name}.astro` })
    .waitFor();
  await page.waitForTimeout(220);
}

async function verifyOverlap(cards: Locator) {
  const front = await cards.nth(0).boundingBox();
  const back = await cards.nth(1).boundingBox();
  assert.ok(front && back);
  assert.ok(front.y > back.y && front.y < back.y + back.height);
  assert.ok(front.width > back.width);
}

async function verifyExpansion(cards: Locator) {
  const front = await cards.nth(0).boundingBox();
  const back = await cards.nth(1).boundingBox();
  assert.ok(front);
  assert.ok(back);
  assert.ok(back.y + back.height < front.y, 'Expanded cards have a readable gap');
  assert.equal(front.width, back.width);
}

async function drag(card: Locator, distance: number) {
  const count = await page.locator('.toast').count();
  const box = await card.boundingBox();
  assert.ok(box);
  const x = box.x + 80;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + distance, y, { steps: 8 });
  if (Math.abs(distance) >= 72) {
    await page.waitForTimeout(220);
    assert.equal(await page.locator('.toast').count(), count - 1, 'Dismissal occurs before release');
  }
  await page.mouse.up();
  await page.waitForTimeout(220);
}

async function bottomToast(target: Page) {
  const box = await target.locator('.toast').first().boundingBox();
  const viewport = target.viewportSize();
  assert.ok(box && viewport);
  assert.ok(box.x >= 0 && box.x + box.width <= viewport.width);
  assert.ok(viewport.height - box.y - box.height < 50);
}

async function bootFailure() {
  const boot = await browser.newPage();
  await boot.route('**/studio/api/project', (route) => route.fulfill({ status: 400, json: { error: 'Startup regression failure.' } }), { times: 1 });
  await boot.goto(url);
  await boot.locator('.studio-toast').filter({ hasText: 'Startup regression failure' }).waitFor();
  await boot.getByRole('button', { name: 'Retry opening Studio', exact: true }).click();
  await boot.locator('.save-state').filter({ hasText: 'Saved' }).waitFor();
  await boot.getByLabel('Dismiss notification').click();
  await boot.locator('.studio-toast').waitFor({ state: 'detached' });
  await boot.close();
}
