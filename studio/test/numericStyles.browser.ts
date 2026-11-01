import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { record, string } from '../src/shared/validation';
import { flatten, nodesOf } from '../src/features/source/source';
import { setAttributes } from '../src/features/settings/settingsEdits';
const browser = await chromium.launch({
  executablePath: process.env['CHROME_PATH'] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
const auth = process.env['STUDIO_STORAGE_STATE'];
const page = await browser.newPage({
  viewport: { width: 1440, height: 1000 },
  ...(auth ? { storageState: auth } : {}),
});
page.setDefaultTimeout(20000);
const url = process.env['STUDIO_URL'] ?? 'http://127.0.0.1:4360/studio';
const headingText = process.env['STUDIO_TEST_HEADING'] ?? 'Style Guide';
const endpoint = new URL('/studio/api/file?file=src/pages/index.astro', url).href;
const expected = new Set<string>();
let original: string | undefined;
let hold = false;
let release = () => {};
const gate = new Promise<void>((resolve) => {
  release = resolve;
});
const held: (() => void)[] = [];
await page.routeWebSocket('**/*', (socket) => {
  const server = socket.connectToServer();
  server.onMessage((message) => {
    if (hold && String(message).includes('"event":"studio:render"')) {
      held.push(() => socket.send(message));
    } else {
      socket.send(message);
    }
  });
});
await page.route('**/*', async (route) => {
  if (hold && route.request().resourceType() === 'fetch' && new URL(route.request().url()).pathname === '/') {
    await gate;
  }
  await route.continue();
});
try {
  await page.goto(url);
  await page.locator('.save-state').filter({ hasText: 'Saved' }).waitFor();
  original = await readSource();
  const id = flatten(nodesOf(original)).find((node) => node.name === 'Heading' && node.children?.some((child) => child.value === headingText))?.id;
  assert.ok(id);
  expected.add(original);
  for (const value of [20, 21, 22]) {
    expected.add(setAttributes(original, id, { maxWidth: { type: 'expr', value: String(value) } }));
  }
  const heading = page.frameLocator('iframe[title="Site preview"]').getByRole('heading', { name: headingText, exact: true });
  await heading.click();
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
  const input = page
    .locator('.props-field')
    .filter({ has: page.locator('.prop-label', { hasText: /^maxWidth$/ }) })
    .locator('.num-field input');
  await input.fill('20');
  await page.locator('.save-state').filter({ hasText: 'Saved' }).waitFor();
  await waitStyle('20ch');
  hold = true;
  const started = performance.now();
  await input.press('ArrowUp');
  await waitStyle('21ch');
  const elapsed = Math.round(performance.now() - started);
  assert.ok(elapsed < 500, `Width responds before server renders (${elapsed}ms)`);
  const deadline = Date.now() + 5000;
  while (!held.length && Date.now() < deadline) {
    await page.waitForTimeout(20);
  }
  assert.ok(held.length, 'A real authoritative render is held');
  const stale = held.shift();
  await input.press('ArrowUp');
  await waitStyle('22ch');
  stale?.();
  await page.waitForTimeout(100);
  await waitStyle('22ch');
  await input.press('ArrowDown');
  await waitStyle('21ch');
  console.log(`Numeric arrow preview: ${elapsed}ms while server renders/fetches are held; stale HTML cannot undo the latest width.`);
} finally {
  hold = false;
  release();
  held.length = 0;
  await page.locator('.save-state').filter({ hasText: 'Saved' }).waitFor();
  if (original) {
    const base = await readSource();
    assert.ok(expected.has(base), 'Do not overwrite another edit');
    const response = await page.request.post(new URL('/studio/api/source', url).href, {
      headers: { Origin: new URL(url).origin },
      data: { file: 'src/pages/index.astro', source: original, base },
    });
    assert.ok(response.ok());
  }
  await browser.close();
}
async function readSource() {
  return string(record(await (await page.request.get(endpoint)).json())['source']);
}
async function waitStyle(value: string) {
  const heading = page.frameLocator('iframe[title="Site preview"]').getByRole('heading', { name: headingText, exact: true });
  const deadline = Date.now() + 2000;
  while ((await heading.evaluate((element) => (element instanceof HTMLElement ? element.style.getPropertyValue('--_mw').trim() : ''))) !== value) {
    assert.ok(Date.now() < deadline, `Expected width ${value}`);
    await page.waitForTimeout(10);
  }
}
