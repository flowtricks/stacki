// Goal: clicking the dimmed canvas leaves component editing just as Desktop does.
// Method: enter a real Astro component, click inside and outside it, and verify source
// selection and iframe identity. Delay a save acknowledgment to check edits are kept.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { startStyleFixture } from './stylePanelFixture';

const source = `---
import Card from '../components/Card.astro';
---
<html><body><main style="padding:40px">
<Card /><p id="outside" style="margin-top:80px">Outside the component</p>
</main></body></html>`;
const component = '<section style="padding:30px"><h1>Inside the component</h1></section>';
const fixture = await startStyleFixture({ page: source, component });
const browser = await chromium.launch({
  executablePath:
    process.env['CHROME_PATH'] ?? (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : chromium.executablePath()),
  headless: true,
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(20_000);
  let holdSaves = false;
  const savedReplies: (() => void)[] = [];
  await page.routeWebSocket('**/studio/sync?*', (socket) => {
    const server = socket.connectToServer();
    server.onMessage((message) => {
      const value: unknown = JSON.parse(String(message));
      if (holdSaves && value && typeof value === 'object' && 'type' in value && value.type === 'saved') {
        assert.ok(savedReplies.length < 10, 'Delayed acknowledgments are bounded');
        savedReplies.push(() => socket.send(message));
      } else {
        socket.send(message);
      }
    });
  });
  await page.goto(fixture.url);
  await page.locator('.save-state').filter({ hasText: 'Saved' }).waitFor();
  const frame = page.frameLocator('iframe[title="Site preview"]');
  const element = await page.locator('iframe[title="Site preview"]').elementHandle();
  assert.ok(element);
  await frame.getByRole('heading', { name: 'Inside the component' }).dblclick();
  const back = page.getByTitle('Back to page', { exact: true });
  await back.waitFor();
  await page.locator('.save-state').filter({ hasText: 'Saved' }).waitFor();
  await frame.getByRole('heading', { name: 'Inside the component' }).click();
  assert.ok(await back.isVisible(), 'An inside click must keep component editing open');
  await frame.locator('#outside').click();
  await back.waitFor({ state: 'hidden' });
  await page.locator('.save-state').filter({ hasText: 'Saved' }).waitFor();
  assert.ok(await element.evaluate((node) => node === document.querySelector('iframe[title="Site preview"]')));
  assert.equal(await readFile(path.join(fixture.root, 'src/pages/index.astro'), 'utf8'), source);
  assert.equal(await readFile(path.join(fixture.root, 'src/components/Card.astro'), 'utf8'), component);
  await frame.getByRole('heading', { name: 'Inside the component' }).dblclick();
  await back.waitFor();
  await page.locator('.save-state').filter({ hasText: 'Saved' }).waitFor();
  await frame.getByRole('heading', { name: 'Inside the component' }).click();
  holdSaves = true;
  await page.locator('.rich-content').fill('Saved before leaving');
  await page.locator('.save-state').filter({ hasText: 'Saving' }).waitFor();
  await frame.locator('#outside').click();
  assert.ok(await back.isVisible(), 'A pending save keeps the component connected');
  // A parent update must not cancel the request to leave the component.
  await page.evaluate(() => window.dispatchEvent(new Event('studio:project-updated')));
  for (let attempt = 0; savedReplies.length === 0 && attempt < 100; attempt++) {
    await page.waitForTimeout(20);
  }
  assert.ok(savedReplies.length > 0, 'The server accepted the edit before navigation');
  holdSaves = false;
  for (const reply of savedReplies.splice(0)) {
    reply();
  }
  await back.waitFor({ state: 'hidden' });
  assert.equal(await readFile(path.join(fixture.root, 'src/components/Card.astro'), 'utf8'), component.replace('Inside the component', 'Saved before leaving'));
  await page.screenshot({ path: '/tmp/stacki-component-exit-verified.png' });
  console.log('Outside canvas click exits the component, keeps the iframe and preserves source.');
} finally {
  await browser.close();
  await fixture.stop();
}
