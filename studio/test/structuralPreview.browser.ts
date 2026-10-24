// Goal: structural edits keep component labels with their variants, without a stale text flash.
// Method: drag real navigator rows while render delivery is held, record every DOM mutation,
// then release the real Astro result and measure warm duplicate/delete preview latency.
import assert from 'node:assert/strict';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { chromium, type Page } from 'playwright';
import { switchPage } from './pageNavigation';

const root = process.env['STUDIO_FIXTURE_ROOT'];
assert.ok(root?.includes('/.studio/'), 'An isolated draft is required');
assert.ok(root);
const url = process.env['STUDIO_URL'] ?? 'http://127.0.0.1:4376/studio';
assert.equal(new URL(url).hostname, '127.0.0.1');
const suffix = `structural-preview-${Date.now()}`;
const file = `src/pages/${suffix}.astro`;
const component = `src/components/${suffix}.astro`;
const source = `---
import Button from '../components/${suffix}.astro';
---
<main><Button variant="primary">Choose a campus</Button><Button variant="secondary">Plan your visit</Button></main>`;
await writeFile(
  path.join(root, component),
  `---
interface Props { variant: 'primary' | 'secondary' }
const { variant } = Astro.props;
---
<button class={variant}><slot /></button>
<style>button { padding: 20px; margin: 10px; font: 24px sans-serif; }
.primary { background: blue; color: white; } .secondary { background: white; color: black; }
</style>`,
  { flag: 'wx' },
);
await writeFile(path.join(root, file), source, { flag: 'wx' });
const browser = await chromium.launch({
  executablePath:
    process.env['CHROME_PATH'] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1920, height: 1100 } });
page.setDefaultTimeout(20_000);
const transport = await holdRenders(page);
try {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await switchPage(page, file);
  const frame = page.frameLocator('iframe[title="Site preview"]');
  await frame.getByRole('button', { name: 'Plan your visit', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Expand all', exact: true }).click();
  await frame.locator('body').evaluate((body) => {
    new MutationObserver(() => {
      for (const button of body.querySelectorAll('button')) {
        const expected = button.textContent?.trim() === 'Choose a campus' ? 'primary' : 'secondary';
        if (!button.classList.contains(expected)) {
          body.ownerDocument.documentElement.dataset['variantMismatch'] = button.outerHTML;
        }
      }
    }).observe(body, { subtree: true, childList: true, characterData: true, attributes: true });
  });
  transport.hold = true;
  await moveSecondFirst(page);
  await waitForSource((text) => text.indexOf('Plan your visit') < text.indexOf('Choose a campus'));
  await setTimeout(350);
  assert.ok(transport.held > 0, 'The real Astro render was held during the drag');
  assert.equal(await frame.locator('html').getAttribute('data-variant-mismatch'), null);
  transport.release();
  await frame.locator('button.secondary:first-child').waitFor();
  assert.equal(await frame.locator('html').getAttribute('data-variant-mismatch'), null);
  await page.keyboard.press('ControlOrMeta+z');
  await frame.locator('button.primary:first-child').waitFor();
  assert.equal(await frame.locator('html').getAttribute('data-variant-mismatch'), null);
  await measureStructuralEdits(page);
  console.log('Drag, undo, duplicate and delete retain button variants.');
} finally {
  transport.release();
  await browser.close();
  await unlink(path.join(root, file));
  await unlink(path.join(root, component));
}

async function moveSecondFirst(page: Page) {
  const row = page.locator('.structure-node[data-node-id="n0.1"]');
  const gap = page.locator('.nav-gap[data-drop-parent="n0"][data-drop-index="0"]');
  const from = await row.boundingBox();
  const to = await gap.boundingBox();
  assert.ok(from && to);
  await page.mouse.move(from.x + 5, from.y + 5);
  await page.mouse.down();
  await page.mouse.move(to.x + 5, to.y + to.height / 2, { steps: 12 });
  await page.mouse.up();
}

async function waitForSource(matches: (source: string) => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (matches(await readFile(path.join(root ?? '', file), 'utf8'))) {
      return;
    }
    await setTimeout(50);
  }
  throw new Error('The source did not reach the expected order');
}

async function holdRenders(page: Page) {
  let releaseFetch = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseFetch = resolve;
  });
  const deliveries: (() => void)[] = [];
  const state = {
    hold: false,
    held: 0,
    release() {
      state.hold = false;
      for (const deliver of deliveries.splice(0)) {
        deliver();
      }
      releaseFetch();
    },
  };
  await page.routeWebSocket('**/*', (socket) => {
    const server = socket.connectToServer();
    server.onMessage((message) => {
      if (state.hold && String(message).includes('"event":"studio:render"')) {
        assert.ok(deliveries.length < 100, 'Held render queue stays bounded');
        state.held++;
        deliveries.push(() => socket.send(message));
      } else {
        socket.send(message);
      }
    });
  });
  await page.route('**/*', async (route) => {
    if (
      state.hold &&
      route.request().resourceType() === 'fetch' &&
      new URL(route.request().url()).pathname === '/' + suffix
    ) {
      await gate;
    }
    await route.continue();
  });
  return state;
}

async function measureStructuralEdits(page: Page) {
  const frame = page.frameLocator('iframe[title="Site preview"]');
  await page.locator('.structure-node[data-node-id="n0.1"]').click();
  const duplicateStart = performance.now();
  await page.keyboard.press('ControlOrMeta+d');
  await frame.locator('button').nth(2).waitFor();
  console.log(`Duplicate to canvas: ${Math.round(performance.now() - duplicateStart)}ms`);
  const deleteStart = performance.now();
  await page.keyboard.press('Delete');
  await frame.locator('button').nth(2).waitFor({ state: 'detached' });
  console.log(`Delete to canvas: ${Math.round(performance.now() - deleteStart)}ms`);
}
