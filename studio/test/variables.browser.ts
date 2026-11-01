// Goal: variable edits and floating controls work in the live collaborative editor.
// Method: use two browser sessions for source edits and undo, real menu clicks,
// and measured scrollbar alignment at desktop and mobile viewport sizes.
import { chromium, type Page } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { record, string } from '../src/shared/validation';

const browser = await chromium.launch({
  executablePath: process.env['CHROME_PATH'] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
const auth = process.env['STUDIO_STORAGE_STATE'];
const options = {
  viewport: { width: 1440, height: 1000 },
  ...(auth ? { storageState: auth } : {}),
};
const first = await (await browser.newContext(options)).newPage();
const second = await (await browser.newContext(options)).newPage();
const errors: string[] = [];
const url = process.env['STUDIO_URL'] ?? 'http://localhost:4352/studio';
const file = 'src/styles/base.css';
let original: string | undefined;
for (const page of [first, second]) {
  page.setDefaultTimeout(20000);
  page.on('pageerror', (error) => errors.push(error.message));
}
try {
  await Promise.all([openVariables(first), openVariables(second)]);
  original = await readSource(first);
  await checkGroupMenu(first);
  const pageSource = await readSource(first, 'src/pages/index.astro');
  await first.getByRole('button', { name: 'Variables', exact: true }).focus();
  await first.keyboard.press('Delete');
  await first.waitForLoadState('networkidle');
  assert.equal(await readSource(first, 'src/pages/index.astro'), pageSource, 'Variable-panel shortcuts must not delete the selected canvas element');
  await first
    .locator('.cms-collection')
    .filter({ hasText: /^Theme/ })
    .click();
  assert.equal(await first.locator('.vars-head[title]').count(), 3, 'Theme modes use separate columns');
  await first
    .locator('.cms-collection')
    .filter({ hasText: /^:root/ })
    .click();
  await first.getByPlaceholder('Search variables').fill('--brand-500');
  const value = variableField(first, '--brand-500');
  await value.fill('#123456');
  await value.press('Enter');
  await waitValue(second, '--brand-500', '#123456');
  assert.equal(await readSource(first), original.replace('--brand-500: #c6fb50', '--brand-500: #123456'));
  await first.locator('.cms-saved.on').waitFor({ state: 'hidden' });
  await first.keyboard.press('Meta+z');
  await waitValue(first, '--brand-500', '#c6fb50');
  await waitValue(second, '--brand-500', '#c6fb50');
  assert.equal(await readSource(first), original, 'Undo restores the exact source');
  await first.waitForLoadState('networkidle');
  await first.keyboard.press('Meta+Shift+z');
  await waitValue(second, '--brand-500', '#123456');
  await first.getByPlaceholder('Search variables').fill('');
  await first.getByRole('button', { name: 'New variable', exact: true }).first().click();
  await first.getByPlaceholder('name', { exact: true }).fill('studio-test-variable');
  await first.getByPlaceholder('name', { exact: true }).press('Enter');
  await waitValue(second, '--studio-test-variable', 'unset');
  assert.ok((await readSource(first)).includes('--studio-test-variable: unset;'));
  await first.getByPlaceholder('Search variables').fill('studio-test-variable');
  await first.locator('.vars-name .vars-rename').click();
  await first.locator('.vars-rename-input').fill('studio-renamed-variable');
  await first.locator('.vars-rename-input').press('Enter');
  await waitValue(second, '--studio-renamed-variable', 'unset');
  await first.getByPlaceholder('Search variables').fill('');
  await mkdir('test-results', { recursive: true });
  await first.screenshot({ path: 'test-results/variables.png' });
  await first
    .locator('.cms-collection')
    .filter({ hasText: /^Theme/ })
    .click();
  await checkScrollbar(first);
  await first.setViewportSize({ width: 390, height: 844 });
  await checkScrollbar(first);
  await first.getByRole('button', { name: 'Dock window', exact: true }).click();
  await checkScrollbar(first);
  await first.setViewportSize({ width: 1440, height: 1000 });
  await first
    .locator('.cms-collection')
    .filter({ hasText: /^:root/ })
    .click();
  await first.getByRole('button', { name: 'Undock window', exact: true }).click();
  await first.setViewportSize({ width: 390, height: 844 });
  await first.getByPlaceholder('Search variables').fill('--brand-500');
  assert.ok(await variableField(first, '--brand-500').isVisible());
  assert.equal(await first.locator('.studio-left').isVisible(), false);
  await first.screenshot({ path: 'test-results/variables-mobile.png' });
  await first.locator('.vars-view button[title="Close"]').click();
  assert.ok(await first.locator('.studio-left').isVisible());
  assert.deepEqual(errors, []);
  console.log('Variables: modes, search, source edits, two-browser refresh, undo/redo, add, rename and mobile passed.');
} catch (error: unknown) {
  console.error(
    'Scrollbar geometry at failure:',
    await first.locator('.vars-horizontal-scroll, .vars-scroll-head, .vars-scroll-rows').evaluateAll((elements) =>
      elements.map((element) => ({
        className: element.getAttribute('class') ?? '',
        viewport: element.clientWidth,
        maximum: element.scrollWidth - element.clientWidth,
        left: element.scrollLeft,
      })),
    ),
  );
  throw error;
} finally {
  if (original !== undefined) {
    const base = await readSource(first);
    const result = await first.request.post(new URL('/studio/api/source', url).href, {
      headers: { Origin: new URL(url).origin },
      data: { file, source: original, base },
    });
    assert.ok(result.ok(), 'Restore the test draft stylesheet');
  }
  await browser.close();
}

async function openVariables(page: Page) {
  await page.goto(url);
  await page.locator('.save-state').filter({ hasText: 'Saved' }).waitFor();
  await page.getByRole('button', { name: 'Expand all', exact: true }).click();
  await page
    .locator('.structure-node')
    .filter({ has: page.locator('.label', { hasText: /^Heading$/ }) })
    .click();
  await page.getByRole('button', { name: 'Variables', exact: true }).click();
  // The only stylesheet is selected automatically and its groups replace the file list.
  await page.getByPlaceholder('Search variables').waitFor();
}
async function checkGroupMenu(page: Page) {
  await page.locator('.vars-section').first().hover();
  await page.getByRole('button', { name: 'Group options', exact: true }).first().click();
  assert.deepEqual(await page.getByRole('menuitem').allTextContents(), ['Rename', 'Duplicate', 'Delete']);
  // Playwright hit-tests the click, so a menu hidden behind the frame cannot pass.
  await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
  const input = page.locator('.vars-section .vars-rename-input');
  await input.waitFor();
  assert.equal(await input.inputValue(), 'Swatches');
  await input.press('Escape');
}
async function checkScrollbar(page: Page) {
  const bar = page.locator('.vars-horizontal-scroll');
  await bar.waitFor({ state: 'visible' });
  await page.waitForFunction(() => {
    const bar = document.querySelector<HTMLElement>('.vars-horizontal-scroll');
    const strip = document.querySelector<HTMLElement>('.vars-sheet-head .vars-scroll-head');
    if (!bar || !strip) {
      return false;
    }
    return (
      bar.clientWidth === strip.clientWidth && bar.scrollWidth === strip.scrollWidth && bar.getBoundingClientRect().left === strip.getBoundingClientRect().left
    );
  });
  // ResizeObserver updates the scroll coordinator after layout; wait for that
  // frame and its React commit before starting a new scrollbar gesture.
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await bar.evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
  });
  await page.waitForFunction(() => {
    const bar = document.querySelector<HTMLElement>('.vars-horizontal-scroll');
    // Empty sections have no overflow; the shared heading carries all Theme columns.
    const strip = document.querySelector<HTMLElement>('.vars-sheet-head .vars-scroll-head');
    if (!bar || !strip) {
      return false;
    }
    const maximum = strip.scrollWidth - strip.clientWidth;
    return maximum > 0 && bar.scrollLeft === maximum && strip.scrollLeft === maximum;
  });
}
function variableField(page: Page, name: string) {
  return page
    .locator('.var-cell')
    .filter({ has: page.locator(`input[title^="${name}:"]`) })
    .locator('[contenteditable=true]');
}
async function waitValue(page: Page, name: string, value: string) {
  await page.waitForFunction(
    ({ name, value }) => {
      const input = document.querySelector<HTMLInputElement>(`input[title^="${name}:"]`);
      return input?.value === value;
    },
    { name, value },
  );
}
async function readSource(page: Page, sourceFile = file) {
  const response = await page.request.get(new URL('/studio/api/file?file=' + encodeURIComponent(sourceFile), url).href);
  return string(record(await response.json())['source']);
}
