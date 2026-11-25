import assert from 'node:assert/strict';
import { chromium, type Page } from 'playwright';

const browser = await chromium.launch({
  executablePath: process.env['CHROME_PATH'] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const url = process.env['STUDIO_URL'] ?? 'http://localhost:4350/studio';
const errors: string[] = [];
page.on('pageerror', (error) => errors.push(error.message));
page.setDefaultTimeout(20000);

// Observe real Web Audio voices without replacing audio playback.
await context.addInitScript(() => {
  const createOscillator = AudioContext.prototype.createOscillator;
  AudioContext.prototype.createOscillator = function () {
    const voice = createOscillator.call(this);
    const root = document.documentElement;
    root.dataset['soundVoices'] = String(Number(root.dataset['soundVoices'] ?? 0) + 1);
    return voice;
  };
});

try {
  await openEditor(page);
  await openMenu(page, true);
  await page.keyboard.press('Escape');
  await checkPlayback(page, true);
  await openMenu(page, true);
  const toggle = page.getByRole('switch', { name: 'Sound effects' });
  await toggle.focus();
  await page.keyboard.press('Space');
  assert.equal(await toggle.getAttribute('aria-checked'), 'false');
  await page.keyboard.press('Escape');
  await checkPlayback(page, false);
  await page.reload();
  await saved(page);
  await openMenu(page, false);
  await page.keyboard.press('Escape');
  await checkPlayback(page, false);

  const other = await context.newPage();
  await openEditor(other);
  await openMenu(other, false);
  await openMenu(page, false);
  await toggle.click();
  await other.waitForFunction(() => document.querySelector('[role="switch"][aria-label="Sound effects"]')?.getAttribute('aria-checked') === 'true');
  await other.close();
  await page.keyboard.press('Escape');
  await checkPlayback(page, true);
  await page.reload();
  await saved(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await openMenu(page, true);
  await toggle.click();
  assert.equal(await toggle.getAttribute('aria-checked'), 'false');
  await toggle.click();
  assert.equal(await toggle.getAttribute('aria-checked'), 'true');
  assert.deepEqual(errors, []);
  console.log('Stacki audio plays by default, mutes, persists after reload, syncs between tabs, and toggles by keyboard and on mobile.');
} finally {
  await browser.close();
}

async function openEditor(target: Page) {
  await target.goto(url);
  await saved(target);
}

async function saved(target: Page) {
  await target.locator('.save-state').filter({ hasText: 'Saved' }).waitFor({ state: 'attached' });
}

async function openMenu(target: Page, enabled: boolean) {
  await target.getByLabel('Stacki account menu', { exact: true }).click();
  const toggle = target.getByRole('switch', { name: 'Sound effects' });
  await toggle.waitFor();
  assert.equal(await toggle.getAttribute('aria-checked'), String(enabled));
}

async function voices() {
  return page.evaluate(() => Number(document.documentElement.dataset['soundVoices'] ?? 0));
}

async function checkPlayback(target: Page, enabled: boolean) {
  const expand = target.getByRole('button', { name: 'Expand all', exact: true });
  if (await expand.isVisible()) {
    await expand.click();
  }
  await target
    .locator('.structure-node')
    .filter({ has: target.locator('.label', { hasText: /^Heading$/ }) })
    .click();
  await target.locator('.right-tabs').getByRole('button', { name: 'Settings', exact: true }).click();
  const before = await voices();
  await target.locator('.props-group-head').filter({ hasText: 'Settings' }).click();
  if (enabled) {
    assert.ok((await voices()) > before, 'A settings button must play a real Stacki voice');
  } else {
    assert.equal(await voices(), before, 'Muted settings must not create audio voices');
  }
}
