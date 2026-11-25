// Goal: the before/after numbers in docs/instant-edits.md ("Successive edits over a slow render"):
// how long after the key press or drop the canvas first shows an add, a delete, a reorder and a
// second delete, in a Studio whose rendering is slow, as a hosted one is.
// Method: a disposable fixture (never a person's project) whose page renders a component that
// takes RENDER_MS to render, and every socket message held SOCKET_DELAY_MS each way (a stand-in for
// the container and the network). Each operation runs RUNS times; the frame records when its page
// first has the expected shape. Nothing is asserted about the times: this is a manual benchmark
// (`npx tsx test/structuralEdits.bench.ts` in studio/, after `npm run assemble`), not a gate suite,
// and the regression check for the same behaviour is structuralInstant.browser.ts, which holds the
// rendering instead of timing it. The fixed delays below are the slow server being simulated.
import assert from 'node:assert/strict';
import { chromium, type Frame, type Page } from 'playwright';
import { startStyleFixture } from './stylePanelFixture';

const RENDER_MS = 700;
const SOCKET_DELAY_MS = 100;
const RUNS = 3;

const fixture = await startStyleFixture({
  component: `---
// The slow server: every rendering of the page waits here.
await new Promise((resolve) => setTimeout(resolve, ${RENDER_MS}));
---
<span class="held"></span>`,
  page: `---
import Card from '../components/Card.astro';
---
<html><head><title>Structural edits</title></head><body>
<Card /><main><h1>First heading</h1><p>Second paragraph</p><p>Third paragraph</p></main>
</body></html>
`,
});
const browser = await chromium.launch({
  executablePath:
    process.env['CHROME_PATH'] ?? (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : chromium.executablePath()),
  headless: true,
});
const results: Record<string, number[]> = { insert: [], delete: [], reorder: [], 'second-delete': [] };
try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await context.routeWebSocket('**/*', (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((message) => {
      setTimeout(() => server.send(message), SOCKET_DELAY_MS);
    });
    server.onMessage((message) => {
      setTimeout(() => socket.send(message), SOCKET_DELAY_MS);
    });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  await page.goto(fixture.url);
  await page.locator('.save-state').filter({ hasText: 'Saved' }).waitFor();
  const frame = await previewFrame(page);
  await frame.locator('main > p').nth(1).waitFor();
  await page.getByRole('button', { name: 'Expand all', exact: true }).click();
  await row(page, 'n0.1.1.2').waitFor();
  for (let run = 0; run < RUNS; run++) {
    results['insert']?.push(await timeInsert(page, frame));
    results['delete']?.push(await timeDelete(page, frame));
    results['reorder']?.push(await timeReorder(page, frame));
    results['second-delete']?.push(await timeSecondDelete(page, frame));
  }
  console.log(JSON.stringify({ renderMs: RENDER_MS, socketDelayMs: SOCKET_DELAY_MS, firstChangeMs: results }));
} finally {
  await browser.close();
  await fixture.stop();
}

async function timeInsert(page: Page, frame: Frame): Promise<number> {
  await row(page, 'n0.1.1.0').click();
  await page.keyboard.press('ControlOrMeta+e');
  await page.keyboard.type('div');
  await page.getByText('<div>', { exact: true }).first().waitFor();
  const shownMs = await timed(frame, 'h1,div,p,p', () => page.keyboard.press('Enter'));
  await undo(page, frame, 'h1,p,p');
  return shownMs;
}

async function timeDelete(page: Page, frame: Frame): Promise<number> {
  await row(page, 'n0.1.1.2').click();
  const shownMs = await timed(frame, 'h1,p', () => page.keyboard.press('Delete'));
  await undo(page, frame, 'h1,p,p');
  return shownMs;
}

async function timeReorder(page: Page, frame: Frame): Promise<number> {
  const source = await row(page, 'n0.1.1.2').boundingBox();
  const target = await page.locator('.nav-gap[data-drop-parent="n0.1.1"][data-drop-index="0"]').boundingBox();
  assert.ok(source, 'The dragged row is on screen');
  assert.ok(target, 'The drop gap is on screen');
  await page.mouse.move(source.x + 5, source.y + 5);
  await page.mouse.down();
  await page.mouse.move(target.x + 5, target.y + target.height / 2, { steps: 8 });
  const shownMs = await timed(frame, 'p,h1,p', () => page.mouse.up());
  await undo(page, frame, 'h1,p,p');
  return shownMs;
}

// The second delete is made as soon as the Navigator shows the first one's answer: the paragraph
// that moved into the deleted one's place, before the first delete's rendering lands.
async function timeSecondDelete(page: Page, frame: Frame): Promise<number> {
  await row(page, 'n0.1.1.1').click();
  await page.keyboard.press('Delete');
  await page.waitForFunction(() => document.querySelectorAll('.structure-node[data-node-id="n0.1.1.2"]').length === 0);
  await row(page, 'n0.1.1.1').click();
  const shownMs = await timed(frame, 'h1', () => page.keyboard.press('Delete'));
  await undo(page, frame, 'h1,p');
  await undo(page, frame, 'h1,p,p');
  return shownMs;
}

// From the action to the first frame whose page has `expected`, measured in the frame's clock.
async function timed(frame: Frame, expected: string, act: () => Promise<void>): Promise<number> {
  await frame.evaluate(installProbe, expected);
  const started = await frame.evaluate(() => performance.now());
  await act();
  await frame.waitForFunction(() => (window.structuralEditsProbe?.shownAt ?? -1) >= 0, undefined, { timeout: 30_000 });
  const shownAt = await frame.evaluate(() => window.structuralEditsProbe?.shownAt ?? -1);
  assert.ok(shownAt >= started, 'The change showed after the action');
  // The edit's own rendering lands before the next step, so it cannot be counted as the undo's.
  await frame.waitForFunction(() => (window.structuralEditsProbe?.morphs ?? 0) > 0, undefined, { timeout: 30_000 });
  return Math.round(shownAt - started);
}

// Waits for the undo's own rendering to land with the page as expected: the next run starts settled.
async function undo(page: Page, frame: Frame, expected: string) {
  await frame.evaluate(installProbe, expected);
  await page.keyboard.press('ControlOrMeta+z');
  await frame.waitForFunction(
    (shape) =>
      (window.structuralEditsProbe?.morphs ?? 0) > 0 &&
      [...(document.querySelector('main')?.children ?? [])].map((child) => child.tagName.toLowerCase()).join(',') === shape,
    expected,
    { timeout: 30_000 },
  );
  await page.locator('.save-state').filter({ hasText: 'Saved' }).waitFor();
}

function row(page: Page, id: string) {
  return page.locator(`.structure-node[data-node-id="${id}"]`);
}

async function previewFrame(page: Page): Promise<Frame> {
  await page.locator('iframe[title="Site preview"]').waitFor();
  const handle = await page.locator('iframe[title="Site preview"]').elementHandle();
  const frame = await handle?.contentFrame();
  assert.ok(frame, 'The preview frame is attached');
  return frame;
}

interface Probe {
  shownAt: number;
  morphs: number;
}

declare global {
  interface Window {
    structuralEditsProbe?: Probe;
  }
}

// In the frame: when the page first had `expected`, and how many renderings arrived since.
// No named functions inside: the page runs this source as it is, without the bench's helpers.
function installProbe(expected: string): void {
  const probe: Probe = { shownAt: -1, morphs: 0 };
  window.structuralEditsProbe = probe;
  const observer = new MutationObserver(() => {
    if (window.structuralEditsProbe !== probe) {
      observer.disconnect();
      return;
    }
    const now = [...(document.querySelector('main')?.children ?? [])].map((child) => child.tagName.toLowerCase()).join(',');
    if (probe.shownAt < 0 && now === expected) {
      probe.shownAt = performance.now();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
  document.addEventListener('avb:before-morph', () => {
    if (window.structuralEditsProbe === probe) {
      probe.morphs++;
    }
  });
}
