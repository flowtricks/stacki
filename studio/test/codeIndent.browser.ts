import { chromium, type Page } from 'playwright';
import assert from 'node:assert/strict';
import { record, string } from '../src/shared/validation';

const browser = await chromium.launch({
  executablePath: process.env['CHROME_PATH'] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
const page = await browser.newPage();
page.setDefaultTimeout(20000);
const url = process.env['STUDIO_URL'] ?? 'http://localhost:4351/studio';
const file = 'src/pages/index.astro';
const endpoint = new URL('/studio/api/file?file=' + encodeURIComponent(file), url).href;
let original: string | undefined;
try {
  await page.goto(url);
  await page.locator('.save-state').filter({ hasText: 'Saved' }).waitFor();
  original = await readSource();
  const lines = original.split('\n');
  assert.ok(lines[1]?.startsWith('import ') && lines[2]?.startsWith('import '));
  await page.getByRole('button', { name: 'Code', exact: true }).click();
  const editor = page.locator('.studio-code-panel .cm-content');
  await editor.click();
  await editor.press('Control+Home');
  await editor.press('ArrowDown');
  await editor.press('Home');
  await editor.press('Tab');
  await waitSource(page, ['' + lines[0], '  ' + lines[1], ...lines.slice(2)].join('\n'));
  assert.ok(await editor.evaluate((element) => element === document.activeElement));
  await editor.press('Shift+Tab');
  await waitSource(page, original);

  await editor.press('Home');
  await editor.press('Shift+ArrowDown');
  await editor.press('Shift+ArrowDown');
  const indented = lines.map((line, index) => (index === 1 || index === 2 ? '  ' + line : line));
  await editor.press('Tab');
  await waitSource(page, indented.join('\n'));
  await editor.press('Meta+z');
  await waitSource(page, original);
  await editor.press('Meta+Shift+z');
  await waitSource(page, indented.join('\n'));
  await editor.press('Shift+Tab');
  await waitSource(page, original);
  await editor.press('ArrowRight');
  await editor.press('Escape');
  await editor.press('Tab');
  assert.equal(await editor.evaluate((element) => element === document.activeElement), false);
  assert.equal(await readSource(), original, 'Leaving the editor must not alter the source');
  console.log('Code Tab/Shift+Tab, multiline indent, undo/redo, saved source and focus escape passed.');
} finally {
  if (original !== undefined) {
    const base = await readSource();
    if (base !== original) {
      const result = await page.request.post(new URL('/studio/api/source', url).href, {
        headers: { Origin: new URL(url).origin },
        data: { file, source: original, base },
      });
      assert.ok(result.ok(), 'Restore the test draft source');
    }
  }
  await browser.close();
}

async function readSource() {
  const response = await page.request.get(endpoint);
  assert.ok(response.ok());
  return string(record(await response.json())['source']);
}
async function waitSource(target: Page, expected: string) {
  await target.waitForFunction(
    async ({ endpoint, expected }) => {
      const response = await fetch(endpoint);
      const data: unknown = await response.json();
      return typeof data === 'object' && data !== null && 'source' in data && data.source === expected;
    },
    { endpoint, expected },
  );
}
