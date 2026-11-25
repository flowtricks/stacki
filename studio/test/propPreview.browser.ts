import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { record, string } from '../src/shared/validation';
import { flatten, parsePage } from '../src/features/source/source';
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
const url = process.env['STUDIO_URL'] ?? 'http://localhost:4368/studio';
let original: string | undefined;
const expectedSources = new Set<string>();
const requirePush = process.env['STUDIO_COMPARE_PULL'] !== 'true';
let release = () => {};
const gate = new Promise<void>((resolve) => {
  release = resolve;
});
const errors: string[] = [];
page.on('pageerror', (error) => errors.push(error.message));
let subscribed = false;
let dropRenders = false;
let pageFetches = 0;
await page.routeWebSocket('**/*', (socket) => {
  const server = socket.connectToServer();
  server.onMessage((message) => {
    if (String(message).includes('"event":"studio:render-ready"')) {
      subscribed = true;
    }
    if (!dropRenders || !String(message).includes('"event":"studio:render"')) {
      socket.send(message);
    }
  });
});

try {
  await page.goto(url);
  await page.locator('.save-state').filter({ hasText: 'Saved' }).waitFor();
  const preview = page.frameLocator('iframe[title="Site preview"]');
  await preview.locator('h1.text-style-display').waitFor();
  await page.waitForLoadState('networkidle');
  if (requirePush) {
    assert.ok(subscribed, 'The preview subscribes on its existing Vite socket');
  }
  original = await readSource();
  rememberExpected(original);
  await page.getByRole('button', { name: 'Expand all', exact: true }).click();
  await page
    .locator('.structure-node')
    .filter({ has: page.locator('.label', { hasText: /^Heading$/ }) })
    .click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  // Hold actual HTTP page fetches. The new prop preview must arrive via the socket
  // while this gate is closed, without a fake rendering or a page navigation.
  await page.route('**/*', async (route) => {
    if (new URL(route.request().url()).pathname === '/' && route.request().resourceType() === 'fetch') {
      pageFetches++;
      if (requirePush) {
        await gate;
      }
    }
    await route.continue();
  });
  let navigations = 0;
  page.on('framenavigated', (frame) => {
    if (frame.parentFrame()) {
      navigations++;
    }
  });
  await page.getByRole('button', { name: 'display', exact: true }).click();
  const started = performance.now();
  await page.locator('.dd-option').filter({ hasText: /^h2$/ }).hover();
  await preview.locator('h1.text-style-h2').waitFor();
  console.log(`Hover preview painted in ${Math.round(performance.now() - started)} ms (${requirePush ? 'page fetches blocked' : 'normal network'}).`);
  await page.keyboard.press('Escape');
  await preview.locator('h1.text-style-display').waitFor();
  await page.getByRole('button', { name: 'display', exact: true }).click();
  await page.locator('.dd-option').filter({ hasText: /^h3$/ }).click();
  await preview.locator('h1.text-style-h3').waitFor();
  assert.ok((await readSource()).includes('variant="h3"'));
  assert.equal(navigations, 0);
  release();
  if (requirePush) {
    await checkFallback();
  }
  assert.deepEqual(errors, []);
  console.log(`Prop hover, cancel and commit passed (${requirePush ? 'socket with fetch fallback' : 'comparison run'}).`);
} finally {
  release();
  if (original !== undefined) {
    const base = await readSource();
    assert.ok(expectedSources.has(base), 'A collaborator changed this draft; do not overwrite their source');
    const result = await page.request.post(new URL('/studio/api/source', url).href, {
      headers: { Origin: new URL(url).origin },
      data: { file: 'src/pages/index.astro', source: original, base },
    });
    assert.ok(result.ok(), 'Restore the exact draft source');
  }
  await browser.close();
}

function rememberExpected(source: string) {
  const parsed = parsePage(source);
  assert.ok(parsed.editable);
  const heading = flatten(parsed.model.nodes).find((node) => node.name === 'Heading');
  assert.ok(heading?.id);
  expectedSources.add(source);
  for (const value of ['h2', 'h3', 'h4']) {
    expectedSources.add(setAttributes(source, heading.id, { variant: { type: 'string', value } }));
  }
}

async function readSource() {
  const response = await page.request.get(new URL('/studio/api/file?file=src/pages/index.astro', url).href);
  assert.ok(response.ok());
  return string(record(await response.json())['source']);
}

async function checkFallback() {
  dropRenders = true;
  const before = pageFetches;
  await page.getByRole('button', { name: 'h3', exact: true }).click();
  await page.locator('.dd-option').filter({ hasText: /^h4$/ }).click();
  await page.frameLocator('iframe[title="Site preview"]').locator('h1.text-style-h4').waitFor();
  assert.ok(pageFetches > before, 'A lost pushed render must recover through the normal page fetch');
}
