// Goal: canvas typing preserves authored spans in Desktop and Studio through real saves.
// Method: edit disposable Astro projects with native pointer/keyboard actions and check
// source bytes, shared declarations, split wrappers, refusal and explicit span deletion.
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Page, type FrameLocator } from 'playwright';
import { startDesktopFixture } from './desktopFixture';
import { startStyleFixture } from './stylePanelFixture';

const source = `---
const heading = "Shared heading";
---
<html><head><title>Canvas text test</title></head><body>
<main><h1>Hello <span class="accent">world</span> again</h1>
<h2>{heading}</h2><p id="split">Animated words</p><p id="changed">Original words</p>
</main></body></html>`;
if (process.env['CANVAS_TEXT_HOST'] !== 'studio') {
  const desktop = await startDesktopFixture(source);
  await prepareContent(desktop.project);
  try {
    const page = await desktop.application.firstWindow({ timeout: 30_000 });
    page.setDefaultTimeout(15_000);
    await page.getByText('Open from folder', { exact: true }).click();
    await checkTextEditing(page, desktop.project);
    console.log('Desktop canvas text interactions passed.');
  } finally {
    await desktop.stop();
  }
}
const studio = await startStyleFixture({ page: source, prepare: prepareContent });
const browser = await chromium.launch({
  executablePath: process.env['CHROME_PATH'] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(15_000);
  await page.goto(studio.url);
  page.on('pageerror', (error) => console.error('Studio browser error:', error.message));
  await checkTextEditing(page, studio.root);
  console.log('Studio canvas text interactions passed.');
} finally {
  await browser.close();
  await studio.stop();
}
async function checkTextEditing(page: Page, root: string) {
  const frame = page.frameLocator('iframe').first();
  await frame.locator('h1').waitFor();
  const settings = page.getByRole('button', { name: 'Settings', exact: true });
  await settings.first().click();
  const sourceFile = path.join(root, 'src/pages/index.astro');
  await checkFocusAndDismiss(page, frame, sourceFile);
  await checkSingleClickSelection(page, frame, sourceFile);
  await checkCaretPlacement(page, frame);
  await checkWhitespace(page, frame);
  await openText(frame, 'h1');
  await replaceText(page, frame, 'Welcome ');
  await checkContentField(page, 'Welcome world again');
  await frame.locator('[data-avb-text-editor]').press('Enter');
  await frame.locator('h1').filter({ hasText: 'Welcome world again' }).waitFor();
  assert.match(await savedText(sourceFile, 'Welcome'), /Welcome <span class="accent">world<\/span>/);
  await frame.locator('h1 span').click();
  assert.equal(await frame.locator('[data-avb-text-editor]').count(), 0);
  await openText(frame, 'h1 span');
  await replaceText(page, frame, 'friends');
  await checkContentField(page, 'friends');
  await frame.locator('[data-avb-text-editor]').press('Enter');
  await frame.locator('h1 span').filter({ hasText: 'friends' }).waitFor();
  assert.match(await savedText(sourceFile, 'friends'), /<span class="accent">friends<\/span>/);
  await openText(frame, 'h2');
  const shared = frame.locator('[data-avb-text-editor]');
  await replaceText(page, frame, 'Updated shared heading');
  await checkContentField(page, 'Updated shared heading');
  assert.equal(await page.locator('.rich-content .expr-chip').getAttribute('data-expr'), '{heading}');
  await shared.press('Enter');
  await frame.locator('h2').filter({ hasText: 'Updated shared heading' }).waitFor();
  const saved = await savedText(sourceFile, 'Updated shared heading');
  assert.match(saved, /const heading = "Updated shared heading"/);
  assert.match(saved, /<h2>\{heading\}<\/h2>/);
  await checkContentText(page, frame, root);
  await checkSlotText(page, frame, sourceFile);
  await checkWrappedSlots(page, frame, sourceFile);
  await checkRuntimeMarkup(page, frame, sourceFile);
  await frame.locator('h1 span').click();
  await page.locator('.node-outline.sel').filter({ hasText: 'accent' }).waitFor();
  await page.keyboard.press('Delete');
  await frame.locator('h1 span').waitFor({ state: 'detached' });
  assert.doesNotMatch(await savedText(sourceFile, '<h1>Welcome  again</h1>'), /class="accent"/);
}
async function checkRuntimeMarkup(page: Page, frame: FrameLocator, sourceFile: string) {
  await frame.locator('#split').evaluate((element) => {
    element.replaceChildren(
      ...['Animated ', 'words'].map((text) => {
        const span = document.createElement('span');
        span.textContent = text;
        return span;
      }),
    );
  });
  await openText(frame, '#split span');
  await replaceText(page, frame, 'Animation edited');
  await frame.locator('[data-avb-text-editor]').press('Enter');
  await frame.locator('#split').filter({ hasText: 'Animation edited' }).waitFor();
  assert.match(await savedText(sourceFile, 'Animation edited'), /<p id="split">Animation edited<\/p>/);
  const before = await readFile(sourceFile, 'utf8');
  await frame.locator('#changed').evaluate((element) => {
    element.textContent = 'Runtime changed';
  });
  await frame.locator('#changed').dblclick({ position: { x: 4, y: 8 } });
  assert.equal(await frame.locator('[data-avb-text-editor]').count(), 0);
  assert.equal(await readFile(sourceFile, 'utf8'), before);
}
async function checkSingleClickSelection(page: Page, frame: FrameLocator, sourceFile: string) {
  const before = await readFile(sourceFile, 'utf8');
  for (const [selector, value] of [
    ['h1', 'Hello world again'],
    ['h1 span', 'world'],
    ['#slot', 'Slot protected'],
    ['#eyebrow', 'Eyebrow label'],
    ['#button-text', 'Button label'],
  ]) {
    assert.ok(selector);
    assert.ok(value);
    await frame.locator(selector).click({ position: { x: 4, y: 8 } });
    await checkContentField(page, value);
    assert.equal(await frame.locator('[data-avb-text-editor]').count(), 0);
  }
  // Leaving one text editor for another text element must return to selection,
  // rather than immediately making the second element editable.
  await openText(frame, 'h1');
  await frame.locator('[data-avb-text-editor]').press('Meta+a');
  await frame.locator('#button-text').click();
  await checkContentField(page, 'Button label');
  assert.equal(await frame.locator('[data-avb-text-editor]').count(), 0);
  assert.equal(await frame.locator('html').evaluate(() => window.getSelection()?.toString()), '');
  assert.equal(await readFile(sourceFile, 'utf8'), before);
}

async function openText(frame: FrameLocator, selector: string) {
  // Source stamps arrive after first paint; retry the user action while they settle.
  for (let attempt = 0; attempt < 60; attempt++) {
    await frame
      .locator(selector)
      .first()
      .dblclick({ position: { x: 4, y: 8 } });
    // Opening crosses a postMessage boundary. Wait for it before retrying a
    // click, which would otherwise blur the field we just opened.
    const opened = await frame
      .locator('[data-avb-text-editor]')
      .waitFor({
        state: 'attached',
        timeout: 500,
      })
      .then(
        () => true,
        () => false,
      );
    if (opened) {
      return;
    }
  }
  throw new Error(`Canvas text did not become editable: ${selector}`);
}

async function savedText(file: string, expected: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const source = await readFile(file, 'utf8');
    if (source.includes(expected)) {
      return source;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Saved source did not include ${expected}`);
}

async function checkFocusAndDismiss(page: Page, frame: FrameLocator, sourceFile: string) {
  // Warm up the marker map before comparing the complete page, including its root.
  await openText(frame, 'h1');
  await frame.locator('[data-avb-text-editor]').press('Escape');
  const before = await frame.locator('html').evaluate((element) => element.outerHTML);
  const sourceBefore = await readFile(sourceFile, 'utf8');
  const appearance = await textAppearance(frame);
  await openText(frame, 'h1');
  assert.deepEqual(await textAppearance(frame), appearance);
  const during = await frame.locator('html').evaluate((element) => {
    const copy = element.cloneNode(true);
    if (!(copy instanceof Element)) {
      throw new Error('Expected cloned document element');
    }
    for (const editor of copy.querySelectorAll('[data-avb-text-editor]')) {
      editor.removeAttribute('contenteditable');
      editor.removeAttribute('data-avb-text-editor');
    }
    return copy.outerHTML;
  });
  assert.equal(during, before);
  assert.equal(await page.locator('.canvas-text-caret').count(), 0);
  assert.equal(await frame.locator('[data-avb-text-editor]').evaluate((element) => getComputedStyle(element).outlineStyle), 'none');
  await frame.locator('#outside').click();
  await frame.locator('[data-avb-text-editor]').waitFor({ state: 'detached' });
  assert.equal(await frame.locator('html').evaluate(() => window.getSelection()?.toString()), '');
  await page.locator('.node-outline.sel').filter({ hasText: 'outside' }).waitFor();
  assert.equal(await readFile(sourceFile, 'utf8'), sourceBefore);
  await openText(frame, 'h1');
  await replaceText(page, frame, 'Discard this');
  await page.keyboard.press('Escape');
  await frame.locator('h1').filter({ hasText: 'Hello world again' }).waitFor();
  assert.equal(await frame.locator('html').evaluate((element) => element.outerHTML), before);
  assert.equal(await readFile(sourceFile, 'utf8'), sourceBefore);
}

async function textAppearance(frame: FrameLocator, selector = 'h1') {
  return frame.locator(selector).evaluate((element) => {
    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    return {
      whiteSpace: style.whiteSpace,
      font: style.font,
      color: style.color,
      letterSpacing: style.letterSpacing,
      lineHeight: style.lineHeight,
      textTransform: style.textTransform,
      width: box.width,
      height: box.height,
      x: box.x,
      y: box.y,
    };
  });
}

async function checkWhitespace(page: Page, frame: FrameLocator) {
  const before = await textAppearance(frame, '#whitespace');
  await frame.locator('#whitespace').dblclick();
  await frame.locator('[data-avb-text-editor]').waitFor();
  assert.deepEqual(await textAppearance(frame, '#whitespace'), before);
  await page.keyboard.press('Escape');
}

async function replaceText(page: Page, frame: FrameLocator, value: string) {
  await frame.locator('[data-avb-text-editor]').press('Meta+a');
  await page.keyboard.insertText(value);
}

async function checkCaretPlacement(page: Page, frame: FrameLocator) {
  await openText(frame, 'h1');
  const point = await frame.locator('h1').evaluate((element) => {
    const text = element.firstChild;
    if (!(text instanceof Text)) {
      throw new Error('Expected heading text');
    }
    const range = document.createRange();
    range.setStart(text, 2);
    range.setEnd(text, 3);
    const box = range.getBoundingClientRect();
    const root = element.getBoundingClientRect();
    return { x: box.x - root.x + 1, y: box.y - root.y + box.height / 2 };
  });
  await frame.locator('h1').click({ position: point });
  const offset = await frame.locator('h1').evaluate(() => window.getSelection()?.anchorOffset);
  assert.equal(offset, 2);
  await page.keyboard.insertText('X');
  await checkContentField(page, 'HeXllo world again');
  assert.equal(await frame.locator('h1').textContent(), 'HeXllo world again');
  await page.keyboard.press('Meta+z');
  await checkContentField(page, 'Hello world again');
  assert.equal(await frame.locator('h1').textContent(), 'Hello world again');
  await page.keyboard.press('Meta+Shift+z');
  await checkContentField(page, 'HeXllo world again');
  assert.equal(await frame.locator('h1').textContent(), 'HeXllo world again');
  await page.keyboard.press('Meta+a');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Delete');
  assert.equal(await frame.locator('h1 span').textContent(), 'world');
  // A selection crossing an authored span must not turn into a destructive edit.
  await frame.locator('h1').evaluate((element) => {
    const first = element.firstChild;
    const child = element.querySelector('span')?.firstChild;
    if (!first || !child) {
      throw new Error('Expected protected text fixture');
    }
    const range = document.createRange();
    range.setStart(first, 0);
    range.setEnd(child, 3);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
  });
  await page.keyboard.insertText('Must not replace the span');
  await page.keyboard.press('Backspace');
  assert.equal(await frame.locator('h1').textContent(), 'HeXllo world again');
  await page.keyboard.press('Escape');
  await frame.locator('h1').filter({ hasText: 'Hello world again' }).waitFor();
  await checkContentField(page, 'Hello world again');
}

async function checkContentField(page: Page, value: string) {
  // The canvas still owns focus here: no Enter, blur, save or source refresh
  // is allowed to make an otherwise stale Content field pass this assertion.
  await page.waitForFunction((expected) => document.querySelector('.rich-content')?.textContent === expected, value);
}

async function prepareSlotComponents(root: string) {
  const directory = path.join(root, 'src/components');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'Heading.astro'), '<h3 id="slot"><slot /></h3>');
  // Match components that render slots as HTML after removing comments, including markers.
  const frontmatter = `---
const content = (await Astro.slots.render('default')).replace(/<!--[\\s\\S]*?-->/g, '').trim();
const Tag = 'p';
---\n`;
  await writeFile(
    path.join(directory, 'Eyebrow.astro'),
    frontmatter + '<div class="eyebrow_wrap"><span aria-hidden="true" />' + '<Tag id="eyebrow"><Fragment set:html={content} /></Tag></div>',
  );
  await writeFile(
    path.join(directory, 'Button.astro'),
    frontmatter +
      '<a href={Astro.props.href}><span class="button_element">' +
      '<span id="button-text" set:html={content} /><svg aria-hidden="true" /></span></a>',
  );
}

async function checkWrappedSlots(page: Page, frame: FrameLocator, sourceFile: string) {
  for (const [selector, text] of [
    ['#eyebrow', 'Eyebrow edited'],
    ['#button-text', 'Button edited'],
  ]) {
    assert.ok(selector);
    assert.ok(text);
    await openText(frame, selector);
    await replaceText(page, frame, text);
    await checkContentField(page, text);
    await frame.locator('[data-avb-text-editor]').press('Meta+a');
    // Clicking a different element must save and select it in the same gesture.
    await frame.locator('#outside').click();
    await frame.locator('[data-avb-text-editor]').waitFor({ state: 'detached' });
    assert.equal(await frame.locator('html').evaluate(() => window.getSelection()?.toString()), '');
    await frame.locator(selector).filter({ hasText: text }).waitFor();
    await savedText(sourceFile, text);
  }
  assert.match(await readFile(sourceFile, 'utf8'), /<Button href="\/destination">Button edited<\/Button>/);
}

async function prepareContent(root: string) {
  await prepareSlotComponents(root);
  await mkdir(path.join(root, 'src/content/blog'), { recursive: true });
  await writeFile(path.join(root, 'src/content/blog/hello.json'), '{"title":"CMS title"}');
  await writeFile(
    path.join(root, 'src/content.config.ts'),
    `import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';
export const collections = { blog: defineCollection({
  loader: glob({ pattern: '*.json', base: './src/content/blog' }),
  schema: z.object({ title: z.string() }),
}) };`,
  );
  await writeFile(
    path.join(root, 'src/pages/index.astro'),
    source
      .replace(
        'const heading',
        `import Heading from '../components/Heading.astro';
import Eyebrow from '../components/Eyebrow.astro';
import Button from '../components/Button.astro';
import { getEntry } from 'astro:content';
const post = await getEntry('blog', 'hello');
const heading`,
      )
      .replace(
        '</main>',
        '<p id="cms">{post.data.title}</p><Heading>Slot <span>protected</span></Heading>' +
          '<Eyebrow>Eyebrow label</Eyebrow><Button href="/destination">Button label</Button>' +
          '<p id="whitespace" style="font-size:32px;width:200px;text-align:center">\n    Native whitespace\n    should stay collapsed.\n</p>' +
          '<div id="outside" class="outside" style="width:80px;height:30px;background:red"></div></main>',
      ),
  );
}
async function checkSlotText(page: Page, frame: FrameLocator, sourceFile: string) {
  await openText(frame, '#slot');
  const input = frame.locator('[data-avb-text-editor]');
  await replaceText(page, frame, 'Edited slot ');
  await checkContentField(page, 'Edited slot protected');
  await input.press('Enter');
  await frame.locator('#slot').filter({ hasText: 'Edited slot protected' }).waitFor();
  assert.match(await savedText(sourceFile, 'Edited slot'), /<Heading>Edited slot <span>protected<\/span><\/Heading>/);
  await frame.locator('#slot span').click();
  assert.equal(await frame.locator('[data-avb-text-editor]').count(), 0);
}
async function checkContentText(page: Page, frame: FrameLocator, root: string) {
  await openText(frame, '#cms');
  const input = frame.locator('[data-avb-text-editor]');
  await replaceText(page, frame, 'Updated CMS title');
  await checkContentField(page, 'Updated CMS title');
  assert.equal(await page.locator('.rich-content .expr-chip').getAttribute('data-expr'), '{post.data.title}');
  await input.press('Enter');
  await savedText(path.join(root, 'src/content/blog/hello.json'), 'Updated CMS title');
  await frame.locator('#cms').filter({ hasText: 'Updated CMS title' }).waitFor();
  const pageSource = await readFile(path.join(root, 'src/pages/index.astro'), 'utf8');
  assert.match(pageSource, /\{post.data.title\}/);
  await openText(frame, '#cms');
  await replaceText(page, frame, 'CMS title edited twice');
  await input.press('Enter');
  await savedText(path.join(root, 'src/content/blog/hello.json'), 'CMS title edited twice');
  await frame.locator('#cms').filter({ hasText: 'CMS title edited twice' }).waitFor();
}
