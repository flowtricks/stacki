// Goal: adding, deleting and reordering show on the canvas before the server's rendering, as on
// Desktop, however slow that rendering is; successive edits never flash back an earlier state.
// Method: a disposable fixture whose page renders a component that waits on a gate file, so the
// test holds every rendering for as long as it likes. Each edit is made while the gate is shut: the
// canvas must already show it while no rendering has arrived (the latency bound is causal: before
// the first `avb:before-morph`, not a number of milliseconds). Then the gate opens and the
// rendering must leave the page as shown. The frame records every page shape it showed, so a node
// that came back for one frame is seen. Waits are bounded and wait on state; nothing sleeps.
import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Frame, type Page } from 'playwright';
import { startStyleFixture } from './stylePanelFixture';

const GATE = '.render-gate';
const fixture = await startStyleFixture({
  component: `---
import { existsSync, watch } from 'node:fs';
// Held while the test's gate file exists, until it is removed; bounded so a lost test cannot hang the server.
if (existsSync(${JSON.stringify(GATE)})) {
  await new Promise((resolve) => {
    const watcher = watch('.', { signal: AbortSignal.timeout(30_000) }, () => {
      if (!existsSync(${JSON.stringify(GATE)})) {
        watcher.close();
      }
    });
    watcher.on('close', resolve);
    watcher.on('error', resolve);
  });
}
---
<span class="held"></span>`,
  page: `---
import Card from '../components/Card.astro';
---
<html><head><title>Instant edits</title></head><body>
<Card /><main><h1>First heading</h1><p>Second paragraph</p><p>Third paragraph</p></main>
</body></html>
`,
});
const gate = path.join(fixture.root, GATE);
const browser = await chromium.launch({
  executablePath:
    process.env['CHROME_PATH'] ?? (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : chromium.executablePath()),
  headless: true,
});
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.setDefaultTimeout(20_000);
  await page.goto(fixture.url);
  await page.locator('.save-state').filter({ hasText: 'Saved' }).waitFor();
  const frame = await previewFrame(page);
  await frame.locator('main > p').nth(1).waitFor();
  await page.getByRole('button', { name: 'Expand all', exact: true }).click();
  await row(page, 'n0.1.1.2').waitFor();
  await checkInsert(page, frame);
  await checkDelete(page, frame);
  await checkReorder(page, frame);
  await checkSuccessiveDeletes(page, frame);
  console.log('Insert, delete, reorder and successive deletes show before the rendering, and never flash back.');
} finally {
  await rm(gate, { force: true });
  await browser.close();
  await fixture.stop();
}

async function checkInsert(page: Page, frame: Frame) {
  await row(page, 'n0.1.1.0').click();
  await page.keyboard.press('ControlOrMeta+e');
  await page.keyboard.type('div');
  await page.getByText('<div>', { exact: true }).first().waitFor();
  const shown = await held(frame, 'h1,div,p,p', () => page.keyboard.press('Enter'));
  await settle(frame, 'h1,div,p,p', shown);
  console.log(JSON.stringify({ operation: 'insert', firstChangeMs: shown.firstChangeMs }));
  await undo(page, frame, 'h1,p,p');
}

async function checkDelete(page: Page, frame: Frame) {
  await row(page, 'n0.1.1.2').click();
  const shown = await held(frame, 'h1,p', () => page.keyboard.press('Delete'));
  await settle(frame, 'h1,p', shown);
  console.log(JSON.stringify({ operation: 'delete', firstChangeMs: shown.firstChangeMs }));
  await undo(page, frame, 'h1,p,p');
}

async function checkReorder(page: Page, frame: Frame) {
  const source = await row(page, 'n0.1.1.2').boundingBox();
  const target = await page.locator('.nav-gap[data-drop-parent="n0.1.1"][data-drop-index="0"]').boundingBox();
  assert.ok(source, 'The dragged row is on screen');
  assert.ok(target, 'The drop gap is on screen');
  await page.mouse.move(source.x + 5, source.y + 5);
  await page.mouse.down();
  await page.mouse.move(target.x + 5, target.y + target.height / 2, { steps: 8 });
  const shown = await held(frame, 'p,h1,p', () => page.mouse.up());
  await settle(frame, 'p,h1,p', shown);
  console.log(JSON.stringify({ operation: 'reorder', firstChangeMs: shown.firstChangeMs }));
  await undo(page, frame, 'h1,p,p');
}

