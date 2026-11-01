// Goal: verify variant feedback for both classes and conditional component children.
// Method: hover real options in a disposable draft, measure native pointer entry to
// verified DOM, then check cancel, shared commit, slots, and an untouched sibling.
// Browser marks use one clock. DOM observation does not claim a completed paint.
import assert from 'node:assert/strict';
import { chromium, type Page } from 'playwright';
import { startStyleFixture } from './stylePanelFixture';
import { record, string } from '../src/shared/validation';

const source = `---
import Card from '../components/Card.astro';
---
<html><head><title>Variant timing</title></head><body>
<Card variant="plain"><strong>Keep this slot</strong></Card>
<Card variant="plain"><em>Sibling slot</em></Card>
</body></html>`;
const component = `---
interface Props { variant?: 'plain' | 'accent' | 'list' | 'table'; }
const { variant = 'plain' } = Astro.props;
---
<section class={variant}>
{variant === 'list' ? <ul><li>List branch</li><li>Extra child</li></ul> :
 variant === 'table' ? <table><tbody><tr><td>Table branch</td></tr></tbody></table> :
 <p>Plain branch</p>}
<slot />
</section>
<style>.accent { color: rgb(120, 30, 90); }</style>`;
const fixture = await startStyleFixture({ page: source, component });
try {
  await checkVariants(fixture.url);
} finally {
  await fixture.stop();
}

async function checkVariants(url: string) {
  const browser = await chromium.launch({
    executablePath:
      process.env['CHROME_PATH'] ??
      (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : chromium.executablePath()),
    headless: true,
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const observer = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    for (const editor of [page, observer]) {
      editor.setDefaultTimeout(20_000);
      await editor.addInitScript(() => Reflect.set(window, '__name', (value: unknown) => value));
      await editor.goto(url);
      await editor.frameLocator('iframe[title="Site preview"]').locator('section').nth(1).waitFor();
    }
    await page.getByRole('button', { name: 'Expand all', exact: true }).click();
    await page
      .locator('.structure-node')
      .filter({ has: page.locator('.label', { hasText: /^Card$/ }) })
      .first()
      .click();
    await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
    await page.getByRole('button', { name: 'plain', exact: true }).click();
    for (const value of ['accent', 'list', 'table', 'accent']) {
      await measureHover(page, value);
      await checkBranch(page, value);
      await checkBranch(observer, 'plain');
      assert.equal(await readSource(page), source, 'Hover must not write the shared source');
    }
    await page.keyboard.press('Escape');
    await checkBranch(page, 'plain');
    assert.equal(await readSource(page), source, 'Cancel preserves the exact source');
    await page.getByRole('button', { name: 'plain', exact: true }).click();
    await page
      .locator('.dd-option')
      .filter({ hasText: /^table$/ })
      .click();
    await checkBranch(page, 'table');
    await checkBranch(observer, 'table');
    assert.match(await readSource(page), /variant="table"/);
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
    await checkBranch(page, 'plain');
    await checkBranch(observer, 'plain');
    assert.equal(await readSource(page), source, 'Undo restores the exact shared source');
    console.log('Variant classes, conditional children, cancel, slots, sibling, shared commit and undo passed.');
  } finally {
    await browser.close();
  }
}

async function measureHover(page: Page, value: string) {
  const option = page.locator('.dd-option').filter({ hasText: new RegExp(`^${value}$`) });
  await option.evaluate((element) => {
    performance.clearMarks('variant-input');
    performance.clearMarks('variant-observed');
    element.addEventListener(
      'pointerenter',
      () => {
        performance.mark('variant-input');
        const started = performance.now();
        const inspect = () => {
          const section = document.querySelector<HTMLIFrameElement>('iframe[title="Site preview"]')?.contentDocument?.querySelector('section');
          if (section?.className === element.textContent?.trim()) {
            performance.mark('variant-observed');
          } else if (performance.now() - started < 10_000) {
            requestAnimationFrame(inspect);
          }
        };
        requestAnimationFrame(inspect);
      },
      { capture: true, once: true },
    );
  });
  await option.hover();
  await page.waitForFunction(() => performance.getEntriesByName('variant-observed').length === 1);
  const elapsed = await page.evaluate(() => {
    const input = performance.getEntriesByName('variant-input')[0];
    const observed = performance.getEntriesByName('variant-observed')[0];
    if (!input || !observed) {
      throw new Error('Variant timing requires both browser marks');
    }
    return observed.startTime - input.startTime;
  });
  assert.ok(elapsed >= 0, 'Observation follows the native hover event');
  console.log(JSON.stringify({ workload: 'variant-hover', value, inputToObservedMs: elapsed }));
}

async function checkBranch(page: Page, value: string) {
  const canvas = page.frameLocator('iframe[title="Site preview"]');
  const first = canvas.locator('section').first();
  await page.waitForFunction((value) => {
    const frame = document.querySelector<HTMLIFrameElement>('iframe[title="Site preview"]');
    return frame?.contentDocument?.querySelector('section')?.classList.contains(value);
  }, value);
  const branch = value === 'list' ? 'ul li' : value === 'table' ? 'table td' : 'p';
  assert.equal(await first.locator(branch).count(), value === 'list' ? 2 : 1);
  assert.equal(await first.locator('ul').count(), value === 'list' ? 1 : 0);
  assert.equal(await first.locator('table').count(), value === 'table' ? 1 : 0);
  assert.equal(await first.locator('p').count(), value === 'list' || value === 'table' ? 0 : 1);
  assert.equal(await first.locator('strong').textContent(), 'Keep this slot');
  assert.equal(await canvas.locator('section').nth(1).getAttribute('class'), 'plain');
  assert.equal(await canvas.locator('section').nth(1).locator('em').textContent(), 'Sibling slot');
  if (value === 'accent') {
    assert.equal(await first.evaluate((element) => getComputedStyle(element).color), 'rgb(120, 30, 90)');
  }
}

async function readSource(page: Page) {
  const response = await page.request.get(new URL('/studio/api/file?file=src/pages/index.astro', fixture.url).href);
  assert.ok(response.ok(), 'Fixture source must be readable');
  const data: unknown = await response.json();
  return string(record(data)['source']);
}
