// Goal: the Studio box offers an upgrade exactly when the installed Studio is strictly behind the latest
// release, whatever the project changed (changes are backed up and counted, never a reason to refuse); version
// strings that are not exact stable versions are never compared.
// Method: table-driven pure tests. Versions cover equal, behind, ahead, prerelease, build tags, padding and
// garbage; changed-file detection is run on every kind of difference and on their absence (the negative space:
// retained and generated paths, identical files); the decision is run over each version order; the wire
// parsers and the manifest parser accept their own output and refuse each known-bad shape.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  STUDIO_UPGRADE_LIMITS,
  compareStudioVersions,
  decideUpgrade,
  detectChangedFiles,
  manualUpgradeCommand,
  parseStableVersion,
  parseStudioRestoreResult,
  parseStudioUpgradeCheck,
  parseStudioUpgradeManifest,
  parseStudioUpgradeResult,
} from '#dist/shared/ipc/studioUpgrade.js';
import { releaseVersion } from '#dist/shared/ipc/studioRelease.js';

test('versions compare numerically, not as text', () => {
  assert.equal(compareStudioVersions('1.4.10', '1.4.12'), 'behind');
  assert.equal(compareStudioVersions('1.4.9', '1.4.10'), 'behind');
  assert.equal(compareStudioVersions('1.9.0', '1.10.0'), 'behind');
  assert.equal(compareStudioVersions('1.4.12', '1.4.12'), 'current');
  assert.equal(compareStudioVersions('1.4.13', '1.4.12'), 'ahead');
  assert.equal(compareStudioVersions('2.0.0', '1.99.99'), 'ahead');
  assert.equal(compareStudioVersions('0.9.9', '1.0.0'), 'behind');
});

test('anything that is not an exact stable version is invalid, on either side', () => {
  for (const bad of [
    '',
    '1',
    '1.4',
    '1.4.10-beta.1',
    '1.4.10+build',
    'v1.4.10',
    '01.4.10',
    '1.4.10 ',
    '1.4.x',
    'latest',
    '1.4.10.1',
    '-1.4.10',
    '9'.repeat(41),
  ]) {
    assert.equal(parseStableVersion(bad), undefined, bad);
    assert.equal(compareStudioVersions(bad, '1.4.12'), 'invalid', bad);
    assert.equal(compareStudioVersions('1.4.10', bad), 'invalid', bad);
  }
  assert.equal(compareStudioVersions('99999999999999999999.0.0', '1.0.0'), 'invalid', 'beyond safe integers');
});

test('the version grammar agrees with the release parser', () => {
  for (const candidate of ['1.4.10', '0.0.0', '10.20.30', '1.4.10-rc.1', '1.04.0', 'x']) {
    let accepted = true;
    try {
      releaseVersion(candidate);
    } catch {
      accepted = false;
    }
    assert.equal(parseStableVersion(candidate) !== undefined, accepted, candidate);
  }
});

const pristine = new Map([
  ['package.json', 'a'],
  ['src/app.ts', 'b'],
  ['src/shared/release.json', 'c'],
]);

test('an untouched Studio has no changed files', () => {
  assert.deepEqual(detectChangedFiles({ pristine, installed: new Map(pristine) }), { listed: [], total: 0 });
});

test('retained and generated paths are never changed files', () => {
  const installed = new Map(pristine);
  for (const file of [
    'cloudflare/wrangler.jsonc',
    'cloudflare/auth-provider.ts',
    '.studio/x.json',
    '.wrangler/state',
    '.studio-state/a',
    '.env',
    '.env.local',
    '.dev.vars',
    'node_modules/a/index.js',
    'dist/cli.mjs',
    'test-results/r.json',
  ]) {
    installed.set(file, 'whatever');
  }
  assert.equal(detectChangedFiles({ pristine, installed }).total, 0);
});

test('modified, added and removed files are each reported, in a fixed order', () => {
  const installed = new Map(pristine);
  installed.set('src/app.ts', 'EDITED');
  installed.delete('src/shared/release.json');
  installed.set('src/zeta.ts', 'new');
  installed.set('src/alpha.ts', 'new');
  const changed = detectChangedFiles({ pristine, installed });
  assert.deepEqual(changed.listed, [
    { kind: 'modifiedFile', path: 'src/app.ts' },
    { kind: 'addedFile', path: 'src/alpha.ts' },
    { kind: 'addedFile', path: 'src/zeta.ts' },
    { kind: 'removedFile', path: 'src/shared/release.json' },
  ]);
  assert.equal(changed.total, 4);
});

test('the listed files are bounded while the total keeps counting', () => {
  const installed = new Map(pristine);
  for (let index = 0; index < 100; index += 1) {
    installed.set(`src/extra${String(index).padStart(3, '0')}.ts`, 'x');
  }
  const changed = detectChangedFiles({ pristine, installed });
  assert.equal(changed.listed.length, STUDIO_UPGRADE_LIMITS.changesListedMax);
  assert.equal(changed.total, 100);
});

test('an empty release is a programmer error', () => {
  assert.throws(() => detectChangedFiles({ pristine: new Map(), installed: new Map() }), /Assertion failed: A release always carries files/);
});

const note = { from: '1.4.10', to: '1.4.12', changed: { listed: [{ kind: 'modifiedFile', path: 'src/a.ts' }], total: 3 } } as const;

