// Goal: page navigation reveals usable markup and catches edits during loading once.
// Method: hold an image and an old HTML response, then edit the destination before
// releasing it. Current content must arrive before images, without a load-triggered reread.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { chromium } from 'playwright';
import { startStyleFixture } from './stylePanelFixture';

const fixture = await startStyleFixture({ page: '<main><h1>First page</h1></main>' });
const browser = await chromium.launch({
  executablePath:
    process.env['CHROME_PATH'] ?? (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : chromium.executablePath()),
  headless: true,
});
let release = () => {};
try {
  const destination = path.join(fixture.root, 'src/pages/second.astro');
  await writeFile(destination, '<main><h1>Before navigation</h1><img src="/held.svg" /></main>');
  const page = await browser.newPage();
  page.setDefaultTimeout(20_000);
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/held.svg', async (route) => {
    await held;
    await route.abort();
  });
  let pulls = 0;
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/second' && request.resourceType() === 'fetch') {
      pulls++;
    }
    assert.ok(pulls < 10, 'Navigation refresh work stays bounded');
  });
  await page.goto(fixture.url);
  await page.getByRole('button', { name: 'Pages', exact: true }).click();
  await page.route('**/second', async (route) => {
    if (route.request().resourceType() !== 'document') {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    // The HTML is already rendered; a later source version must replace it.
    await writeFile(destination, '<main><h1>Changed during navigation</h1><img src="/held.svg" /></main>');
    await route.fulfill({ response });
  });
  await page.getByRole('button', { name: 'second.astro', exact: true }).click();
  const preview = page.frameLocator('iframe[title="Site preview"]');
  await preview.getByRole('heading', { name: 'Changed during navigation', exact: true }).waitFor();
  await page.locator('.preview-frame-wrap[data-preview-loading="false"]').waitFor();
  await setTimeout(2000);
  const beforeLoad = pulls;
  assert.ok(beforeLoad <= 3, 'Navigation, edit and subscription startup have bounded fallbacks');
  release();
  await setTimeout(2500);
  assert.equal(pulls, beforeLoad, 'Completing iframe load must not schedule another page render');
  console.log('Navigation catches edits during loading without waiting for images or pulling twice.');
} finally {
  release();
  await browser.close();
  await fixture.stop();
}
