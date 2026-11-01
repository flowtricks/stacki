// Goal: collaborators resolve element ownership inside Settings without disruptive toasts.
// Method: two real browser sessions select, take over, insert children, and release ownership.
import { chromium, type Page } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { record, string } from '../src/shared/validation';

const browser = await chromium.launch({
  executablePath: process.env['CHROME_PATH'] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
const firstContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const secondContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const first = await firstContext.newPage();
const second = await secondContext.newPage();
const url = process.env['STUDIO_URL'] ?? 'http://localhost:4360/studio';
const endpoint = new URL('/studio/api/file?file=src%2Fpages%2Findex.astro', url).href;
const errors: string[] = [];
for (const page of [first, second]) {
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => errors.push(error.message));
}
try {
  await Promise.all([first.goto(url), second.goto(url)]);
  for (const page of [first, second]) {
    await page.locator('.save-state').filter({ hasText: 'Saved' }).waitFor();
    await page.frameLocator('iframe[title="Site preview"]').locator('h1').waitFor();
    await page.getByRole('button', { name: 'Expand all', exact: true }).click();
  }
  await row(first, 'Heading').click();
  await selected(first, 'Heading');
  await row(second, 'Eyebrow').click();
  await selected(second, 'Eyebrow');
  const heading = second.frameLocator('iframe[title="Site preview"]').locator('h1');
  await heading.hover();
  assert.equal(await heading.evaluate((node) => getComputedStyle(node).cursor), 'default');
  await heading.click();
  await selected(second, 'Heading');
  await locked(second);
  assert.equal(await second.locator('.toast').count(), 0, 'Selection does not show a blocking toast');
  assert.equal(await second.locator('.rich-content').count(), 0, 'Locked settings cannot be edited');
  await first.locator('.rich-content').waitFor();
  await row(second, 'Heading').click();
  await selected(second, 'Heading');
  await locked(second);
  await mkdir('test-results', { recursive: true });
  await second.screenshot({ path: 'test-results/selection-takeover.png' });
  await second.locator('.studio-right').getByRole('button', { name: 'Take over', exact: true }).click();
  await selected(second, 'Heading');
  await selected(first, 'Heading');
  await locked(first);
  await second.locator('.rich-content').waitFor();
  await sharedContainerInsertion(first, second);
  await row(first, 'Img').click();
  await selected(first, 'Img');
  await second.locator('.studio-right').getByRole('button', { name: 'Take over', exact: true }).waitFor({ state: 'detached' });
  await row(first, 'ContentWrapper').click();
  await selected(first, 'ContentWrapper');
  await locked(first);
  await secondContext.close();
  await first.waitForFunction(() => document.querySelectorAll('.collaborator-outline').length === 0);
  await first.locator('.studio-right').getByRole('button', { name: 'Take over', exact: true }).waitFor({ state: 'detached' });
  await selected(first, 'ContentWrapper');
  assert.deepEqual(errors, []);
  console.log('Shared canvas/navigator selection, Settings takeover, child insertion without takeover, owner release and disconnect passed.');
} finally {
  await browser.close();
}

function row(page: Page, name: string) {
  return page.locator('.structure-node').filter({
    has: page.locator('.label').filter({ hasText: new RegExp(`^${name}$`) }),
  });
}

async function selected(page: Page, name: string) {
  await row(page, name).and(page.locator('.selected')).waitFor();
}

async function locked(page: Page) {
  await page.locator('.studio-right').getByRole('heading', { name: 'This element is being edited', exact: true }).waitFor();
  await page.locator('.studio-right').getByRole('button', { name: 'Take over', exact: true }).waitFor();
}

async function sharedContainerInsertion(owner: Page, inspector: Page) {
  await row(owner, 'ContentWrapper').click();
  await selected(owner, 'ContentWrapper');
  await row(inspector, 'ContentWrapper').click();
  await selected(inspector, 'ContentWrapper');
  await locked(inspector);
  const original = string(record(await (await inspector.request.get(endpoint)).json())['source']);
  await inspector.keyboard.press('Meta+f');
  const palette = inspector.locator('.insert-palette');
  await palette.getByPlaceholder('Search components, elements…').fill('Paragraph');
  await palette
    .locator('.insert-item')
    .filter({ has: inspector.locator('.insert-item-label', { hasText: /^Paragraph$/ }) })
    .click();
  await selected(inspector, 'Paragraph');
  await inspector.locator('.save-state').filter({ hasText: 'Saved' }).waitFor();
  const changed = string(record(await (await inspector.request.get(endpoint)).json())['source']);
  assert.match(changed, /<Paragraph>[\s\S]*<\/Paragraph>\s*<\/ContentWrapper>/);
  await selected(owner, 'ContentWrapper');
  await inspector.keyboard.press('Meta+z');
  await inspector.waitForFunction(
    async ({ endpoint, original }) => {
      const data: unknown = await (await fetch(endpoint)).json();
      return !!data && typeof data === 'object' && 'source' in data && data.source === original;
    },
    { endpoint, original },
  );
  await row(inspector, 'ContentWrapper').click();
  await selected(inspector, 'ContentWrapper');
  await locked(inspector);
}
