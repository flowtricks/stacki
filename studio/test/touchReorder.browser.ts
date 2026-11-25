// Goal: on a phone, a held touch reorders the Navigator, and the canvas shows the new order
// in the frame after the drop or the one after it, long before the page is rebuilt. A swipe
// that does not hold still scrolls and starts no drag.
// Method: the iPhone 13 profile against a running editor (STUDIO_URL, default the
// stacki.build demo on :8787), in two engines, because Playwright cannot pan WebKit natively:
//   • WebKit (Safari's engine): the touch is dispatched as iOS sends it (pointerdown and
//     touchstart, a hold, then pointermove and touchmove, then pointerup). Once the drag has
//     started, every touchmove must be cancelled, which is what stops iOS from turning it into
//     the list's scroll and sending pointercancel (measured on the iOS Simulator; see
//     src/features/navigator/useTouchTree.ts). A swipe with no hold must not start a drag.
//   • Chromium: a real touch through `Input.dispatchTouchEvent`, which honours touch-action
//     and cancelled touchmoves as a phone does.
// In both, the Heading row is dropped below the Paragraph row, and the canvas's own order is
// read two animation frames after the drop, before the rebuilt page arrives.
// Run: `STUDIO_URL=http://localhost:8787/ npx tsx test/touchReorder.browser.ts` from studio/.
import assert from 'node:assert/strict';
import { chromium, devices, webkit, type Browser, type Page } from 'playwright';

const URL = process.env['STUDIO_URL'] ?? 'http://localhost:8787/';
const HOLD_MS = 400;
const MOVE_STEPS = 10;

const failures: string[] = [];
await run(webkit, dragWebKit);
await run(chromium, dragChromium);
assert.deepEqual(failures, []);
console.log('A held touch reorders the Navigator and the canvas shows it within two frames, in WebKit and Chromium.');

