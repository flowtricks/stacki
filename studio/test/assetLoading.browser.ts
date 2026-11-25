// Goal: default folders and early font loading match Desktop without repeat downloads.
// Method: serve a real WOFF2 from a disposable project, hold its response before the
// font folder opens, then verify previews, remembered navigation and folder fallbacks.
import assert from 'node:assert/strict';
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Page } from 'playwright';
import { startStyleFixture } from './stylePanelFixture';

const fixture = await startStyleFixture();
const browser = await chromium.launch({
  executablePath:
    process.env['CHROME_PATH'] ?? (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : chromium.executablePath()),
  headless: true,
});
try {
  await mkdir(path.join(fixture.root, 'src/assets/images'), { recursive: true });
  await mkdir(path.join(fixture.root, 'src/assets/fonts'), { recursive: true });
  await copyFile('test/fixtures/site/src/assets/fonts/inter-regular.woff2', path.join(fixture.root, 'src/assets/fonts/inter.woff2'));
  await writeFile(path.join(fixture.root, 'src/assets/fonts/large.woff2'), Buffer.alloc(262145));
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(20_000);
  await checkFonts(page);
  await page.close();
  await rm(path.join(fixture.root, 'src/assets/images'), { recursive: true });
  const fallback = await browser.newPage();
  await openAssets(fallback);
  assert.equal(await fallback.locator('.asset-crumbs .last').innerText(), 'assets');
  await fallback.close();
  await rm(path.join(fixture.root, 'src/assets'), { recursive: true });
  const root = await browser.newPage();
  await openAssets(root);
  assert.equal(await root.locator('.asset-crumbs .last').innerText(), 'Assets');
  console.log('Default folders, cached navigation and early real font previews pass.');
} finally {
  await browser.close();
  await fixture.stop();
}

async function openAssets(page: Page): Promise<void> {
  await page.goto(fixture.url);
  await page.locator('.save-state').filter({ hasText: 'Saved' }).waitFor();
  await page.getByRole('button', { name: 'Assets', exact: true }).click();
  await page.getByRole('status', { name: 'Loading assets…', exact: true }).waitFor({ state: 'hidden' });
}

async function checkFonts(page: Page): Promise<void> {
  let downloads = 0;
  let largeDownloads = 0;
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/studio/api/asset?*', async (route) => {
    const file = new URL(route.request().url()).searchParams.get('file');
    if (file === 'src/assets/fonts/inter.woff2') {
      downloads++;
      const response = await route.fetch();
      await gate;
      await route.fulfill({ response });
    } else {
      if (file === 'src/assets/fonts/large.woff2') {
        largeDownloads++;
      }
      await route.continue();
    }
  });
  await openAssets(page);
  assert.equal(await page.locator('.asset-crumbs .last').innerText(), 'images');
  for (let attempt = 0; downloads === 0 && attempt < 100; attempt++) {
    await page.waitForTimeout(20);
  }
  assert.equal(downloads, 1, 'Font starts loading while the images folder is still open');
  assert.equal(largeDownloads, 0, 'Large fonts must not be prefetched');
  release();
  await page.waitForFunction(() => Array.from(document.fonts).some((face) => face.family.startsWith('avb-font-') && face.status === 'loaded'));
  // The oversized invalid file tested the preload budget; remove it before viewing fonts.
  await rm(path.join(fixture.root, 'src/assets/fonts/large.woff2'));
  await page
    .locator('.asset-crumbs .crumb')
    .filter({ hasText: /^assets$/ })
    .click();
  await page
    .locator('.asset-folder')
    .filter({ hasText: /^fonts$/ })
    .click();
  await page.locator('.asset-font').filter({ hasText: 'Aa' }).waitFor({ timeout: 1000 });
  await page.getByRole('button', { name: 'Navigator', exact: true }).click();
  await page.getByRole('button', { name: 'Assets', exact: true }).click();
  await page.locator('.asset-font').filter({ hasText: 'Aa' }).waitFor({ timeout: 1000 });
  assert.equal(await page.locator('.asset-crumbs .last').innerText(), 'fonts');
  assert.equal(downloads, 1, 'Reopening reuses the registered font');
  await page.screenshot({ path: '/tmp/stacki-assets-font-preview.png' });
}
