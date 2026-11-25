// Goal: Studio's canvas reveals a selection by the same rule as the Desktop canvas. Only a
// node with no part in the frame moves the page, the move is vertical, and <html> and <body>
// never move it. Following a collaborator is what asks for a reveal here.
// Method: bundle the real preview client, serve it in a frame inside a host page, post
// `studio:reveal` as usePreview does, and compare the scroll position before and after. The
// reveal scrolls instantly, so a reply to a later message proves it has already happened. The
// Desktop suite (test/electron/preload/revealScrollsDown.test.js) covers the rule's edge cases.
import { chromium, type Frame, type Page } from 'playwright';
import { build, type Plugin } from 'esbuild';
import assert from 'node:assert/strict';

const ORIGIN = 'http://studio.test';
const VIEWPORT_HEIGHT_PX = 600;
const ROOT_PATH = '9';
const BODY_PATH = '9.1';

// The dev server's client is a bare URL import, and nothing here needs what it does.
const silentHotClient: Plugin = {
  name: 'silent-hot-client',
  setup(context) {
    context.onResolve({ filter: /^\/@vite\/client$/ }, () => ({ path: 'hot', namespace: 'silent-hot-client' }));
    context.onLoad({ filter: /.*/, namespace: 'silent-hot-client' }, () => ({
      contents: 'export const createHotContext = () => ({ on() {}, send() {} });',
    }));
  },
};

const bundled = await build({
  entryPoints: ['src/features/preview/previewClient.ts'],
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'esm',
  plugins: [silentHotClient],
});
const client = bundled.outputFiles[0]?.text;
assert.ok(client !== undefined, 'The preview client bundles to one file');

// `height: 100%` leaves the boxes of <html> and <body> above the frame once the page has
// scrolled, which is what makes them the hard case.
const FRAME_PAGE = `<!doctype html><!--avb-s:${ROOT_PATH}--><html data-avb-p="${ROOT_PATH}"><head><meta charset=utf-8>
<style>
  html, body { margin: 0; height: 100%; }
  body { overflow-x: hidden; }
  .gap { height: 1500px; }
  .box { height: 100px; background: #3c6; }
  .away { width: 300px; margin-left: 900px; }
</style></head><!--avb-s:${BODY_PATH}--><body data-avb-p="${BODY_PATH}">
  <div class="gap"></div>
  <!--avb-s:0--><section class="box" id="box" data-avb-p="0"></section><!--avb-e:0-->
  <div class="gap"></div>
  <!--avb-s:1--><section class="box away" id="away" data-avb-p="1"></section><!--avb-e:1-->
  <div class="gap"></div>
  <script>
    addEventListener('message', (event) => {
      if (event.data && event.data.type === 'test:ping') {
        parent.postMessage({ type: 'test:pong' }, '*');
      }
    });
  </script>
  <script type="module" src="/client.js"></script>
</body><!--avb-e:${BODY_PATH}--></html><!--avb-e:${ROOT_PATH}-->`;

const HOST_PAGE = `<!doctype html><meta charset=utf-8>
<style>html, body { margin: 0; } iframe { border: 0; width: 800px; height: ${VIEWPORT_HEIGHT_PX}px; display: block; }</style>
<iframe id="canvas" src="/frame.html"></iframe>`;

const browser = await chromium.launch({
  executablePath: process.env['CHROME_PATH'] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});

interface Reading {
  readonly top: number;
  readonly scrollX: number;
  readonly scrollY: number;
}

try {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route(`${ORIGIN}/**`, (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === '/client.js') {
      return route.fulfill({ contentType: 'text/javascript', body: client });
    }
    return route.fulfill({ contentType: 'text/html', body: pathname === '/frame.html' ? FRAME_PAGE : HOST_PAGE });
  });
  await page.goto(`${ORIGIN}/host.html`);
  const frame = page.frame({ url: `${ORIGIN}/frame.html` });
  assert.ok(frame, 'The canvas frame loaded');
  await frame.waitForLoadState('load');

  await checkKeepsPlace(page, frame, 'a box cut by the top', '0', 'box', -40);
  await checkKeepsPlace(page, frame, 'a box cut by the bottom', '0', 'box', 550);
  await checkKeepsPlace(page, frame, 'a box showing one pixel at the top', '0', 'box', -99);
  await checkKeepsPlace(page, frame, 'a box showing one pixel at the bottom', '0', 'box', 599);
  await checkKeepsPlace(page, frame, 'a box wholly inside', '0', 'box', 200);
  await checkKeepsPlace(page, frame, '<body> far down the page', BODY_PATH, 'box', 200);
  await checkKeepsPlace(page, frame, '<html> far down the page', ROOT_PATH, 'box', 200);

  const below = await reveal(page, frame, '0', 'box', 900);
  assert.ok(below.after.top >= 0 && below.after.top + 100 <= VIEWPORT_HEIGHT_PX, `A box below the frame comes on screen: ${JSON.stringify(below)}`);
  const above = await reveal(page, frame, '0', 'box', -500);
  assert.ok(above.after.top >= 0 && above.after.top + 100 <= VIEWPORT_HEIGHT_PX, `A box above the frame comes on screen: ${JSON.stringify(above)}`);
  const sideways = await reveal(page, frame, '1', 'away', 900);
  assert.notEqual(sideways.after.scrollY, sideways.before.scrollY, 'A box beside and below the frame scrolls down');
  assert.equal(sideways.after.scrollX, 0, 'and never sideways');

  assert.deepEqual(errors, []);
  console.log('Studio reveals a selection only when no part of it is in view, vertically, and never for <html> or <body>.');
} finally {
  await browser.close();
}

async function checkKeepsPlace(page: Page, frame: Frame, what: string, nodePath: string, id: string, boxTop: number): Promise<void> {
  const { before, after } = await reveal(page, frame, nodePath, id, boxTop);
  assert.equal(before.top, boxTop, `${what} starts where it asked to`);
  assert.ok(before.scrollY > 0, `${what} starts down the page`);
  assert.deepEqual(after, before, `${what} does not move the page`);
}

// Puts a box at a chosen top in the frame, reveals a path from there, and reads both ends.
async function reveal(page: Page, frame: Frame, nodePath: string, id: string, boxTop: number): Promise<{ before: Reading; after: Reading }> {
  const read = (): Promise<Reading> =>
    frame.evaluate(
      (elementId) => ({
        top: document.getElementById(elementId)?.getBoundingClientRect().top ?? Number.NaN,
        scrollX: window.scrollX,
        scrollY: window.scrollY,
      }),
      id,
    );
  await frame.evaluate(
    ({ elementId, top }) => {
      const box = document.getElementById(elementId)?.getBoundingClientRect();
      window.scrollTo({ top: window.scrollY + (box?.top ?? 0) - top, behavior: 'instant' });
    },
    { elementId: id, top: boxTop },
  );
  const before = await read();
  await page.evaluate(
    (path) =>
      new Promise<void>((resolve) => {
        const canvas = document.querySelector('iframe');
        // Left in place: tsx names a function held in a variable, and that name does not
        // exist in the page. A later reply resolves a settled promise, which does nothing.
        addEventListener('message', (event: MessageEvent<unknown>) => {
          const data = event.data;
          if (typeof data === 'object' && data !== null && 'type' in data && data.type === 'test:pong') {
            resolve();
          }
        });
        canvas?.contentWindow?.postMessage({ type: 'studio:reveal', id: path, occurrence: 0 }, '*');
        canvas?.contentWindow?.postMessage({ type: 'test:ping' }, '*');
      }),
    nodePath,
  );
  return { before, after: await read() };
}
