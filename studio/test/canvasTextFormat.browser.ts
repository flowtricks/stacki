// Goal: words selected on Studio's canvas get Desktop's format bar, in a plain element and in
// text a component instance shows from its slot, and each press writes the Content field's
// markup around exactly the selected words in the page source.
// Method: a disposable Astro project with a plain heading, a paragraph and two slot
// components (one printing <slot />, one printing the slot as HTML, as the marketing site's
// Heading does). Each text is opened with a native double-click, a word is selected with a
// DOM range, the bar must appear, and a press must save. Bold → <strong>, italic → <em>,
// inline code → <code> and link → <a href> are checked against the saved source bytes, which
// must change only around the selected words. Then words already inside <strong> and <em> are
// selected from an editor opened on the plain words beside them: the bar must appear with Bold
// or Italic lit, and pressing it must take the markup off again, the only way to unbold on the
// canvas.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type FrameLocator, type Page } from 'playwright';
import { startStyleFixture } from './stylePanelFixture';

const source = `---
import Heading from '../components/Heading.astro';
import Title from '../components/Title.astro';
---
<html><head><title>Canvas format test</title></head><body>
<main>
<h1 id="plain">Edit Astro sites visually</h1>
<p id="para">Plain paragraph words here</p>
<Heading>Slot words go here</Heading>
<Title>Edit Astro sites visually</Title>
<div id="outside" style="width:80px;height:30px;background:red"></div>
</main></body></html>`;

const studio = await startStyleFixture({ page: source, prepare: prepareComponents });
const browser = await chromium.launch({
  executablePath: process.env['CHROME_PATH'] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(15_000);
  page.on('pageerror', (error) => console.error('Studio browser error:', error.message));
  await page.goto(studio.url);
  const frame = page.frameLocator('iframe').first();
  await frame.locator('#plain').waitFor();
  const file = path.join(studio.root, 'src/pages/index.astro');
  await format(page, frame, { selector: '#plain', word: 'visually', button: 'Bold', glide: true });
  await shown(frame, file, '#plain strong', /<h1 id="plain">Edit Astro sites <strong>visually<\/strong><\/h1>/);
  await format(page, frame, { selector: '#para', word: 'paragraph', button: 'Italic' });
  await shown(frame, file, '#para em', /<p id="para">Plain <em>paragraph<\/em> words here<\/p>/);
  await format(page, frame, { selector: '#slot', word: 'words', button: 'Code' });
  await shown(frame, file, '#slot code', /<Heading>Slot <code>words<\/code> go here<\/Heading>/);
  await format(page, frame, { selector: '#title', word: 'visually', button: 'Bold' });
  await shown(frame, file, '#title strong', /<Title>Edit Astro sites <strong>visually<\/strong><\/Title>/);
  await format(page, frame, { selector: '#title', word: 'Astro', button: 'Link', url: '/docs' });
  await shown(frame, file, '#title a[href="/docs"]', /<Title>Edit <a href="\/docs">Astro<\/a> sites <strong>visually<\/strong><\/Title>/);
  await format(page, frame, { selector: '#plain', word: 'visually', button: 'Bold', lit: 'Bold' });
  await removed(frame, file, '#plain strong', /<h1 id="plain">Edit Astro sites visually<\/h1>/);
  await format(page, frame, { selector: '#para', word: 'paragraph', button: 'Italic', lit: 'Italic' });
  await removed(frame, file, '#para em', /<p id="para">Plain paragraph words here<\/p>/);
  // Nothing outside the pressed words changed.
  const saved = await readFile(file, 'utf8');
  assert.equal(
    saved,
    source
      .replace('Slot words go', 'Slot <code>words</code> go')
      .replace('<Title>Edit Astro sites visually', '<Title>Edit <a href="/docs">Astro</a> sites <strong>visually</strong>'),
  );
  console.log('Studio canvas format bar passed.');
} finally {
  await browser.close();
  await studio.stop();
}

async function prepareComponents(root: string) {
  const directory = path.join(root, 'src/components');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'Heading.astro'), '<h3 id="slot"><slot /></h3>');
  // The slot rendered as HTML, as the marketing site's Heading component does.
  await writeFile(
    path.join(directory, 'Title.astro'),
    `---
const content = (await Astro.slots.render('default')).replace(/<!--[\\s\\S]*?-->/g, '').trim();
---
<h2 id="title"><Fragment set:html={content} /></h2>`,
  );
}

