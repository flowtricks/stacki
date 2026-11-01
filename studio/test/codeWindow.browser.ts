import { chromium, type Page } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { record, string } from '../src/shared/validation';

const browser = await chromium.launch({
  executablePath: process.env['CHROME_PATH'] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors: string[] = [];
page.on('pageerror', (error) => errors.push(error.message));
page.setDefaultTimeout(20000);
const url = process.env['STUDIO_URL'] ?? 'http://localhost:4352/studio';
const file = 'src/pages/index.astro';
let original: string | undefined;
try {
  await page.goto(url);
  await saved(page);
  original = await readSource(page);
  const fixture = original + '\n<script is:inline>\n// Popup script\n</script>\n<style>\n.studio-popup-probe { color: red; }\n</style>\n';
  await replaceSource(page, fixture);
  await page.reload();
  await saved(page);
  const frontmatter = page.locator('.frontmatter-node');
  await frontmatter.click();
  await page.keyboard.press('Enter');
  const popup = page.getByRole('dialog');
  await page.getByRole('dialog', { name: 'Frontmatter', exact: true }).waitFor();
  assert.ok((await popup.locator('.cm-content').innerText()).includes('import Layout'));
  assert.ok(!(await popup.locator('.cm-content').innerText()).includes('<Layout'));
  await page.keyboard.press('Meta+Home');
  await page.keyboard.insertText('// Popup frontmatter\n');
  await saved(page);
  assert.equal(await readSource(page), fixture.replace(/^---\r?\n/, '---\n// Popup frontmatter\n'));
  await closePopup(page);
  await frontmatter.dblclick();
  await popup.waitFor();
  await closePopup(page);
  await page.getByRole('button', { name: 'Edit code', exact: true }).click();
  await popup.waitFor();
  await closePopup(page);
  for (const name of ['script', 'style']) {
    const row = page.locator('.structure-node').filter({ has: page.locator('.label', { hasText: new RegExp('^' + name + '$') }) });
    await row.click();
    await page.keyboard.press('Enter');
    await page.getByRole('dialog', { name: '<' + name + '>', exact: true }).waitFor();
    const before = await readSource(page);
    await page.keyboard.press('Meta+End');
    await page.keyboard.insertText(name === 'script' ? '// Saved script\n' : '/* Saved style */\n');
    await saved(page);
    const marker = name === 'script' ? '// Saved script\n' : '/* Saved style */\n';
    assert.equal(await readSource(page), before.replace('</' + name + '>', marker + '</' + name + '>'));
    await closePopup(page);
  }
  await frontmatter.click();
  await page.getByRole('button', { name: 'Code', exact: true }).click();
  await page.locator('.code-panel .cm-content').click();
  await page.keyboard.press('Enter');
  assert.equal(await popup.count(), 0, 'Enter inside the code panel must edit code, not open a popup');
  await page.getByRole('button', { name: 'Navigator', exact: true }).click();
  await frontmatter.click();
  await page.keyboard.press('Shift+Enter');
  assert.equal(await popup.count(), 0, 'Modified Enter does not open a popup');
  await page.keyboard.press('Enter');
  await popup.waitFor();
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/code-popup.png' });
  assert.deepEqual(errors, []);
  console.log('Frontmatter/script/style Enter, double-click, Edit code, live source edits and typing guards passed.');
} finally {
  if (original !== undefined) {
    await replaceSource(page, original);
  }
  await browser.close();
}
async function saved(page: Page) {
  await page.locator('.save-state').filter({ hasText: 'Saved' }).waitFor();
}
async function readSource(page: Page) {
  const result = await page.request.get(new URL('/studio/api/file?file=' + file, url).href);
  return string(record(await result.json())['source']);
}
async function replaceSource(page: Page, source: string) {
  const result = await page.request.post(new URL('/studio/api/source', url).href, {
    headers: { Origin: new URL(url).origin },
    data: { file, source, base: await readSource(page) },
  });
  assert.ok(result.ok(), await result.text());
}
async function closePopup(page: Page) {
  await page.getByTitle('Close (edits are saved live)', { exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
}
