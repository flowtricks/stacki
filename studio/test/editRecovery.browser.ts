// Goal: preserve real edits across failed saves, navigation, and outside changes.
// Method: obstruct the real atomic-write destination, recover through browser
// reload, then edit the source on disk with delayed real preview deliveries.
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Page } from 'playwright';
import { startStyleFixture } from './stylePanelFixture';
import { delayPreviewRenders } from './delayedPreview.browser';
import { switchPage } from './pageNavigation';

const original = '<main><h1>Original heading</h1><p>Keep sibling</p></main>';
const fixture = await startStyleFixture({ page: original });
try {
  await writeFile(path.join(fixture.root, 'src/pages/other.astro'), '<h1>Other page</h1>');
  await checkRecovery();
} finally {
  await fixture.stop();
}

async function checkRecovery() {
  const browser = await chromium.launch({
    executablePath:
      process.env['CHROME_PATH'] ??
      (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : chromium.executablePath()),
    headless: true,
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(20_000);
    const delayed = await delayPreviewRenders(page);
    await page.goto(fixture.url);
    await heading(page, 'Original heading');
    await selectHeading(page);
    await page.locator('.save-state').filter({ hasText: 'Saved' }).waitFor();
    await checkFailedSave(page);
    delayed.enable();
    await page.locator('.rich-content').fill('Edit before navigating');
    await page.locator('.save-state').filter({ hasText: 'Saved' }).waitFor();
    await switchPage(page, 'src/pages/other.astro');
    await heading(page, 'Other page');
    await delayed.drain();
    assert.equal(await page.frameLocator('iframe').locator('h1').innerText(), 'Other page');
    await switchPage(page, 'src/pages/index.astro');
    await heading(page, 'Edit before navigating');
    await writeFile(path.join(fixture.root, 'src/pages/index.astro'), '<main><h1>Outside edit</h1><p>Keep sibling</p></main>');
    await heading(page, 'Outside edit');
    await delayed.drain();
    assert.equal(await page.frameLocator('iframe').locator('h1').innerText(), 'Outside edit');
    assert.equal(await page.frameLocator('iframe').locator('main > p').innerText(), 'Keep sibling');
    delayed.assertDelivered();
    console.log('Failed-save recovery, navigation, and outside edits preserve the expected page.');
  } finally {
    await browser.close();
  }
}

async function checkFailedSave(page: Page) {
  const file = path.join(fixture.root, 'src/pages/index.astro');
  const obstruction = file + '.studio-tmp';
  await mkdir(obstruction);
  try {
    await page.locator('.rich-content').fill('Keep my unsaved edit');
    await page.locator('.save-state').filter({ hasText: 'Needs attention' }).waitFor();
    assert.equal(await readFile(file, 'utf8'), original);
    assert.equal(await page.locator('.rich-content').innerText(), 'Keep my unsaved edit');
  } finally {
    await rm(obstruction, { recursive: true, force: true });
  }
  await page.reload();
  await page.locator('.save-state').filter({ hasText: 'Saved' }).waitFor();
  await heading(page, 'Keep my unsaved edit');
  assert.match(await readFile(file, 'utf8'), /Keep my unsaved edit/);
  await selectHeading(page);
}

async function selectHeading(page: Page) {
  const expand = page.getByRole('button', { name: 'Expand all', exact: true });
  if (await expand.isVisible()) {
    await expand.click();
  }
  await page
    .locator('.structure-node')
    .filter({
      has: page.locator('.label', { hasText: /^h1$/ }),
    })
    .click();
}

async function heading(page: Page, text: string) {
  await page.frameLocator('iframe').getByRole('heading', { name: text, exact: true }).waitFor();
}
