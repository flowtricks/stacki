import { chromium, type Page } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { parseComponentUsage } from '../vendor/stacki/src/features/palette/paletteModel';

const browser = await chromium.launch({
  executablePath: process.env['CHROME_PATH'] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
const auth = process.env['STUDIO_STORAGE_STATE'];
const page = await browser.newPage({
  viewport: { width: 1440, height: 1000 },
  ...(auth ? { storageState: auth } : {}),
});
page.setDefaultTimeout(20000);
const errors: string[] = [];
page.on('pageerror', (error) => errors.push(error.message));
try {
  await page.goto(process.env['STUDIO_URL'] ?? 'http://localhost:4350/studio');
  await page.locator('.save-state').filter({ hasText: 'Saved' }).waitFor();
  await page.getByRole('button', { name: 'Components', exact: true }).click();
  const choice = await usage(page, 'src/components/form/Choice.astro');
  const total = choice.reduce((sum, file) => sum + file.count, 0);
  const row = page.locator('.palette-item').filter({ hasText: /^Choice\d+ instances?$/ });
  await row.getByRole('button', { name: `${total} instance${total === 1 ? '' : 's'}`, exact: true }).click();
  await page.locator('.instances-head').getByText('Choice instances').waitFor();
  for (const file of choice) {
    const entry = page.getByTitle(file.rel, { exact: true });
    await entry.waitFor();
    assert.equal(await entry.locator('.instances-count').innerText(), String(file.count));
  }
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/component-instances.png' });
  const example = choice.find((file) => file.rel === 'src/pages/example-components.astro');
  assert.ok(example);
  await page.getByTitle(example.rel, { exact: true }).click();
  await page.locator('.save-state').filter({ hasText: 'Saved' }).waitFor();
  await page.getByRole('button', { name: 'Expand all', exact: true }).click();
  await page.getByRole('button', { name: 'Components', exact: true }).click();
  await page.getByPlaceholder('Search components').fill('Choice');
  await row.locator('.palette-instances').click();
  await page.getByText('On this page', { exact: true }).waitFor();
  await page.locator('.instances-group').filter({ hasText: 'On this page' }).getByRole('button').first().click();
  await page.locator('.structure-node.selected').filter({ hasText: 'Choice' }).waitFor();
  await liveCounts(page);
  assert.deepEqual(errors, []);
  console.log('Stacki instance counts, usage files, navigation, and current-page selection passed.');
} catch (error) {
  await page.screenshot({ path: 'test-results/component-instances-failure.png' });
  throw error;
} finally {
  await browser.close();
}

async function liveCounts(observer: Page) {
  const editor = await browser.newPage({ ...(auth ? { storageState: auth } : {}) });
  editor.setDefaultTimeout(20000);
  let duplicated = false;
  try {
    await editor.goto(new URL('/studio', observer.url()).href);
    await editor.locator('.save-state').filter({ hasText: 'Saved' }).waitFor();
    await editor.getByRole('button', { name: 'Expand all', exact: true }).click();
    await editor
      .locator('.structure-node')
      .filter({ has: editor.locator('.label', { hasText: /^Heading$/ }) })
      .click();
    const initial = (await usage(observer, 'src/components/typography/Heading.astro')).reduce((sum, file) => sum + file.count, 0);
    await observer.getByRole('button', { name: 'Components', exact: true }).click();
    await observer.getByPlaceholder('Search components').fill('Heading');
    await observer.getByRole('button', { name: `${initial} instances`, exact: true }).waitFor();
    await editor.keyboard.press('Meta+d');
    duplicated = true;
    await observer.getByRole('button', { name: `${initial + 1} instances`, exact: true }).waitFor();
    await editor.keyboard.press('Meta+z');
    duplicated = false;
    await observer.getByRole('button', { name: `${initial} instances`, exact: true }).waitFor();
    await editor.locator('.save-state').filter({ hasText: 'Saved' }).waitFor();
  } finally {
    if (duplicated) {
      await editor.keyboard.press('Meta+z');
      await editor.locator('.save-state').filter({ hasText: 'Saved' }).waitFor();
    }
    await editor.close();
  }
}

async function usage(page: Page, file: string) {
  const response = await page.request.get(new URL('/studio/api/component-usage?file=' + encodeURIComponent(file), page.url()).href);
  assert.ok(response.ok());
  const result = parseComponentUsage(await response.json());
  assert.equal(result.kind, 'ready');
  if (result.kind !== 'ready') {
    throw new Error('Could not load usage');
  }
  return result.files;
}
