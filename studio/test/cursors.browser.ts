// Goal: verify collaborative cursors and chat from the account menu and keyboard.
// Method: use two live browser sessions to check messages, focus and frame replacement.
import { chromium, type Page, type FrameLocator } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';

const browser = await chromium.launch({
  executablePath:
    process.env['CHROME_PATH'] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
const firstContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const secondContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await firstContext.addInitScript(() => sessionStorage.setItem('studio-name', 'Alice'));
await secondContext.addInitScript(() => sessionStorage.setItem('studio-name', 'Bob'));
const first = await firstContext.newPage();
const second = await secondContext.newPage();
const errors: string[] = [];
for (const page of [first, second]) {
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => errors.push(error.message));
}
const url = process.env['STUDIO_URL'] ?? 'http://localhost:4360/studio';
try {
  await Promise.all([first.goto(url), second.goto(url)]);
  for (const page of [first, second]) {
    await page.locator('.save-state').filter({ hasText: 'Saved' }).waitFor();
    await page.frameLocator('iframe[title="Site preview"]').locator('h1').waitFor();
    await page.getByRole('button', { name: 'Expand all', exact: true }).click();
  }
  await row(first, 'Heading').click();
  await row(second, 'Eyebrow').click();
  const preview = first.frameLocator('iframe[title="Site preview"]');
  const otherPreview = second.frameLocator('iframe[title="Site preview"]');
  const heading = preview.locator('h1');
  const remote = otherPreview.locator('.collaborator-cursor[data-peer="Alice"]');
  const source = await first.locator('.rich-content').innerText();
  await replacePreviewFrame(first);
  await replacePreviewFrame(second);
  await heading.hover({ position: { x: 30, y: 10 } });
  await remote.waitFor({ state: 'visible' });
  assert.equal(await remote.locator('.cursor-name').innerText(), 'Alice');
  const remoteColor = await remote.evaluate((node) => getComputedStyle(node).color);
  const outline = second.locator('.collaborator-outline[data-peer="Alice"]');
  await outline.waitFor();
  assert.equal(await outline.evaluate((node) => getComputedStyle(node).outlineColor), remoteColor);
  assert.notEqual(
    await first
      .locator('.node-outline.sel')
      .first()
      .evaluate((node) => getComputedStyle(node).outlineColor),
    remoteColor,
  );
  const initial = await remote.getAttribute('style');
  await heading.hover({ position: { x: 100, y: 20 } });
  await remote.evaluate(
    (node, initialStyle) =>
      new Promise<void>((resolve) => {
        const observer = new MutationObserver(() => {
          if (node.getAttribute('style') !== initialStyle) {
            observer.disconnect();
            resolve();
          }
        });
        if (node.getAttribute('style') !== initialStyle) {
          resolve();
        } else {
          observer.observe(node, { attributes: true });
        }
      }),
    initial,
  );
  await heading.press('/');
  const input = preview.getByRole('textbox', { name: 'Cursor message' });
  await input.waitFor({ state: 'visible' });
  await checkMessageWrapping(first, preview);
  await input.fill('Can we try');
  await remote
    .locator('.cursor-text')
    .filter({ hasText: /^Can we try$/ })
    .waitFor();
  await input.fill('Can we try a larger heading?');
  await remote
    .locator('.cursor-text')
    .filter({ hasText: /^Can we try a larger heading\?$/ })
    .waitFor();
  const editorPosition = await input.boundingBox();
  assert.ok(editorPosition);
  await heading.hover({ position: { x: 180, y: 30 } });
  const movedEditor = await input.boundingBox();
  assert.ok(movedEditor);
  assert.ok(movedEditor.x > editorPosition.x + 40, 'Typing bubble follows the pointer');
  await input.press('Enter');
  await input.waitFor({ state: 'hidden' });
  await remote.locator('.cursor-text').filter({ hasText: 'larger heading' }).waitFor();
  const local = preview.locator('.local-cursor');
  await local.waitFor({ state: 'visible' });
  const localPosition = await local.getAttribute('style');
  await heading.hover({ position: { x: 260, y: 40 } });
  assert.notEqual(await local.getAttribute('style'), localPosition);
  await first.clock.install();
  await first.clock.fastForward(20000);
  await local.waitFor({ state: 'visible' });
  assert.equal(await local.locator('.cursor-text').innerText(), 'Can we try a larger heading?');
  await remote.locator('.cursor-text').filter({ hasText: 'larger heading' }).waitFor();
  await first.clock.resume();
  await mkdir('test-results', { recursive: true });
  await second.screenshot({ path: 'test-results/cursors.png' });
  await first.getByLabel('Stacki account menu', { exact: true }).click();
  await first.getByRole('button', { name: 'Cursor chat', exact: true }).click();
  await input.waitFor({ state: 'visible' });
  assert.equal(await input.inputValue(), 'Can we try a larger heading?');
  await input.fill('Keep this');
  await input.press('Escape');
  await input.waitFor({ state: 'hidden' });
  await remote
    .locator('.cursor-text')
    .filter({ hasText: /^Keep this$/ })
    .waitFor();
  await first.mouse.move(15, 15);
  await remote.waitFor({ state: 'detached' });
  await heading.hover();
  await remote
    .locator('.cursor-text')
    .filter({ hasText: /^Keep this$/ })
    .waitFor();
  await replacePreviewFrame(first);
  await heading.hover();
  await local.waitFor({ state: 'visible' });
  assert.equal(await local.locator('.cursor-text').innerText(), 'Keep this');
  await heading.press('Backspace');
  await input.waitFor({ state: 'visible' });
  assert.equal(await input.inputValue(), 'Keep thi');
  await input.selectText();
  await first.keyboard.down('Backspace');
  await input.waitFor({ state: 'hidden' });
  await first.keyboard.down('Backspace');
  await first.keyboard.up('Backspace');
  await local.waitFor({ state: 'hidden' });
  await remote.locator('.cursor-text').filter({ hasText: /^$/ }).waitFor({ state: 'attached' });
  assert.equal(await first.locator('.rich-content').innerText(), source);
  await otherPreview.locator('h1').hover();
  const bob = preview.locator('.collaborator-cursor[data-peer="Bob"]');
  await bob.waitFor({ state: 'visible' });
  assert.notEqual(await bob.evaluate((node) => getComputedStyle(node).color), remoteColor);
  await first.mouse.move(15, 15);
  await remote.waitFor({ state: 'detached' });
  await heading.hover();
  await remote.waitFor({ state: 'visible' });
  await firstContext.close();
  await remote.waitFor({ state: 'detached' });
  assert.deepEqual(errors, []);
  console.log(
    'Live cursors, matching colors, persistent pointer chat, frame replacement, Backspace erasure, source preservation, and disconnect passed.',
  );
} catch (error) {
  await mkdir('test-results', { recursive: true });
  await first.screenshot({ path: 'test-results/cursors-failure-first.png' }).catch(() => {});
  await second.screenshot({ path: 'test-results/cursors-failure-second.png' }).catch(() => {});
  throw error;
} finally {
  await browser.close();
}

function row(page: Page, name: string) {
  return page.locator('.structure-node').filter({
    has: page.locator('.label').filter({ hasText: new RegExp(`^${name}$`) }),
  });
}

async function replacePreviewFrame(page: Page) {
  await page.getByTitle('Canvas — all breakpoints — 4', { exact: true }).click();
  await page.getByTitle('Desktop — 1', { exact: true }).click();
  const preview = page.frameLocator('iframe[title="Site preview"]');
  await preview.locator('#studio-live-cursors').waitFor({ state: 'attached' });
  await page.getByLabel('Stacki account menu', { exact: true }).click();
  await page.getByRole('button', { name: 'Cursor chat', exact: true }).click();
  const input = preview.getByRole('textbox', { name: 'Cursor message' });
  await input.waitFor({ state: 'visible' });
  await input.press('Escape');
}

async function checkMessageWrapping(page: Page, preview: FrameLocator) {
  const input = preview.getByRole('textbox', { name: 'Cursor message' });
  for (const message of [
    'Inviting some more people in here to test this. This message should wrap onto new lines and look exactly the same while typing and after submitting.',
    'abcdefghijklmnop'.repeat(10),
  ]) {
    await input.fill(message);
    const metrics = await input.evaluate((node) => ({
      height: node.clientHeight,
      lineHeight: Number.parseFloat(getComputedStyle(node).lineHeight),
      horizontalOverflow: node.scrollWidth - node.clientWidth,
      verticalOverflow: node.scrollHeight - node.clientHeight,
      border: getComputedStyle(node).borderWidth,
    }));
    assert.equal(metrics.border, '0px');
    assert.ok(metrics.height > metrics.lineHeight * 2, 'Long messages wrap while typing');
    assert.ok(metrics.horizontalOverflow <= 1, 'No horizontal overflow');
    assert.ok(metrics.verticalOverflow <= 1, 'Textarea grows to show the full message');
    const editing = await preview.locator('.cursor-editor .cursor-text').boundingBox();
    assert.ok(editing);
    await mkdir('test-results', { recursive: true });
    await page.screenshot({ path: 'test-results/cursor-chat-editing.png' });
    await input.press('Enter');
    const bubble = preview.locator('.local-cursor .cursor-text');
    await bubble.waitFor();
    assert.equal(await bubble.innerText(), message);
    const submitted = await bubble.boundingBox();
    assert.ok(submitted);
    for (const dimension of ['x', 'y', 'width', 'height'] as const) {
      assert.ok(
        Math.abs(editing[dimension] - submitted[dimension]) < 1,
        `Same ${dimension} before and after submission`,
      );
    }
    await page.keyboard.press('/');
    await input.waitFor();
  }
}
