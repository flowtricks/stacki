// Goal: repository setup rejects malformed IPC and bounds account/repository inventories.
// Method: round-trip each action and mutate identifiers, revisions, kinds, and collection sizes.
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseIpcPayload } from '#dist/shared/ipc/ipcPayloads.js';
import {
  classifyCreateFailure,
  classifyOrganizationFailure,
  mergeOrganizations,
  parseOrganizationMemberships,
  parseRepositoryRequest,
  parseRepositoryResult,
} from '#dist/shared/ipc/publishRepository.js';
const revision = 'a'.repeat(64);
test('repository requests and results round-trip', () => {
  for (const request of [
    { action: 'list', account: 'work' },
    { action: 'connect', account: 'work', repository: 'work/site', revision },
    { action: 'create', account: 'work', owner: 'work', name: 'site', private: true },
    { action: 'create', account: 'work', owner: 'acme-co', name: 'site', private: false },
  ]) {
    assert.deepEqual(parseRepositoryRequest(request), request);
    assert.deepEqual(parseIpcPayload('publish:repository', { projectPath: '/site', request }), {
      projectPath: '/site',
      request,
    });
  }
  const ready = {
    ok: true,
    value: {
      connected: 'work/site',
      revision,
      repositories: ['work/site'],
      mode: 'editable',
      organizations: ['acme-co'],
      organizationAccess: 'available',
      notice: '',
    },
  };
  assert.deepEqual(parseRepositoryResult(ready), ready);
  assert.deepEqual(parseRepositoryResult({ ok: false, error: 'Unavailable' }), {
    ok: false,
    error: 'Unavailable',
  });
});
test('repository requests reject unsafe identifiers and result excess', () => {
  for (const request of [
    undefined,
    {},
    { action: 'list', account: '' },
    { action: 'list', account: '-flag' },
    { action: 'list', account: 'a'.repeat(40) },
    { action: 'connect', account: 'work', repository: 'work/../outside', revision },
    { action: 'connect', account: 'work', repository: 'work/site', revision: 'old' },
    { action: 'create', account: 'work', owner: 'work', name: '../outside', private: true },
    { action: 'create', account: 'work', owner: 'work', name: 'site', private: 'yes' },
    { action: 'create', account: 'work', name: 'site', private: true },
    { action: 'create', account: 'work', owner: '', name: 'site', private: true },
    { action: 'create', account: 'work', owner: '-flag', name: 'site', private: true },
    { action: 'create', account: 'work', owner: 'acme/evil', name: 'site', private: true },
  ]) {
    assert.throws(() => parseRepositoryRequest(request));
  }
  const base = { connected: '', revision, repositories: [], mode: 'editable', organizations: [], organizationAccess: 'available', notice: '' };
  for (const value of [
    { ...base, connected: 'bad' },
    { ...base, repositories: Array(501).fill('work/site') },
    { ...base, mode: 'other' },
    { ...base, notice: 'x'.repeat(1001) },
    { ...base, organizations: ['bad/login'] },
    { ...base, organizations: Array(301).fill('acme-co') },
    { ...base, organizationAccess: 'denied' },
    { connected: '', revision, repositories: [], mode: 'editable', notice: '' },
  ]) {
    assert.throws(() => parseRepositoryResult({ ok: true, value }));
  }
});
test('repository sentences keep valid references and drop malformed ones', () => {
  const error = { key: 'publish.repositories.error.changed' };
  assert.deepEqual(parseRepositoryResult({ ok: false, error: 'Changed', errorRef: error }), { ok: false, error: 'Changed', errorRef: error });
  assert.deepEqual(parseRepositoryResult({ ok: false, error: 'Changed', errorRef: { key: 'bad key' } }), { ok: false, error: 'Changed' });
  const value = { connected: '', revision, repositories: [], mode: 'editable', organizations: [], organizationAccess: 'available', notice: 'Managed' };
  const noticeRef = { key: 'publish.repositories.managedNotice' };
  assert.deepEqual(parseRepositoryResult({ ok: true, value: { ...value, noticeRef } }), { ok: true, value: { ...value, noticeRef } });
  assert.deepEqual(parseRepositoryResult({ ok: true, value: { ...value, noticeRef: 3 } }), { ok: true, value });
});

test('organization memberships keep only active organizations the account can create in', () => {
  const entry = (login: string, role: string, state = 'active') => ({ state, role, organization: { login } });
  assert.deepEqual(
    parseOrganizationMemberships([
      entry('acme-co', 'admin'),
      entry('beta', 'member'),
      entry('billing', 'billing_manager'),
      entry('invited', 'member', 'pending'),
    ]),
    ['acme-co', 'beta'],
  );
  assert.deepEqual(parseOrganizationMemberships([]), []);
});
test('organization memberships reject malformed pages', () => {
  for (const page of [
    undefined,
    {},
    [{ state: 'active', role: 'owner', organization: { login: 'acme-co' } }],
    [{ state: 'gone', role: 'admin', organization: { login: 'acme-co' } }],
    [{ state: 'active', role: 'admin' }],
    [{ state: 'active', role: 'admin', organization: { login: 'not a login' } }],
    Array(101).fill({ state: 'active', role: 'admin', organization: { login: 'acme-co' } }),
  ]) {
    assert.throws(() => parseOrganizationMemberships(page));
  }
});
test('merged organizations are unique, sorted without case, and bounded', () => {
  assert.deepEqual(
    mergeOrganizations([
      ['beta', 'Acme'],
      ['acme-co', 'beta'],
    ]),
    ['acme-co', 'Acme', 'beta'].sort((left, right) => left.toLowerCase().localeCompare(right.toLowerCase())),
  );
  const many = Array.from({ length: 301 }, (_, index) => `org-${index}`);
  assert.throws(() => mergeOrganizations([many]));
});
test('GitHub failures are told apart so the screen names the fix', () => {
  assert.equal(classifyOrganizationFailure('This API operation needs the "read:org" scope. To request it, run: gh auth refresh -s read:org'), 'needsScope');
  assert.equal(classifyOrganizationFailure('gh: Bad credentials (HTTP 401)'), 'failed');
  assert.equal(classifyOrganizationFailure(''), 'failed');
  assert.equal(classifyCreateFailure('GraphQL: Name already exists on this account (createRepository)'), 'exists');
  assert.equal(classifyCreateFailure('Resource protected by organization SAML enforcement. You must grant your token access (HTTP 403)'), 'approval');
  assert.equal(classifyCreateFailure('The acme-co organization has enabled OAuth App access restrictions (HTTP 403)'), 'approval');
  assert.equal(classifyCreateFailure('gh: You do not have permission to create repositories in acme-co (HTTP 403)'), 'forbidden');
  assert.equal(classifyCreateFailure('connect ETIMEDOUT'), 'other');
  assert.equal(classifyCreateFailure(''), 'other');
});
