import { chromium, type Page } from 'playwright';
import assert from 'node:assert/strict';
import { writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { record, string } from '../src/shared/validation';

const root = process.env['STUDIO_FIXTURE_ROOT'];
assert.ok(root && root.includes('/.studio/'), 'Use an isolated Studio fixture, never website source');
const url = process.env['STUDIO_URL'] ?? 'http://127.0.0.1:4360/studio';
assert.equal(new URL(url).hostname, '127.0.0.1');
const componentFile = path.join(root, 'src/components/VariantProbe.astro');
const pageFile = path.join(root, 'src/pages/variant-check.astro');
const source = `---
import VariantProbe from '../components/VariantProbe.astro';
---
<html><head><title>Variant check</title></head><body>
<VariantProbe variant="plain"><strong>Keep this slot</strong></VariantProbe>
<VariantProbe variant="plain"><em>Sibling slot</em></VariantProbe>
</body></html>
`;
await writeFile(
  componentFile,
  `---
interface Props { variant?: 'plain' | 'list' | 'table'; }
const {variant = 'plain'} = Astro.props;
---
<section data-probe={variant}>
{variant === 'list' ? <ul><li>List branch</li><li>Extra child</li></ul> : variant === 'table' ? <table><tbody><tr><td>Table branch</td></tr></tbody></table> : <p>Plain branch</p>}
<slot />
</section>
`,
  { flag: 'wx' },
);
await writeFile(pageFile, source, { flag: 'wx' });
const browser = await chromium.launch({
  executablePath: process.env['CHROME_PATH'] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const observer = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors: string[] = [];
page.on('pageerror', (error) => errors.push(error.message));
const received = new Set<string>();
let dropVariants = false;
await page.routeWebSocket('**/*', (socket) => {
  const server = socket.connectToServer();
  server.onMessage((message) => {
    const text = String(message);
    if (text.includes('"event":"studio:variant-render"')) {
      const data = record(record(JSON.parse(text))['data']);
      if (typeof data['value'] === 'string' || data['value'] === null) {
        received.add(String(data['value']));
      }
      if (dropVariants) {
        return;
      }
    }
    socket.send(message);
  });
});
try {
  await openPage(page);
  await openPage(observer);
  const canvas = page.frameLocator('iframe[title="Site preview"]');
  const other = observer.frameLocator('iframe[title="Site preview"]');
  await page
    .locator('.structure-node')
    .filter({ has: page.locator('.label', { hasText: /^VariantProbe$/ }) })
    .first()
    .click();
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
  await page.getByRole('button', { name: 'plain', exact: true }).click();
  await page
    .locator('.dd-option')
    .filter({ hasText: /^list$/ })
    .hover();
  await canvas.locator('section').first().locator('ul li').nth(1).waitFor();
  assert.equal(await canvas.locator('section').first().locator('strong').textContent(), 'Keep this slot');
  assert.equal(await canvas.locator('section').nth(1).getAttribute('data-probe'), 'plain');
  assert.equal(await other.locator('ul').count(), 0, 'Other editors never see speculative HTML');
  assert.equal(await readSource(), source, 'Hover must never write the shared draft');
  while (received.size < 3) {
    await page.waitForTimeout(20);
  }
  dropVariants = true;
  const started = performance.now();
  await page
    .locator('.dd-option')
    .filter({ hasText: /^table$/ })
    .hover();
  await canvas.locator('section').first().locator('table td').waitFor();
  const elapsed = Math.round(performance.now() - started);
  assert.ok(elapsed < 500, `Cached HTML should paint promptly (${elapsed}ms)`);
  await page.keyboard.press('Escape');
  await canvas.locator('section').first().locator('p').waitFor();
  assert.equal(await readSource(), source);
  dropVariants = false;
  await page.getByRole('button', { name: 'plain', exact: true }).click();
  await page
    .locator('.dd-option')
    .filter({ hasText: /^table$/ })
    .hover();
  await canvas.locator('table').waitFor();
  await page
    .locator('.dd-option')
    .filter({ hasText: /^table$/ })
    .click();
  await other.locator('table').waitFor();
  assert.ok((await readSource()).includes('variant="table"'));
  assert.deepEqual(errors, []);
  console.log(`HTML variants: cached table in ${elapsed}ms, slots/siblings preserved, draft untouched on hover/cancel, commit shared.`);
} finally {
  await browser.close();
  await rm(pageFile);
  await rm(componentFile);
}
async function openPage(target: Page) {
  await target.goto(url);
  await target.getByRole('button', { name: 'Current page', exact: true }).click();
  await target.getByRole('option').filter({ hasText: 'variant-check' }).click();
  await target.frameLocator('iframe[title="Site preview"]').locator('section').nth(1).waitFor();
  await target.getByRole('button', { name: 'Expand all', exact: true }).click();
}
async function readSource() {
  const response = await page.request.get(new URL('/studio/api/file?file=src/pages/variant-check.astro', url).href);
  return string(record(await response.json())['source']);
}
