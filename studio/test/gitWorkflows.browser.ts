// Goal: run the shared Desktop Git controls against Studio's real HTTP workflows.
// Method: use a disposable Astro preview and local Git origin, commit a draft,
// create/switch branches, and pull a remote commit without touching a user repository.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { startStyleFixture } from './stylePanelFixture';
import { createGitWorkspaceFixture } from './gitWorkspaceFixture';
import { startGitWorkspaceHTTP } from './gitWorkspaceHTTP';
import { HistoryRepository } from '../src/features/history/historyRepository';
import { parseCommitDiffRequest } from '../vendor/stacki/shared/ipc/gitCommitDiff';

const fixture = await startStyleFixture();
const setup = await createGitWorkspaceFixture({ root: fixture.root });
const server = await startGitWorkspaceHTTP(fixture.root, setup.connection);
const history = new HistoryRepository(fixture.root, async () => ({
  ok: true,
  value: setup.connection,
}));
const browser = await chromium.launch({
  executablePath:
    process.env['CHROME_PATH'] ?? (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : chromium.executablePath()),
  headless: true,
});
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(20_000);
  page.on('pageerror', (error) => console.error(error));
  page.on('console', (message) => {
    if (message.type() === 'error') {
      console.error(message.text());
    }
  });
  await page.route('**/studio/api/git/*', async (route) => {
    const response = await fetch(server.origin + new URL(route.request().url()).pathname, {
      method: 'POST',
      headers: route.request().headers(),
      body: route.request().postData() ?? '{}',
    });
    if (!response.ok) {
      console.error(route.request().url(), await response.clone().text());
    }
    await route.fulfill({
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: await response.text(),
    });
  });
  await page.route('**/studio/api/history/*', async (route) => {
    const url = new URL(route.request().url());
    const value = url.pathname.endsWith('/log')
      ? await history.read(Number(url.searchParams.get('skip') ?? 0), url.searchParams.get('scope') === 'current' ? 'current' : 'all')
      : url.pathname.endsWith('/commit')
        ? await history.commit(url.searchParams.get('hash') ?? '')
        : await history.diff(parseCommitDiffRequest(route.request().postDataJSON()));
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(value) });
  });
  await page.goto(fixture.url);
  await page.locator('.save-state').filter({ hasText: 'Saved' }).waitFor();
  await page.getByRole('button', { name: 'Git', exact: true }).click();
  await page.getByRole('button', { name: 'Pull from GitHub', exact: true }).waitFor();
  await page.getByRole('region', { name: 'Branches', exact: true }).waitFor();
  await page.getByRole('textbox', { name: 'Commit message', exact: true }).fill('Browser commit');
  await page.getByRole('button', { name: 'Commit all changes', exact: true }).click();
  await page
    .getByRole('button', { name: 'Nothing to commit', exact: true })
    .waitFor()
    .catch(async (error: unknown) => {
      console.error(await page.locator('body').innerText());
      throw error;
    });
  assert.equal(await setup.git('rev-parse', 'HEAD'), setup.head, 'Commit does not push to GitHub');
  await page.getByText('Browser commit', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'New branch', exact: true }).click();
  await page.getByRole('textbox', { name: 'New branch name', exact: true }).fill('browser-branch');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.getByRole('button', { name: 'browser-branch, current branch', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Switch to main', exact: true }).click();
  await page.getByRole('button', { name: 'main, current branch', exact: true }).waitFor();
  await writeFile(path.join(setup.remote, 'src/pages/contact.astro'), '<h1>Pulled remotely</h1>');
  await setup.git('add', '.');
  await setup.git('commit', '--quiet', '-m', 'Remote contact');
  await page.reload();
  await page.locator('.save-state').filter({ hasText: 'Saved' }).waitFor();
  await page.getByRole('button', { name: 'Git', exact: true }).click();
  const pull = page.getByRole('button', { name: 'Pull from GitHub', exact: true });
  await page.waitForFunction(() => {
    const button = document.querySelector('.git-pull');
    return button instanceof HTMLButtonElement && !button.disabled;
  });
  await pull.click();
  await page.getByText('Pulled changes from GitHub', { exact: true }).waitFor();
  assert.equal(await readFile(path.join(fixture.root, 'src/pages/contact.astro'), 'utf8'), '<h1>Pulled remotely</h1>');
  await page.getByText('Remote contact', { exact: true }).waitFor();
  await page.screenshot({ path: '/tmp/stacki-git-workflows-browser.png', fullPage: true });
} finally {
  await browser.close();
  await server.stop();
  await fixture.stop();
  await rm(setup.parent, { recursive: true, force: true });
}
