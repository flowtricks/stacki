import { PARAGRAPH_TEXT } from '../src/features/source/instanceDefaults';
// Verify real browser shortcuts in the inspector, canvas and code editor, plus
// the Stacki palette's search, navigation, insertion and source-backed undo.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { record, string } from '../src/shared/validation';

const browser = await chromium.launch({
  executablePath: process.env['CHROME_PATH'] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(20_000);
const url = process.env['STUDIO_URL'] ?? 'http://localhost:4350/studio';
const file = 'src/pages/index.astro';
const endpoint = new URL('/studio/api/file?file=' + encodeURIComponent(file), url).href;
const errors: string[] = [];
page.on('pageerror', (error) => errors.push(error.message));
let original: string | undefined;
const palette = page.locator('.insert-palette');
const search = palette.getByPlaceholder('Search components, elements…');
try {
  await page.goto(url);
  await saved();
  original = await readSource();
  await page.getByRole('button', { name: 'Expand all', exact: true }).click();
  await selectHeading();
  await page.locator('.rich-content').focus();
  await page.keyboard.press('Meta+f');
  await search.waitFor();
  assert.ok(await search.evaluate((element) => element === document.activeElement));
  await search.fill('no-such-element-xyz');
  await palette.getByText('No matches.', { exact: true }).waitFor();
  await search.fill('');
  await search.press('Tab');
  assert.equal(await palette.locator('.insert-tab.on').innerText(), 'Components');
  await search.press('Tab');
  assert.equal(await palette.locator('.insert-tab.on').innerText(), 'Elements');
  await search.press('Shift+Tab');
  assert.equal(await palette.locator('.insert-tab.on').innerText(), 'Components');
  await search.press('Escape');
  await palette.waitFor({ state: 'detached' });
  for (const shortcut of ['Meta+f', 'Meta+e', 'Control+f', 'Control+e']) {
    await page.frameLocator('iframe').locator('h1').click();
    await page.keyboard.press(shortcut);
    await search.waitFor();
    await search.press('Escape');
  }
  await selectHeading();
  await page.keyboard.press('Meta+e');
  await palette.getByRole('button', { name: 'Elements', exact: true }).click();
  await search.fill('h');
  await search.press('ArrowDown');
  assert.equal(await palette.locator('.insert-item.highlight .insert-item-label').innerText(), '<h2>');
  await search.press('ArrowUp');
  assert.equal(await palette.locator('.insert-item.highlight .insert-item-label').innerText(), '<h1>');
  await search.fill('mark');
  await search.press('Enter');
  await palette.waitFor({ state: 'detached' });
  await waitSourceIncludes('<mark>');
  await saved();
  await page.keyboard.press('Meta+z');
  await waitSource(original);
  await page
    .locator('.structure-node')
    .filter({ has: page.locator('.label', { hasText: /^ContentWrapper$/ }) })
    .click();
  await page.keyboard.press('Meta+f');
  await search.fill('Paragraph');
  await palette
    .locator('.insert-item')
    .filter({ has: page.locator('.insert-item-label', { hasText: /^Paragraph$/ }) })
    .click();
  await waitSourceIncludes(`<Paragraph>${PARAGRAPH_TEXT}</Paragraph>`);
  await saved();
  assert.match(await readSource(), /<Paragraph>[\s\S]*<\/Paragraph>\s*<\/ContentWrapper>/);
  await page.keyboard.press('Meta+z');
  await waitSource(original);
  await page.getByRole('button', { name: 'Code', exact: true }).click();
  await page.locator('.studio-code-panel .cm-content').click();
  await page.keyboard.press('Meta+f');
  await page.locator('.cm-search').waitFor();
  assert.equal(await palette.count(), 0, 'CodeMirror keeps its own find shortcut');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Navigator', exact: true }).click();
  await page.keyboard.press('Meta+e');
  await search.waitFor();
  await page.screenshot({ path: 'test-results/quick-insert.png' });
  await page.locator('.insert-overlay').click({ position: { x: 5, y: 5 } });
  await palette.waitFor({ state: 'detached' });
  assert.deepEqual(errors, []);
  console.log('Quick-insert shortcuts, search, tabs, arrow keys, dismissal, HTML/component insertion, placement, undo, and CodeMirror find passed.');
} finally {
  if (original !== undefined) {
    const base = await readSource();
    if (base !== original) {
      const response = await page.request.post(new URL('/studio/api/source', url).href, {
        headers: { Origin: new URL(url).origin },
        data: { file, source: original, base },
      });
      assert.ok(response.ok(), 'Restore test draft');
    }
  }
  await browser.close();
}
async function selectHeading() {
  await page
    .locator('.structure-node')
    .filter({ has: page.locator('.label', { hasText: /^Heading$/ }) })
    .click();
}
async function saved() {
  await page.locator('.save-state').filter({ hasText: 'Saved' }).waitFor();
}
async function readSource() {
  const response = await page.request.get(endpoint);
  assert.ok(response.ok());
  return string(record(await response.json())['source']);
}
async function waitSource(expected: string) {
  await page.waitForFunction(
    async ({ endpoint, expected }) => {
      const response = await fetch(endpoint);
      const data: unknown = await response.json();
      return typeof data === 'object' && data !== null && 'source' in data && data.source === expected;
    },
    { endpoint, expected },
  );
}
async function waitSourceIncludes(fragment: string) {
  await page.waitForFunction(
    async ({ endpoint, fragment }) => {
      const response = await fetch(endpoint);
      const data: unknown = await response.json();
      return typeof data === 'object' && data !== null && 'source' in data && typeof data.source === 'string' && data.source.includes(fragment);
    },
    { endpoint, fragment },
  );
}
