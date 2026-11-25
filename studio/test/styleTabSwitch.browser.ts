// Goal: switching the inspector from Settings back to Style must never paint an
// empty or partial Style panel. The panel once remounted on every switch and
// started from an empty stylesheet inventory, so the selector chips, values and
// "Add custom styles in" line vanished for a frame or more and then reappeared.
// Method: open the shared style fixture, select an element whose rules live in a
// component and a global stylesheet, then sample the inspector on every
// animation frame (plus every DOM mutation) across several Style -> Settings ->
// Style round trips. Each sample taken while Style is the active tab must show
// the same selector chips and the same Opacity value as before the switch.
import assert from 'node:assert/strict';
import { chromium, type Page } from 'playwright';
import { startStyleFixture } from './stylePanelFixture';

const ROUND_TRIPS = 4;
const FRAMES_SETTLE_MIN = 30;

const fixture = await startStyleFixture();
const browser = await chromium.launch({
  executablePath: process.env['CHROME_PATH'] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1500, height: 1050 } });
page.setDefaultTimeout(20000);
const errors: string[] = [];
page.on('pageerror', (error) => errors.push(error.message));
try {
  await page.addInitScript(() => {
    Reflect.set(window, '__name', (value: unknown) => value);
  });
  await page.goto(fixture.url);
  await page.locator('.save-state').filter({ hasText: 'Saved' }).waitFor();
  await page
    .frameLocator('iframe[title="Site preview"]')
    .locator('#target')
    .click({ position: { x: 5, y: 5 } });
  const style = page.getByRole('button', { name: 'Style', exact: true });
  const settings = page.getByRole('button', { name: 'Settings', exact: true });
  await style.click();
  await page
    .locator('.embed-editor_selector-chip')
    .filter({ hasText: /^\.component$/ })
    .waitFor();
  await page.waitForFunction(() => document.querySelector<HTMLInputElement>('input[aria-label="Opacity"]')?.value === '0.9');
  const settled = await snapshot(page);
  assert.ok(settled.chips.includes('.component'), `The settled panel must list the component rule: ${settled.chips.join(', ')}`);
  await startSampling(page, settled);
  for (let trip = 0; trip < ROUND_TRIPS; trip++) {
    await settings.click();
    await waitFrames(page, FRAMES_SETTLE_MIN);
    await style.click();
    await waitFrames(page, FRAMES_SETTLE_MIN);
  }
  const failures = await page.evaluate((): readonly string[] => {
    const report: unknown = Reflect.get(window, '__styleTabSamples');
    return Array.isArray(report) ? report.map((sample: unknown) => String(sample)) : ['The sampler did not run'];
  });
  assert.deepEqual(failures, [], 'Every Style-tab frame must show the settled chips and values');
  const counted = await page.evaluate(() => Number(Reflect.get(window, '__styleTabFrames')));
  assert.ok(counted >= ROUND_TRIPS * FRAMES_SETTLE_MIN, `The sampler must cover the switches (${counted} frames)`);
  assert.deepEqual(errors, []);
  console.log(`Style panel stays complete across ${ROUND_TRIPS} Settings -> Style switches (${counted} sampled frames).`);
} catch (error) {
  await page.screenshot({ path: 'test-results/style-tab-switch-failure.png' }).catch(() => {});
  throw error;
} finally {
  await browser.close();
  await fixture.stop();
}

interface PanelSnapshot {
  readonly chips: readonly string[];
  readonly opacity: string;
}

async function snapshot(page: Page): Promise<PanelSnapshot> {
  return page.evaluate(() => ({
    chips: [...document.querySelectorAll('.embed-editor_selector-chip')].map((chip) => chip.textContent.trim()),
    opacity: document.querySelector<HTMLInputElement>('input[aria-label="Opacity"]')?.value ?? '',
  }));
}

// Records a failure string for each sample, taken while the Style tab is the
// active one, whose chips or Opacity value differ from the settled panel.
async function startSampling(page: Page, settled: PanelSnapshot): Promise<void> {
  await page.evaluate((expected) => {
    const failures: string[] = [];
    let frames = 0;
    Reflect.set(window, '__styleTabSamples', failures);
    Reflect.set(window, '__styleTabFrames', 0);
    const sample = (origin: string): void => {
      const active = [...document.querySelectorAll('.right-tabs button.on')].map((button) => button.textContent.trim());
      if (active.includes('Style')) {
        const chips = [...document.querySelectorAll('.embed-editor_selector-chip')].map((chip) => chip.textContent.trim());
        const opacity = document.querySelector<HTMLInputElement>('input[aria-label="Opacity"]')?.value ?? '';
        if (chips.join('|') !== expected.chips.join('|')) {
          failures.push(`${origin} ${frames}: chips [${chips.join(', ')}]`);
        } else if (opacity !== expected.opacity) {
          failures.push(`${origin} ${frames}: opacity "${opacity}"`);
        }
      }
    };
    const frame = (): void => {
      frames++;
      Reflect.set(window, '__styleTabFrames', frames);
      sample('frame');
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    new MutationObserver(() => sample('mutation')).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
  }, settled);
}

async function waitFrames(page: Page, count: number): Promise<void> {
  await page.evaluate(
    (total) =>
      new Promise<void>((resolve) => {
        let left = total;
        const step = (): void => {
          left--;
          if (left > 0) {
            requestAnimationFrame(step);
          } else {
            resolve();
          }
        };
        requestAnimationFrame(step);
      }),
    count,
  );
}
