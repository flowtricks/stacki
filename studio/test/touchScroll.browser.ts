// Goal: on a phone, a vertical swipe over the Style panel scrolls it, wherever the finger
// lands: on a section header, a spacing or position band, a spacing number, a scrubbable label
// or a slider. Those controls once took every touch outright (`touch-action: none` and a write
// on the press), so a swipe edited a value instead of scrolling. They now claim a touch only
// once a horizontal drag or a held press is clear (src/ui/touchClaim.ts).
// Method: the iPhone 13 profile, touch enabled, against a running editor (STUDIO_URL, default
// the stacki.build demo on :8787). Two engines, because Playwright cannot pan WebKit natively:
//   • WebKit (Safari's engine): for each start point, the swipe's touch and pointer events are
//     dispatched as iOS sends them (press, vertical moves with a few pixels of drift, then the
//     pointercancel iOS sends once it scrolls). No listener may cancel them, every element
//     under the finger must allow a vertical pan, no value may change, and the element hit
//     must sit inside the panel's bounded scroll container (no layer above it). Mobile WebKit
//     has no wheel either, so the pan itself is applied by hand and must move scrollTop.
//   • Chromium: a real touch swipe through `Input.dispatchTouchEvent`, which pans natively and
//     honours touch-action and cancelled touchmoves, must change the panel's scrollTop, and a
//     horizontal drag on a scrub label must still change its value.
// Run: `STUDIO_URL=http://localhost:8787/ npx tsx test/touchScroll.browser.ts` from studio/.
import assert from 'node:assert/strict';
import { chromium, devices, webkit, type Browser, type Page } from 'playwright';

const URL = process.env['STUDIO_URL'] ?? 'http://localhost:8787/';
const PANEL = '.studio-right.mobile-open';
const SCROLLER = `${PANEL} .embed-editor_root`;
// Where swipes start: a plain header, then each kind of drag control in the panel.
const STARTS = [
  '.embed-editor_section-header',
  '.embed-editor_spacing-label.embed-editor_spacing-left',
  'svg.embed-editor_spacing-fill',
  '.u-field-label.is-active',
  '.u-drag-slider',
] as const;
const SWIPE_PX = 150;
const SWIPE_STEPS = 12;
const DRIFT_PX = 4;

const failures: string[] = [];
await run(webkit, checkWebKit);
await run(chromium, checkChromium);
assert.deepEqual(failures, []);
console.log('Touch swipes scroll the Style panel from every start point in WebKit and Chromium.');

