// Goal: validate native Desktop editing through its real save and preview pipeline.
// Method: type into the inspector, reorder navigator rows, duplicate/delete, and
// undo, checking the rendered DOM and authored file in a disposable Electron app.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from 'playwright';
import { startDesktopFixture } from './desktopFixture';
import { measureTextInput } from './editLatencyProbe';

const fixture = await startDesktopFixture(
  `---
import Card from '../components/Card.astro';
---
<main><h1>Hello <strong>nested</strong> world</h1><p>Second element</p>
<Card variant="plain"><strong>Keep the slot</strong></Card></main>`,
  `---
interface Props { variant?: 'plain' | 'accent' | 'list' }
const { variant = 'plain' } = Astro.props;
---
<section class={variant}>{variant === 'list' ? <ul><li>New child</li></ul> :
<div>Plain child</div>}<slot /></section>
<style>.accent { color: rgb(120, 30, 90); }</style>`,
);
try {
  const page = await fixture.application.firstWindow({ timeout: 30_000 });
  page.setDefaultTimeout(20_000);
  await page.getByText('Open from folder', { exact: true }).click();
  await page.frameLocator('iframe').locator('main > h1').waitFor();
  await checkText(page);
  await checkStructure(page);
  await checkInsertion(page);
  await checkVariants(page);
  const source = await readFile(path.join(fixture.project, 'src/pages/index.astro'), 'utf8');
  assert.match(source, /Hello <strong>nested<\/strong> world typed/);
  assert.equal(source.match(/<p>/g)?.length, 1);
  console.log('Desktop typing, reorder, duplicate, delete, insertion, variants and undo passed.');
} finally {
  await fixture.stop();
}

async function checkText(page: Page) {
  await select(page, 'h1');
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
  await page.locator('.node-outline.sel').filter({ hasText: 'h1' }).waitFor();
  const input = page.locator('.rich-content');
  await input.click();
  await input.press('ControlOrMeta+End');
  const preview = page.frames().find((candidate) => candidate.parentFrame());
  assert.ok(preview, 'Desktop has an attached preview');
  const timing = await measureTextInput(page, preview, input, {
    selector: 'main > h1',
    text: ' typed',
    expected: 'Hello nested world typed',
  });
  const frame = page.frameLocator('iframe');
  await frame.getByRole('heading', { name: 'Hello nested world typed', exact: true }).waitFor();
  assert.equal(await frame.locator('main > h1 strong').innerText(), 'nested');
  await page.locator('.node-outline.sel').filter({ hasText: 'h1' }).waitFor();
  console.log(JSON.stringify({ operation: 'desktop-type', ...timing }));
}

async function checkStructure(page: Page) {
  await select(page, 'p');
  const row = page.locator('.structure-node').filter({ has: page.locator('.label', { hasText: /^p$/ }) });
  const gap = page.locator('.nav-gap[data-drop-parent="n0"][data-drop-index="0"]');
  const source = await row.boundingBox();
  const target = await gap.boundingBox();
  assert.ok(source);
  assert.ok(target);
  const started = performance.now();
  await page.mouse.move(source.x + 5, source.y + 5);
  await page.mouse.down();
  await page.mouse.move(target.x + 5, target.y + target.height / 2, { steps: 12 });
  await page.mouse.up();
  const frame = page.frameLocator('iframe');
  await frame.locator('main > p:first-child').waitFor();
  console.log(
    JSON.stringify({
      operation: 'desktop-reorder',
      actionToObservedMs: performance.now() - started,
    }),
  );
  await page.keyboard.press('ControlOrMeta+z');
  await frame.locator('main > h1:first-child').waitFor();
  await select(page, 'p');
  await page.keyboard.press('ControlOrMeta+d');
  await frame.locator('main > p').nth(1).waitFor();
  await page.keyboard.press('Delete');
  await frame.locator('main > p').nth(1).waitFor({ state: 'detached' });
}

async function select(page: Page, name: string) {
  await page
    .locator('.structure-node')
    .filter({
      has: page.locator('.label', { hasText: new RegExp(`^${name}$`) }),
    })
    .click();
}

async function checkInsertion(page: Page) {
  await select(page, 'h1');
  await page.keyboard.press('ControlOrMeta+e');
  const palette = page.locator('.insert-palette');
  await palette.getByRole('button', { name: 'Elements', exact: true }).click();
  await palette.getByPlaceholder('Search components, elements…').fill('mark');
  await palette.getByPlaceholder('Search components, elements…').press('Enter');
  await palette.waitFor({ state: 'detached' });
  await page.frameLocator('iframe').locator('main mark').waitFor({ state: 'attached' });
  await page.keyboard.press('ControlOrMeta+z');
  await page.frameLocator('iframe').locator('main mark').waitFor({ state: 'detached' });
}

async function checkVariants(page: Page) {
  await select(page, 'Card');
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
  const frame = page.frameLocator('iframe');
  for (const variant of ['accent', 'list']) {
    await page.getByRole('button', { name: 'plain', exact: true }).click();
    await page
      .locator('.dd-option')
      .filter({ hasText: new RegExp(`^${variant}$`) })
      .click();
    await frame.locator(`section.${variant}`).waitFor();
    assert.equal(await frame.locator('section strong').innerText(), 'Keep the slot');
    assert.equal(await frame.locator('section ul').count(), variant === 'list' ? 1 : 0);
    assert.equal(await frame.locator('section > div').count(), variant === 'list' ? 0 : 1);
    await page.keyboard.press('ControlOrMeta+z');
    await frame.locator('section.plain > div').waitFor();
    assert.equal(await frame.locator('section ul').count(), 0);
  }
}
