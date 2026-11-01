// Real browser coverage of the upstream panel, shared saves, schema controls,
// item operations, and phone layout against an isolated running draft.
import { chromium, type Page } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { record } from '../src/shared/validation';
const browser = await chromium.launch({
  executablePath: process.env['CHROME_PATH'] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
const url = process.env['STUDIO_URL'] ?? 'http://localhost:4365/studio';
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const first = await context.newPage();
const second = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
const rel = `data/cms-browser-${Date.now()}.json`;
const payload = { projectPath: 'studio', rel };
const errors: string[] = [];
for (const page of [first, second]) {
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => errors.push(error.message));
}
try {
  await first.goto(url);
  await api(first, 'cms:create', { projectPath: 'studio', name: rel.slice(5, -5) });
  const read = await api(first, 'cms:read', payload);
  await api(
    first,
    'cms:write',
    {
      ...payload,
      data: [
        { title: 'First item', enabled: true, count: 2, details: { subtitle: 'Nested value' } },
        ...Array.from({ length: 7 }, (_, index) => ({
          title: `Other item ${index}`,
          enabled: false,
          count: 4,
        })),
      ],
    },
    read['versions'],
  );
  await Promise.all([openCollection(first), second.goto(url).then(() => openCollection(second))]);
  const input = field(first, 'Title').locator('input');
  await input.fill('Shared item');
  await field(second, 'Title').locator('input').filter({ visible: true }).waitFor();
  await second.waitForFunction(() => [...document.querySelectorAll<HTMLInputElement>('.cms-field input')].some((input) => input.value === 'Shared item'));
  const saved = record((await api(first, 'cms:read', payload))['value'])['data'];
  assert.ok(Array.isArray(saved));
  assert.equal(record(saved[0])['title'], 'Shared item');
  await first.getByTitle('New item', { exact: true }).click();
  await first.locator('.cms-item').filter({ hasText: 'Item 9' }).waitFor();
  await first.getByTitle('Duplicate item', { exact: true }).click();
  await first.getByPlaceholder('Search items').fill('Shared');
  assert.equal(await first.locator('.cms-item').count(), 1);
  await first.getByPlaceholder('Search items').fill('');
  await first.locator('.cms-collection.on').getByTitle('Collection settings').click();
  await first.getByRole('button', { name: 'Add field', exact: true }).first().click();
  await first
    .getByRole('button')
    .filter({ has: first.locator('.cms-type-name', { hasText: /^Text$/ }) })
    .click();
  await first.getByPlaceholder('e.g. Subtitle').fill('Summary');
  await first.getByRole('button', { name: 'Add field', exact: true }).last().click();
  await first.locator('.cms-schema-name').filter({ visible: true }).first().waitFor();
  await first.waitForFunction(() => [...document.querySelectorAll<HTMLInputElement>('.cms-schema-name')].some((input) => input.value === 'Summary'));
  await mkdir('test-results', { recursive: true });
  await first.screenshot({ path: 'test-results/cms-desktop.png' });
  const phone = await (
    await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    })
  ).newPage();
  await phone.goto(url);
  await openCollection(phone);
  assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  const phoneField = await field(phone, 'Title').locator('input').boundingBox();
  assert.ok(phoneField && phoneField.width > 200, 'Phone fields must have usable width');
  await phone.screenshot({ path: 'test-results/cms-mobile.png' });
  assert.deepEqual(errors, []);
  console.log('CMS navigation, shared edits, items, schema dialog, search and mobile layout passed.');
} finally {
  try {
    const usage = await api(first, 'cms:usage', payload);
    await api(first, 'cms:delete', payload, usage['versions']);
  } finally {
    await browser.close();
  }
}
async function api(page: Page, operation: string, payload: unknown, versions: unknown = {}) {
  const response = await page.request.post(new URL('/studio/api/cms', url).href, {
    data: { operation, payload, versions },
  });
  const result = record(await response.json());
  assert.ok(response.ok(), JSON.stringify(result));
  return result;
}
async function openCollection(page: Page) {
  await page.getByRole('button', { name: 'Collections', exact: true }).click();
  await page.locator('.cms-collection[title="src/data"]').click();
  await page.locator(`.cms-collection[title="src/${rel}"]`).click();
  await field(page, 'Title').locator('input').waitFor();
}
function field(page: Page, label: string) {
  return page
    .locator('.cms-field')
    .filter({ has: page.locator('.cms-field-head label', { hasText: new RegExp(`^${label}$`) }) })
    .first();
}
