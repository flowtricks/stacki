// Goal: Studio's canvas resolves a click in the space between a loop's items the way the
// Desktop canvas does. The browser can only name the element holding the items, but the
// point is inside the loop's outline, so the loop is selected; a click on an item still
// selects that item, and a click outside the items' union still selects the holder. Hover,
// double-click and the context menu resolve the same way.
// Method: bundle the real preview client, serve it in a frame inside a host page that records
// what the frame posts, and click with Playwright in real Chrome so the gaps are laid out by
// the browser. The page is marked the way the serializer marks a loop: markers around the
// loop, its items tagged with their own path. A second list is the same loop after a
// component stripped the comments out of its slot (stacki.build's <Section> does): only
// the items' tags are left, and the canvas works the loop out from them (frameRegions.ts). The Desktop preload keeps the same rule in
// test/electron/preload/loopGapHit.test.js; both read electron/preload/frameUnionTarget.ts.
import { chromium, type Frame, type Page } from 'playwright';
import { build, type Plugin } from 'esbuild';
import assert from 'node:assert/strict';

const ORIGIN = 'http://studio.test';

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

// <ul> is node 0, `promises.map` is 0.0 and each <li> it renders is 0.0.0.
const FRAME_PAGE = `<!doctype html><html><head><meta charset=utf-8>
<style>
  body { margin: 0; }
  ul { display: flex; gap: 40px; margin: 0; padding: 20px 20px 60px; list-style: none; }
  li { width: 100px; height: 40px; background: #3c6; }
</style></head><body>
  <!--avb-s:0--><ul data-avb-p="0"><!--avb-s:0.0-->
    <li data-avb-p="0.0.0">One</li>
    <li data-avb-p="0.0.0">Two</li>
    <li data-avb-p="0.0.0">Three</li>
  <!--avb-e:0.0--></ul><!--avb-e:0-->
  <ul data-avb-p="1" class="stripped">
    <li data-avb-p="1.0.0">One</li>
    <li data-avb-p="1.0.0">Two</li>
    <li data-avb-p="1.0.0">Three</li>
  </ul>
  <script type="module" src="/client.js"></script>
</body></html>`;

const HOST_PAGE = `<!doctype html><meta charset=utf-8>
<style>html, body { margin: 0; } iframe { border: 0; width: 800px; height: 400px; display: block; }</style>
<iframe id="canvas" src="/frame.html#avb-design"></iframe>
<script>
  window.received = [];
  addEventListener('message', (event) => window.received.push(event.data));
</script>`;

const browser = await chromium.launch({
  executablePath: process.env['CHROME_PATH'] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});

interface Located {
  readonly type: string;
  readonly id: string;
  readonly occurrence: number;
}

