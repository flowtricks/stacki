// Goal: refreshing panels keeps readable counts and preserves the active page style.
// Method: hold real component-usage responses in a disposable Astro fixture, change
// its source, and verify cached counts until the fresh response is released.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { startStyleFixture } from './stylePanelFixture';

const source = `---
import Card from '../components/Card.astro';
---
<html><body><Card /></body></html>`;
const fixture = await startStyleFixture({ page: source });
const browser = await chromium.launch({
  executablePath:
    process.env['CHROME_PATH'] ?? (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : chromium.executablePath()),
  headless: true,
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(20_000);
  let holding = true;
  const replies: (() => void)[] = [];
  await page.route('**/studio/api/component-usage', async (route) => {
    const response = await route.fetch();
    if (holding) {
      assert.ok(replies.length < 4, 'Component refresh requests stay bounded');
      await new Promise<void>((resolve) => {
        replies.push(resolve);
      });
    }
    await route.fulfill({ response });
  });
  await page.goto(fixture.url);
  await page.locator('.save-state').filter({ hasText: 'Saved' }).waitFor();
  await page.getByRole('button', { name: 'Components', exact: true }).click();
  const count = page.locator('.palette-item').filter({ hasText: 'Card' }).locator('.palette-instances');
  await count.filter({ hasText: 'Checking instances...' }).waitFor();
  const loadingStyle = await count.evaluate((element) => {
    const style = getComputedStyle(element);
    return { color: style.color, opacity: style.opacity };
  });
  assert.equal(loadingStyle.opacity, '1');
  const label = count.locator('.panel-loading-label');
  assert.equal(await label.evaluate((element) => getComputedStyle(element).animationName), 'panel-loading-highlight');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await label.evaluate((element) => getComputedStyle(element).animationName), 'none');
  assert.equal(await label.evaluate((element) => getComputedStyle(element).color), loadingStyle.color);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  holding = false;
  for (const release of replies.splice(0)) {
    release();
  }
  await count.filter({ hasText: /^1 instance$/ }).waitFor();
  assert.equal(await count.evaluate((element) => getComputedStyle(element).color), loadingStyle.color);
  await page.getByRole('button', { name: 'Navigator', exact: true }).click();
  await writeFile(path.join(fixture.root, 'src/pages/index.astro'), source.replace('<Card />', '<Card /><Card />'));
  holding = true;
  await page.getByRole('button', { name: 'Components', exact: true }).click();
  await count.filter({ hasText: /^1 instance$/ }).waitFor({ timeout: 1000 });
  assert.equal(await page.getByText('Checking instances...', { exact: true }).count(), 0);
  for (let attempt = 0; replies.length === 0 && attempt < 100; attempt++) {
    await page.waitForTimeout(20);
  }
  assert.ok(replies.length > 0, 'Fresh counts are pending while the cached count stays visible');
  holding = false;
  for (const release of replies.splice(0)) {
    release();
  }
  await count.filter({ hasText: /^2 instances$/ }).waitFor();
  await page.getByRole('button', { name: 'Pages', exact: true }).click();
  const active = page.locator('.studio-page-list .list-item.active');
  await active.waitFor();
  await page.mouse.move(1200, 20);
  const background = await active.evaluate((element) => getComputedStyle(element).backgroundColor);
  await active.hover();
  assert.equal(
    await active.evaluate((element) => getComputedStyle(element).backgroundColor),
    background,
    'Hovering the active page must not change its background',
  );
  console.log('Readable loading counts, cached reopen counts, fresh results and active page styling pass.');
} finally {
  await browser.close();
  await fixture.stop();
}
