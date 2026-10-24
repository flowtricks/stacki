// Goal: canvas overviews show complete pages without stretching viewport-sized sections.
// Method: open a disposable Astro page in real Studio, hold an image response past
// document readiness, then check all three breakpoints, late CSS, inline edits and shrinkage.
import { chromium, type Page } from 'playwright';
import assert from 'node:assert/strict';
import { readFile, writeFile, unlink, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { switchPage } from './pageNavigation';

const root = process.env['STUDIO_FIXTURE_ROOT'];
assert.ok(root, 'An isolated draft root is required');
assert.ok(root.includes('/.studio/'), 'Use an isolated local draft, never a user website');
const url = process.env['STUDIO_URL'] ?? 'http://127.0.0.1:4376/studio';
assert.equal(new URL(url).hostname, '127.0.0.1');
const relative = `src/pages/canvas-height-${Date.now()}.astro`;
const file = path.join(root, relative);
const source = `<!doctype html>
<html lang="en"><head><title>Full page canvas regression</title>
<style is:global>
  * { box-sizing: border-box; }
  html, body { margin: 0; font: 32px system-ui; }
  .hero { height: 100vh; background: #e9e2d7; display: grid; place-items: center; }
  .inline { background: #c5d7df; }
  .tail { height: 1800px; background: #263b43; color: white;
    display: flex; align-items: end; padding: 24px; }
</style></head><body>
<section class="hero"><h1>Fixed 100vh hero</h1></section>
<section class="inline" style="height: calc(25svh + 10px) !important">Inline viewport units</section>
<footer class="tail">The end of the full page</footer>
<img src="/canvas-slow.svg" alt="" style="position:absolute;width:1px;height:1px;top:0" />
</body></html>`;
await writeFile(file, source, { flag: 'wx' });
const browser = await chromium.launch({
  executablePath:
    process.env['CHROME_PATH'] ??
    (process.platform === 'darwin'
      ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      : chromium.executablePath()),
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1920, height: 1100 } });
page.setDefaultTimeout(30_000);
let releaseImage = () => {};
const imageGate = new Promise<void>((resolve) => {
  releaseImage = resolve;
});
await page.route('**/canvas-slow.svg', async (route) => {
  await imageGate;
  await route.fulfill({
    contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>',
  });
});
try {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await switchPage(page, relative);
  await page.getByTitle('Canvas — all breakpoints — 4', { exact: true }).click();
  await checkFrames(page, { hero: 1, inline: 0.25, tail: 1800 });
  const states = await page
    .locator('.canvas-frame iframe')
    .evaluateAll((frames) =>
      frames.map((frame) =>
        frame instanceof HTMLIFrameElement ? frame.contentDocument?.readyState : undefined,
      ),
    );
  assert.ok(
    states.every((state) => state !== 'complete'),
    'Freeze must precede image load',
  );
  releaseImage();
  await checkFrames(page, { hero: 1, inline: 0.25, tail: 1800 });
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/canvas-full-page.png' });
  await changeFrameContent(page, 'grow');
  await checkFrames(page, { hero: 1, inline: 0.5, tail: 1800 });
  await changeFrameContent(page, 'shrink');
  await checkFrames(page, { hero: 0.5, inline: 0.5, tail: 100 });
  assert.equal(await readFile(file, 'utf8'), source, 'Canvas sizing never rewrites website source');
  console.log(
    'Full-page canvas: fixed vh/svh/dvh/lvh, slow load, inline updates and shrink passed.',
  );
} finally {
  releaseImage();
  await browser.close();
  await unlink(file);
}

async function checkFrames(
  page: Page,
  expected: { readonly hero: number; readonly inline: number; readonly tail: number },
) {
  await page.waitForFunction((sizes) => {
    const frames = [...document.querySelectorAll('.canvas-frame iframe')];
    const viewports = [900, 1024, 812];
    return (
      frames.length === 3 &&
      frames.every((frame, index) => {
        if (!(frame instanceof HTMLIFrameElement)) {
          return false;
        }
        const document = frame.contentDocument;
        const viewport = viewports[index];
        if (!document || viewport === undefined) {
          return false;
        }
        const hero = document.querySelector('.hero')?.getBoundingClientRect().height;
        const inline = document.querySelector('.inline')?.getBoundingClientRect().height;
        const bottom = document.querySelector('.tail')?.getBoundingClientRect().bottom;
        const total = (sizes.hero + sizes.inline) * viewport + 10 + sizes.tail;
        return (
          hero !== undefined &&
          inline !== undefined &&
          bottom !== undefined &&
          Math.abs(hero - sizes.hero * viewport) < 1 &&
          Math.abs(inline - (sizes.inline * viewport + 10)) < 1 &&
          Math.abs(frame.clientHeight - total) < 2 &&
          Math.abs(bottom - total) < 2
        );
      })
    );
  }, expected);
}

async function changeFrameContent(page: Page, action: 'grow' | 'shrink') {
  await page.locator('.canvas-frame iframe').evaluateAll((frames, change) => {
    for (const frame of frames) {
      if (!(frame instanceof HTMLIFrameElement)) {
        continue;
      }
      const document = frame.contentDocument;
      if (!document) {
        throw new Error('Missing canvas document');
      }
      if (change === 'grow') {
        document
          .querySelector('.inline')
          ?.setAttribute('style', 'height: calc(50dvh + 10px) !important');
      } else {
        const style = document.createElement('style');
        style.textContent = '.hero { height: 50lvh; } .tail { height: 100px; }';
        document.head.appendChild(style);
      }
    }
  }, action);
}