async function run(engine: typeof webkit | typeof chromium, check: (page: Page) => Promise<void>): Promise<void> {
  const browser: Browser = await engine.launch(
    engine === chromium ? { executablePath: process.env['CHROME_PATH'] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' } : {},
  );
  try {
    const context = await browser.newContext({ ...devices['iPhone 13'], reducedMotion: 'reduce' });
    // tsx names the arrow functions inside page.evaluate with a `__name` helper the page lacks.
    await context.addInitScript('globalThis.__name = (target) => target;');
    if (engine === webkit) {
      // The WebKit swipe is synthetic, so its pointer id is not a live pointer and capturing it
      // throws NotFoundError. Capture cannot be checked with synthetic pointers; let it pass.
      await context.addInitScript(`{
        const capture = Element.prototype.setPointerCapture;
        Element.prototype.setPointerCapture = function (id) {
          try { capture.call(this, id); } catch (error) { if (!(error instanceof DOMException)) { throw error; } }
        };
      }`);
    }
    const page = await context.newPage();
    page.setDefaultTimeout(60000);
    page.on('pageerror', (error) => failures.push(`${engine.name()}: ${error.message}`));
    await openStylePanel(page);
    await check(page);
  } finally {
    await browser.close();
  }
}

async function openStylePanel(page: Page): Promise<void> {
  await page.goto(URL);
  // The demo opens in preview; a project opens straight in the editor.
  const exit = page.getByRole('button', { name: 'Exit preview (Esc)' });
  const preview = page.frameLocator('iframe[title="Site preview"]').locator('h1').first();
  await Promise.race([exit.waitFor(), preview.waitFor()]);
  if (await exit.isVisible()) {
    await exit.tap();
  }
  await preview.tap();
  await page.locator('.preview-toolbar').getByRole('button', { name: 'Show style and settings panel', exact: true }).tap();
  await page.locator(PANEL).getByRole('button', { name: 'Style', exact: true }).tap();
  await page.locator(SCROLLER).waitFor();
  const bounded = await page.locator(SCROLLER).evaluate((element) => element.scrollHeight > element.clientHeight);
  assert.ok(bounded, 'The Style panel is a bounded scroll container');
}

// The start point's centre after scrolling it to the middle of the panel; a band starts on
// the left side's band, away from the numbers on it.
async function startPoint(page: Page, selector: string): Promise<{ x: number; y: number } | undefined> {
  await page.locator(SCROLLER).evaluate((element) => {
    element.scrollTop = 0;
  });
  const target = page.locator(`${PANEL} ${selector}`).first();
  if ((await target.count()) === 0) {
    return undefined;
  }
  await target.evaluate((element) => element.scrollIntoView({ block: 'center' }));
  const box = await target.boundingBox();
  if (box === null) {
    return undefined;
  }
  if (selector.startsWith('svg')) {
    return { x: box.x + 16, y: box.y + box.height / 2 };
  }
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function checkWebKit(page: Page): Promise<void> {
  for (const selector of STARTS) {
    const point = await startPoint(page, selector);
    if (point === undefined) {
      failures.push(`webkit: no ${selector} in the Style panel`);
      continue;
    }
    const before = await panelValues(page);
    const outcome = await page.evaluate(
      ({ x, y, swipe, steps, drift }) => {
        const target = document.elementFromPoint(x, y);
        if (target === null) {
          return { prevented: ['no element'], blocked: [] as string[], inside: false };
        }
        const blocked: string[] = [];
        for (let element: Element | null = target; element !== null; element = element.parentElement) {
          const action = getComputedStyle(element).touchAction;
          if (action !== 'auto' && !action.includes('pan-y') && action !== 'manipulation') {
            blocked.push(`${element.tagName.toLowerCase()}.${[...element.classList].join('.')}: ${action}`);
          }
        }
        const prevented: string[] = [];
        // A cancelled touchstart or touchmove stops the pan; a cancelled pointerdown does not
        // (it only stops compatibility mouse events), so the controls may still cancel that.
        const send = (event: Event) => {
          target.dispatchEvent(event);
          if (event.defaultPrevented && event.type.startsWith('touch')) {
            prevented.push(event.type);
          }
        };
        const pointer = (type: string, dx: number, dy: number) =>
          new PointerEvent(type, {
            bubbles: true,
            cancelable: type !== 'pointercancel',
            pointerId: 7,
            pointerType: 'touch',
            isPrimary: true,
            clientX: x + dx,
            clientY: y + dy,
            button: 0,
            buttons: 1,
          });
        // WebKit on macOS has no Touch constructor; listeners here read only the type and cancel.
        send(pointer('pointerdown', 0, 0));
        send(new Event('touchstart', { bubbles: true, cancelable: true }));
        for (let step = 1; step <= steps; step += 1) {
          const dx = Math.round((drift * step) / steps);
          const dy = -Math.round((swipe * step) / steps);
          send(pointer('pointermove', dx, dy));
          send(new Event('touchmove', { bubbles: true, cancelable: true }));
        }
        send(pointer('pointercancel', drift, -swipe));
        send(new Event('touchcancel', { bubbles: true, cancelable: false }));
        const inside = document.querySelector('.studio-right.mobile-open .embed-editor_root')?.contains(target) ?? false;
        return { prevented, blocked, inside };
      },
      { ...point, swipe: SWIPE_PX, steps: SWIPE_STEPS, drift: DRIFT_PX },
    );
    if (outcome.prevented.length > 0) {
      failures.push(`webkit ${selector}: the swipe's ${outcome.prevented.join(', ')} was cancelled`);
    }
    if (outcome.blocked.length > 0) {
      failures.push(`webkit ${selector}: no vertical pan through ${outcome.blocked.join('; ')}`);
    }
    if ((await panelValues(page)) !== before) {
      failures.push(`webkit ${selector}: the swipe changed a value`);
    }
    if (!outcome.inside) {
      failures.push(`webkit ${selector}: a layer over the panel takes the touch`);
      continue;
    }
    // Mobile WebKit here has neither a native pan nor a wheel, so the pan the unblocked swipe
    // starts is applied by hand: it must reach the panel's scroll container and move it.
    const top = await scrollTop(page);
    await page.locator(SCROLLER).evaluate((element, distance) => element.scrollBy(0, distance), SWIPE_PX);
    if ((await scrollTop(page)) <= top) {
      failures.push(`webkit ${selector}: the panel did not scroll from this point`);
    }
  }
}

async function checkChromium(page: Page): Promise<void> {
  const session = await page.context().newCDPSession(page);
  const swipe = async (from: { x: number; y: number }, to: { x: number; y: number }) => {
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [from] });
    for (let step = 1; step <= SWIPE_STEPS; step += 1) {
      const point = { x: from.x + ((to.x - from.x) * step) / SWIPE_STEPS, y: from.y + ((to.y - from.y) * step) / SWIPE_STEPS };
      await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [point] });
      await page.waitForTimeout(16);
    }
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(400);
  };
  for (const selector of STARTS) {
    const point = await startPoint(page, selector);
    if (point === undefined) {
      failures.push(`chromium: no ${selector} in the Style panel`);
      continue;
    }
    const before = await panelValues(page);
    const top = await scrollTop(page);
    await swipe(point, { x: point.x + DRIFT_PX, y: point.y - SWIPE_PX });
    if ((await scrollTop(page)) <= top) {
      failures.push(`chromium ${selector}: a touch swipe did not scroll the panel`);
    }
    if ((await panelValues(page)) !== before) {
      failures.push(`chromium ${selector}: the swipe changed a value`);
    }
  }
  // The negative space: a horizontal drag on a spacing number is still a drag.
  const label = await startPoint(page, '.embed-editor_spacing-label.embed-editor_spacing-left');
  if (label !== undefined) {
    const before = await panelValues(page);
    await swipe(label, { x: label.x - 60, y: label.y });
    if ((await panelValues(page)) === before) {
      failures.push('chromium: a horizontal drag on a spacing number did not change it');
    }
  }
}

async function scrollTop(page: Page): Promise<number> {
  return page.locator(SCROLLER).evaluate((element) => element.scrollTop);
}

// Every value the panel shows, as one string: a swipe must leave it as it was.
async function panelValues(page: Page): Promise<string> {
  return page
    .locator(SCROLLER)
    .evaluate((element) =>
      [...element.querySelectorAll('input, .embed-editor_spacing-label, [role="slider"]')]
        .map((field) => (field instanceof HTMLInputElement ? field.value : (field.getAttribute('aria-valuenow') ?? field.textContent ?? '')))
        .join('|'),
    );
}
