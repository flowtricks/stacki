// Goal: source edits must not rescan assets in every collaborator's browser.
// Method: observe real watcher notifications in two independent browser sessions;
// edit source, replace an image and create a folder, checking both event categories.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { startStyleFixture } from './stylePanelFixture';

const fixture = await startStyleFixture();
const browser = await chromium.launch({
  executablePath:
    process.env['CHROME_PATH'] ?? (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : chromium.executablePath()),
  headless: true,
});
try {
  const pages = await Promise.all([browser.newPage(), browser.newPage()]);
  for (const page of pages) {
    page.setDefaultTimeout(20_000);
    await page.goto(fixture.url, { waitUntil: 'domcontentloaded' });
    await page.locator('.save-state').filter({ hasText: 'Saved' }).waitFor();
    await page.evaluate(() => {
      window.addEventListener('studio:assets-changed', () => performance.mark('asset-change'));
    });
  }
  const refreshed = Promise.all(pages.map((page) => page.waitForResponse('**/studio/api/project')));
  await writeFile(path.join(fixture.root, 'src/pages/index.astro'), '<h1>Changed text</h1>');
  // The source websocket can arrive before the watcher's 200 ms notification.
  // Await the scan it triggers so an early source message cannot hide a rescan.
  await refreshed;
  for (const page of pages) {
    assert.equal(
      await page.evaluate(() => performance.getEntriesByName('asset-change').length),
      0,
      'An ordinary source edit must not invalidate the asset catalog',
    );
  }
  await writeFile(path.join(fixture.root, 'public/pattern.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"/>');
  for (const page of pages) {
    await page.waitForFunction(() => performance.getEntriesByName('asset-change').length > 0);
    await page.evaluate(() => performance.clearMarks('asset-change'));
  }
  await mkdir(path.join(fixture.root, 'public/new-folder'));
  for (const page of pages) {
    await page.waitForFunction(() => performance.getEntriesByName('asset-change').length > 0);
  }
  console.log('Source edits skip asset invalidation; image and folder edits notify both users.');
} finally {
  await browser.close();
  await fixture.stop();
}
