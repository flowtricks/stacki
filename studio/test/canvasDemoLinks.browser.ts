// Goal: in the static demo's canvas, interact mode follows a site's links the way the live
// site does. The baked pages are served under a base (/demo/site/) while the site writes its
// links from the root (`/features`), so a link to one of its pages loads the baked page under
// the base, with #avb-design kept, and the new page can be selected. A same-host route that is
// no page (`/download/mac`, which the site's Worker answers) opens the real URL in a new tab and
// leaves the canvas where it is.
// Method: bundle the real preview client, serve two baked-style pages under the base in a frame,
// send the page list as useCanvasInteraction does (`avb:site-pages` with the demo's base),
// switch to interact mode, and click with Playwright in real Chrome.
import { chromium, type Page } from 'playwright';
import { build, type Plugin } from 'esbuild';
import assert from 'node:assert/strict';

const ORIGIN = 'http://demo.test';
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

const page = (body: string) => `<!doctype html><html><head><meta charset=utf-8>
<style>a { display: inline-block; padding: 20px; font-size: 20px; }</style></head><body>
${body}
<script type="module" src="/demo/site/stacki-runtime/preview.js"></script>
</body></html>`;

const HOME = page(`<!--avb-s:0--><nav data-avb-p="0">
  <a id="features" data-avb-p="0.0" href="/features">Features</a>
  <a id="download" data-avb-p="0.1" href="/download/mac">Download for Mac</a>
</nav><!--avb-e:0-->`);
const FEATURES = page(`<!--avb-s:0--><main data-avb-p="0"><h1 id="title" data-avb-p="0.0">Features</h1></main><!--avb-e:0-->`);

const HOST_PAGE = `<!doctype html><meta charset=utf-8>
<style>html, body { margin: 0; } iframe { border: 0; width: 800px; height: 400px; display: block; }</style>
<iframe id="canvas" src="/demo/site/#avb-design"></iframe>
<script>
  window.received = [];
  addEventListener('message', (event) => window.received.push(event.data));
</script>`;

const browser = await chromium.launch({
  executablePath: process.env['CHROME_PATH'] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});

try {
  const tab = await browser.newPage({ viewport: { width: 900, height: 500 } });
  const errors: string[] = [];
  tab.on('pageerror', (error) => errors.push(error.message));
  const requested: string[] = [];
  await tab.route(`${ORIGIN}/**`, (route) => {
    const { pathname } = new URL(route.request().url());
    requested.push(pathname);
    if (pathname === '/demo/site/stacki-runtime/preview.js') {
      return route.fulfill({ contentType: 'text/javascript', body: client });
    }
    if (pathname === '/demo/site/') {
      return route.fulfill({ contentType: 'text/html', body: HOME });
    }
    if (pathname === '/demo/site/features/') {
      return route.fulfill({ contentType: 'text/html', body: FEATURES });
    }
    if (pathname === '/host.html') {
      return route.fulfill({ contentType: 'text/html', body: HOST_PAGE });
    }
    return route.fulfill({ status: 404, contentType: 'text/html', body: 'Not found' });
  });
  await tab.goto(`${ORIGIN}/host.html`);
  const home = tab.frame({ url: /\/demo\/site\/#avb-design$/ });
  assert.ok(home, 'The canvas frame loaded');
  await home.waitForLoadState('load');
  await prepare(tab);
  await home.evaluate(() => {
    const opened: string[] = [];
    Reflect.set(window, 'openedTabs', opened);
    window.open = (url?: string | URL, target?: string, features?: string) => {
      opened.push(`${String(url)} ${target ?? ''} ${features ?? ''}`);
      return null;
    };
  });

  // Download for Mac: the site's own host, but no page of it.
  await home.click('#download');
  await tab.waitForTimeout(LINK_HOLD_WAIT_MS);
  assert.equal(await frameAddress(tab), '/demo/site/#avb-design', 'A download route leaves the canvas where it is');
  assert.deepEqual(
    await home.evaluate((): unknown => Reflect.get(window, 'openedTabs')),
    [`${ORIGIN}/download/mac _blank noopener,noreferrer`],
    'and opens the real URL in a new tab',
  );
  assert.ok(!requested.includes('/download/mac'), 'The frame never asked for it');

  // A page written from the site root: loaded under the base, still the canvas.
  await home.click('#features');
  await tab.waitForFunction(() => document.querySelector('iframe')?.contentWindow?.location.pathname === '/demo/site/features/', undefined, {
    timeout: 5000,
  });
  assert.equal(await frameAddress(tab), '/demo/site/features/#avb-design', 'A root link loads the baked page with the design hash');
  // The frame tells Studio where it is, which the Pages switcher follows (canvasRoute.ts strips the base).
  // Said as the new page's client starts, which can be just after the address changes.
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if ((await navigations(tab)).includes('/demo/site/features/')) {
      break;
    }
    await tab.waitForTimeout(100);
  }
  assert.ok((await navigations(tab)).includes('/demo/site/features/'), 'The new page reports its path');
  const features = tab.frame({ url: /\/demo\/site\/features\// });
  assert.ok(features, 'The new page loaded');
  await features.waitForLoadState('load');
  await prepare(tab);
  await features.click('#title');
  await tab.waitForTimeout(100);
  assert.equal((await selections(tab)).at(-1), '0.0', 'The new page can be selected');

  assert.deepEqual(errors, []);
  console.log('The demo canvas loads root links under its base and opens routes that are no page in a new tab.');
} finally {
  await browser.close();
}

// What useCanvasInteraction and the editor send a frame as it loads.
async function prepare(tab: Page): Promise<void> {
  await tab.evaluate(() => {
    const frame = document.querySelector('iframe')?.contentWindow;
    frame?.postMessage({ type: 'studio:scope', scope: '', focus: '', occurrence: 0 }, '*');
    frame?.postMessage({ type: 'avb:site-pages', base: '/demo/site', routes: ['/', '/features'] }, '*');
    frame?.postMessage({ type: 'avb:interaction', mode: 'interact' }, '*');
  });
  await tab.waitForTimeout(100);
}

async function frameAddress(tab: Page): Promise<string> {
  return tab.evaluate(() => {
    const where = document.querySelector('iframe')?.contentWindow?.location;
    return where === undefined ? '' : where.pathname + where.hash;
  });
}

async function navigations(tab: Page): Promise<readonly string[]> {
  return messages(tab, 'avb:navigated', 'path');
}

async function selections(tab: Page): Promise<readonly string[]> {
  return messages(tab, 'studio:select', 'id');
}

async function messages(tab: Page, type: string, field: string): Promise<readonly string[]> {
  return tab.evaluate(
    ({ wanted, key }) => {
      const received: unknown = Reflect.get(window, 'received');
      const values: string[] = [];
      for (const message of Array.isArray(received) ? (received as readonly unknown[]) : []) {
        if (typeof message === 'object' && message !== null && Reflect.get(message, 'type') === wanted) {
          values.push(String(Reflect.get(message, key)));
        }
      }
      return values;
    },
    { wanted: type, key: field },
  );
}