async function format(
  page: Page,
  frame: FrameLocator,
  press: { readonly selector: string; readonly word: string; readonly button: string; readonly url?: string; readonly lit?: string; readonly glide?: boolean },
) {
  const bubble = page.locator('.rich-bubble');
  await openText(frame, press.selector);
  await selectWord(frame, press.word);
  await bubble.waitFor();
  // The buttons lit are exactly the formats the words already sit in.
  const lit = await bubble.locator('button[aria-pressed="true"]').evaluateAll((buttons) => buttons.map((button) => button.getAttribute('title')));
  assert.deepEqual(lit, press.lit === undefined ? [] : [press.lit]);
  if (press.glide === true) {
    await glidesBetween(page, 'Italic', 'Code');
  }
  await bubble.locator(`button[title="${press.button}"]`).click();
  if (press.url !== undefined) {
    const field = bubble.locator('input');
    await field.fill(press.url);
    await field.press('Enter');
  }
  await bubble.waitFor({ state: 'detached' });
  await frame.locator('[data-avb-text-editor]').waitFor({ state: 'detached' });
}

// Selects one word of the open editor's text, as a drag across it would.
async function selectWord(frame: FrameLocator, word: string) {
  await frame.locator('[data-avb-text-editor]').evaluate((editor, wanted) => {
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent ?? '';
      const at = text.indexOf(wanted);
      if (at >= 0) {
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + wanted.length);
        window.getSelection()?.removeAllRanges();
        window.getSelection()?.addRange(range);
        return;
      }
    }
    throw new Error(`No text holds ${wanted}`);
  }, word);
}

async function openText(frame: FrameLocator, selector: string) {
  // Source stamps arrive after first paint; retry the user action while they settle.
  for (let attempt = 0; attempt < 60; attempt++) {
    await frame
      .locator(selector)
      .first()
      .dblclick({ position: { x: 4, y: 8 } });
    const opened = await frame
      .locator('[data-avb-text-editor]')
      .waitFor({ state: 'attached', timeout: 500 })
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

// The press is saved to the page source and the preview shows its markup, so the
// next press starts from a settled page.
async function shown(frame: FrameLocator, file: string, rendered: string, expected: RegExp) {
  await savedMatch(file, expected);
  await frame.locator(rendered).waitFor();
}

// The hover highlight is one element: it lands on the first hovered button,
// then slides to the next, ending exactly behind it.
async function glidesBetween(page: Page, first: string, second: string) {
  const bubble = page.locator('.rich-bubble');
  const glide = bubble.locator('.rich-format-glide');
  for (const title of [first, second]) {
    const button = bubble.locator(`button[title="${title}"]`);
    await button.hover();
    const target = await button.boundingBox();
    assert.ok(target);
    await page.waitForFunction(
      ({ x, width }) => {
        const box = document.querySelector('.rich-format-glide')?.getBoundingClientRect();
        return box !== undefined && Math.abs(box.x - x) < 0.5 && Math.abs(box.width - width) < 0.5;
      },
      { x: target.x, width: target.width },
    );
    assert.match((await glide.getAttribute('class')) ?? '', /\bshown\b/);
  }
  assert.match((await glide.getAttribute('class')) ?? '', /\bslide\b/, 'the second hover slides');
}

// A press that took markup off: saved, and the preview no longer shows it.
async function removed(frame: FrameLocator, file: string, gone: string, expected: RegExp) {
  await savedMatch(file, expected);
  await frame.locator(gone).waitFor({ state: 'detached' });
}

async function savedMatch(file: string, expected: RegExp) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const text = await readFile(file, 'utf8');
    if (expected.test(text)) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  assert.match(await readFile(file, 'utf8'), expected);
}