async function run(engine: typeof webkit | typeof chromium, drag: (page: Page, from: Box, to: Box) => Promise<void>): Promise<void> {
  const browser: Browser = await engine.launch(
    engine === chromium ? { executablePath: process.env['CHROME_PATH'] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' } : {},
  );
  try {
    const context = await browser.newContext({ ...devices['iPhone 13'], reducedMotion: 'reduce' });
    // tsx names the arrow functions inside page.evaluate with a `__name` helper the page lacks.
    await context.addInitScript('globalThis.__name = (target) => target;');
    const page = await context.newPage();
    page.setDefaultTimeout(60000);
    page.on('pageerror', (error) => failures.push(`${engine.name()}: ${error.message}`));
    await openNavigator(page);
    const before = await rowOrder(page);
    assert.ok(before.indexOf('Heading') < before.indexOf('Paragraph'), `${engine.name()}: the page starts with the heading first`);
    await watchCanvas(page);
    const from = await box(page, '.structure-node[data-node-id="n0.0.0.1"]');
    const to = await box(page, '.nav-gap[data-drop-parent="n0.0.0"][data-drop-index="3"]');
    await drag(page, from, to);
    await page.waitForFunction(() => document.querySelectorAll('.structure-node').length > 0);
    const after = await rowOrder(page);
    if (after.indexOf('Heading') < after.indexOf('Paragraph')) {
      failures.push(`${engine.name()}: the Navigator did not reorder (${after.join(', ')})`);
    }
    const canvas = await page.evaluate(() => (window as unknown as { __canvasOrder?: string }).__canvasOrder ?? 'not recorded');
    if (!/^[^,]*,P,H1/.test(canvas)) {
      failures.push(`${engine.name()}: two frames after the drop the canvas showed ${canvas}`);
    }
  } finally {
    await browser.close();
  }
}

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

async function box(page: Page, selector: string): Promise<Box> {
  const found = await page.locator(selector).boundingBox();
  assert.ok(found, `${selector} is on screen`);
  return found;
}

async function openNavigator(page: Page): Promise<void> {
  await page.goto(URL);
  const exit = page.getByRole('button', { name: 'Exit preview (Esc)' });
  const preview = page.frameLocator('iframe[title="Site preview"]').locator('h1').first();
  await Promise.race([exit.waitFor(), preview.waitFor()]);
  if (await exit.isVisible()) {
    await exit.tap();
  }
  await preview.waitFor();
  await page.getByRole('button', { name: 'Navigator', exact: true }).tap();
  await page.getByRole('button', { name: 'Expand all', exact: true }).tap();
  await page.locator('.structure-node[data-node-id="n0.0.0.2"]').waitFor();
}

async function rowOrder(page: Page): Promise<string[]> {
  return page.locator('.structure-node[data-node-id^="n0.0.0."]').evaluateAll((rows) => rows.map((row) => row.textContent?.trim() ?? ''));
}

// On the drop, the canvas is read two animation frames later: the frame the drop landed in
// and the one after it.
async function watchCanvas(page: Page): Promise<void> {
  await page.evaluate(() => {
    const frame = document.querySelector<HTMLIFrameElement>('iframe[title="Site preview"]')?.contentWindow;
    if (!frame) {
      throw new Error('the canvas frame is same-origin in the demo');
    }
    document.addEventListener(
      'drop',
      () => {
        frame.requestAnimationFrame(() =>
          frame.requestAnimationFrame(() => {
            const heading = frame.document.querySelector('h1');
            const tags = [...(heading?.parentElement?.children ?? [])].map((element) => element.tagName);
            (window as unknown as { __canvasOrder?: string }).__canvasOrder = tags.join(',');
          }),
        );
      },
      { capture: true, once: true },
    );
  });
}

// iOS's event order for a held touch, dispatched by hand: WebKit in Playwright has no touch
// input of its own. Every touchmove after the hold must come back cancelled.
async function dragWebKit(page: Page, from: Box, to: Box): Promise<void> {
  const swipe = await page.evaluate(
    async ({ from, steps }) => {
      const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
      const row = document.elementFromPoint(from.x + 60, from.y + from.height / 2);
      if (!row) {
        throw new Error('the row is under the finger');
      }
      let started = 0;
      const count = () => {
        started += 1;
      };
      document.addEventListener('dragstart', count, true);
      const x = from.x + 60;
      const y = from.y + from.height / 2;
      row.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerType: 'touch', pointerId: 3, isPrimary: true, clientX: x, clientY: y }),
      );
      for (let step = 1; step <= steps; step++) {
        window.dispatchEvent(
          new PointerEvent('pointermove', {
            bubbles: true,
            cancelable: true,
            pointerType: 'touch',
            pointerId: 3,
            isPrimary: true,
            clientX: x,
            clientY: y - step * 6,
          }),
        );
        await wait(16);
      }
      window.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerType: 'touch', pointerId: 3, isPrimary: true }));
      await wait(500);
      document.removeEventListener('dragstart', count, true);
      return started;
    },
    { from, steps: MOVE_STEPS },
  );
  if (swipe !== 0) {
    failures.push('webkit: a swipe with no hold started a drag');
  }
  const cancelled = await page.evaluate(
    async ({ from, to, hold, steps }) => {
      const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
      const x = from.x + 60;
      const y = from.y + from.height / 2;
      const targetY = to.y + to.height / 2;
      const row = document.elementFromPoint(x, y);
      if (!row) {
        throw new Error('the row is under the finger');
      }
      const pointer = (type: string, target: EventTarget, pointY: number) =>
        target.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            pointerType: 'touch',
            pointerId: 4,
            isPrimary: true,
            clientX: x,
            clientY: pointY,
            buttons: 1,
          }),
        );
      // WebKit in Playwright constructs TouchEvent without touch lists; what matters here is
      // whether the listener cancels it.
      const touch = (pointY: number): boolean => {
        const event = new Event('touchmove', { bubbles: true, cancelable: true });
        document.elementFromPoint(x, pointY)?.dispatchEvent(event);
        return event.defaultPrevented;
      };
      pointer('pointerdown', row, y);
      row.dispatchEvent(new Event('touchstart', { bubbles: true, cancelable: true }));
      await wait(hold);
      const results: boolean[] = [];
      for (let step = 1; step <= steps; step++) {
        const pointY = y + ((targetY - y) * step) / steps;
        results.push(touch(pointY));
        pointer('pointermove', document.elementFromPoint(x, pointY) ?? document.body, pointY);
        await wait(16);
      }
      pointer('pointerup', document.elementFromPoint(x, targetY) ?? document.body, targetY);
      await wait(100);
      return results;
    },
    { from, to, hold: HOLD_MS, steps: MOVE_STEPS },
  );
  if (!cancelled.every(Boolean)) {
    failures.push(`webkit: a touchmove during the drag was left to scroll (${cancelled.join(',')})`);
  }
}

// A real touch: Chromium pans, honours touch-action and cancelled touchmoves, and sends
// pointercancel when it scrolls, as a phone does.
async function dragChromium(page: Page, from: Box, to: Box): Promise<void> {
  const session = await page.context().newCDPSession(page);
  const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', x: number, y: number) =>
    session.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
  const x = from.x + 60;
  const y = from.y + from.height / 2;
  const targetY = to.y + to.height / 2;
  await touch('touchStart', x, y);
  await page.waitForTimeout(HOLD_MS);
  for (let step = 1; step <= MOVE_STEPS; step++) {
    await touch('touchMove', x, y + ((targetY - y) * step) / MOVE_STEPS);
    await page.waitForTimeout(16);
  }
  await touch('touchEnd', x, targetY);
  await page.waitForTimeout(300);
}
