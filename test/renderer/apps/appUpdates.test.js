// Goal: what the Apps panel says about an installed app's update follows one pure decision, so the
// row, the details and the rail agree. An app from GitHub or the marketplace with a newer version
// waiting is "available"; the same app with auto-update on whose new version asks for more than the
// installed one (new hosts, sign-in providers, role switches) is "needs-approval" and reads
// "Update needs your OK"; an uploaded app or one added to the project folder is the person's own
// and never offers an update, whatever its lock entry holds. The waiting set follows update checks:
// a held update waits like an available one, an installed one no longer does.
// Method: the pure functions of src/features/apps/appUpdates.tsx over hand-made lock entries.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { repoPath } = require('../../helpers/sources');

// The module imports a stylesheet; it is empty here, as in the panel tests.
function bundle(entry) {
  const directory = repoPath('node_modules/.stacki-test/app-updates');
  fs.mkdirSync(directory, { recursive: true });
  const outfile = path.join(directory, 'module.cjs');
  esbuild.buildSync({
    entryPoints: [repoPath(entry)],
    outfile,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    loader: { '.css': 'empty' },
    logLevel: 'silent',
  });
  return require(outfile);
}

const updates = bundle('src/features/apps/appUpdates.tsx');

const update = (additions = []) => ({ version: '1.2.0', tag: 'v1.2.0', sha256: 'a'.repeat(64), additions });
const lock = (source, options = {}) => ({
  id: 'heat-map',
  version: '1.1.0',
  sha256: 'b'.repeat(64),
  installedAt: '2026-11-10T00:00:00.000Z',
  source,
  update: options.update,
  autoUpdate: options.autoUpdate ?? false,
});
const github = { kind: 'github', owner: 'octocat', repository: 'heat-map', asset: 'heat-map.zip', tag: 'v1.1.0' };
const marketplace = { kind: 'marketplace', id: 'heat-map', version: '1.1.0' };

test('a newer version is available for a GitHub and a marketplace install, with auto-update off', () => {
  for (const source of [github, marketplace]) {
    const status = updates.appUpdateStatus(lock(source, { update: update() }));
    assert.equal(status.kind, 'available');
    assert.equal(updates.updateStatusLabel(status), 'Update available · v1.2.0');
    // What it adds is still named, so the person sees it before choosing Update.
    const withAdditions = updates.appUpdateStatus(lock(source, { update: update(['reaches api.example.com']) }));
    assert.equal(withAdditions.kind, 'available', 'auto-update is off: it is simply available');
  }
  assert.equal(updates.appUpdateStatus(lock(github)).kind, 'none', 'nothing waits');
});

test('auto-update on holds a version that asks for more: it reads "Update needs your OK"', () => {
  for (const source of [github, marketplace]) {
    const held = updates.appUpdateStatus(lock(source, { autoUpdate: true, update: update(['reaches api.example.com', 'signs in to Google']) }));
    assert.equal(held.kind, 'needs-approval');
    assert.equal(updates.updateStatusLabel(held), 'Update needs your OK · v1.2.0');
    // Negative space: auto-update on with nothing new is an ordinary waiting update (it installs at the next check).
    assert.equal(updates.appUpdateStatus(lock(source, { autoUpdate: true, update: update([]) })).kind, 'available');
  }
});

test('an uploaded app or one added to the project folder never offers an update', () => {
  for (const source of [{ kind: 'file', fileName: 'x.zip' }, { kind: 'local' }]) {
    assert.equal(updates.appUpdateStatus(lock(source, { update: update(['reaches api.example.com']), autoUpdate: true })).kind, 'none');
    assert.equal(updates.appUpdatable(source), false);
  }
  assert.equal(updates.appUpdatable(github), true);
  assert.equal(updates.appUpdatable(marketplace), true);
});

test('the note names what a version adds, and nothing when it adds nothing', () => {
  assert.equal(updates.updateAdditionsNote(update([])), undefined);
  assert.equal(
    updates.updateAdditionsNote(update(['reaches api.example.com', 'adds the “Can export” permission'])),
    'New in v1.2.0: reaches api.example.com, adds the “Can export” permission.',
  );
});

test('the auto-update hint says who it is for', () => {
  assert.equal(updates.AUTO_UPDATE_HINT, 'Install new versions of this app as they are released. Only turn this on for a publisher you trust.');
});

test('the waiting set follows the installed list and the update checks', () => {
  const app = (source, options) => ({ manifest: { id: 'heat-map' }, lock: lock(source, options) });
  updates.noteInstalledApps([app(github, { update: update() })]);
  const count = updates.waitingUpdateCount;
  assert.equal(count(), 1);
  updates.noteInstalledApps([app({ kind: 'local' }, { update: update() })]);
  assert.equal(count(), 0, 'an own app never waits');
  updates.noteUpdateOutcomes([{ kind: 'needs-approval', id: 'heat-map', version: '1.2.0', additions: ['reaches api.example.com'] }]);
  assert.equal(count(), 1, 'a held update waits');
  updates.noteUpdateOutcomes([{ kind: 'failed', id: 'heat-map', message: 'offline' }]);
  assert.equal(count(), 1, 'a failed check says nothing new');
  updates.noteUpdateOutcomes([{ kind: 'updated', id: 'heat-map', version: '1.2.0' }]);
  assert.equal(count(), 0, 'an installed update no longer waits');
});