try {
  const page = await browser.newPage({ viewport: { width: 900, height: 500 } });
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
  const frame = page.frame({ url: /\/frame\.html/ });
  assert.ok(frame, 'The canvas frame loaded');
  await frame.waitForLoadState('load');
  await page.evaluate(() => document.querySelector('iframe')?.contentWindow?.postMessage({ type: 'studio:scope', scope: '', focus: '', occurrence: 0 }, '*'));
  const items = await itemBoxes(frame);
  const [first, second, third] = items;
  assert.ok(first && second && third, 'The loop rendered three items');
  const middle = first.top + first.height / 2;
  const gap = { x: (first.right + second.left) / 2, y: middle };

  assert.deepEqual(await located(page, 'click', gap), { type: 'studio:select', id: '0.0', occurrence: 0 }, 'The gap between items selects the loop');
  assert.deepEqual(
    await located(page, 'click', { x: (second.right + third.left) / 2, y: middle }),
    { type: 'studio:select', id: '0.0', occurrence: 0 },
    'and so does the next gap',
  );
  assert.deepEqual(
    await located(page, 'click', { x: second.left + 10, y: middle }),
    { type: 'studio:select', id: '0.0.0', occurrence: 1 },
    'An item still selects that item',
  );
  assert.deepEqual(
    await located(page, 'click', { x: first.left + 10, y: first.bottom + 30 }),
    { type: 'studio:select', id: '0', occurrence: 0 },
    'Below the items is the holder',
  );
  assert.deepEqual(await located(page, 'dblclick', gap), { type: 'studio:open', id: '0.0', occurrence: 0 }, 'A double-click resolves the same way');
  assert.deepEqual(await located(page, 'contextmenu', gap), { type: 'avb:context-node', id: '0.0', occurrence: 0 }, 'So does the context menu');
  await page.mouse.move(gap.x, gap.y);
  // Hover lights what a click would select.
  await page.waitForFunction(() => {
    const received: unknown = Reflect.get(window, 'received');
    let hovered: unknown;
    for (const message of Array.isArray(received) ? (received as readonly unknown[]) : []) {
      if (typeof message === 'object' && message !== null && Reflect.get(message, 'type') === 'studio:outlines') {
        hovered = Reflect.get(message, 'hovered');
      }
    }
    return typeof hovered === 'object' && hovered !== null && Reflect.get(hovered, 'id') === '0.0';
  });

  // The stripped list: no markers for the loop, only its items' tags.
  const stripped = await frame.evaluate(() =>
    [...document.querySelectorAll('ul.stripped li')].map((item) => {
      const box = item.getBoundingClientRect();
      return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, height: box.height };
    }),
  );
  const [one, two, three] = stripped;
  assert.ok(one && two && three, 'The stripped loop rendered three items');
  const row = one.top + one.height / 2;
  assert.deepEqual(
    await located(page, 'click', { x: (one.right + two.left) / 2, y: row }),
    { type: 'studio:select', id: '1.0', occurrence: 0 },
    'Without markers, the gap between items still selects the loop',
  );
  assert.deepEqual(
    await located(page, 'click', { x: three.left + 10, y: row }),
    { type: 'studio:select', id: '1.0.0', occurrence: 2 },
    'and an item still selects the item',
  );
  // Selected, the loop is outlined around all three items.
  await page.evaluate(() => document.querySelector('iframe')?.contentWindow?.postMessage({ type: 'studio:select', id: '1.0', occurrence: 0 }, '*'));
  const outline = await page.waitForFunction(() => {
    const received: unknown = Reflect.get(window, 'received');
    let rects: unknown;
    for (const message of Array.isArray(received) ? (received as readonly unknown[]) : []) {
      if (typeof message === 'object' && message !== null && Reflect.get(message, 'type') === 'studio:outlines') {
        const all: unknown = Reflect.get(message, 'rects');
        rects = typeof all === 'object' && all !== null ? Reflect.get(all, '1.0') : undefined;
      }
    }
    return Array.isArray(rects) && rects.length > 0 ? JSON.stringify(rects) : false;
  });
  const drawn: unknown = JSON.parse(String(await outline.jsonValue()));
  const box: unknown = Array.isArray(drawn) ? drawn[0] : undefined;
  assert.ok(typeof box === 'object' && box !== null, 'The loop has an outline');
  assert.equal(Math.round(Number(Reflect.get(box, 'x'))), Math.round(one.left), 'It starts at the first item');
  assert.equal(Math.round(Number(Reflect.get(box, 'x')) + Number(Reflect.get(box, 'w'))), Math.round(three.right), 'and ends at the last');

  assert.deepEqual(errors, []);
  console.log('Studio selects a loop from the space between its items, as Desktop does, and an item from the item.');
} finally {
  await browser.close();
}

async function itemBoxes(
  frame: Frame,
): Promise<readonly { readonly left: number; readonly right: number; readonly top: number; readonly bottom: number; readonly height: number }[]> {
  return frame.evaluate(() =>
    [...document.querySelectorAll('ul:not(.stripped) li')].map((item) => {
      const box = item.getBoundingClientRect();
      return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, height: box.height };
    }),
  );
}

// The frame sits at the host's origin, so frame coordinates are page coordinates.
async function located(
  page: Page,
  gesture: 'click' | 'dblclick' | 'contextmenu',
  point: { readonly x: number; readonly y: number },
): Promise<Located | undefined> {
  const before = await page.evaluate((): unknown => Reflect.get(window, 'received'));
  const count = Array.isArray(before) ? before.length : 0;
  if (gesture === 'dblclick') {
    await page.mouse.dblclick(point.x, point.y);
  } else {
    await page.mouse.click(point.x, point.y, { button: gesture === 'contextmenu' ? 'right' : 'left' });
  }
  await page.waitForTimeout(100);
  const wanted = gesture === 'click' ? 'studio:select' : gesture === 'dblclick' ? 'studio:open' : 'avb:context-node';
  const messages = await page.evaluate((from): unknown => {
    const received: unknown = Reflect.get(window, 'received');
    return Array.isArray(received) ? received.slice(from) : [];
  }, count);
  for (const message of Array.isArray(messages) ? messages : []) {
    if (typeof message === 'object' && message !== null && Reflect.get(message, 'type') === wanted) {
      const id: unknown = Reflect.get(message, wanted === 'avb:context-node' ? 'path' : 'id');
      const occurrence: unknown = Reflect.get(message, 'occurrence');
      return { type: wanted, id: String(id), occurrence: typeof occurrence === 'number' ? occurrence : -1 };
    }
  }
  return undefined;
}
