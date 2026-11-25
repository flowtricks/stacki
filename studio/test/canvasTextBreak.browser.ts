// Goal: a drag selection in canvas text survives mouse up when it crosses a <br> or an inline
// child. Across a <br> it can be typed over; an inline child's words are never replaced.
// Method: drive real pointer and keyboard input against a disposable Astro project in
// Desktop and Studio, read the frame's selection, and check the saved source bytes.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type FrameLocator, type Page } from 'playwright';
import { startDesktopFixture } from './desktopFixture';
import { startStyleFixture } from './stylePanelFixture';

const source = `---
const heading = "Shared heading";
---
<html><head><title>Canvas text selection test</title></head><body>
<main><h1 id="hero">Messaging with<br class="hero_break" />
  actual wings.</h1>
<h2 id="undo">First line<br />Second line</h2>
<h3 id="reverse">Top words<br />Bottom words</h3>
<h4 id="single">Top words<br />Lower words</h4>
<p id="strong">Hello <strong>bold words</strong> again</p>
<p id="span">Start <span class="accent">middle</span> finish</p>
<p id="bound">Plain <b>{heading}</b> tail</p>
<p id="outside">Outside text</p>
</main></body></html>`;

if (process.env['CANVAS_TEXT_HOST'] !== 'studio') {
  const desktop = await startDesktopFixture(source);
  try {
    const page = await desktop.application.firstWindow({ timeout: 30_000 });
    page.setDefaultTimeout(15_000);
    await page.getByText('Open from folder', { exact: true }).click();
    await checkSelections(page, desktop.project);
    console.log('Desktop canvas text selections passed.');
  } finally {
    await desktop.stop();
  }
}
if (process.env['CANVAS_TEXT_HOST'] !== 'desktop') {
  const studio = await startStyleFixture({ page: source });
  const browser = await chromium.launch({
    executablePath: process.env['CHROME_PATH'] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(15_000);
    page.on('pageerror', (error) => console.error('Studio browser error:', error.message));
    await page.goto(studio.url);
    await checkSelections(page, studio.root);
    console.log('Studio canvas text selections passed.');
  } finally {
    await browser.close();
    await studio.stop();
  }
}

async function checkSelections(page: Page, root: string) {
  const frame = page.frameLocator('iframe').first();
  await frame.locator('#hero').waitFor();
  await checkDragSurvives(page, frame);
  await checkSourceEdits(page, frame, path.join(root, 'src/pages/index.astro'));
}

// Every direction across the break, in an editor opened on either run.
async function checkDragSurvives(page: Page, frame: FrameLocator) {
  const upper = { text: 0, offset: 10 };
  const lower = { text: 2, offset: 6 };
  const { x, y } = await offsetIn(frame, '#hero', lower);
  const lowerRun = { x, y };
  for (const [opened, from, to] of [
    [{ x: 4, y: 8 }, upper, lower],
    [{ x: 4, y: 8 }, lower, upper],
    [lowerRun, upper, lower],
    [lowerRun, lower, upper],
  ] as const) {
    await openText(frame, '#hero', opened);
    await drag(page, frame, '#hero', from, to);
    assert.match(await selectedText(frame), /^with\s+actual$/);
    assert.equal(await frame.locator('[data-avb-text-editor]').count(), 1, 'the editor stays open');
    await page.keyboard.press('Escape');
  }
  // A drag released beyond the words, and one out of an inline child.
  await openText(frame, '#hero');
  const start = await pagePoint(frame, '#hero', upper);
  const outside = await frame.locator('#outside').boundingBox();
  assert.ok(outside, 'The paragraph is on screen');
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(outside.x + 200, outside.y + 40, { steps: 6 });
  await page.mouse.up();
  assert.equal(await frame.locator('[data-avb-text-editor]').count(), 1, 'a release outside keeps the editor');
  assert.notEqual(await selectedText(frame), '');
  await page.keyboard.press('Escape');
  // Selecting within one run, a plain click and a click away behave as they always did.
  await openText(frame, '#hero');
  await drag(page, frame, '#hero', { text: 0, offset: 0 }, { text: 0, offset: 9 });
  assert.equal(await selectedText(frame), 'Messaging');
  const caret = await pagePoint(frame, '#hero', { text: 0, offset: 3 });
  await page.mouse.click(caret.x, caret.y);
  assert.equal(await selectedText(frame), '');
  assert.equal(await frame.locator('[data-avb-text-editor]').count(), 1, 'a click in the words keeps the editor');
  await frame.locator('#outside').click();
  await frame.locator('[data-avb-text-editor]').waitFor({ state: 'detached' });
  assert.equal(await selectedText(frame), '');
}

async function checkSourceEdits(page: Page, frame: FrameLocator, file: string) {
  const original = await readFile(file, 'utf8');
  // Typing over the selection, with the words either side and the <br> kept.
  await openText(frame, '#hero');
  await drag(page, frame, '#hero', { text: 0, offset: 10 }, { text: 2, offset: 6 });
  await page.keyboard.insertText('real');
  assert.equal(await frame.locator('#hero br').count(), 1);
  await page.keyboard.press('Enter');
  let saved = await savedText(file, 'Messaging real<br class="hero_break" />');
  assert.match(saved, /Messaging real<br class="hero_break" \/> wings\.<\/h1>/);
  assert.equal(saved.replace(/<h1 id="hero">[^]*?<\/h1>/, ''), original.replace(/<h1 id="hero">[^]*?<\/h1>/, ''), 'nothing else moved');
  await settled(frame, '#hero', 'Messaging real');
  // Deleting, dragging upwards.
  await openText(frame, '#reverse');
  await drag(page, frame, '#reverse', { text: 2, offset: 6 }, { text: 0, offset: 3 });
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Enter');
  // The run's edge space goes, as for any edit: its source began with no space.
  saved = await savedText(file, '<h3 id="reverse">Top<br />words</h3>');
  await settled(frame, '#reverse', 'Top');
  // Undo inside the editor brings both runs back, so nothing is saved.
  const undone = saved;
  await openText(frame, '#undo');
  await drag(page, frame, '#undo', { text: 0, offset: 6 }, { text: 2, offset: 6 });
  await page.keyboard.insertText('x');
  await page.keyboard.press('Meta+z');
  assert.equal(await frame.locator('#undo').evaluate((element) => element.textContent), 'First lineSecond line');
  await page.keyboard.press('Enter');
  await new Promise<void>((resolve) => setTimeout(resolve, 300));
  assert.equal(await readFile(file, 'utf8'), undone);
  // A caret's Delete stops at the break instead of eating the next run.
  await openText(frame, '#single');
  await page.keyboard.press('Meta+a');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Delete');
  assert.equal(await frame.locator('#single').textContent(), 'Top wordsLower words');
  await page.keyboard.press('Escape');
  // Copying leaves the source and the editor as they were.
  await openText(frame, '#single');
  await drag(page, frame, '#single', { text: 0, offset: 4 }, { text: 2, offset: 5 });
  const copied = await frame.locator('html').evaluate(
    () =>
      new Promise<string>((resolve) => {
        document.addEventListener('copy', () => resolve(window.getSelection()?.toString() ?? ''), { once: true });
        document.execCommand('copy');
      }),
  );
  assert.match(copied, /^words\s+Lower$/);
  assert.equal(await frame.locator('[data-avb-text-editor]').count(), 1);
  await page.keyboard.press('Escape');
  assert.equal(await readFile(file, 'utf8'), undone);
  // Across an inline child: the selection stands, and its words are not replaced.
  await openText(frame, '#span');
  await drag(page, frame, '#span', { text: 0, offset: 2 }, { text: 2, offset: 3 });
  assert.equal(await frame.locator('[data-avb-text-editor]').count(), 1);
  assert.match(await selectedText(frame), /^art middle fin$/);
  await page.keyboard.insertText('-');
  await page.keyboard.press('Backspace');
  assert.equal(await frame.locator('#span').textContent(), 'Start middle finish');
  await page.keyboard.press('Escape');
  assert.equal(await readFile(file, 'utf8'), undone);
  // A drag past a <strong> stays selected too.
  await openText(frame, '#strong');
  await drag(page, frame, '#strong', { text: 0, offset: 2 }, { text: 2, offset: 3 });
  assert.equal(await frame.locator('[data-avb-text-editor]').count(), 1);
  await page.keyboard.press('Escape');
  // A shared value is never changed through a selection: typing over it is refused.
  const before = await readFile(file, 'utf8');
  await openText(frame, '#bound');
  await drag(page, frame, '#bound', { text: 0, offset: 2 }, { text: 2, offset: 2 });
  assert.equal(await frame.locator('[data-avb-text-editor]').count(), 1);
  await page.keyboard.insertText('z');
  assert.match((await frame.locator('#bound').textContent()) ?? '', /Shared heading/);
  await page.keyboard.press('Escape');
  assert.equal(await readFile(file, 'utf8'), before);
}

interface TextPoint {
  /** The child of the element that holds the words. */
  readonly text: number;
  readonly offset: number;
}

async function drag(page: Page, frame: FrameLocator, selector: string, from: TextPoint, to: TextPoint) {
  const start = await pagePoint(frame, selector, from);
  const end = await pagePoint(frame, selector, to);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move((start.x + end.x) / 2, (start.y + end.y) / 2, { steps: 4 });
  await page.mouse.move(end.x, end.y, { steps: 4 });
  await page.mouse.up();
}

// A character's middle in window pixels: the frame may be scaled into the canvas.
async function pagePoint(frame: FrameLocator, selector: string, point: TextPoint) {
  const inside = await offsetIn(frame, selector, point);
  const box = await frame.locator(selector).boundingBox();
  assert.ok(box, 'The text is on screen');
  return { x: box.x + inside.x * inside.scale(box.width), y: box.y + inside.y * inside.scale(box.width) };
}

async function offsetIn(frame: FrameLocator, selector: string, point: TextPoint) {
  const inside = await frame.locator(selector).evaluate((element, target) => {
    const text = element.childNodes[target.text];
    if (!(text instanceof Text)) {
      throw new Error('Expected a text child');
    }
    const range = document.createRange();
    const words = text.data.trimStart();
    const offset = text.data.length - words.length + target.offset;
    range.setStart(text, offset);
    range.setEnd(text, offset + 1);
    const box = range.getBoundingClientRect();
    const whole = element.getBoundingClientRect();
    return { x: box.x - whole.x, y: box.y + box.height / 2 - whole.y, width: whole.width };
  }, point);
  return { x: inside.x, y: inside.y, scale: (width: number) => width / inside.width };
}

async function selectedText(frame: FrameLocator) {
  return frame.locator('html').evaluate(() => window.getSelection()?.toString() ?? '');
}

async function openText(frame: FrameLocator, selector: string, position = { x: 4, y: 8 }) {
  // Source stamps arrive after first paint; retry the user action while they settle.
  for (let attempt = 0; attempt < 60; attempt++) {
    await frame.locator(selector).dblclick({ position });
    const opened = await frame
      .locator('[data-avb-text-editor]')
      .waitFor({ state: 'attached', timeout: 500 })
      .then(
        () => true,
        () => false,
      );
    if (opened) {
      // A press beside the double click that opened the editor must be its own click.
      await new Promise<void>((resolve) => setTimeout(resolve, 600));
      // The window losing focus closes an editor by design: open it again then.
      if ((await frame.locator('[data-avb-text-editor]').count()) === 1) {
        return;
      }
    }
  }
  throw new Error(`Canvas text did not become editable: ${selector}`);
}

// A save renders, then brings a new catalog, and a catalog closes any open
// editor: the next gesture waits for both.
async function settled(frame: FrameLocator, selector: string, words: string) {
  await frame.locator(selector).filter({ hasText: words }).waitFor();
  await new Promise<void>((resolve) => setTimeout(resolve, 750));
}

async function savedText(file: string, expected: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const text = await readFile(file, 'utf8');
    if (text.includes(expected)) {
      return text;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Saved source did not include ${expected}`);
}
