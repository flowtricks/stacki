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
const endpoint = new URL('/studio/api/file?file=src%2Fpages%2F404.astro', url).href;
const errors: string[] = [];
page.on('pageerror', (error) => errors.push(error.message));
try {
  await page.goto(url);
  await page.locator('.save-state').filter({ hasText: 'Saved' }).waitFor();
  await page.getByRole('button', { name: 'Expand all', exact: true }).click();
  await row(page, 'ContentWrapper').click();
  await page.keyboard.press('Meta+c');
  const original = string(record(await (await page.request.get(endpoint)).json())['source']);
  await page.getByRole('button', { name: 'Current page', exact: true }).click();
  await page.getByRole('option').filter({ hasText: '404' }).click();
  await page.locator('.save-state').filter({ hasText: 'Saved' }).waitFor();
  await page.frameLocator('iframe[title="Site preview"]').locator('h1').waitFor();
  await row(page, 'Layout').click();
  await page.keyboard.press('Meta+v');
  await page.waitForFunction(async (endpoint) => {
    const data: unknown = await (await fetch(endpoint)).json();
    return !!data && typeof data === 'object' && 'source' in data && typeof data.source === 'string' && data.source.includes('src={logo_icon}');
  }, endpoint);
  const changed = string(record(await (await page.request.get(endpoint)).json())['source']);
  for (const binding of ['Icon', 'Img', 'Eyebrow', 'logo_icon', 'lumos_background']) {
    assert.ok(changed.includes(`import ${binding} from`), `Carries ${binding}`);
  }
  assert.equal(changed.match(/import Heading from/g)?.length, 1);
  await page.frameLocator('iframe[title="Site preview"]').locator('h1').nth(1).waitFor();
  await page.keyboard.press('Meta+z');
  await sourceEquals(page, original);
  await page.keyboard.press('Meta+Shift+z');
  await sourceEquals(page, changed);
  await page.keyboard.press('Meta+z');
  await sourceEquals(page, original);
  await insertExistingSection(page, original);
  assert.deepEqual(errors, []);
  console.log('Cross-page paste carries real component and asset bindings, renders, and undoes/redoes atomically.');
} finally {
  await browser.close();
}

function row(page: Page, name: string) {
  return page.locator('.structure-node').filter({ has: page.locator('.label', { hasText: new RegExp(`^${name}$`) }) });
}
async function sourceEquals(page: Page, expected: string) {
  await page.waitForFunction(
    async ({ endpoint, expected }) => {
      const data: unknown = await (await fetch(endpoint)).json();
      return !!data && typeof data === 'object' && 'source' in data && data.source === expected;
    },
    { endpoint, expected },
  );
}

async function insertExistingSection(page: Page, original: string) {
  await row(page, 'Layout').click();
  await page.keyboard.press('Meta+f');
  const palette = page.locator('.insert-palette');
  await palette.getByPlaceholder('Search components, elements…').fill('Section');
  await palette
    .locator('.insert-item')
    .filter({ has: page.locator('.insert-item-label', { hasText: /^Section$/ }) })
    .click();
  await page.waitForFunction(async (endpoint) => {
    const data: unknown = await (await fetch(endpoint)).json();
    return !!data && typeof data === 'object' && 'source' in data && typeof data.source === 'string' && data.source.includes('<Section />');
  }, endpoint);
  const changed = string(record(await (await page.request.get(endpoint)).json())['source']);
  assert.equal(changed.match(/import Section from/g)?.length, 1);
  assert.ok(!changed.includes('SectionInserted'));
  const sections = page.frameLocator('iframe[title="Site preview"]').locator('main > .section');
  assert.ok(!changed.includes('New content'));
  await page.keyboard.press('Meta+f');
  await palette.getByPlaceholder('Search components, elements…').fill('Heading');
  await palette
    .locator('.insert-item')
    .filter({ has: page.locator('.insert-item-label', { hasText: /^Heading$/ }) })
    .click();
  await sections.filter({ hasText: /^Text$/ }).waitFor();
  const rectangles = await sections.evaluateAll((nodes) =>
    nodes.map((node) => {
      const rect = node.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom };
    }),
  );
  assert.equal(rectangles.length, 2);
  assert.ok(rectangles[0] && rectangles[1] && rectangles[0].bottom <= rectangles[1].top + 1, 'Inserted sections keep separate layout boxes');
  await page.keyboard.press('Meta+z');
  await sourceEquals(page, changed);
  await page.keyboard.press('Meta+z');
  await sourceEquals(page, original);
}
