// Goal: provider-qualified identities parse only into bounded, unambiguous `<provider>:<subject>` text, and a bare
// roles.json login keeps meaning `github:<login>` so no existing file needs migrating.
// Method: known-good and known-bad shapes, each bound at its limit and one past it, the comparison key for GitHub (case
// folded) and other providers (exact), and roles.json members written both ways resolving to the same role.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  IDENTITY_LIMITS,
  identityKey,
  identityProvider,
  identitySubject,
  parseProviderId,
  parseQualifiedIdentity,
} from '#dist/shared/properties/memberIdentity.js';
import { memberRole, parseProjectRoles } from '#dist/shared/properties/projectRoles.js';

test('qualified identities parse, split and reject malformed text', () => {
  const parsed = parseQualifiedIdentity('email:a@b.com');
  assert.ok(parsed.ok);
  assert.equal(identityProvider(parsed.value), 'email');
  assert.equal(identitySubject(parsed.value), 'a@b.com');
  for (const bad of ['', 'octocat', ':x', 'Email:a', 'email:', 'email:a b', 'email:a,b', 'email:a\u0000', 7, undefined]) {
    assert.equal(parseQualifiedIdentity(bad).ok, false, String(bad));
  }
});

test('every bound holds at its limit and fails one past it', () => {
  assert.ok(parseProviderId('p'.repeat(IDENTITY_LIMITS.providerCharsMax)).ok);
  assert.equal(parseProviderId('p'.repeat(IDENTITY_LIMITS.providerCharsMax + 1)).ok, false);
  assert.ok(parseQualifiedIdentity('p:' + 's'.repeat(IDENTITY_LIMITS.subjectCharsMax)).ok);
  assert.equal(parseQualifiedIdentity('p:' + 's'.repeat(IDENTITY_LIMITS.subjectCharsMax + 1)).ok, false);
});

test('GitHub logins compare case-insensitively and other providers exactly; a bare login is a GitHub login', () => {
  assert.equal(identityKey('Octocat'), identityKey('github:OCTOCAT'));
  assert.notEqual(identityKey('email:A@b.com'), identityKey('email:a@b.com'));
});

test('roles.json members written bare or qualified resolve to the same role', () => {
  const roles = parseProjectRoles({ version: 1, roles: [{ id: 'admin', name: 'Admin', members: ['Owner', 'email:boss@x.test'] }] });
  assert.equal(memberRole(roles, 'github:owner')?.id, 'admin');
  assert.equal(memberRole(roles, 'owner')?.id, 'admin');
  assert.equal(memberRole(roles, 'email:boss@x.test')?.id, 'admin');
  assert.equal(memberRole(roles, 'email:owner'), undefined);
  assert.throws(() => parseProjectRoles({ version: 1, roles: [{ id: 'admin', name: 'Admin', members: ['email:'] }] }));
});
