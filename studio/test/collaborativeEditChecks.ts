// Goal: structural and text operations converge across independent editors.
// Method: native pointer/keyboard actions and exact DOM/source checks. Durations
// include automation overhead on one test-process clock, not proof of paint.
import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import { record, string } from '../src/shared/validation';

export async function checkCollaborativeEdits(first: Page, second: Page) {
  const original = await readSource(first);
  await selectRow(first, 'Card', 1);
  let started = performance.now();
  await moveSecondFirst(first);
  await waitBoth(first, second, 'main > button.secondary:first-child');
  await verifyLabels(first, second);
  report('reorder', started);
  const reordered = await readSource(first);
  assert.ok(reordered.indexOf('Plan your visit') < reordered.indexOf('Choose a campus'));
  await first.keyboard.press('ControlOrMeta+z');
  await waitBoth(first, second, 'main > button.primary:first-child');
  await selectRow(first, 'Card', 1);
  started = performance.now();
  await first.keyboard.press('ControlOrMeta+d');
  await waitCount(first, second, 'main > button', 3);
  report('duplicate', started);
  await verifyLabels(first, second);
  started = performance.now();
  await first.keyboard.press('Delete');
  await waitCount(first, second, 'main > button', 2);
  report('delete', started);
  await verifyLabels(first, second);
  // Deletion removes the element range; its inserted blank separator may remain.
  assert.equal((await readSource(first)).replace(/\n{2,}/g, '\n'), original, 'Duplicate/delete preserves authored content and imports');
  await checkInsertion(first, second);
  await checkTyping(first, second);
}

async function checkInsertion(first: Page, second: Page) {
  await selectRow(first, 'h1');
  await first.keyboard.press('ControlOrMeta+e');
  const palette = first.locator('.insert-palette');
  await palette.getByRole('button', { name: 'Elements', exact: true }).click();
  await palette.getByPlaceholder('Search components, elements…').fill('mark');
  const started = performance.now();
  await palette.getByPlaceholder('Search components, elements…').press('Enter');
  await palette.waitFor({ state: 'detached' });
  await waitCount(first, second, 'main mark', 1);
  assert.match(await readSource(first), /<mark[\s>]/);
  report('insert-element', started);
  await first.keyboard.press('ControlOrMeta+z');
  await waitCount(first, second, 'main mark', 0);
}

async function checkTyping(first: Page, second: Page) {
  await watchTextProgress(first, second);
  await selectRow(first, 'h1');
  const input = first.locator('.rich-content');
  await input.click();
  await first.keyboard.press('ControlOrMeta+End');
  const started = performance.now();
  await input.pressSequentially(' typed rapidly', { delay: 15 });
  const expected = 'Hello nested world typed rapidly';
  for (const page of [first, second]) {
    await page.frameLocator('iframe[title="Site preview"]').getByRole('heading', { name: expected, exact: true }).waitFor();
    assert.equal(await page.frameLocator('iframe[title="Site preview"]').locator('h1 strong').textContent(), 'nested');
  }
  report('type-text', started);
  assert.match(await readSource(first), /<strong>nested<\/strong> world typed rapidly/);
  await selectRow(second, 'p');
  await second.locator('.rich-content').fill('Second participant text');
  await waitBoth(first, second, 'main > p:text-is("Second participant text")');
  for (const page of [first, second]) {
    await page.frameLocator('iframe[title="Site preview"]').getByRole('heading', { name: expected, exact: true }).waitFor();
  }
  const source = await readSource(first);
  assert.ok(source.includes('Second participant text'));
  assert.ok(source.includes('typed rapidly'));
  await Promise.all([input.pressSequentially(' first', { delay: 15 }), second.locator('.rich-content').pressSequentially(' second', { delay: 15 })]);
  for (const page of [first, second]) {
    await page
      .frameLocator('iframe[title="Site preview"]')
      .getByRole('heading', { name: `${expected} first`, exact: true })
      .waitFor();
    await page.frameLocator('iframe[title="Site preview"]').getByText('Second participant text second', { exact: true }).waitFor();
  }
}

async function moveSecondFirst(page: Page) {
  const row = page
    .locator('.structure-node')
    .filter({ has: page.locator('.label', { hasText: /^Card$/ }) })
    .nth(1);
  const identifier = await row.getAttribute('data-node-id');
  assert.ok(identifier, 'Drag source has an identity');
  const parent = identifier.slice(0, identifier.lastIndexOf('.'));
  const gap = page.locator(`.nav-gap[data-drop-parent="${parent}"][data-drop-index="0"]`);
  const from = await row.boundingBox();
  const to = await gap.boundingBox();
  assert.ok(from, 'Drag source must be visible');
  assert.ok(to, 'Drag destination must be visible');
  await page.mouse.move(from.x + 5, from.y + 5);
  await page.mouse.down();
  await page.mouse.move(to.x + 5, to.y + to.height / 2, { steps: 12 });
  await page.mouse.up();
}

async function selectRow(page: Page, name: string, index = 0) {
  await page
    .locator('.structure-node')
    .filter({ has: page.locator('.label', { hasText: new RegExp(`^${name}$`) }) })
    .nth(index)
    .click();
}

async function waitBoth(first: Page, second: Page, selector: string) {
  for (const page of [first, second]) {
    await page.frameLocator('iframe[title="Site preview"]').locator(selector).waitFor();
  }
}

async function waitCount(first: Page, second: Page, selector: string, count: number) {
  for (const page of [first, second]) {
    await page.waitForFunction(
      ({ selector, count }) => {
        const frame = document.querySelector<HTMLIFrameElement>('iframe[title="Site preview"]');
        return frame?.contentDocument?.querySelectorAll(selector).length === count;
      },
      { selector, count },
    );
  }
}

async function verifyLabels(first: Page, second: Page) {
  for (const page of [first, second]) {
    const buttons = page.frameLocator('iframe[title="Site preview"]').locator('main > button');
    const values = await buttons.evaluateAll((elements) =>
      elements.map((element) => ({
        text: element.textContent,
        style: element.getAttribute('class'),
      })),
    );
    assert.ok(values.length >= 2, 'Original component instances remain');
    assert.ok(values.length <= 3, 'Only one duplicate exists');
    for (const value of values) {
      assert.equal(value.style, value.text === 'Choose a campus' ? 'primary' : 'secondary');
    }
  }
}

async function watchTextProgress(first: Page, second: Page) {
  for (const page of [first, second]) {
    await page
      .frameLocator('iframe[title="Site preview"]')
      .locator('body')
      .evaluate((body) => {
        // Collapsible trailing spaces are not visible text; typing can normalize them.
        let previous = body.querySelector('h1')?.textContent?.trimEnd() ?? '';
        new MutationObserver(() => {
          const current = body.querySelector('h1')?.textContent?.trimEnd() ?? '';
          if (!current.startsWith(previous)) {
            body.dataset['textRegression'] = `${previous} -> ${current}`.slice(0, 500);
          }
          previous = current;
        }).observe(body, { childList: true, characterData: true, subtree: true });
      });
  }
}

async function readSource(page: Page) {
  const response = await page.request.get(new URL('/studio/api/file?file=src/pages/index.astro', page.url()).href);
  assert.ok(response.ok(), 'Read the shared draft source');
  const data: unknown = await response.json();
  return string(record(data)['source']);
}

function report(operation: string, started: number) {
  console.log(JSON.stringify({ operation, actionToBothObservedMs: performance.now() - started }));
}
