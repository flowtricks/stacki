// Goal: a reordered button reaches the canvas even while its HTTP refresh is stuck.
// Method: render a real Astro component slower than the old fallback threshold,
// perform native drags, then hold HTTP to check push supersession and undo.
import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import { chromium, type Page, type Request } from 'playwright';
import { startStyleFixture } from './stylePanelFixture';

const fixture = await startStyleFixture({
  page: `---
import Card from '../components/Card.astro';
---
<main><Card variant="primary">Choose a campus</Card>
<Card variant="secondary">Plan your visit</Card></main>`,
  component: `---
interface Props { variant: 'primary' | 'secondary' }
const { variant } = Astro.props;
await new Promise((resolve) => setTimeout(resolve, 1800));
---
<button class={variant}><slot /></button>`,
});
try {
  await checkReorder();
} finally {
  await fixture.stop();
}

async function checkReorder() {
  const browser = await chromium.launch({
    executablePath:
      process.env['CHROME_PATH'] ??
      (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : chromium.executablePath()),
    headless: true,
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    page.setDefaultTimeout(20_000);
    const renders = observeRenders(page);
    let navigations = 0;
    page.on('framenavigated', () => {
      navigations++;
    });
    await page.goto(fixture.url);
    const frame = page.frameLocator('iframe[title="Site preview"]');
    await frame.locator('button.primary:first-child').waitFor();
    await page.getByRole('button', { name: 'Expand all', exact: true }).click();
    for (let attempt = 0; attempt < 100 && renders.completed === 0; attempt++) {
      await setTimeout(50);
    }
    assert.ok(renders.completed > 0, 'Initial subscription render must settle before editing');
    await checkPushFirst(page, renders);
    const loaded = navigations;
    const held = await holdRefresh(page);
    try {
      await page.frames()[1]?.evaluate(() => {
        document.dispatchEvent(new Event('studio:render-fallback'));
      });
      await held.started;
      await moveSecondFirst(page);
      await frame.locator('button.secondary:first-child').waitFor({ timeout: 5000 });
      assert.equal(await frame.locator('button.secondary').innerText(), 'Plan your visit');
      assert.equal(await frame.locator('button.primary').innerText(), 'Choose a campus');
      await page.keyboard.press('ControlOrMeta+z');
      await frame.locator('button.primary:first-child').waitFor({ timeout: 5000 });
      assert.equal(navigations, loaded, 'Superseding a refresh must not reload either document');
      console.log('Reorder and undo apply pushed HTML while HTTP refreshes remain held.');
    } finally {
      held.release();
    }
  } finally {
    await browser.close();
  }
}

async function holdRefresh(page: Page) {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const observed = page.waitForRequest((request) => request.resourceType() === 'fetch' && new URL(request.url()).pathname === '/', { timeout: 10_000 });
  let heldCount = 0;
  await page.route('**/*', async (route) => {
    const request = route.request();
    if (request.resourceType() === 'fetch' && new URL(request.url()).pathname === '/') {
      heldCount++;
      assert.ok(heldCount <= 10, 'A reorder and undo have bounded refresh work');
      await gate;
    }
    await route.continue();
  });
  return { started: observed, release: () => release() };
}

async function moveSecondFirst(page: Page) {
  const row = page.locator('.structure-node[data-node-id="n0.1"]');
  const gap = page.locator('.nav-gap[data-drop-parent="n0"][data-drop-index="0"]');
  const source = await row.boundingBox();
  const target = await gap.boundingBox();
  assert.ok(source);
  assert.ok(target);
  await page.mouse.move(source.x + 5, source.y + 5);
  await page.mouse.down();
  await page.mouse.move(target.x + 5, target.y + target.height / 2, { steps: 12 });
  await page.mouse.up();
}

async function checkPushFirst(page: Page, renders: { readonly started: number }) {
  const frame = page.frameLocator('iframe[title="Site preview"]');
  let pulls = 0;
  const observe = (request: Request) => {
    if (request.resourceType() === 'fetch' && new URL(request.url()).pathname === '/') {
      pulls++;
    }
  };
  page.on('request', observe);
  try {
    const before = renders.started;
    await moveSecondFirst(page);
    await frame.locator('button.secondary:first-child').waitFor({ timeout: 5000 });
    // A second watcher render can start after the first result reaches the browser.
    await setTimeout(300);
    assert.equal(renders.started - before, 1, 'One accepted reorder starts one server render');
    assert.equal(pulls, 0, 'A healthy render push must not compete with a structural HTTP pull');
    await page.keyboard.press('ControlOrMeta+z');
    await frame.locator('button.primary:first-child').waitFor({ timeout: 5000 });
    await setTimeout(300);
    assert.equal(renders.started - before, 2, 'Undo also uses the same single render path');
  } finally {
    page.off('request', observe);
  }
}

function observeRenders(page: Page) {
  const counts = { started: 0, completed: 0 };
  page.on('websocket', (socket) => {
    socket.on('framereceived', ({ payload }) => {
      const text = String(payload);
      if (!text.startsWith('{')) {
        return;
      }
      assert.ok(text.length <= 16_000_000, 'Preview test messages remain bounded');
      const input: unknown = JSON.parse(text);
      if (input && typeof input === 'object' && 'event' in input) {
        if (input.event === 'studio:render-pending') {
          counts.started++;
        } else if (input.event === 'studio:render') {
          counts.completed++;
        }
      }
      assert.ok(counts.started <= 20, 'This test has a bounded number of render requests');
    });
  });
  return counts;
}
