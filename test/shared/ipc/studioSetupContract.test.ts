// Verify setup boundaries accept every declared result and reject malformed
// values before UI code can use them or installation can begin.
import assert from 'node:assert/strict';
import test from 'node:test';
import { BOUNDARY_LIMITS } from '#dist/shared/core/boundary.js';
import { parseIpcPayload } from '#dist/shared/ipc/ipcPayloads.js';
import { parseStudioStatus, parseStudioInstallResult, parseStudioAuthResult } from '#dist/shared/ipc/studioSetup.js';
import { parseStudioInstallProgress, STUDIO_INSTALL_STAGES, STUDIO_LOG_CHARS_MAX, studioCompletedStages } from '#dist/shared/ipc/studioProgress.js';

test('Studio progress validates every stage, identity and output bound', () => {
  const base = { projectPath: '/site', requestId: 'install-1', output: '', stage: 'release' };
  for (const stage of STUDIO_INSTALL_STAGES) {
    assert.deepEqual(parseStudioInstallProgress({ ...base, stage }), { ...base, stage });
  }
  assert.equal(
    parseStudioInstallProgress({
      ...base,
      output: 'x'.repeat(STUDIO_LOG_CHARS_MAX),
    }).output.length,
    STUDIO_LOG_CHARS_MAX,
  );
  for (const value of [
    undefined,
    12,
    {},
    { ...base, stage: 'unknown' },
    { ...base, projectPath: '/site\0' },
    { ...base, projectPath: 'x'.repeat(BOUNDARY_LIMITS.pathLengthMax + 1) },
    { ...base, requestId: '' },
    { ...base, requestId: 'x'.repeat(65) },
    { ...base, requestId: undefined },
    { ...base, output: 42 },
    { ...base, output: 'x'.repeat(STUDIO_LOG_CHARS_MAX + 1) },
  ]) {
    assert.throws(() => parseStudioInstallProgress(value));
  }
  for (const requestId of [undefined, '', 'x'.repeat(65), 7]) {
    assert.throws(() =>
      parseIpcPayload('studio:install', {
        projectPath: '/site',
        source: 'published',
        requestId,
      }),
    );
  }
});

test('stage counts reject impossible internal stages', () => {
  assert.equal(studioCompletedStages('release'), 0);
  assert.equal(studioCompletedStages('complete'), STUDIO_INSTALL_STAGES.length - 1);
  assert.throws(() => {
    Reflect.apply(studioCompletedStages, undefined, ['impossible']);
  }, /Studio progress stage belongs to the installation sequence/);
});

test('Studio setup payloads constrain source and project path', () => {
  for (const source of ['published', 'file']) {
    assert.deepEqual(
      parseIpcPayload('studio:install', {
        projectPath: '/site',
        source,
        requestId: 'test-install',
      }),
      {
        projectPath: '/site',
        source,
        requestId: 'test-install',
      },
    );
  }
  for (const source of ['https://untrusted.invalid/release', '../release', undefined, 12]) {
    assert.throws(() =>
      parseIpcPayload('studio:install', {
        projectPath: '/site',
        source,
        requestId: 'test-install',
      }),
    );
  }
  assert.throws(() =>
    parseIpcPayload('studio:install', {
      projectPath: '/site\0',
      source: 'file',
      requestId: 'test-install',
    }),
  );
});

test('Studio status and installation results are validated', () => {
  for (const value of [
    { kind: 'missing', desktopVersion: '1.2.3' },
    { kind: 'installed', desktopVersion: '1.2.3', version: '1.0.0', signIn: 'github' },
    { kind: 'installed', desktopVersion: '1.2.3', version: '1.0.0', signIn: 'custom' },
    { kind: 'blocked', desktopVersion: '1.2.3', message: 'Existing folder' },
  ]) {
    assert.deepEqual(parseStudioStatus(value), value);
  }
  for (const value of [{ kind: 'installed', version: '1.2.3' }, { kind: 'canceled' }, { kind: 'error', message: 'Unavailable' }]) {
    assert.deepEqual(parseStudioInstallResult(value), value);
  }
  for (const value of [undefined, 1, {}, { kind: 'installed' }, { kind: 'error', message: 7 }]) {
    assert.throws(() => parseStudioStatus(value));
    assert.throws(() => parseStudioInstallResult(value));
  }
});

test('the sign-in choice rides the install and setAuth payloads, bounded and without secrets', () => {
  const base = { projectPath: '/site', source: 'published', requestId: 'test-install' };
  const google = {
    kind: 'google',
    clientId: 'abc.apps.googleusercontent.com',
    allowedDomains: ['example.com'],
    allowedEmails: [],
    admin: 'google:me@example.com',
  };
  assert.deepEqual(parseIpcPayload('studio:install', { ...base, auth: google }).auth, google);
  assert.equal(parseIpcPayload('studio:install', base).auth, undefined, 'absent means GitHub');
  assert.deepEqual(parseIpcPayload('studio:setAuth', { projectPath: '/site', auth: { kind: 'github' } }), { projectPath: '/site', auth: { kind: 'github' } });
  const bad: readonly unknown[] = [
    { ...google, clientSecret: 'shh' },
    { ...google, clientId: '' },
    { ...google, admin: 'oidc:me@example.com' },
    { ...google, allowedDomains: Array.from({ length: 51 }, (_, index) => `d${index}.example.com`) },
    { kind: 'oidc', issuer: 'http://insecure.test', clientId: 'a', allowedDomains: [], allowedEmails: [], admin: 'oidc:a@b.co' },
    { kind: 'access', teamDomain: 'x.cloudflareaccess.com', aud: 'short', admin: 'access:a@b.co' },
    { kind: 'saml' },
    'google',
    undefined,
  ];
  for (const auth of bad) {
    assert.throws(() => parseIpcPayload('studio:install', { ...base, auth: auth === undefined ? 'nope' : auth }));
    assert.throws(() => parseIpcPayload('studio:setAuth', { projectPath: '/site', auth }));
  }
  assert.throws(() => parseIpcPayload('studio:setAuth', { projectPath: '/site' }));
});

test('Studio status carries the sign-in type and the setAuth result is validated', () => {
  const installed = { kind: 'installed', desktopVersion: '1.2.3', version: '1.0.0' };
  assert.throws(() => parseStudioStatus(installed), 'a status without its sign-in is refused');
  assert.throws(() => parseStudioStatus({ ...installed, signIn: 'saml' }));
  for (const signIn of ['github', 'access', 'google', 'oidc', 'passkey', 'custom']) {
    assert.equal(parseStudioStatus({ ...installed, signIn }).kind, 'installed');
  }
  assert.deepEqual(parseStudioAuthResult({ kind: 'saved', signIn: 'oidc' }), { kind: 'saved', signIn: 'oidc' });
  assert.deepEqual(parseStudioAuthResult({ kind: 'error', message: 'No' }), { kind: 'error', message: 'No' });
  for (const value of [undefined, {}, { kind: 'saved' }, { kind: 'saved', signIn: 'x' }, { kind: 'error', message: 1 }]) {
    assert.throws(() => parseStudioAuthResult(value));
  }
});
