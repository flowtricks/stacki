// Goal: the real shared CMS edits HTML and ISO dates without altering untouched data.
// Method: create one disposable collection, use keyboard and toolbar controls, verify
// persisted values after reload, and inspect desktop/mobile rendering in Chromium.
import { chromium, type Page } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { record } from '../src/shared/validation';

const url = process.env['STUDIO_URL'] ?? 'http://127.0.0.1:4376/studio';
assert.equal(new URL(url).hostname, '127.0.0.1', 'Run only against an isolated local draft');
const rel = `data/content-inputs-${Date.now()}.json`;
const payload = { projectPath: 'studio', rel };
const html = '<p>Are you in a <strong>Connect Group</strong>?</p><p>Get connected!</p>';
const initial = {
  title: 'Community event',
  description: html,
  startDate: '2026-10-25T00:00:00.000Z',
  removeDate: '2026-11-01T17:15:12.345-06:00',
  day: '2026-10-25',
  details: { description: '<p>Nested content</p>' },
  notes: ['<p>List content</p>'],
  restricted: '<p>Keep original</p><script>window.__unsafeHTML = true</script>',
};
const browser = await chromium.launch({
  executablePath:
    process.env['CHROME_PATH'] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 1100 },
  timezoneId: 'America/Chicago',
});
const page = await context.newPage();
page.setDefaultTimeout(20000);
const errors: string[] = [];
page.on('pageerror', (error) => errors.push(error.message));
try {
  await page.goto(url);
  await api('cms:create', { projectPath: 'studio', name: rel.slice(5, -5) });
  const read = await api('cms:read', payload);
  await api('cms:write', { ...payload, data: [initial] }, read['versions']);
  await openCollection(page);
  const description = field(page, 'Description').first();
  const editor = description.getByRole('textbox', { name: 'Description', exact: true });
  assert.equal(await editor.innerText(), 'Are you in a Connect Group?\n\nGet connected!');
  assert.equal(await editor.locator('strong').innerText(), 'Connect Group');
  assert.equal(
    await field(page, 'Start date').locator('input[type="date"]').inputValue(),
    '2026-10-25',
    'UTC midnight must not shift to yesterday in Chicago',
  );
  assert.deepEqual(await stored(), initial, 'Merely opening fields must not rewrite their data');
  assert.equal(await page.locator('.html-content script').count(), 0);
  assert.equal(
    await page.evaluate(() => {
      const value: unknown = Reflect.get(window, '__unsafeHTML');
      return value;
    }),
    undefined,
  );
  await editor.fill('Updated description');
  await editor.press('ControlOrMeta+a');
  await description.getByRole('button', { name: 'Bold', exact: true }).click();
  assert.match(await editor.innerHTML(), /<(b|strong)>Updated description<\/(b|strong)>/);
  await checkExternalUpdates(await waitForDescriptionSave());
  await description.getByRole('button', { name: 'HTML', exact: true }).click();
  assert.match(
    await description.getByRole('textbox', { name: 'Description HTML' }).inputValue(),
    /Updated description/,
  );
  const sourceInput = description.getByRole('textbox', { name: 'Description HTML' });
  const sourceValue = await sourceInput.inputValue();
  await sourceInput.fill('');
  assert.equal(await sourceInput.isVisible(), true, 'Partial HTML edits keep the source control');
  await sourceInput.fill(sourceValue);
  await description.getByRole('button', { name: 'Visual', exact: true }).click();
  assert.equal(await editor.innerText(), 'Updated description');
  await field(page, 'Start date').locator('input[type="date"]').fill('2026-10-28');
  await field(page, 'Remove date').locator('input[type="date"]').fill('2026-11-05');
  await field(page, 'Day').locator('input[type="date"]').fill('2028-02-29');
  const saved = await waitForSave();
  assert.equal(saved['removeDate'], '2026-11-05T17:15:12.345-06:00');
  assert.equal(saved['day'], '2028-02-29');
  assert.equal(saved['restricted'], initial.restricted);
  assert.deepEqual(saved['details'], initial.details);
  assert.deepEqual(saved['notes'], initial.notes);
  await page.reload();
  await openCollection(page);
  assert.equal(
    await field(page, 'Description').first().locator('.html-content').innerText(),
    'Updated description',
  );
  assert.equal(
    await field(page, 'Start date').locator('input[type="date"]').inputValue(),
    '2026-10-28',
  );
  await field(page, 'Start date').getByRole('button', { name: 'Choose start date' }).click();
  await page.keyboard.press('Escape');
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/content-inputs-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => document.documentElement.scrollWidth <= innerWidth);
  await page.screenshot({ path: 'test-results/content-inputs-mobile.png' });
  assert.deepEqual(errors, []);
  console.log('Rich text, date picker, timestamp preservation, reload and mobile checks passed.');
} finally {
  try {
    const usage = await api('cms:usage', payload);
    await api('cms:delete', payload, usage['versions']);
  } finally {
    await browser.close();
  }
}

async function api(operation: string, body: unknown, versions: unknown = {}) {
  const response = await page.request.post(new URL('/studio/api/cms', url).href, {
    data: { operation, payload: body, versions },
  });
  const result = record(await response.json());
  assert.ok(response.ok(), JSON.stringify(result));
  return result;
}
async function stored() {
  const data = record((await api('cms:read', payload))['value'])['data'];
  assert.ok(Array.isArray(data));
  return record(data[0]);
}
async function waitForSave() {
  for (let attempt = 0; attempt < 50; attempt++) {
    const data = await stored();
    if (data['startDate'] === '2026-10-28T00:00:00.000Z' && data['day'] === '2028-02-29') {
      return data;
    }
    await page.waitForTimeout(200);
  }
  assert.fail('Rich text and date changes must reach the stored collection within 10 seconds');
}
async function openCollection(target: Page) {
  await target.getByRole('button', { name: 'Collections', exact: true }).click();
  await target.locator('.cms-collection[title="src/data"]').click();
  await target.locator(`.cms-collection[title="src/${rel}"]`).click();
  await field(target, 'Title').locator('input').waitFor();
}
function field(target: Page, label: string) {
  return target.locator('.cms-field').filter({
    has: target.locator('.cms-field-head label', { hasText: new RegExp(`^${label}$`) }),
  });
}

async function checkExternalUpdates(saved: Readonly<Record<string, unknown>>) {
  const editor = field(page, 'Description').first().locator('.html-content');
  await editor.focus();
  for (const description of ['<p>External description</p>', saved['description']]) {
    const read = await api('cms:read', payload);
    await api('cms:write', { ...payload, data: [{ ...saved, description }] }, read['versions']);
    await page.waitForFunction((expected) => {
      const content = document.querySelector('.html-content');
      return content?.innerHTML === expected;
    }, description);
  }
}

async function waitForDescriptionSave() {
  for (let attempt = 0; attempt < 50; attempt++) {
    const data = await stored();
    const description = data['description'];
    if (typeof description === 'string' && /<(b|strong)>Updated description/.test(description)) {
      return data;
    }
    await page.waitForTimeout(200);
  }
  assert.fail('Formatted HTML must reach the stored collection within 10 seconds');
}
