// Goal: exercise the shared Git graph/diff UI and the relocated connection status.
// Method: serve real Git history through a held browser transport while the real
// Studio fixture runs, then inspect its graph, changed-file dialog and exact diff.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { startStyleFixture } from './stylePanelFixture';
import { HistoryRepository } from '../src/features/history/historyRepository';
import { publishGit } from '../src/features/publishing/publishGit';
import { parseCommitDiffRequest } from '../vendor/stacki/shared/ipc/gitCommitDiff';

const fixture = await startStyleFixture();
const origin = await createHistoryOrigin();
const history = new HistoryRepository(
  fixture.root,
  async () => ({
    ok: true,
    value: { repository: 'test/history', branch: 'main', token: 'test-only' },
  }),
  (context, args, input, options) =>
    publishGit(
      context,
      args.map((argument) => (argument === 'https://github.com/test/history.git' ? pathToFileURL(origin).href : argument)),
      input,
      options,
    ),
);
const browser = await chromium.launch({
  executablePath:
    process.env['CHROME_PATH'] ?? (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : chromium.executablePath()),
  headless: true,
});
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(20_000);
  let details = 0;
  let holdGraph = false;
  const releaseGraph: (() => void)[] = [];
  await page.route('**/studio/api/history/*', async (route) => {
    const url = new URL(route.request().url());
    const input: unknown = route.request().postDataJSON();
    if (holdGraph && url.pathname.endsWith('/log')) {
      assert.ok(releaseGraph.length < 4, 'Reopening bounds simultaneous graph requests');
      await new Promise<void>((resolve) => {
        releaseGraph.push(resolve);
      });
    }
    if (url.pathname.endsWith('/commit')) {
      details++;
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(await history.commit(url.searchParams.get('hash') ?? '')),
      });
      return;
    }
    const value = url.pathname.endsWith('/log')
      ? await history.read(Number(url.searchParams.get('skip') ?? 0), url.searchParams.get('scope') === 'current' ? 'current' : 'all')
      : await history.diff(parseCommitDiffRequest(input));
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(value) });
  });
  await page.route('**/studio/api/git/*', async (route) => {
    const info = (await history.read(0, 'all')).info;
    const value = route.request().url().endsWith('/incoming')
      ? 0
      : {
          ...info,
          isRepo: true,
          remote: 'https://github.com/test/history.git',
          dirty: false,
          ahead: 0,
          parked: [],
          trunk: 'main',
          hasUpstream: true,
        };
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(value) });
  });
  await page.goto(fixture.url);
  await page.locator('.studio-titlebar-start .save-state').filter({ hasText: 'Saved' }).waitFor();
  assert.equal(await page.locator('.draft-chip').count(), 0);
  assert.equal(await page.locator('.studio-titlebar-end .save-state').count(), 0);
  await page.getByRole('button', { name: 'Git', exact: true }).click();
  assert.equal(await page.locator('aside').getByRole('button', { name: 'Undo', exact: true }).count(), 0);
  assert.equal(await page.locator('aside').getByRole('button', { name: 'Redo', exact: true }).count(), 0);
  await page.getByText('Change heading', { exact: true }).waitFor();
  assert.equal(details, 0, 'Opening the graph does not load changed files');
  await page.getByText('Change heading', { exact: true }).click();
  await page.getByRole('button', { name: 'View changed files (1)', exact: true }).click();
  assert.equal(details, 1, 'Only the expanded commit loads its files');
  await page.getByRole('button', { name: 'View diff for src/pages/index.astro', exact: true }).click();
  await page.locator('.history-diff-line.added').filter({ hasText: '<h1>After</h1>' }).waitFor();
  await page.locator('.history-diff-line.deleted').filter({ hasText: '<h1>Before</h1>' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Restore file…', exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Close changed files', exact: true }).click();
  await page.getByRole('button', { name: 'Navigator', exact: true }).click();
  holdGraph = true;
  await page.getByRole('button', { name: 'Git', exact: true }).click();
  await page.getByText('Change heading', { exact: true }).waitFor({ timeout: 1000 });
  assert.equal(await page.getByText('Reading history…', { exact: true }).count(), 0);
  assert.equal(await page.getByRole('status', { name: 'Loading Git history…', exact: true }).count(), 0);
  holdGraph = false;
  for (const release of releaseGraph.splice(0)) {
    release();
  }
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.locator('.studio-titlebar-start .save-state').isVisible());
  assert.ok(await page.locator('header').evaluate((header) => header.scrollWidth <= header.clientWidth + 1));
  console.log('Shared Git graph and exact file diff render; status replaces Draft at desktop and phone widths.');
} finally {
  await browser.close();
  await fixture.stop();
  await rm(origin, { recursive: true, force: true });
}

async function createHistoryOrigin() {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-history-ui-'));
  const execute = promisify(execFile);
  const git = async (...args: readonly string[]) => {
    await execute('git', args, { cwd: root, timeout: 20_000, maxBuffer: 1024 * 1024 });
  };
  await git('init', '--initial-branch=main');
  await git('config', 'user.name', 'History Test');
  await git('config', 'user.email', 'history@example.test');
  await mkdir(path.join(root, 'src/pages'), { recursive: true });
  await writeFile(path.join(root, 'src/pages/index.astro'), '<h1>Before</h1>\n');
  await git('add', '.');
  await git('commit', '-m', 'First page');
  await writeFile(path.join(root, 'src/pages/index.astro'), '<h1>After</h1>\n');
  await git('commit', '-am', 'Change heading');
  return root;
}
