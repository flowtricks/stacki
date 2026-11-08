// Goal: in Studio, a bare text run converts to a tag from the canvas menu as it does in
// Desktop, the new element ends up selected, undo gives the bare text back, and left
// click and canvas text editing are unchanged by the menu reaching the run.
// Method: drive a real browser against a disposable Astro project, right-click the words
// on the canvas, and read the saved source bytes and the navigator's selected row.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Page } from 'playwright';
import { startStyleFixture } from './stylePanelFixture';

const CODE = '<code id="between">// npm install<br />import &#123; Pidgin &#125; from "x";<br /> to: "Dana",<br />&#125;);</code>';
const LINES = `<section id="lines"><b>bold</b>
  Second run
  <i>slanted</i></section>`;
const source = `<html><head><title>Text convert</title></head><body><main>${CODE}${LINES}</main></body></html>`;
const POLLS_MAX = 100;
const EDITOR_ATTEMPTS_MAX = 30;

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
  const file = path.join(studio.root, 'src/pages/index.astro');
  await page.frameLocator('iframe').first().locator('#between').waitFor();
  await checkLeftClickStillSelectsTheElement(page);
  await checkConvert(page, file, {
    selector: '#between',
    words: 'import',
    tag: 'span',
    expected: source.replace('import &#123; Pidgin &#125; from "x";', '<span>import &#123; Pidgin &#125; from "x";</span>'),
  });
  await checkConvert(page, file, { selector: '#lines', words: 'Second run', tag: 'div', expected: source.replace('Second run', '<div>Second run</div>') });
  await checkCanvasEditingStillOpens(page);
  console.log('Studio canvas text conversion passed.');
} finally {
  await browser.close();
  await studio.stop();
}

// The point in the page of the first character of a run, in the editor's coordinates.
async function wordsPoint(page: Page, selector: string, words: string) {
  const frame = page.frames().find((candidate) => candidate.parentFrame() !== null);
  assert.ok(frame, 'Studio has a preview frame');
  const inFrame = await frame.evaluate(
    ([host, wanted]) => {
      const walker = document.createTreeWalker(document.querySelector(host ?? '') ?? document.body, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const at = node.textContent?.indexOf(wanted ?? '') ?? -1;
        if (at >= 0) {
          const range = document.createRange();
          range.setStart(node, at);
          range.setEnd(node, at + 2);
          const box = range.getBoundingClientRect();
          return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
        }
      }
      return undefined;
    },
    [selector, words],
  );
  assert.ok(inFrame, `the words ${words} are on the canvas`);
  const box = await page.locator('iframe').first().boundingBox();
  assert.ok(box);
  return { x: box.x + inFrame.x, y: box.y + inFrame.y };
}

async function selectedRow(page: Page): Promise<string> {
  return (await page.locator('.structure-node.selected').first().innerText()).trim();
}

async function settled(page: Page, file: string, expected: string) {
  for (let poll = 0; poll < POLLS_MAX; poll++) {
    if ((await readFile(file, 'utf8')) === expected) {
      return;
    }
    await page.waitForTimeout(100);
  }
  assert.equal(await readFile(file, 'utf8'), expected);
}

async function checkLeftClickStillSelectsTheElement(page: Page) {
  const point = await wordsPoint(page, '#between', 'import');
  await page.mouse.click(point.x, point.y);
  await page.waitForFunction(() => document.querySelector('.structure-node.selected')?.textContent?.trim() === 'code');
}

async function checkConvert(
  page: Page,
  file: string,
  run: { readonly selector: string; readonly words: string; readonly tag: string; readonly expected: string },
) {
  const point = await wordsPoint(page, run.selector, run.words);
  await page.mouse.click(point.x, point.y, { button: 'right' });
  const convert = page.getByRole('menuitem', { name: 'Convert to' });
  await convert.hover();
  assert.equal(await page.getByRole('menuitem', { name: 'Wrap in' }).count(), 0, 'a run has no tag to wrap');
  await page.getByRole('menuitem', { name: run.tag, exact: true }).click();
  await settled(page, file, run.expected);
  await page.waitForFunction((tag) => document.querySelector('.structure-node.selected')?.textContent?.trim() === tag, run.tag);
  assert.equal(await selectedRow(page), run.tag, 'the new element is selected, not the blank run beside it');
  await page.keyboard.press('ControlOrMeta+z');
  await settled(page, file, source);
  await page.waitForFunction((words) => document.querySelector('.structure-node.selected')?.textContent?.includes(words) === true, run.words);
}

async function checkCanvasEditingStillOpens(page: Page) {
  const frame = page.frameLocator('iframe').first();
  // Source stamps arrive after the undone page paints; retry the gesture while they settle.
  for (let attempt = 0; attempt < EDITOR_ATTEMPTS_MAX; attempt++) {
    const point = await wordsPoint(page, '#between', 'import');
    await page.mouse.dblclick(point.x, point.y);
    const opened = await frame
      .locator('[data-avb-text-editor]')
      .waitFor({ state: 'attached', timeout: 500 })
      .then(
        () => true,
        () => false,
      );
    if (opened) {
      await page.keyboard.press('Escape');
      return;
    }
  }
  assert.fail('The canvas text editor opens on a double click');
}
