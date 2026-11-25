import { PARAGRAPH_TEXT } from '../src/features/source/instanceDefaults';
import { openSettingsGroup } from './settingsGroup';
import { chromium, type Page } from 'playwright';
import assert from 'node:assert/strict';
import { record, string } from '../src/shared/validation';

const browser = await chromium.launch({
  executablePath: process.env['CHROME_PATH'] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(20000);
const url = process.env['STUDIO_URL'] ?? 'http://localhost:4373/studio';
const endpoint = new URL('/studio/api/file?file=src%2Fpages%2Findex.astro', url).href;
const errors: string[] = [];
page.on('pageerror', (error) => errors.push(error.message));
try {
  await page.goto(url);
  await page.locator('.save-state').filter({ hasText: 'Saved' }).waitFor();
  const original = await readSource();
  await page.getByRole('button', { name: 'Expand all', exact: true }).click();
  await row(page, 'Heading').click();
  await checkSlots(original);
  await row(page, 'ContentWrapper').click();
  await page.getByRole('button', { name: 'Components', exact: true }).click();
  await page
    .locator('.palette-item')
    .filter({ has: page.locator('.label', { hasText: /^Paragraph/ }) })
    .dblclick();
  await page.getByRole('button', { name: 'Navigator', exact: true }).click();
  await row(page, 'Paragraph').and(page.locator('.selected')).waitFor();
  await sourceIncludes(`<Paragraph>${PARAGRAPH_TEXT}</Paragraph>`);
  const appended = await readSource();
  assert.match(appended, /<Paragraph>[\s\S]*<\/Paragraph>\s*<\/ContentWrapper>/);
  await page.keyboard.press('Meta+d');
  await row(page, 'Paragraph').nth(1).and(page.locator('.selected')).waitFor();
  await page.keyboard.press('Backspace');
  await row(page, 'Paragraph').and(page.locator('.selected')).waitFor();
  await sourceEquals(appended);
  await page.keyboard.press('Backspace');
  await row(page, 'Img').and(page.locator('.selected')).waitFor();
  for (let count = 0; count < 4; count++) {
    await page.locator('.save-state').filter({ hasText: 'Saved' }).waitFor();
    await page.keyboard.press('Meta+z');
    await page.locator('.save-state').filter({ hasText: 'Saved' }).waitFor();
  }
  await sourceEquals(original);
  assert.deepEqual(errors, []);
  console.log('Component-panel append, duplicate/delete selection, slot dropdown assignment and undo passed.');
} finally {
  await browser.close();
}

async function checkSlots(original: string) {
  await openSettingsGroup(page);
  const slot = page.locator('.props-field').filter({ has: page.locator('.prop-label', { hasText: /^slot$/ }) });
  await slot.locator('.dd-trigger').click();
  await page
    .locator('.dd-option')
    .filter({ hasText: /^column2$/ })
    .click();
  await sourceIncludes('<Heading slot="column2"');
  const changed = await readSource();
  assert.match(changed, /<Heading[^>]*slot="column2"/);
  await page.frameLocator('iframe').locator('.layout > div:last-child h1').waitFor();
  await page.keyboard.press('Meta+z');
  await sourceEquals(original);
}
function row(page: Page, name: string) {
  return page.locator('.structure-node').filter({ has: page.locator('.label', { hasText: new RegExp(`^${name}$`) }) });
}
async function readSource() {
  return string(record(await (await page.request.get(endpoint)).json())['source']);
}
async function sourceEquals(expected: string) {
  await page.waitForFunction(
    async ({ endpoint, expected }) => {
      const data: unknown = await (await fetch(endpoint)).json();
      return !!data && typeof data === 'object' && 'source' in data && data.source === expected;
    },
    { endpoint, expected },
  );
}
async function sourceIncludes(expected: string) {
  await page.waitForFunction(
    async ({ endpoint, expected }) => {
      const data: unknown = await (await fetch(endpoint)).json();
      return !!data && typeof data === 'object' && 'source' in data && typeof data.source === 'string' && data.source.includes(expected);
    },
    { endpoint, expected },
  );
}
