// Goal: the main process turns a project's Studio folder into digests an upgrade can compare with the release
// it came from: edits, additions and removals show; line endings, retained folders and generated folders do
// not; a folder beyond the scan bounds is reported as unreadable instead of guessed.
// Method: build temporary Studio folders on disk, run the real scanner and the pure conflict rule over a
// release built from the same files, and compare. No network and no project of the person's is touched.
import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { contentDigest, installedDigests, releaseDigests } from '#dist/electron/project/studioUpgrade.js';
import { restoreBackup } from '#dist/electron/project/studioInstall.js';
import { detectChangedFiles } from '#dist/shared/ipc/studioUpgrade.js';

const files = {
  'package.json': '{"name":"@stacki/studio"}\n',
  'src/app.ts': 'export const a = 1;\nexport const b = 2;\n',
  'src/shared/release.json': '{"version":"1.4.10"}\n',
};
const release = { format: 1 as const, version: '1.4.10', files: Object.entries(files).map(([filePath, content]) => ({ path: filePath, content })) };

function studioFolder(extra: (directory: string) => void = () => {}): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-upgrade-'));
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
    fs.writeFileSync(path.join(directory, file), content);
  }
  extra(directory);
  return directory;
}

test('an untouched folder matches its release, whatever the line endings and generated folders', async () => {
  const directory = studioFolder((root) => {
    fs.writeFileSync(path.join(root, 'src/app.ts'), files['src/app.ts'].replace(/\n/g, '\r\n'));
    fs.mkdirSync(path.join(root, 'node_modules/x'), { recursive: true });
    fs.writeFileSync(path.join(root, 'node_modules/x/index.js'), 'generated');
    fs.mkdirSync(path.join(root, 'dist'));
    fs.writeFileSync(path.join(root, 'dist/cli.mjs'), 'built');
    fs.mkdirSync(path.join(root, 'cloudflare'));
    fs.writeFileSync(path.join(root, 'cloudflare/wrangler.jsonc'), '{}');
    fs.writeFileSync(path.join(root, '.env.local'), 'SECRET=1');
  });
  const installed = await installedDigests(directory);
  assert.ok(installed);
  const report = detectChangedFiles({ pristine: releaseDigests(release), installed });
  assert.deepEqual(report, { listed: [], total: 0 });
});

test('an edit, an added file and a removal are found, and the retained auth provider file is not a change', async () => {
  const directory = studioFolder((root) => {
    fs.writeFileSync(path.join(root, 'src/app.ts'), 'export const a = 99;\n');
    fs.unlinkSync(path.join(root, 'package.json'));
    fs.writeFileSync(path.join(root, 'src/mine.ts'), 'x');
    fs.mkdirSync(path.join(root, 'cloudflare'));
    fs.writeFileSync(path.join(root, 'cloudflare/auth-provider.ts'), 'export default {}');
  });
  const installed = await installedDigests(directory);
  assert.ok(installed);
  const report = detectChangedFiles({ pristine: releaseDigests(release), installed });
  assert.deepEqual(report.listed, [
    { kind: 'modifiedFile', path: 'src/app.ts' },
    { kind: 'addedFile', path: 'src/mine.ts' },
    { kind: 'removedFile', path: 'package.json' },
  ]);
});

test('a symbolic link is never a release file', async () => {
  const directory = studioFolder((root) => fs.symlinkSync('/etc/hosts', path.join(root, 'src/link.ts')));
  const installed = await installedDigests(directory);
  assert.ok(installed);
  assert.deepEqual(detectChangedFiles({ pristine: releaseDigests(release), installed }).listed, [{ kind: 'addedFile', path: 'src/link.ts' }]);
});

test('a file larger than a release file may be makes the folder unreadable', async () => {
  const directory = studioFolder((root) => fs.writeFileSync(path.join(root, 'src/big.ts'), 'x'.repeat(2_000_001)));
  assert.equal(await installedDigests(directory), undefined);
});

test('digests ignore line endings only', () => {
  assert.equal(contentDigest('a\r\nb'), contentDigest('a\nb'));
  assert.notEqual(contentDigest('a\nb'), contentDigest('a\nB'));
  assert.throws(() => releaseDigests({ format: 1, version: '1.0.0', files: [] }), /A release always carries files/);
});

test('a restore puts the backed up folder back and keeps settings and state with the project', async () => {
  const site = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-restore-'));
  const studio = path.join(site, 'studio');
  fs.mkdirSync(path.join(studio, 'cloudflare'), { recursive: true });
  fs.writeFileSync(path.join(studio, 'cloudflare/wrangler.jsonc'), '{"live":true}');
  fs.writeFileSync(path.join(studio, 'package.json'), '{"version":"1.4.12"}');
  const backup = path.join(site, '.stacki/studio/updates/backup-1.4.12-abc');
  fs.mkdirSync(backup, { recursive: true });
  fs.writeFileSync(path.join(backup, 'package.json'), '{"version":"1.4.10"}');
  await restoreBackup(studio, 'backup-1.4.12-abc');
  assert.equal(fs.readFileSync(path.join(studio, 'package.json'), 'utf8'), '{"version":"1.4.10"}');
  assert.equal(fs.readFileSync(path.join(studio, 'cloudflare/wrangler.jsonc'), 'utf8'), '{"live":true}', 'retained settings stay');
  assert.equal(fs.existsSync(backup), false, 'the backup became the folder');
  assert.equal(fs.existsSync(path.join(site, '.stacki/studio/updates/update.lock')), false, 'the lock is released');
});

test('a restore refuses a name that is not a plain backup folder and a missing backup', async () => {
  const site = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-restore-'));
  fs.mkdirSync(path.join(site, 'studio'));
  for (const name of ['../studio', 'studio', 'backup-a/b', '']) {
    await assert.rejects(restoreBackup(path.join(site, 'studio'), name), /named backup/);
  }
  await assert.rejects(restoreBackup(path.join(site, 'studio'), 'backup-missing'));
});
