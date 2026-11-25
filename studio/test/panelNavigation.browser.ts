// Goal: Assets, CMS and Variables retain content when their panels remount.
// Method: hold real API responses before first load and again after switching away;
// assert distinct loading/empty states and immediate cached content while revalidating.
import assert from 'node:assert/strict';
import { chromium, type Page } from 'playwright';
import { startStyleFixture } from './stylePanelFixture';

const fixture = await startStyleFixture({
  page: '---\nconst items = [{ title: "One" }];\n---\n<main><h1>Panel checks</h1></main>',
});
const browser = await chromium.launch({
  executablePath:
    process.env['CHROME_PATH'] ?? (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : chromium.executablePath()),
  headless: true,
});
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(20_000);
  await page.goto(fixture.url);
  await page.locator('.save-state').filter({ hasText: 'Saved' }).waitFor();
  for (const panel of [
    { name: 'Assets', endpoint: 'assets', loading: 'Loading assets', content: 'public' },
    { name: 'Collections', endpoint: 'cms', loading: 'Loading collections', content: 'items' },
    {
      name: 'Variables',
      endpoint: 'variables',
      loading: 'Loading CSS variables',
      content: 'global.css',
    },
  ]) {
    await checkPanel(page, panel);
  }
} finally {
  await browser.close();
  await fixture.stop();
}

async function checkPanel(
  page: Page,
  panel: {
    readonly name: string;
    readonly endpoint: string;
    readonly loading: string;
    readonly content: string;
  },
) {
  const route = `**/studio/api/${panel.endpoint}`;
  for (const phase of ['initial', 'reopen']) {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let requests = 0;
    await page.route(route, async (request) => {
      requests++;
      assert.ok(requests <= 4, 'Panel reads remain bounded');
      await gate;
      await request.continue();
    });
    try {
      await page.getByRole('button', { name: panel.name, exact: true }).click();
      if (panel.name === 'Collections') {
        assert.equal(await page.locator('.studio-editor-content > .cms-view').count(), 0);
        assert.ok(await page.locator('.studio-editor-content iframe').first().isVisible());
      }
      const rail = page.locator('aside').first();
      if (phase === 'initial') {
        await rail.getByRole('status', { name: panel.loading, exact: false }).waitFor();
        assert.equal(await rail.locator('.panel-loading').innerText(), '');
        assert.equal(await rail.locator('.panel-loading').evaluate((element) => getComputedStyle(element).padding), '0px');
      } else {
        if (panel.name === 'Collections') {
          // The cached folder list appears before the default single-folder selection.
          assert.ok(await rail.locator('.cms-collection').count());
        } else {
          assert.ok((await rail.innerText()).toLowerCase().includes(panel.content.toLowerCase()), `${panel.name} reopens immediately`);
        }
        assert.ok(!(await rail.innerText()).includes(panel.loading));
      }
      assert.ok(!/Empty folder|No collections to show|No CSS custom properties/.test(await rail.innerText()));
      release();
      await rail.getByText(panel.content, { exact: false }).first().waitFor();
      await page.getByRole('button', { name: 'Navigator', exact: true }).click();
    } finally {
      release();
      await page.unrouteAll({ behavior: 'wait' });
    }
  }
  console.log(`${panel.name}: loading on first visit, cached content on reopen, fresh background read.`);
}