test('the decision depends on the versions only, never on what the project changed', () => {
  assert.deepEqual(decideUpgrade({ installed: '1.4.10', latest: '1.4.12', previous: undefined }), {
    kind: 'ready',
    installed: '1.4.10',
    latest: '1.4.12',
    previous: undefined,
  });
  assert.deepEqual(decideUpgrade({ installed: '1.4.12', latest: '1.4.12', previous: note }), { kind: 'current', version: '1.4.12', previous: note });
  assert.deepEqual(decideUpgrade({ installed: '1.5.0', latest: '1.4.12', previous: undefined }), { kind: 'current', version: '1.5.0', previous: undefined });
  assert.deepEqual(decideUpgrade({ installed: '1.4.10', latest: undefined, previous: undefined }), { kind: 'unavailable' }, 'offline is quiet');
  assert.deepEqual(decideUpgrade({ installed: '1.4.10-beta', latest: '1.4.12', previous: undefined }), { kind: 'unavailable' });
  assert.deepEqual(decideUpgrade({ installed: '1.4.10', latest: 'nope', previous: undefined }), { kind: 'unavailable' });
});

test('the manual command names the updater, never npm create', () => {
  assert.equal(manualUpgradeCommand('1.4.12'), 'node studio/dist/cli.mjs update . 1.4.12 --replace-customizations');
  assert.throws(() => manualUpgradeCommand('1.4.12; rm -rf /'), /exact stable version/);
});

test('wire parsers round-trip good values and refuse bad ones', () => {
  const unknown = { from: '1.4.10', to: '1.4.12', changed: undefined };
  for (const good of [
    { kind: 'unavailable' },
    { kind: 'current', version: '1.4.12', previous: undefined },
    { kind: 'current', version: '1.4.12', previous: note },
    { kind: 'ready', installed: '1.4.10', latest: '1.4.12', previous: unknown },
  ]) {
    assert.deepEqual(parseStudioUpgradeCheck(JSON.parse(JSON.stringify(good))), good);
  }
  const bad: unknown[] = [
    undefined,
    'x',
    { kind: 'other' },
    { kind: 'blocked', installed: '1.4.10', latest: '1.4.12' },
    { kind: 'current', version: '1.4.12-beta' },
    { kind: 'ready', installed: '1.4.10' },
    { kind: 'ready', installed: '1.4.10', latest: '1.4.12', previous: { from: 'x', to: '1.4.12' } },
    { kind: 'ready', installed: '1.4.10', latest: '1.4.12', previous: { ...note, changed: { listed: [{ kind: 'modifiedFile' }], total: 1 } } },
    { kind: 'ready', installed: '1.4.10', latest: '1.4.12', previous: { ...note, changed: { listed: [{ kind: 'weird', path: 'a' }], total: 1 } } },
    { kind: 'ready', installed: '1.4.10', latest: '1.4.12', previous: { ...note, changed: { listed: [], total: -1 } } },
    {
      kind: 'ready',
      installed: '1.4.10',
      latest: '1.4.12',
      previous: {
        ...note,
        changed: {
          listed: [
            { kind: 'addedFile', path: 'a' },
            { kind: 'addedFile', path: 'b' },
          ],
          total: 1,
        },
      },
    },
    {
      kind: 'ready',
      installed: '1.4.10',
      latest: '1.4.12',
      previous: { ...note, changed: { listed: Array.from({ length: 26 }, (_, index) => ({ kind: 'addedFile', path: `f${index}` })), total: 26 } },
    },
  ];
  for (const input of bad) {
    assert.throws(() => parseStudioUpgradeCheck(input), Error, JSON.stringify(input));
  }
  assert.deepEqual(parseStudioUpgradeResult({ kind: 'upgraded', version: '1.4.12', note }), { kind: 'upgraded', version: '1.4.12', note });
  assert.deepEqual(parseStudioUpgradeResult({ kind: 'error', message: 'no' }), { kind: 'error', message: 'no' });
  for (const input of [{ kind: 'upgraded', version: '1.4.12' }, { kind: 'upgraded', version: 'x', note }, { kind: 'error' }, { kind: 'done' }, 3]) {
    assert.throws(() => parseStudioUpgradeResult(input));
  }
  assert.deepEqual(parseStudioRestoreResult({ kind: 'restored', version: '1.4.10' }), { kind: 'restored', version: '1.4.10' });
  for (const input of [{ kind: 'restored', version: '1.4' }, { kind: 'error' }, { kind: 'x' }, undefined]) {
    assert.throws(() => parseStudioRestoreResult(input));
  }
});

test('the manifest names a plain backup folder and nothing else', () => {
  const good = { format: 1, backup: 'backup-1.4.12-3f2a9c1e-0000-4000-8000-000000000000', note };
  assert.deepEqual(parseStudioUpgradeManifest(JSON.parse(JSON.stringify(good))), good);
  for (const backup of [
    '',
    '../studio',
    'backup-../x',
    'backup-a/b',
    'studio',
    'backup-',
    `backup-${'a'.repeat(STUDIO_UPGRADE_LIMITS.backupNameCharsMax)}`,
    'backup-a b',
  ]) {
    assert.throws(() => parseStudioUpgradeManifest({ ...good, backup }), Error, backup);
  }
  assert.throws(() => parseStudioUpgradeManifest({ ...good, format: 2 }), /Unsupported/);
  assert.throws(() => parseStudioUpgradeManifest({ format: 1, backup: good.backup }));
});
