// Only use an isolated draft: exercise real schema fields, saves while switching
// entries, and independent browser refreshes against Astro's content config.
import { chromium, type Page } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
const root = process.env['STUDIO_TEST_WORKSPACE'];
assert.ok(root, 'Set STUDIO_TEST_WORKSPACE to an isolated running draft');
const url = process.env['STUDIO_URL'] ?? 'http://localhost:4365/studio';
const config = path.join(root, 'src/content.config.ts');
const contentDirectory = `src/content/cms-browser-${Date.now()}`;
const directory = path.join(root, contentDirectory);
const source = (title: string) => `---\ntitle: ${title}\n---\nBody unchanged.\n`;
await writeFile(
  config,
  "import { defineCollection, z } from 'astro:content'; import { glob } from 'astro/loaders'; export const collections = { cmsBrowser: defineCollection({ loader: glob({ pattern: '**/*.md', base: './CONTENT_DIRECTORY' }), schema: z.object({ title: z.string() }) }) };".replace(
    'CONTENT_DIRECTORY',
    contentDirectory,
  ),
  { flag: 'wx' },
);
await mkdir(directory, { recursive: true });
await writeFile(path.join(directory, 'first.md'), source('First'), { flag: 'wx' });
await writeFile(path.join(directory, 'second.md'), source('Second'), { flag: 'wx' });
const browser = await chromium.launch({
  executablePath: process.env['CHROME_PATH'] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
const first = await (await browser.newContext()).newPage();
const second = await (await browser.newContext()).newPage();
const errors: string[] = [];
for (const page of [first, second]) {
  page.on('pageerror', (error) => errors.push(error.message));
}
try {
  await Promise.all([open(first), open(second)]);
  await title(first).fill('Saved before switching');
  await first
    .locator('.cms-item')
    .filter({ hasText: /^Second$/ })
    .click();
  await second.waitForFunction(() =>
    [...document.querySelectorAll<HTMLInputElement>('.cms-field input')].some((input) => input.value === 'Saved before switching'),
  );
  assert.equal(await readFile(path.join(directory, 'first.md'), 'utf8'), source('Saved before switching'));
  assert.equal(await readFile(path.join(directory, 'second.md'), 'utf8'), source('Second'));
  const saved = second.waitForResponse(
    (response) => response.url().endsWith('/studio/api/cms') && response.request().postData()?.includes('content:writeEntry') === true,
  );
  await title(second).fill('Saved before closing');
  await second.getByRole('button', { name: 'Collections', exact: true }).click();
  assert.ok((await saved).ok());
  await first
    .locator('.cms-item')
    .filter({ hasText: /^Saved before closing$/ })
    .waitFor();
  assert.equal(await readFile(path.join(directory, 'first.md'), 'utf8'), source('Saved before closing'));
  assert.deepEqual(errors, []);
  console.log('Schema-backed content edits survive entry switches and reach independent browsers.');
} finally {
  await browser.close();
  await rm(config);
  await rm(directory, { recursive: true });
}
async function open(page: Page) {
  page.setDefaultTimeout(15000);
  await page.goto(url);
  await page.getByRole('button', { name: 'Collections', exact: true }).click();
  await page
    .locator('.cms-collection')
    .filter({ hasText: /^Content collections/ })
    .click();
  await page
    .locator('.cms-collection')
    .filter({ hasText: /^Cms browser/ })
    .click();
  await title(page).waitFor();
}
function title(page: Page) {
  return page
    .locator('.cms-field')
    .filter({ has: page.locator('label', { hasText: /^Title/ }) })
    .locator('input')
    .first();
}
