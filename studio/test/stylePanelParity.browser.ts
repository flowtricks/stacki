import { chromium, type Page, type Locator } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { startStyleFixture } from './stylePanelFixture';
import { checkStyleControls } from './stylePanelControls.browser';
import { checkStyleQueries } from './stylePreviewQueries.browser';
import { record, string } from '../src/shared/validation';

const fixture = await startStyleFixture();
const browser = await chromium.launch({
  executablePath:
    process.env['CHROME_PATH'] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1500, height: 1050 } });
page.setDefaultTimeout(20000);
const errors: string[] = [];
page.on('pageerror', (error) => errors.push(error.message));
try {
  await page.addInitScript(() => {
    Reflect.set(window, '__name', (value: unknown) => value);
  });
  await page.goto(fixture.url);
  await page.locator('.save-state').filter({ hasText: 'Saved' }).waitFor();
  await page
    .frameLocator('iframe[title="Site preview"]')
    .locator('#target')
    .click({ position: { x: 5, y: 5 } });
  await page.getByRole('button', { name: 'Style', exact: true }).click();
  await checkStyleQueries(page);
  await checkColors(page);
  await checkSections(page);
  await page.waitForFunction(() => {
    const image = document.querySelector('.embed-editor_bg-layer-preview img');
    return image instanceof HTMLImageElement && image.complete && image.naturalWidth === 32;
  });
  await checkStyleControls(page);
  await selectChip(
    page.locator('.embed-editor_selector-chip').filter({ hasText: /^\.component$/ }),
  );
  await checkWriteUndo(page);
  await checkClassAdd(page);
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/style-panel-parity.png' });
  assert.deepEqual(errors, []);
  console.log(
    'Green/blue/gray chip states, query dimming, all panel sections, component writes/undo, and class-list additions passed.',
  );
} catch (error) {
  console.error(await page.locator('.style-panel-host').innerText(), errors);
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/style-panel-failure.png' });
  throw error;
} finally {
  await browser.close();
  await fixture.stop();
}
async function checkColors(page: Page) {
  const chip = page.locator('.embed-editor_selector-chip');
  const green = chip.filter({ hasText: /^\.component$/ });
  await green.waitFor();
  assert.match((await green.getAttribute('class')) ?? '', /is-component/);
  await selectChip(green);
  await chipColor(green, 'rgb(22, 120, 60)');
  await green.hover();
  await chipColor(green, 'rgb(22, 120, 60)');
  const blue = chip.filter({ hasText: /^\.sheet$/ });
  await selectChip(blue);
  await chipColor(blue, 'rgb(1, 107, 205)');
  const dimmed = chip.filter({ hasText: /^\.query-only$/ });
  assert.match((await dimmed.getAttribute('class')) ?? '', /is-dimmed/);
  await page.getByRole('checkbox', { name: /Show inherited styles/ }).check();
  const inherited = chip.filter({ hasText: /^\.parent \.component$/ });
  await selectChip(inherited);
  await chipColor(inherited, 'rgb(74, 74, 74)');
  await selectChip(green);
}
async function selectChip(chip: Locator) {
  await chip.and(chip.page().locator(':enabled')).waitFor();
  if ((await chip.getAttribute('aria-pressed')) !== 'true') {
    await chip.click();
  }
  await chip.and(chip.page().locator('[aria-pressed="true"]')).waitFor();
}
async function checkSections(page: Page) {
  for (const name of [
    'Flex/Grid Child',
    'Layout',
    'Spacing',
    'Size',
    'Position',
    'Typography',
    'Backgrounds',
    'Borders',
    'Effects',
    'Other properties',
  ]) {
    await page
      .getByRole('button', { name, exact: true })
      .and(page.locator('.embed-editor_section-toggle'))
      .waitFor();
  }
  await page.getByRole('button', { name: 'Expand CSS Code', exact: true }).click();
  await page.locator('.style-panel-host .cm-content').waitFor();
  await page.getByRole('button', { name: 'Collapse CSS Code', exact: true }).click();
}
async function checkWriteUndo(page: Page) {
  const file = 'src/components/Card.astro';
  const before = await source(page, file);
  const opacity = page.locator('input[aria-label="Opacity"]');
  await opacity.hover();
  await opacity.fill('0.65');
  await opacity.press('Enter');
  await page.waitForFunction(() => {
    const el = document.querySelector('iframe')?.contentDocument?.querySelector('#target');
    return el && getComputedStyle(el).opacity === '0.65';
  });
  const after = await source(page, file);
  assert.match(after, /opacity: 0.65/);
  assert.ok(after.includes('const example = true;'));
  assert.ok(after.includes('.unrelated { outline: 3px solid red; }'));
  await page.keyboard.press('Meta+z');
  await page.waitForFunction(() => {
    const el = document.querySelector('iframe')?.contentDocument?.querySelector('#target');
    return el && getComputedStyle(el).opacity === '0.9';
  });
  assert.equal(await source(page, file), before);
}
async function checkClassAdd(page: Page) {
  await page.locator('.embed-editor_selector-well').click({ position: { x: 3, y: 3 } });
  await page.getByRole('combobox', { name: 'Add a selector', exact: true }).fill('.new-style');
  await page.getByRole('combobox', { name: 'Add a selector', exact: true }).press('Enter');
  await page.frameLocator('iframe[title="Site preview"]').locator('#target.new-style').waitFor();
  const written = await source(page, 'src/pages/index.astro');
  assert.match(written, /class:list=\{\["sheet", "component", "query-only", "new-style"\]\}/);
}
async function source(page: Page, file: string) {
  const response = await page.request.get(
    new URL('/studio/api/file?file=' + encodeURIComponent(file), fixture.url).href,
  );
  assert.ok(response.ok());
  return string(record(await response.json())['source']);
}

async function chipColor(chip: Locator, color: string) {
  await chip
    .page()
    .waitForFunction(
      ({ element, color }) => element && getComputedStyle(element).backgroundColor === color,
      { element: await chip.elementHandle(), color },
    );
}
