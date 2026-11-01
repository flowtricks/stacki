import { switchPage } from './pageNavigation';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
const browser = await chromium.launch({
  executablePath: process.env['CHROME_PATH'] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
const context = await browser.newContext({
  ...(process.env['STUDIO_STORAGE_STATE'] ? { storageState: process.env['STUDIO_STORAGE_STATE'] } : {}),
});
const page = await context.newPage();
const errors: string[] = [];
let navigations = 0;
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => {
  if (message.text().includes('could not patch the page')) {
    errors.push(message.text());
  }
});
page.on('framenavigated', (frame) => {
  if (frame.parentFrame() && new URL(frame.url()).pathname === '/404') {
    navigations++;
  }
});
try {
  await page.goto(process.env['STUDIO_URL'] ?? 'http://localhost:4351/studio');
  await page.locator('.save-state').filter({ hasText: 'Saved' }).waitFor({ timeout: 90000 });
  for (let visit = 0; visit < 2; visit++) {
    await switchPage(page, 'src/pages/404.astro');
    const preview = page.frameLocator('iframe[title="Site preview"]');
    await preview.locator('h1').waitFor();
    await page.getByRole('button', { name: 'Expand all', exact: true }).click();
    await page
      .locator('.structure-node')
      .filter({ has: page.locator('.label', { hasText: /^Heading$/ }) })
      .first()
      .click();
    await page.locator('.node-outline.sel').waitFor();
    // Real preview fetches must accept the authored 404 response, retain its
    // running document, and complete repeated morphs without a reload cycle.
    for (let update = 0; update < 3; update++) {
      const frame = page.frames().find((candidate) => new URL(candidate.url()).pathname === '/404');
      assert.ok(frame);
      await frame.evaluate(
        () =>
          new Promise<void>((resolve) => {
            document.addEventListener('avb:morphed', () => resolve(), { once: true });
            window.postMessage({ type: 'avb:patch-now' }, location.origin);
          }),
      );
    }
    await page.waitForTimeout(1500);
    assert.equal(navigations, visit + 1, '404 should load exactly once per page switch');
    assert.deepEqual(errors, []);
    await switchPage(page, 'src/pages/index.astro');
    await preview.locator('h1').waitFor();
  }
  console.log('Repeated 404 navigation, selected outlines, and six in-place updates passed without reloads.');
} finally {
  await browser.close();
}
