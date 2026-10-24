// Goal: verify Client restrictions and transitions to the Developer role.
// Method: use a live draft to check editing, history, persistence and menu controls.
import { chromium, type Page } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { record, string } from '../src/shared/validation';

const browser = await chromium.launch({
  executablePath:
    process.env['CHROME_PATH'] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(20000);
const url = process.env['STUDIO_URL'] ?? 'http://localhost:4350/studio';
const errors: string[] = [];
page.on('pageerror', (error) => errors.push(error.message));
let original: string | undefined;
try {
  await page.goto(url);
  await saved();
  original = await readSource();
  await switchRole('Client');
  await assertClientChrome(page);
  const layout = row('Layout');
  assert.equal(await layout.getAttribute('draggable'), 'false');
  assert.equal(await page.locator('.nav-gap[data-drop-parent=""]').count(), 0);
  await layout.click({ button: 'right' });
  assert.equal(await page.getByRole('menuitem', { name: /Delete/ }).isDisabled(), true);
  assert.equal(await page.getByRole('menuitem', { name: /Duplicate/ }).isDisabled(), true);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Expand all', exact: true }).click();
  await row('Heading').dblclick();
  await page
    .locator('.structure-node.selected .label')
    .filter({ hasText: /^Heading$/ })
    .waitFor();
  assert.equal(await page.locator('.comp-back').count(), 0);
  await page.frameLocator('iframe').locator('h1').dblclick();
  assert.equal(await page.locator('.comp-back').count(), 0);
  await row('Heading').click();
  await page.keyboard.press('Enter');
  await page.keyboard.press('c');
  await page.keyboard.press('Alt+KeyV');
  await assertClientChrome(page);
  assert.equal(await page.locator('.code-panel, .code-popup, .cm-editor').count(), 0);
  assert.equal(await readSource(), original);
  await page.locator('.rich-content').fill('Client role content check');
  await saved();
  await page
    .frameLocator('iframe')
    .getByRole('heading', { name: 'Client role content check', exact: true })
    .waitFor();
  assert.ok((await readSource()).includes('Client role content check'));
  await row('Heading').click();
  await page.keyboard.press('Meta+z');
  await saved();
  await page
    .frameLocator('iframe')
    .getByRole('heading', { name: 'Style Guide', exact: true })
    .waitFor();
  assert.equal(await readSource(), original);
  await row('Heading').click({ button: 'right' });
  await page.getByRole('menuitem', { name: /Duplicate/ }).click();
  await saved();
  await row('Heading').nth(1).waitFor();
  await page.keyboard.press('Meta+z');
  await saved();
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('.structure-node .label')].filter(
        (el) => el.textContent === 'Heading',
      ).length === 1,
  );
  assert.equal(await readSource(), original);
  await page.reload();
  await saved();
  await assertClientChrome(page);
  await page.getByLabel('Stacki account menu', { exact: true }).click();
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/client-role-menu.png' });
  await page.keyboard.press('Escape');
  await switchRole('Developer');
  await page.getByRole('button', { name: 'Code', exact: true }).waitFor();
  await page.locator('.frontmatter-node').dblclick();
  await page.getByRole('dialog', { name: 'Frontmatter', exact: true }).waitFor();
  await switchRole('Client');
  assert.equal(await page.getByRole('dialog').count(), 0);
  await switchRole('Developer');
  await page.getByRole('button', { name: 'Expand all', exact: true }).click();
  await row('Heading').dblclick();
  await page.locator('.comp-back').waitFor();
  await saved();
  await switchRole('Client');
  await page.locator('.comp-back').waitFor({ state: 'hidden' });
  await saved();
  await assertClientChrome(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel('Stacki account menu', { exact: true }).click();
  const bounds = await page.locator('.account-popover').boundingBox();
  assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 390);
  await page.screenshot({ path: 'test-results/client-role-mobile.png' });
  assert.deepEqual(errors, []);
  console.log(
    'Client role menu, content edits/undo, protected layout, hidden code/style/variables, instant role transitions, persistence and mobile menu passed.',
  );
} catch (error) {
  await page.screenshot({ path: 'test-results/client-role-failure.png' });
  throw error;
} finally {
  if (original !== undefined && (await readSource()) !== original) {
    const response = await page.request.post(new URL('/studio/api/source', url).href, {
      headers: { Origin: new URL(url).origin },
      data: { file: 'src/pages/index.astro', source: original, base: await readSource() },
    });
    assert.ok(response.ok(), await response.text());
  }
  await browser.close();
}
function row(name: string) {
  return page
    .locator('.structure-node')
    .filter({ has: page.locator('.label', { hasText: new RegExp('^' + name + '$') }) });
}
async function saved() {
  await page.locator('.save-state').filter({ hasText: 'Saved' }).waitFor();
}
async function switchRole(role: 'Client' | 'Developer') {
  await page.getByLabel('Stacki account menu', { exact: true }).click();
  await page.getByRole('menuitemradio', { name: new RegExp(role) }).click();
}
async function readSource() {
  const response = await page.request.get(
    new URL('/studio/api/file?file=src/pages/index.astro', url).href,
  );
  return string(record(await response.json())['source']);
}
async function assertClientChrome(page: Page) {
  await page.locator('.client-role-badge').waitFor();
  for (const name of ['Code', 'Variables', 'Style', 'Edit code']) {
    assert.equal(
      await page.getByRole('button', { name, exact: true }).count(),
      0,
      name + ' hidden',
    );
  }
  assert.equal(await page.locator('.frontmatter-node').count(), 0);
}
