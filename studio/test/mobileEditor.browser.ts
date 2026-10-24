// Goal: phone editing keeps selection on the canvas and every toolbar action reachable.
// Method: use real touch events against a running draft, resize its panes, and inspect bounds.
import assert from 'node:assert/strict';
import { chromium, type Page } from 'playwright';

const browser = await chromium.launch({
  executablePath:
    process.env['CHROME_PATH'] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  reducedMotion: 'reduce',
  ...(process.env['STUDIO_STORAGE_STATE']
    ? {
        storageState: process.env['STUDIO_STORAGE_STATE'],
      }
    : {}),
});
const page = await context.newPage();
const errors: string[] = [];
page.on('pageerror', (error) => errors.push(error.message));
try {
  await page.goto(process.env['STUDIO_URL'] ?? 'http://localhost:4351/studio');
  await page.locator('.save-state').filter({ hasText: 'Saved' }).waitFor({
    state: 'attached',
    timeout: 90000,
  });
  const heading = page.frameLocator('iframe[title="Site preview"]').locator('h1');
  await heading.waitFor();
  assert.equal(await page.locator('.studio-left').count(), 0);
  await heading.tap();
  assert.equal(await page.locator('.studio-left').count(), 0);
  assert.equal(await page.locator('.studio-right.mobile-open').count(), 0);
  await checkInspectors(page);
  for (const width of [320, 375, 390, 430, 600, 700, 701, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    await settle(page);
    await checkToolbarBounds(page);
  }
  await page.getByRole('button', { name: 'Navigator', exact: true }).tap();
  await checkToolbarBounds(page);
  await page.setViewportSize({ width: 768, height: 844 });
  await settle(page);
  await checkToolbarBounds(page);
  await page.getByRole('button', { name: 'Navigator', exact: true }).tap();
  await page.setViewportSize({ width: 320, height: 844 });
  await settle(page);
  await checkOverflow(page);
  await page.screenshot({ path: '/tmp/stacki-mobile-toolbar.png' });
  await page.getByLabel('Stacki account menu', { exact: true }).tap();
  await page.getByRole('menuitemradio', { name: 'Client', exact: true }).tap();
  await page.locator('.account-popover').waitFor({ state: 'detached' });
  assert.equal(
    await page
      .locator('.preview-toolbar')
      .getByRole('button', {
        name: 'Style',
        exact: true,
      })
      .count(),
    0,
  );
  await page
    .locator('.preview-toolbar')
    .getByRole('button', {
      name: 'Settings',
      exact: true,
    })
    .tap();
  await page.locator('.studio-right.mobile-open').waitFor();
  assert.deepEqual(errors, []);
  console.log(
    'Touch selection, both inspectors, client role and toolbar fitting at 10 widths passed.',
  );
} finally {
  await browser.close();
}

async function checkInspectors(page: Page) {
  const toolbar = page.locator('.preview-toolbar');
  await toolbar.getByRole('button', { name: 'Settings', exact: true }).tap();
  const inspector = page.locator('.studio-right.mobile-open');
  await inspector.getByText('Content', { exact: true }).waitFor();
  await page.screenshot({ path: '/tmp/stacki-mobile-settings.png' });
  await inspector.getByRole('button', { name: 'Close settings', exact: true }).tap();
  await toolbar.getByRole('button', { name: 'Style', exact: true }).tap();
  await inspector.getByText('CSS Code', { exact: true }).waitFor();
  await page.screenshot({ path: '/tmp/stacki-mobile-style.png' });
  await inspector.getByRole('button', { name: 'Close settings', exact: true }).tap();
  await page.frameLocator('iframe[title="Site preview"]').locator('h1').tap();
  assert.equal(await page.locator('.studio-left').count(), 0);
  assert.equal(await page.locator('.studio-right.mobile-open').count(), 0);
}

async function checkOverflow(page: Page) {
  await page.getByRole('button', { name: 'More preview actions', exact: true }).tap();
  const menu = page.getByRole('dialog', { name: 'More preview actions', exact: true });
  await menu.waitFor();
  await menu.getByTitle('Tablet (768px) — 2', { exact: true }).tap();
  await menu.waitFor({ state: 'detached' });
  assert.equal(
    await page
      .locator('.preview-toolbar')
      .getByRole('button', {
        name: 'Tablet (768px) — 2',
        exact: true,
      })
      .getAttribute('aria-pressed'),
    'true',
  );
  await page.getByRole('button', { name: 'More preview actions', exact: true }).tap();
  await menu.waitFor();
  await page.screenshot({ path: '/tmp/stacki-mobile-overflow.png' });
  await menu.getByRole('button', { name: 'Column guide', exact: true }).tap();
  await page.getByRole('dialog', { name: 'Column guide', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('dialog', { name: 'Column guide', exact: true }).waitFor({
    state: 'detached',
  });
  await menu.getByRole('textbox', { name: 'Canvas width', exact: true }).fill('768');
  await menu.getByRole('textbox', { name: 'Canvas width', exact: true }).press('Enter');
  await menu.getByRole('button', { name: 'Fit', exact: true }).tap();
  await page.keyboard.press('Escape');
  await menu.waitFor({ state: 'detached' });
  await checkToolbarBounds(page);
}

async function settle(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

async function checkToolbarBounds(page: Page) {
  const layout = await page.locator('.preview-toolbar').evaluate((toolbar) => {
    const outer = toolbar.getBoundingClientRect();
    const controls = Array.from(
      toolbar.querySelectorAll<HTMLElement>(
        ':scope > .preview-toolbar-item:not(.is-overflow), :scope > .preview-toolbar-more:not(.is-overflow)',
      ),
    );
    const boxes = controls.map((control) => control.getBoundingClientRect());
    return {
      screenFits: document.documentElement.scrollWidth <= window.innerWidth,
      toolbarFits: toolbar.scrollWidth <= toolbar.clientWidth,
      contained: boxes.every((box) => box.left >= outer.left && box.right <= outer.right),
      separated: boxes.every(
        (box, index) => index === 0 || box.left >= (boxes[index - 1]?.right ?? 0),
      ),
      visible: controls.length,
    };
  });
  assert.ok(layout.screenFits, `Page overflows at ${page.viewportSize()?.width}`);
  assert.ok(layout.toolbarFits, `Toolbar overflows at ${page.viewportSize()?.width}`);
  assert.ok(layout.contained, 'An action extends outside the toolbar');
  assert.ok(layout.separated, 'Toolbar actions overlap');
  assert.ok(layout.visible > 0, 'At least the overflow menu remains accessible');
}
