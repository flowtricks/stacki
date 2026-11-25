// Goal: collect input-to-observed-value samples using the actual Studio style panel.
// Method: edit a disposable fixture through native input events, verify its computed
// opacity and successful source writes, and report first-edit and warm samples.
// This is a small local workload; it is not a Cloudflare or large-project benchmark.
// Run after `npm run build`: `node --import tsx test/editLatency.browser.ts`.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startStyleFixture } from './stylePanelFixture';
import { measureStyleInput } from './editLatencyProbe';

const fixture = await startStyleFixture();
try {
  await measureFixture(fixture.url);
} finally {
  await fixture.stop();
}

async function measureFixture(url: string) {
  const browser = await chromium.launch({
    executablePath:
      process.env['CHROME_PATH'] ??
      (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : chromium.executablePath()),
    headless: true,
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1500, height: 1050 } });
    page.setDefaultTimeout(20_000);
    // esbuild's function-name helper also appears in functions serialized to the page.
    await page.addInitScript(() => Reflect.set(window, '__name', (value: unknown) => value));
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.locator('.save-state').filter({ hasText: 'Saved' }).waitFor();
    const preview = page.locator('iframe[title="Site preview"]');
    await page
      .frameLocator('iframe[title="Site preview"]')
      .locator('#target')
      .click({ position: { x: 5, y: 5 } });
    await page.getByRole('button', { name: 'Style', exact: true }).click();
    const selector = page.locator('.embed-editor_selector-chip').filter({ hasText: /^\.component$/ });
    await selector.and(page.locator(':enabled')).waitFor();
    await selector.click();
    const input = page.getByRole('textbox', { name: 'Opacity', exact: true });
    const element = await preview.elementHandle();
    assert.ok(element, 'The fixture must have a preview frame');
    const frame = await element.contentFrame();
    assert.ok(frame, 'The preview frame must be attached');
    for (const [index, value] of ['0.61', '0.62', '0.63', '0.64', '0.65', '0.66'].entries()) {
      const result = await measureStyleInput(page, frame, input, value);
      console.log(
        JSON.stringify({
          workload: 'component-opacity',
          phase: index ? 'warm' : 'first',
          ...result,
        }),
      );
    }
  } finally {
    await browser.close();
  }
}
