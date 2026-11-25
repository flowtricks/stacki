import { switchPage } from './pageNavigation';
import { chromium, type Page } from 'playwright';
import assert from 'node:assert/strict';
const browser = await chromium.launch({
  executablePath: process.env['CHROME_PATH'] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
const url = process.env['STUDIO_URL'] ?? 'http://localhost:4351/studio';
const firstContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const secondContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await firstContext.addInitScript(() => sessionStorage.setItem('studio-name', 'First'));
await secondContext.addInitScript(() => sessionStorage.setItem('studio-name', 'Second'));
const first = await firstContext.newPage();
const second = await secondContext.newPage();
const row = (page: Page, name: string) =>
  page
    .locator('.structure-node')
    .filter({ has: page.locator('.label', { hasText: new RegExp(`^${name}$`) }) })
    .first();
let release = () => {};
const gate = new Promise<void>((resolve) => {
  release = resolve;
});
let delayed = false;
let original: string | undefined;
try {
  await Promise.all([first.goto(url), second.goto(url)]);
  for (const page of [first, second]) {
    await page.locator('.save-state').filter({ hasText: 'Saved' }).waitFor();
    await page.getByRole('button', { name: 'Expand all', exact: true }).click();
  }
  await row(first, 'Heading').click();
  await row(second, 'Eyebrow').click();
  const outline = first.locator('.collaborator-outline[data-peer="Second"]');
  await outline.waitFor();
  assert.equal(await first.locator('.collaborator-outline[data-peer="First"]').count(), 0, 'An editor must never see their own selection as a collaborator');
  assert.equal(await second.locator('.collaborator-outline[data-peer="Second"]').count(), 0);
  assert.equal(await outline.evaluate((node) => getComputedStyle(node).outlineColor), 'rgb(0, 157, 255)');
  assert.equal(await outline.locator('.collaborator-avatar').count(), 1);
  await first.getByRole('button', { name: 'Go to Second’s selection', exact: true }).click();
  await first
    .locator('.structure-node.selected .label')
    .filter({ hasText: /^Eyebrow$/ })
    .waitFor();
  await switchPage(second, 'src/pages/404.astro');
  await second.locator('.save-state').filter({ hasText: 'Saved' }).waitFor();
  await second.getByRole('button', { name: 'Expand all', exact: true }).click();
  await row(second, 'Heading').click();
  await first
    .getByRole('button', { name: 'Go to Second’s selection', exact: true })
    .filter({ has: first.locator('text=SE') })
    .waitFor();
  await first.getByRole('button', { name: 'Pages', exact: true }).click();
  await first.locator('.file-row[data-file="src/pages/index.astro"]').getByRole('group').getByTitle('First', { exact: true }).waitFor();
  await first.locator('.file-row[data-file="src/pages/404.astro"]').getByRole('group').getByTitle('Second', { exact: true }).waitFor();
  await first.waitForFunction(() => document.querySelector('[aria-label="Go to Second’s selection"]')?.getAttribute('title')?.includes('404.astro'));
  await first.getByRole('button', { name: 'Go to Second’s selection', exact: true }).click();
  await first.waitForFunction(() => document.querySelector('[aria-label="Current page"]')?.getAttribute('data-file') === 'src/pages/404.astro');
  await first.locator('.node-outline.sel').waitFor();
  assert.equal(await first.locator('.collaborator-outline[data-peer="First"]').count(), 0, 'Switching file connections must not expose an old self selection');
  await first
    .locator('.structure-node.selected .label')
    .filter({ hasText: /^Heading$/ })
    .waitFor();
  // Hold every new server rendering to prove literal text previews do not wait
  // on a network round trip or Astro compilation, including on the other editor.
  for (const page of [first, second]) {
    await switchPage(page, 'src/pages/index.astro');
    await page.locator('.save-state').filter({ hasText: 'Saved' }).waitFor();
    await page.getByRole('button', { name: 'Expand all', exact: true }).click();
    await row(page, 'Heading').click();
    await page.frameLocator('iframe[title="Site preview"]').locator('h1').waitFor();
    await page.route('**/*', async (route) => {
      if (delayed && route.request().resourceType() === 'fetch' && new URL(route.request().url()).pathname === '/') {
        await gate;
      }
      await route.continue();
    });
  }
  original = await first.locator('.rich-content').innerText();
  delayed = true;
  const start = Date.now();
  await first.locator('.rich-content').fill('Instant collaborative text');
  for (const page of [first, second]) {
    await page
      .frameLocator('iframe[title="Site preview"]')
      .getByRole('heading', { name: 'Instant collaborative text', exact: true })
      .waitFor({ timeout: 1500 });
  }
  console.log(`Literal text reached both previews in ${Date.now() - start}ms while server renders were held.`);
  await first.locator('.rich-content').fill(original);
  release();
  await first.locator('.save-state').filter({ hasText: 'Saved' }).waitFor();
  await first.frameLocator('iframe[title="Site preview"]').getByRole('heading', { name: original, exact: true }).waitFor();
  await first.getByRole('button', { name: 'Pages', exact: true }).click();
  const pagePeople = first.locator('.file-row[data-file="src/pages/index.astro"] .page-presence');
  await pagePeople.getByTitle('First', { exact: true }).waitFor();
  await pagePeople.getByTitle('Second', { exact: true }).waitFor();
  assert.equal(await first.locator('.file-row[data-file="src/pages/404.astro"] .page-presence').count(), 0);
  await secondContext.close();
  await pagePeople.getByTitle('Second', { exact: true }).waitFor({ state: 'detached' });
  await pagePeople.getByTitle('First', { exact: true }).waitFor();
  await first.screenshot({ path: 'test-results/page-presence.png' });
  console.log(
    'Blue collaborator outline, avatar following across pages, exact selection, immediate text previews, and page presence movement/disconnection passed.',
  );
} finally {
  release();
  if (original !== undefined) {
    await first
      .locator('.rich-content')
      .fill(original)
      .catch(() => {});
    await first
      .locator('.save-state')
      .filter({ hasText: 'Saved' })
      .waitFor()
      .catch(() => {});
  }
  await browser.close();
}
