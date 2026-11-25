// Goal: another editor sees literal typing without waiting for Astro rendering.
// Method: two independent sessions edit a slot-rendering component that strips
// markers, while real pushed HTML is held and later delivered in order.
import assert from 'node:assert/strict';
import { chromium, type Page } from 'playwright';
import { startStyleFixture } from './stylePanelFixture';

const fixture = await startStyleFixture({
  page: `---
import Card from '../components/Card.astro';
---
<main><Card>Hello world</Card><p>Another element</p></main>`,
  component: `---
const content = (await Astro.slots.render('default')).replace(/<!--[\\s\\S]*?-->/g, '').trim();
---
<h1 {...Astro.props} set:html={content} />`,
});
try {
  await checkEditors();
} finally {
  await fixture.stop();
}

async function checkEditors() {
  const browser = await chromium.launch({
    executablePath:
      process.env['CHROME_PATH'] ??
      (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : chromium.executablePath()),
    headless: true,
  });
  try {
    const first = await browser.newPage();
    const second = await browser.newPage();
    const holds = await Promise.all([holdRenders(first), holdRenders(second)]);
    for (const page of [first, second]) {
      await page.addInitScript(() => Reflect.set(window, '__name', (value: unknown) => value));
      await page.goto(fixture.url);
      await page.frameLocator('iframe[title="Site preview"]').locator('h1').waitFor();
      await page.getByRole('button', { name: 'Expand all', exact: true }).click();
    }
    await first
      .locator('.structure-node')
      .filter({ has: first.locator('.label', { hasText: /^Card$/ }) })
      .click();
    holds.forEach((hold) => hold.enable());
    const input = first.locator('.rich-content');
    for (const text of ['Hello world one', 'Hello world two', 'Hello world & three']) {
      const start = performance.now();
      await input.fill(text);
      for (const page of [first, second]) {
        await page.frameLocator('iframe[title="Site preview"]').getByRole('heading', { name: text, exact: true }).waitFor({ timeout: 1000 });
      }
      console.log(JSON.stringify({ text, actionToBothObservedMs: performance.now() - start }));
    }
    await checkKeystrokes(first, second);
    await first.locator('.save-state').filter({ hasText: 'Saved' }).waitFor();
    assert.ok(
      holds.some((hold) => hold.count() > 0),
      'Actual server renders were held',
    );
    holds.forEach((hold) => hold.release());
    await input.fill('After delayed renders');
    await second.frameLocator('iframe[title="Site preview"]').getByRole('heading', { name: 'After delayed renders', exact: true }).waitFor();
  } finally {
    await browser.close();
  }
}

async function checkKeystrokes(first: Page, second: Page) {
  const input = first.locator('.rich-content');
  await input.press('End');
  let expected = await input.innerText();
  const timings: number[] = [];
  // Include spaces, punctuation and an entity, not just whole-value fills.
  // Each observation includes automation overhead and checks the actual peer DOM.
  for (const character of ' — live & shared!') {
    const started = performance.now();
    await input.pressSequentially(character);
    expected += character;
    await second.frameLocator('iframe[title="Site preview"]').getByRole('heading', { name: expected.trim(), exact: true }).waitFor({ timeout: 1000 });
    timings.push(performance.now() - started);
  }
  assert.equal(await input.innerText(), expected, 'Remote echoes preserve the local caret');
  const burst = ' continuous typing without waiting for peers';
  await input.pressSequentially(burst, { delay: 25 });
  expected += burst;
  await second.frameLocator('iframe[title="Site preview"]').getByRole('heading', { name: expected.trim(), exact: true }).waitFor({ timeout: 1000 });
  assert.equal(await input.innerText(), expected, 'Continuous typing preserves every character');
  console.log(JSON.stringify({ keystrokeToPeerObservedMs: timings }));
}

async function holdRenders(page: Page) {
  let enabled = false;
  const waiting: (() => void)[] = [];
  await page.routeWebSocket('**/*', (socket) => {
    const server = socket.connectToServer();
    server.onMessage((message) => {
      if (enabled && String(message).includes('"event":"studio:render"')) {
        assert.ok(waiting.length < 30, 'Held renders remain bounded');
        waiting.push(() => socket.send(message));
      } else {
        socket.send(message);
      }
    });
  });
  return {
    enable: () => {
      enabled = true;
    },
    count: () => waiting.length,
    release: () => {
      enabled = false;
      waiting.splice(0).forEach((send) => send());
    },
  };
}
