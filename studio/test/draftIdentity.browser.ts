// Goal: a replaced server draft must preserve local text and stop reconnect loops.
// Method: retain IndexedDB across reload, replace only the incoming sync identity,
// then advance browser time beyond recovery budgets and verify no new connection.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startStyleFixture } from './stylePanelFixture';

const fixture = await startStyleFixture({ page: '<main><h1>Preserved local draft</h1></main>' });
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
  let connections = 0;
  await page.routeWebSocket('**/studio/sync?**', (socket) => {
    connections++;
    assert.ok(connections <= 2, 'A draft conflict must not loop through reconnections');
    const server = socket.connectToServer();
    server.onMessage((message) => {
      const value: unknown = JSON.parse(String(message));
      if (value && typeof value === 'object' && 'type' in value && value.type === 'sync') {
        socket.send(JSON.stringify({ ...value, epoch: 'replacement-document' }));
      } else {
        socket.send(message);
      }
    });
  });
  await page.reload();
  await page.locator('.save-state').filter({ hasText: 'Needs attention' }).waitFor();
  await page.getByRole('button', { name: 'Code', exact: true }).click();
  assert.ok((await page.locator('.cm-content').innerText()).includes('Preserved local draft'));
  await page.clock.install();
  await page.clock.fastForward(300_000);
  assert.equal(connections, 1, 'An incompatible draft is not repaired by opening another socket');
  assert.equal(await page.locator('.save-state').innerText(), 'Needs attention');
  console.log('Draft identity mismatch preserves source and stops transport recovery.');
} finally {
  await browser.close();
  await fixture.stop();
}
