import { chromium, type Page } from 'playwright';
import assert from 'node:assert/strict';
import { startStyleFixture } from './stylePanelFixture';
import { mkdir } from 'node:fs/promises';

const fixture = await startStyleFixture();
const browser = await chromium.launch({
  executablePath: process.env['CHROME_PATH'] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(15000);
const errors: string[] = [];
page.on('pageerror', (error) => errors.push(error.message));
const failed = new Set<string>();
let unavailable = false;
let failures = 0;
let successes = 0;
// Polls of 100 ms each, five seconds in all, for the recovered inventories.
const RECOVERY_POLLS_MAX = 50;
// A server restart can interrupt the initial inventories. Subsequent replies
// are the real draft server's files, not a fabricated selector fixture.
await page.route('**/studio/api/styles*', async (route) => {
  const url = route.request().url();
  if (unavailable || !failed.has(url)) {
    failures++;
    failed.add(url);
    await route.fulfill({ status: 503, contentType: 'text/plain', body: 'Restarting' });
    return;
  }
  successes++;
  await route.continue();
});
try {
  await page.goto(fixture.url);
  await page.locator('.save-state').filter({ hasText: 'Saved' }).waitFor();
  await selectNode(page, '#target');
  await page.getByRole('button', { name: 'Style', exact: true }).click();
  const chips = page.locator('.embed-editor_selector-chip');
  await chips.filter({ hasText: /^\.sheet$/ }).waitFor();
  await chips.filter({ hasText: /^\.component$/ }).waitFor();
  assert.equal(failed.size, 2);
  const display = chips.filter({ hasText: /^\.sheet$/ });
  if ((await display.getAttribute('aria-pressed')) === 'true') {
    await display.click();
  }
  await display.and(page.locator('[aria-pressed="false"]')).waitFor();
  await display.click();
  await display.and(page.locator('[aria-pressed="true"]')).waitFor();
  await display.click();
  await display.and(page.locator('[aria-pressed="false"]')).waitFor();
  // Hiding is the checked state: unchecked shows the global `p` rule, checked hides it.
  const hideGlobals = page.getByRole('checkbox', { name: /Hide global selectors/ });
  await hideGlobals.uncheck();
  assert.ok((await chips.filter({ hasText: /^p$/ }).count()) > 0);
  await hideGlobals.check();
  assert.equal(await chips.filter({ hasText: /^p$/ }).count(), 0);
  await selectNode(page, '.card');
  await chips.filter({ hasText: /^\.card$/ }).waitFor();
  assert.equal(await chips.filter({ hasText: /^\.sheet$/ }).count(), 0);
  await selectNode(page, '#target');
  await chips.filter({ hasText: /^\.sheet$/ }).waitFor();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Style', exact: true }).click();
  await chips.filter({ hasText: /^\.sheet$/ }).waitFor();
  await chips.filter({ hasText: /^\.component$/ }).waitFor();
  await checkRecovery(page);
  await chips.filter({ hasText: /^\.component$/ }).waitFor();
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/style-selectors.png' });
  assert.deepEqual(errors, []);
  console.log('Selector loading recovers after interrupted inventories; Stacki chip selection, global filters, element switching, and reopening pass.');
} finally {
  await browser.close();
  await fixture.stop();
}
async function selectNode(page: Page, selector: string) {
  await page
    .frameLocator('iframe[title="Site preview"]')
    .locator(selector)
    .click({ position: { x: 5, y: 5 } });
}

// A failed inventory reports through the app's toast stack (not an inline alert),
// keeps the chips it already had, and recovers on the next focus or online event.
async function checkRecovery(page: Page) {
  await page.waitForLoadState('networkidle');
  failures = 0;
  unavailable = true;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.getByRole('region', { name: 'Notifications' }).getByText('Could not load stylesheet sources', { exact: false }).first().waitFor();
  // All three attempts fail, then stop. A failed refresh must retain the chips.
  await page.waitForTimeout(2500);
  assert.equal(failures, 6, 'Each of the two inventories gets at most three attempts');
  await page
    .locator('.embed-editor_selector-chip')
    .filter({ hasText: /^\.sheet$/ })
    .waitFor();
  unavailable = false;
  successes = 0;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  for (let attempt = 0; attempt < RECOVERY_POLLS_MAX && successes < 2; attempt++) {
    await page.waitForTimeout(100);
  }
  assert.equal(successes, 2, 'Both inventories reload once the server is back');
  assert.equal(failures, 6, 'A recovered server takes no further failed attempts');
}
