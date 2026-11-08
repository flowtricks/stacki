// Goal: Studio's canvas interact mode is select mode plus one difference, as on Desktop. A
// click still selects; a button's own click listener runs; a link navigates the frame once
// the double-click window has passed, and a double-click on its words stays on the page so
// they can be edited. In select mode a link never navigates and page scripts stay quiet.
// A link to another site opens in a new tab and leaves the frame where it is; a page script
// sending the frame elsewhere is cancelled; a followed page link keeps #avb-design, and the
// loader clears as soon as Studio points the frame at the page it is already showing.
// Method: bundle the real preview client, serve it in a frame inside a host page that records
// what the frame posts and runs the real usePreviewLoading, switch modes with `avb:interaction`
// as useCanvasInteraction does, and click with Playwright so the browser itself decides whether
// a link is followed. The Desktop suite (test/electron/preload/canvasInteract.test.js) pins the
// same rules on the preload.
import { chromium, type Frame, type Page } from 'playwright';
import { build, type Plugin } from 'esbuild';
import assert from 'node:assert/strict';

const ORIGIN = 'http://studio.test';
// LINK_HOLD_MS in electron/preload/frameInteraction.ts, with room for the timer.
const LINK_HOLD_WAIT_MS = 350 + 300;

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

// The host: the canvas's loader, fed by the real readiness hook, around the frame.
const hostBundle = await build({
  stdin: {
    contents: `
      import { createElement, useRef, useState } from 'react';
      import { createRoot } from 'react-dom/client';
      import { usePreviewLoading } from './src/features/preview/PreviewLoading';
      window.received = [];
      addEventListener('message', (event) => window.received.push(event.data));
      function Host() {
        const [url, setURL] = useState('/frame.html#avb-design');
        window.setURL = setURL;
        const wrap = useRef(null);
        const loading = usePreviewLoading(url, wrap, false, () => {});
        return createElement('div', { ref: wrap, id: 'wrap', 'data-ready': String(loading.ready) }, createElement('iframe', { id: 'canvas', src: url }));
      }
      createRoot(document.getElementById('root')).render(createElement(Host));
    `,
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'esm',
  define: { 'process.env.NODE_ENV': '"production"' },
});
const host = hostBundle.outputFiles[0]?.text;
assert.ok(host !== undefined, 'The host bundles to one file');

const FRAME_PAGE = `<!doctype html><html><head><meta charset=utf-8>
<style>a, button { display: inline-block; padding: 20px; font-size: 20px; } .card { cursor: pointer; }</style></head><body>
  <h2 id="title">A heading</h2>
  <div class="card"><span id="card-words">A card the page makes clickable</span></div>
  <input id="field" type="text">
  <!--avb-s:0--><button id="menu" data-avb-p="0">Menu</button><!--avb-e:0-->
  <!--avb-s:1--><a id="about" data-avb-p="1" href="/about.html"><span id="words">About us</span></a><!--avb-e:1-->
  <!--avb-s:2--><a id="github" data-avb-p="2" href="https://github.example/flowtricks/stacki">GitHub</a><!--avb-e:2-->
  <!--avb-s:3--><a id="download" data-avb-p="3" href="/download/mac">Download for Mac</a><!--avb-e:3-->
  <div style="height: 3000px"></div>
  <script>
    window.opened = 0;
    document.getElementById('menu').addEventListener('click', () => { window.opened += 1; });
  </script>
  <script type="module" src="/client.js"></script>
</body></html>`;

const ABOUT_PAGE = '<!doctype html><meta charset=utf-8><h1>About</h1><script type="module" src="/client.js"></script>';

const HOST_PAGE = `<!doctype html><meta charset=utf-8>
<style>html, body { margin: 0; } iframe { border: 0; width: 800px; height: 600px; display: block; }</style>
<div id="root"></div><script type="module" src="/host.js"></script>`;

const browser = await chromium.launch({
  executablePath: process.env['CHROME_PATH'] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});

try {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route(`${ORIGIN}/**`, (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === '/client.js') {
      return route.fulfill({ contentType: 'text/javascript', body: client });
    }
    if (pathname === '/host.js') {
      return route.fulfill({ contentType: 'text/javascript', body: host });
    }
    const body = pathname === '/frame.html' ? FRAME_PAGE : pathname === '/about.html' ? ABOUT_PAGE : HOST_PAGE;
    return route.fulfill({ contentType: 'text/html', body });
  });
  await page.goto(`${ORIGIN}/host.html`);
  await page.waitForSelector('#wrap[data-ready="true"]', { timeout: 5000 });
  const frame = page.frame({ url: /\/frame\.html/ });
  assert.ok(frame, 'The canvas frame loaded');
  await frame.waitForLoadState('load');
  await page.waitForSelector('#wrap[data-ready="true"]', { timeout: 5000 });
  await post(page, { type: 'studio:scope', scope: '', focus: '', occurrence: 0 });

  // Select mode: the canvas keeps every click.
  await frame.click('#words');
  await frame.click('#menu');
  await page.waitForTimeout(LINK_HOLD_WAIT_MS);
  assert.equal(await framePath(page), '/frame.html', 'Select mode keeps links inert');
  assert.equal(await frame.evaluate((): unknown => Reflect.get(window, 'opened')), 0, 'Select mode keeps page scripts quiet');
  assert.deepEqual(await selections(page), ['1', '0'], 'Select mode selects');

  assert.deepEqual(
    await cursors(frame),
    { title: 'default', link: 'default', button: 'default', card: 'default', field: 'default' },
    'Select mode: the arrow everywhere',
  );

  // Interact mode: the same clicks select, and the page has them too.
  await post(page, { type: 'avb:interaction', mode: 'interact' });
  assert.deepEqual(
    await cursors(frame),
    { title: 'default', link: 'pointer', button: 'pointer', card: 'pointer', field: 'text' },
    "Interact mode: the arrow over text, the pointer over what acts on a click (the page's own included), the I-beam in a field",
  );
  await frame.click('#menu');
  await page.waitForTimeout(100); // The selection reaches the host as a message.
  assert.equal(await frame.evaluate((): unknown => Reflect.get(window, 'opened')), 1, "Interact mode runs the button's own listener");
  assert.deepEqual((await selections(page)).slice(2), ['0'], 'Interact mode still selects the button');

  await frame.dblclick('#words');
  await page.waitForTimeout(LINK_HOLD_WAIT_MS);
  assert.equal(await framePath(page), '/frame.html', 'A double-click on a link stays on the page');

  // Another site: a new tab, never the canvas.
  await frame.evaluate(() => {
    const opened: string[] = [];
    Reflect.set(window, 'openedTabs', opened);
    window.open = (url?: string | URL, target?: string, features?: string) => {
      opened.push(`${String(url)} ${target ?? ''} ${features ?? ''}`);
      return null;
    };
  });
  await frame.click('#github');
  await page.waitForTimeout(LINK_HOLD_WAIT_MS);
  assert.equal(await framePath(page), '/frame.html', 'A link to another site leaves the canvas where it is');
  assert.deepEqual(
    await frame.evaluate((): unknown => Reflect.get(window, 'openedTabs')),
    ['https://github.example/flowtricks/stacki _blank noopener,noreferrer'],
    'and opens in a new tab',
  );
  assert.equal((await selections(page)).at(-1), '2', 'The link was still selected');

  // The site's own host, but no page of the site (a download route its server answers): the
  // real URL in a new tab, never the canvas. The host lists the pages (useCanvasInteraction).
  await post(page, { type: 'avb:site-pages', base: '', routes: ['/frame.html', '/about.html'] });
  await frame.click('#download');
  await page.waitForTimeout(LINK_HOLD_WAIT_MS);
  assert.equal(await framePath(page), '/frame.html', 'A download route leaves the canvas where it is');
  assert.deepEqual(
    await frame.evaluate((): unknown => Reflect.get(window, 'openedTabs')),
    ['https://github.example/flowtricks/stacki _blank noopener,noreferrer', `${ORIGIN}/download/mac _blank noopener,noreferrer`],
    'and opens the real URL in a new tab',
  );

  // Arrow keys after a canvas click move the selection, as on Desktop, and do not scroll the page.
  await frame.click('#menu');
  const keysBefore = await studioKeys(page);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowUp');
  await page.waitForTimeout(100);
  assert.deepEqual((await studioKeys(page)).slice(keysBefore.length), ['ArrowDown', 'ArrowUp'], 'The arrows reach the editor');
  assert.equal(await frame.evaluate(() => window.scrollY), 0, 'and the page does not scroll');
  await frame.click('#field');
  const typedBefore = await studioKeys(page);
  await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(100);
  assert.deepEqual((await studioKeys(page)).slice(typedBefore.length), [], 'A field keeps its arrows for the caret');

  // A page script sending the canvas elsewhere is cancelled before it starts.
  await frame.evaluate(() => {
    location.href = 'https://elsewhere.example/';
  });
  await page.waitForTimeout(300);
  assert.equal(await framePath(page), '/frame.html', 'A script cannot take the canvas off the site');

  await frame.click('#words');
  await page.waitForTimeout(100); // The selection reaches the host as a message.
  assert.equal((await selections(page)).at(-1), '1', 'Interact mode selects the link before it navigates');
  await page.waitForFunction(() => document.querySelector('iframe')?.contentWindow?.location.pathname === '/about.html', undefined, { timeout: 5000 });
  assert.equal(
    await page.evaluate(() => document.querySelector('iframe')?.contentWindow?.location.hash),
    '#avb-design',
    'A followed page keeps the design hash',
  );

  // Studio learns the route and points the frame at the page it already shows, which does
  // not load it again: the ready message the page sent on arrival has to count.
  await page.waitForTimeout(200);
  await page.evaluate(() => {
    const setURL: unknown = Reflect.get(window, 'setURL');
    if (typeof setURL === 'function') {
      Reflect.apply(setURL, undefined, ['/about.html#avb-design']);
    }
  });
  await page.waitForSelector('#wrap[data-ready="true"]', { timeout: 500 });

  assert.deepEqual(errors, []);
  console.log('Studio interact mode selects on click, runs page scripts and follows links; select mode keeps them inert.');
} finally {
  await browser.close();
}

