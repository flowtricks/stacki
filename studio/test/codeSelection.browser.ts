import { chromium, type Page } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { record, string } from '../src/shared/validation';
import { parsePageModel } from '../vendor/stacki/shared/page/pageNode';
import { parsePage } from '../src/features/source/source';
import { sourceLineLabel, sourceNodeAtOffset, sourceRangeForSelection } from '../vendor/stacki/src/features/code/codePanelModel';

const browser = await chromium.launch({
  executablePath: process.env['CHROME_PATH'] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 420 } });
page.setDefaultTimeout(20000);
const errors: string[] = [];
page.on('pageerror', (error) => errors.push(error.message));
try {
  await page.goto(process.env['STUDIO_URL'] ?? 'http://localhost:4351/studio');
  await page.locator('.save-state').filter({ hasText: 'Saved' }).waitFor();
  const original = await readSource(page);
  const parsed = parsePage(original, { locs: true });
  assert.ok(parsed.editable);
  const model = parsePageModel(parsed.model);
  const heading = sourceNodeAtOffset(model.nodes, original.indexOf('<Heading') + 2);
  assert.ok(heading);
  const label = sourceLineLabel(original, sourceRangeForSelection(model, heading.id, original.length));
  assert.ok(label);
  await page.getByRole('button', { name: 'Expand all', exact: true }).click();
  await page
    .locator('.structure-node')
    .filter({ has: page.locator('.label', { hasText: /^Heading$/ }) })
    .click();
  await page.getByRole('button', { name: 'Code', exact: true }).click();
  await page.locator('.code-panel-lines').filter({ hasText: label }).waitFor();
  await assertHeadingVisible(page);
  const initialScroll = await page.locator('.cm-scroller').evaluate((element) => element.scrollTop);
  assert.ok(initialScroll > 0, 'Opening Code must reveal the selected block');
  // Select another element on the real canvas, then return to the heading.
  const preview = page.frameLocator('iframe[title="Site preview"]');
  await preview.getByText('v1.0.0', { exact: true }).click();
  await page.locator('.code-panel-lines').filter({ hasText: label }).waitFor({ state: 'hidden' });
  await page.locator('.cm-scroller').evaluate((element) => {
    element.scrollTop = 0;
  });
  await preview.locator('h1').click();
  await page.locator('.code-panel-lines').filter({ hasText: label }).waitFor();
  await assertHeadingVisible(page);
  assert.ok(await page.locator('.cm-scroller').evaluate((element) => element.scrollTop > 0));
  assert.equal(await page.getByRole('button', { name: 'Code', exact: true }).getAttribute('aria-pressed'), 'true');
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/code-selection.png' });
  assert.equal(await readSource(page), original, 'Selecting elements must not change source');
  assert.deepEqual(errors, []);
  console.log('Navigator and canvas selections highlight and reveal matching code without changing source.');
} finally {
  await browser.close();
}

async function readSource(page: Page) {
  const response = await page.request.get(new URL('/studio/api/file?file=src/pages/index.astro', page.url()).href);
  return string(record(await response.json())['source']);
}
async function assertHeadingVisible(page: Page) {
  const opening = page
    .locator('.cm-component-link')
    .filter({ hasText: /^Heading$/ })
    .first();
  await opening.waitFor();
  await page.waitForFunction(() => {
    const token = [...document.querySelectorAll('.cm-component-link')].find((node) => node.textContent === 'Heading');
    const scroller = document.querySelector('.cm-scroller');
    if (!token || !scroller) {
      return false;
    }
    const box = token.getBoundingClientRect();
    const viewport = scroller.getBoundingClientRect();
    return box.top >= viewport.top && box.bottom <= viewport.bottom && !token.closest('.cm-code-muted');
  });
  assert.ok((await page.locator('.cm-code-muted').count()) > 0, 'Surrounding code uses Stacki’s dimming treatment');
}
