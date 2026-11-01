// Exercise a settings-only TypeScript module outside src/data in an isolated draft.
import { chromium, type Page } from 'playwright';
import assert from 'node:assert/strict';
import { writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';

const root = process.env['STUDIO_TEST_WORKSPACE'];
assert.ok(root, 'Set STUDIO_TEST_WORKSPACE to an isolated running draft');
const url = process.env['STUDIO_URL'] ?? 'http://localhost:4365/studio';
const rel = `cms-settings-${Date.now()}.ts`;
const file = path.join(root, 'src', rel);
const source = '// Keep this comment.\nexport const title: string = "Module title";\nexport const routes: string[] = ["/404"];\n';
await writeFile(file, source, { flag: 'wx' });
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
  const saved = first.waitForResponse(
    (response) => response.url().endsWith('/studio/api/cms') && response.request().postData()?.includes('cms:write') === true,
  );
  await title(first).fill('Updated module title');
  assert.ok((await saved).ok());
  await second.waitForFunction(() =>
    [...document.querySelectorAll<HTMLInputElement>('.cms-field input')].some((input) => input.value === 'Updated module title'),
  );
  assert.equal(await readFile(file, 'utf8'), source.replace('Module title', 'Updated module title'));
  assert.deepEqual(errors, []);
  console.log('TypeScript settings appear, save without changing surrounding source, and sync.');
} finally {
  await browser.close();
  await rm(file);
}
async function open(page: Page) {
  page.setDefaultTimeout(15000);
  await page.goto(url);
  await page.getByRole('button', { name: 'Collections', exact: true }).click();
  await page.locator(`.cms-collection[title="src/${rel}"]`).click();
  await page.locator(`.cms-collection[title="src/${rel}#*general"]`).click();
  await title(page).waitFor();
}
function title(page: Page) {
  return page
    .locator('.cms-field')
    .filter({ has: page.locator('label', { hasText: /^Title$/ }) })
    .locator('input')
    .first();
}