// The second delete names the path the first one shifted onto: the canvas must be numbered as the
// new source is, and a rendering of the first delete must not bring the second node back.
async function checkSuccessiveDeletes(page: Page, frame: Frame) {
  await row(page, 'n0.1.1.1').click();
  const shown = await held(frame, 'h1,p', () => page.keyboard.press('Delete'), { keepGate: true });
  // The Navigator shows the server's answer: the third paragraph is now n0.1.1.1.
  await page.waitForFunction(() => document.querySelectorAll('.structure-node[data-node-id="n0.1.1.2"]').length === 0);
  await row(page, 'n0.1.1.1').click();
  await page.keyboard.press('Delete');
  await frame.waitForFunction(() => document.querySelector('main')?.children.length === 1);
  const morphs = await frame.evaluate(() => window.studioInstantProbe?.morphs ?? -1);
  assert.equal(morphs, 0, 'Both deletes show while every rendering is held');
  await settle(frame, 'h1', shown);
  const shapes = (await frame.evaluate(() => window.studioInstantProbe?.shapes)) ?? [];
  const second = shapes.indexOf('h1');
  assert.ok(second > 0, 'The second delete was shown');
  assert.deepEqual(
    shapes.slice(second).filter((shape) => shape !== 'h1'),
    [],
    `Once shown, no rendering brought a deleted node back: ${shapes.join(' | ')}`,
  );
  console.log(JSON.stringify({ operation: 'successive-delete', firstChangeMs: shown.firstChangeMs, shapes }));
}

interface Shown {
  readonly firstChangeMs: number;
}

// Shuts the gate, records what the frame shows, makes the edit and waits for the canvas to show
// `expected`, which it must do before any rendering arrives.
async function held(frame: Frame, expected: string, act: () => Promise<void>, options: { readonly keepGate?: boolean } = {}): Promise<Shown> {
  await writeFile(gate, 'held');
  await frame.evaluate(installProbe, expected);
  const started = await frame.evaluate(() => performance.now());
  await act();
  await frame.waitForFunction(() => (window.studioInstantProbe?.shownAt ?? -1) >= 0, undefined, { timeout: 10_000 });
  const probe = await frame.evaluate(() => window.studioInstantProbe);
  assert.ok(probe, 'The frame probe is installed');
  assert.equal(probe.morphs, 0, `The canvas shows "${expected}" before any rendering arrives`);
  if (!options.keepGate) {
    await rm(gate, { force: true });
  }
  return { firstChangeMs: Math.round(probe.shownAt - started) };
}

// Opens the gate and waits for a rendering that leaves the page as shown.
async function settle(frame: Frame, expected: string, shown: Shown) {
  assert.ok(shown.firstChangeMs >= 0, 'A shown edit has a time');
  await rm(gate, { force: true });
  await frame.waitForFunction(
    (shape) => {
      const probe = window.studioInstantProbe;
      return probe !== undefined && probe.morphs > 0 && probe.shapes.at(-1) === shape;
    },
    expected,
    { timeout: 20_000 },
  );
}

async function undo(page: Page, frame: Frame, expected: string) {
  await page.keyboard.press('ControlOrMeta+z');
  await frame.waitForFunction(
    (shape) => [...(document.querySelector('main')?.children ?? [])].map((child) => child.tagName.toLowerCase()).join(',') === shape,
    expected,
  );
  // The undo's own rendering lands before the next edit is timed.
  await frame.evaluate(installProbe, expected);
  await frame.waitForFunction(() => (window.studioInstantProbe?.morphs ?? 0) > 0, undefined, { timeout: 20_000 });
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
  readonly shapes: string[];
}

declare global {
  interface Window {
    studioInstantProbe?: Probe;
  }
}

// In the frame: every page shape shown (sampled on each mutation), when `expected` first showed,
// and how many renderings arrived. Bounded: 200 shapes.
// No named functions inside: the page runs this source as it is, without the test's helpers.
function installProbe(expected: string): void {
  const probe: Probe = {
    shownAt: -1,
    morphs: 0,
    shapes: [[...(document.querySelector('main')?.children ?? [])].map((child) => child.tagName.toLowerCase()).join(',')],
  };
  window.studioInstantProbe = probe;
  const observer = new MutationObserver(() => {
    if (window.studioInstantProbe !== probe) {
      observer.disconnect();
      return;
    }
    const now = [...(document.querySelector('main')?.children ?? [])].map((child) => child.tagName.toLowerCase()).join(',');
    if (probe.shapes.at(-1) !== now && probe.shapes.length < 200) {
      probe.shapes.push(now);
    }
    if (probe.shownAt < 0 && now === expected) {
      probe.shownAt = performance.now();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
  document.addEventListener('avb:before-morph', () => {
    if (window.studioInstantProbe === probe) {
      probe.morphs++;
    }
  });
}
