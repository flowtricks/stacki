// Goal: component settings survive lost updates/acknowledgments and preview reconnects.
// Method: use real Studio sockets and Astro rendering in an isolated draft, dropping only
// selected transport frames. Verify source, durable Saved status and the rendered section.
import { chromium, type Page, type WebSocketRoute } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { record, string } from '../src/shared/validation';
import { restartPropPreview } from './propRecoveryRestart';

const root = process.env['STUDIO_FIXTURE_ROOT'];
assert.ok(root, 'An isolated draft root is required');
assert.ok(root.includes('/.studio/'), 'Use an isolated draft, never a user website');
const url = process.env['STUDIO_URL'] ?? 'http://127.0.0.1:4376/studio';
assert.equal(new URL(url).hostname, '127.0.0.1');
const sourceFile = path.join(root, 'src/pages/index.astro');
const original = await readFile(sourceFile, 'utf8');
const originalTheme = /<Section theme="([^"]+)">/.exec(original)?.[1] ?? 'inherit';
const browser = await chromium.launch({
  executablePath:
    process.env['CHROME_PATH'] ??
    (process.platform === 'darwin'
      ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      : chromium.executablePath()),
  headless: true,
});
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
page.setDefaultTimeout(40_000);
const transport = await interceptTransport(page);
try {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await saved(page);
  await selectSection(page);
  await theme(page, 'light');
  await verifyTheme(page, 'light');
  console.log('Normal theme edit saved and rendered.');

  transport.fault = 'update';
  await theme(page, 'dark');
  await saving(page);
  assert.ok(transport.dropped > 0);
  assert.match(await readFile(sourceFile, 'utf8'), /<Section theme="light">/);
  const connections = transport.connections;
  await verifyTheme(page, 'dark');
  assert.ok(transport.connections > connections, 'Missing update forces a new sync handshake');
  console.log('Lost update recovered through Yjs replay and rendered theme-dark.');

  await selectSection(page);
  transport.fault = 'saved';
  await theme(page, 'light');
  await verifyTheme(page, 'light');
  assert.ok(transport.dropped >= 2, 'The durable acknowledgment was actually dropped');
  console.log('Lost durable acknowledgment recovered without discarding the draft.');

  await restartPropPreview(root, new URL(url).port);
  await saved(page);
  await selectSection(page);
  transport.dropRenders = true;
  await theme(page, 'dark');
  await verifyTheme(page, 'dark');
  transport.dropRenders = false;
  console.log('Edit after reconnect rendered through the HTTP fallback with pushes dropped.');

  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/prop-recovery.png' });
  await selectSection(page);
  await theme(page, originalTheme);
  await saved(page);
  assert.equal(await readFile(sourceFile, 'utf8'), original, 'Only the selected prop changed');
  console.log('Original source restored byte-for-byte; no website publication occurred.');
} finally {
  await browser.close();
}

async function selectSection(page: Page) {
  const expand = page.getByRole('button', { name: 'Expand all', exact: true });
  if (await expand.count()) {
    await expand.click();
  }
  await page
    .locator('.structure-node')
    .filter({ has: page.locator('.label', { hasText: /^Section$/ }) })
    .first()
    .click();
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
}

async function theme(page: Page, value: string) {
  const row = page
    .locator('.props-field')
    .filter({ has: page.locator('.prop-label', { hasText: /^theme$/i }) });
  await row.locator('.dd-trigger').click();
  await page
    .locator('.dd-option')
    .filter({ hasText: new RegExp(`^${value}$`) })
    .click();
  // Move away so speculative enum hover rendering cannot satisfy the assertion.
  await page.mouse.move(700, 50);
}

async function verifyTheme(page: Page, value: string) {
  await saved(page);
  await page
    .frameLocator('iframe[title="Site preview"]')
    .locator(`section.section.theme-${value}`)
    .first()
    .waitFor();
  const response = await page.request.get(
    new URL('/studio/api/file?file=src/pages/index.astro', url).href,
  );
  const input: unknown = await response.json();
  assert.ok(string(record(input)['source']).includes(`<Section theme="${value}">`));
}

async function saved(page: Page) {
  await page
    .locator('.save-state')
    .filter({ hasText: /^Saved$/ })
    .waitFor();
}

async function saving(page: Page) {
  await page
    .locator('.save-state')
    .filter({ hasText: /^Saving$/ })
    .waitFor();
}

async function interceptTransport(page: Page) {
  // One active document socket and one fault at a time keep interception bounded.
  const state: {
    fault: 'none' | 'update' | 'saved';
    dropped: number;
    connections: number;
    document: WebSocketRoute | undefined;
    dropRenders: boolean;
  } = { fault: 'none', dropped: 0, connections: 0, document: undefined, dropRenders: false };
  await page.routeWebSocket('**/*', (socket) => {
    const server = socket.connectToServer();
    const document = new URL(socket.url()).pathname === '/studio/sync';
    if (document) {
      state.document = socket;
      state.connections++;
    }
    socket.onMessage((message) => {
      const input: unknown = JSON.parse(String(message));
      if (document && state.fault === 'update' && record(input)['type'] === 'update') {
        state.fault = 'none';
        state.dropped++;
        return;
      }
      server.send(message);
    });
    server.onMessage((message) => {
      const input: unknown = JSON.parse(String(message));
      const data = record(input);
      if (document && state.fault === 'saved' && data['type'] === 'saved') {
        state.fault = 'none';
        state.dropped++;
        return;
      }
      if (state.dropRenders && data['event'] === 'studio:render') {
        return;
      }
      socket.send(message);
    });
  });
  return state;
}
