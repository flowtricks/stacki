// Exercise contextual defaults through the navigator, inspector and drag tools.
// Verify shared persistence, stale-write protection, unchanged instances and client restrictions.
import assert from 'node:assert/strict';
import { chromium, type Page } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { parseMetadataFile } from '../vendor/stacki/shared/properties/projectMetadata';
import { parseDefaultsSource } from '../vendor/stacki/shared/properties/componentDefaults';
const browser = await chromium.launch({
  executablePath: process.env['CHROME_PATH'] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
const first = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const second = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const base = process.env['STUDIO_URL'] ?? 'http://localhost:4358/studio';
const heading = 'src/components/typography/Heading.astro';
const wrapper = 'src/components/wrapper/ContentWrapper.astro';
const errors: string[] = [];
for (const page of [first, second]) {
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && message.text().includes('[stacki] could not patch')) {
      errors.push(message.text());
    }
  });
}
const row = (page: Page, label: string) =>
  page
    .locator('.structure-node')
    .filter({
      has: page.locator('.label', { hasText: new RegExp('^' + label + '$') }),
    })
    .first();
async function expand(page: Page) {
  const button = page.getByRole('button', { name: 'Expand all', exact: true });
  if (await button.isVisible()) {
    await button.click();
  }
}
async function edit(page: Page, label: string) {
  await expand(page);
  await row(page, label).click({ button: 'right' });
  const menu = page.getByRole('menu', { name: 'Element actions' });
  assert.equal(await menu.locator(':scope > button').last().innerText(), 'Set component defaults');
  await menu.getByRole('menuitem', { name: 'Set component defaults', exact: true }).click();
  await page.getByRole('button', { name: 'Close defaults', exact: true }).waitFor();
  await page.locator('.save-state').filter({ hasText: 'Saved' }).waitFor();
  await page.locator('.node-focus').first().waitFor();
}
async function close(page: Page) {
  await page.getByRole('button', { name: 'Close defaults', exact: true }).click();
  await page.getByRole('button', { name: 'Close defaults', exact: true }).waitFor({ state: 'hidden' });
  await page.locator('.save-state').filter({ hasText: 'Saved' }).waitFor();
}
async function readDefaults(page: Page) {
  const stored = parseMetadataFile(await (await page.request.get(base + '/api/metadata?kind=components')).json());
  assert.ok(stored.source);
  const parsed = parseDefaultsSource(stored.source);
  assert.ok(parsed.ok);
  return parsed.value;
}
try {
  await first.goto(base, { waitUntil: 'domcontentloaded' });
  await first.locator('.save-state').filter({ hasText: 'Saved' }).waitFor();
  await first.getByLabel('Stacki account menu', { exact: true }).click();
  assert.equal(await first.getByRole('button', { name: 'Project settings', exact: true }).count(), 0);
  await first.getByLabel('Stacki account menu', { exact: true }).click();
  await first.locator('[data-popup][aria-label="Stacki account"]').waitFor({ state: 'hidden' });
  const previewFrame = first.frames().find((frame) => frame.url().includes('#avb-design'));
  assert.ok(previewFrame);
  const lifetime = await previewFrame.evaluate(() => performance.timeOrigin);
  await edit(first, 'Heading');
  await first
    .frameLocator('iframe')
    .getByRole('heading', { name: await first.locator('.rich-content').innerText(), exact: true })
    .waitFor();
  assert.equal(await previewFrame.evaluate(() => performance.timeOrigin), lifetime);
  assert.equal(await row(first, 'ContentWrapper').getAttribute('aria-disabled'), 'true');
  assert.equal(await row(first, 'Heading').getAttribute('aria-disabled'), 'false');
  await first.locator('.rich-content').fill('Contextual default heading');
  assert.equal(
    await first
      .locator('.prop-label.set')
      .filter({ hasText: /^Content$/ })
      .count(),
    1,
  );
  const width = first.locator('.props-field').filter({
    has: first.locator('.prop-label', { hasText: /^maxWidth$/ }),
  });
  await width.locator('input').fill('37');
  await width.locator('input').press('Enter');
  assert.equal(await width.locator('.prop-label.set').count(), 1);
  const render = first.locator('.props-field').filter({
    has: first.locator('.prop-label', { hasText: /^render$/ }),
  });
  const renderLabel = render.locator('.prop-label');
  if (await render.locator('.prop-label.set').count()) {
    await renderLabel.click({ modifiers: ['Alt'] });
  }
  assert.equal(await render.locator('.bool-seg button.on').innerText(), 'True');
  await render.getByRole('button', { name: 'True', exact: true }).click();
  assert.equal(await render.locator('.prop-label.set').count(), 1);
  const tag = first.locator('.props-field').filter({
    has: first.locator('.prop-label', { hasText: /^tag$/ }),
  });
  await tag.locator('.dd-trigger').click();
  await first.locator('.dd-option').filter({ hasText: /^h2$/ }).click();
  await first.locator('.dd-popup').waitFor({ state: 'hidden' });
  assert.equal(await tag.locator('.prop-label.set').count(), 1);
  await first.frameLocator('iframe').getByRole('heading', { name: 'Contextual default heading', exact: true }).waitFor();
  await mkdir('test-results', { recursive: true });
  await first.screenshot({ path: 'test-results/component-defaults-context.png' });
  // A real click on a dimmed sibling must save and close the defaults session.
  await first.frameLocator('iframe').getByText('Desktop and hosted Studio', { exact: true }).click();
  await first.getByRole('button', { name: 'Close defaults', exact: true }).waitFor({ state: 'hidden' });
  assert.equal(await previewFrame.evaluate(() => performance.timeOrigin), lifetime);
  assert.match((await row(first, 'Heading').getAttribute('class')) ?? '', /selected/);
  const stored = await readDefaults(first);
  assert.equal(stored.components[heading]?.text, 'Contextual default heading');
  assert.equal(stored.components[heading]?.props?.['maxWidth'], 37);
  assert.equal(stored.components[heading]?.props?.['render'], true);
  assert.equal(stored.components[heading]?.props?.['tag'], 'h2');
  await first.frameLocator('iframe').getByRole('heading', { name: 'A shared Stacki editor', exact: true }).waitFor();
  // Reset removes authored slot content; this fixture's Astro fallback is empty.
  const contentLabel = first.locator('.prop-label').filter({ hasText: /^Content$/ });
  assert.equal(await contentLabel.getAttribute('class'), 'prop-label set');
  await contentLabel.click({ modifiers: ['Alt'] });
  await first.frameLocator('iframe').getByRole('heading', { name: 'A shared Stacki editor', exact: true }).waitFor({ state: 'hidden' });
  assert.equal(await contentLabel.getAttribute('class'), 'prop-label');
  await first.locator('.rich-content').fill('A shared Stacki editor');
  await first.locator('.save-state').filter({ hasText: 'Saved' }).waitFor();
  await edit(first, 'Heading');
  assert.equal(await first.locator('.rich-content').innerText(), 'Contextual default heading');
  assert.equal(await render.locator('.prop-label.set').count(), 1);
  assert.equal(await tag.locator('.prop-label.set').count(), 1);
  // Escape forwarded from the preview frame uses the same save-and-close path.
  await first
    .frameLocator('iframe')
    .getByRole('heading', {
      name: 'Contextual default heading',
      exact: true,
    })
    .click();
  await first.keyboard.press('Escape');
  await first.getByRole('button', { name: 'Close defaults', exact: true }).waitFor({ state: 'hidden' });
  await edit(first, 'Heading');
  await second.goto(base, { waitUntil: 'domcontentloaded' });
  await second.locator('.save-state').filter({ hasText: 'Saved' }).waitFor();
  await edit(second, 'Heading');
  await second.locator('.rich-content').fill('Saved by the other editor');
  await close(second);
  await first.locator('.rich-content').fill('Stale changes');
  await first.getByRole('button', { name: 'Close defaults', exact: true }).click();
  await first.getByText('Project settings changed. Reload before saving.', { exact: true }).waitFor();
  await first.getByRole('button', { name: 'Discard changes', exact: true }).click();
  await first.getByRole('button', { name: 'Close defaults', exact: true }).waitFor({ state: 'hidden' });
  await edit(first, 'ContentWrapper');
  await expand(first);
  const rootId = await row(first, 'ContentWrapper').getAttribute('data-node-id');
  assert.ok(rootId);
  const labels = await first.locator('.structure-node .label').allTextContents();
  const moving = labels.indexOf('Heading') < labels.indexOf('Paragraph') ? 'Heading' : 'Paragraph';
  const remaining = moving === 'Heading' ? 'Paragraph' : 'Heading';
  const child = row(first, moving);
  const gap = first.locator(`.nav-gap[data-drop-parent="${rootId}"][data-drop-index="2"]`);
  const source = await child.boundingBox();
  const target = await gap.boundingBox();
  assert.ok(source && target);
  await first.mouse.move(source.x + 5, source.y + 5);
  await first.mouse.down();
  await first.mouse.move(target.x + 5, target.y + target.height / 2, { steps: 15 });
  await first.mouse.up();
  await first.waitForFunction(
    ({ moving, remaining }) => {
      const labels = [...document.querySelectorAll('.structure-node .label')].map((item) => item.textContent);
      return labels.indexOf(moving) > labels.indexOf(remaining);
    },
    { moving, remaining },
  );
  await close(first);
  const children = (await readDefaults(first)).components[wrapper]?.children;
  assert.ok(children?.[0] && 'component' in children[0]);
  assert.equal(children[0].component, `src/components/typography/${remaining}.astro`);
  await first.getByLabel('Stacki account menu', { exact: true }).click();
  await first.getByRole('menuitemradio', { name: 'Client', exact: true }).click();
  await expand(first);
  await row(first, 'Heading').click({ button: 'right' });
  assert.equal(await first.getByRole('menuitem', { name: 'Set component defaults' }).isDisabled(), true);
  await first.keyboard.press('Escape');
  assert.deepEqual(errors, []);
  console.log('Contextual component defaults and client mode browser checks passed.');
} catch (error) {
  await mkdir('test-results', { recursive: true });
  await first.screenshot({ path: 'test-results/component-defaults-failure.png' });
  console.error(await first.locator('body').innerText());
  console.error(errors);
  throw error;
} finally {
  await browser.close();
}