async function post(page: Page, message: unknown): Promise<void> {
  await page.evaluate((data) => document.querySelector('iframe')?.contentWindow?.postMessage(data, '*'), message);
  await page.waitForTimeout(50);
}

async function cursors(frame: Frame): Promise<Record<string, string>> {
  // No helper inside: tsx names a function held in a variable, and that name does not exist in the page.
  const read = await frame.evaluate(() =>
    ['#title', '#words', '#menu', '#card-words', '#field'].map((selector) => {
      const element = document.querySelector(selector);
      return element === null ? 'missing' : getComputedStyle(element).cursor;
    }),
  );
  const [title = '', link = '', button = '', card = '', field = ''] = read;
  return { title, link, button, card, field };
}

async function studioKeys(page: Page): Promise<readonly string[]> {
  return page.evaluate(() => {
    const received: unknown = Reflect.get(window, 'received');
    const keys: string[] = [];
    for (const message of Array.isArray(received) ? (received as readonly unknown[]) : []) {
      if (typeof message === 'object' && message !== null && Reflect.get(message, 'type') === 'studio:key') {
        keys.push(String(Reflect.get(message, 'key')));
      }
    }
    return keys;
  });
}

async function framePath(page: Page): Promise<string | undefined> {
  return page.evaluate(() => document.querySelector('iframe')?.contentWindow?.location.pathname);
}

async function selections(page: Page): Promise<readonly string[]> {
  return page.evaluate(() => {
    const received: unknown = Reflect.get(window, 'received');
    const ids: string[] = [];
    for (const message of Array.isArray(received) ? received : []) {
      if (typeof message === 'object' && message !== null && Reflect.get(message, 'type') === 'studio:select') {
        ids.push(String(Reflect.get(message, 'id')));
      }
    }
    return ids;
  });
}
