// Goal: the Roles panel's "Invite member" model is right for every sign-in method and safe on hostile input.
// Method: table tests per provider form (valid, normalised, invalid, over-long), adding and moving members through
// roles.json (duplicates, the member bound, the last admin), the audit message, the custom-provider fallback with and without
// a provider-declared parser, and the interface's optional `inviteHint` validation. Pure functions: no UI, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addInvitedMember,
  inviteFormFor,
  parseInviteIdentifier,
  removeInvitedMember,
  rolesChangeMessage,
  signInLink,
  type InviteForm,
} from '../src/features/roles/memberInvite';
import { parseProjectRolesSource, ROLE_LIMITS, serializeProjectRoles } from '../vendor/stacki/shared/properties/projectRoles';
import { validateAuthProvider, type AuthProvider } from '../src/features/auth/authProvider';

const file = (extra: { admin?: readonly string[]; client?: readonly string[] } = {}) =>
  parseProjectRolesSource(
    JSON.stringify({
      version: 1,
      roles: [
        { id: 'admin', name: 'Admin', members: extra.admin ?? ['octocat'] },
        { id: 'client', name: 'Client', members: extra.client ?? [] },
      ],
    }),
  );

const form = (provider: string) => {
  const found = inviteFormFor(provider, undefined);
  assert.ok(found, provider);
  return found;
};

test('each site gets the one form for its provider; unknown ids get none; custom providers get the generic one', () => {
  assert.equal(form('github').kind, 'github-login');
  for (const provider of ['access', 'google', 'oidc']) {
    assert.deepEqual(form(provider), { kind: 'email', provider });
  }
  assert.equal(form('passkey').kind, 'passkey-handle');
  assert.equal(inviteFormFor('saml', undefined), undefined, 'an unknown built-in id offers nothing');
  assert.deepEqual(inviteFormFor('acme', { displayName: 'Acme SSO', hint: 'employee number' }), {
    kind: 'custom',
    provider: 'acme',
    displayName: 'Acme SSO',
    hint: 'employee number',
  });
  assert.equal(inviteFormFor('Bad Id', { displayName: 'x', hint: undefined }), undefined);
});

test('identifiers are normalised per provider', () => {
  const ok = (provider: string, input: string) => {
    const result = parseInviteIdentifier(form(provider), input);
    assert.ok(result.ok, `${provider} ${input}`);
    return result.value;
  };
  assert.equal(ok('github', '  @OctoCat '), 'OctoCat');
  assert.equal(ok('google', ' Ann@Corp.Test '), 'google:ann@corp.test');
  assert.equal(ok('oidc', 'ann@corp.test'), 'oidc:ann@corp.test');
  assert.equal(ok('access', 'ann@corp.test'), 'access:ann@corp.test');
  assert.equal(ok('passkey', ' Client-Acme '), 'passkey:client-acme');
  const custom: InviteForm = { kind: 'custom', provider: 'acme', displayName: 'Acme', hint: undefined };
  const generic = parseInviteIdentifier(custom, 'emp-42');
  assert.ok(generic.ok);
  assert.equal(generic.value, 'acme:emp-42');
  const shaped = parseInviteIdentifier(custom, 'EMP-42', (input) => input.toLowerCase().replace(/^emp-/, ''));
  assert.ok(shaped.ok);
  assert.equal(shaped.value, 'acme:42');
  assert.equal(parseInviteIdentifier(custom, 'x', () => undefined).ok, false, 'the provider can refuse');
});

test('hostile or malformed identifiers are refused with a message, never written', () => {
  const bad: readonly (readonly [string, string])[] = [
    ['github', ''],
    ['github', 'bad name'],
    ['github', 'a,b'],
    ['github', '-x'],
    ['github', 'x'.repeat(200)],
    ['google', 'not-an-email'],
    ['google', 'a@b'],
    ['google', 'a b@c.test'],
    ['google', 'a@b.com,c@d.com'],
    ['google', `${'a'.repeat(201)}@b.test`],
    ['google', 'a@b.test\nco-authored-by: x'],
    ['passkey', 'Has Space'],
    ['passkey', '-lead'],
    ['passkey', 'a'.repeat(65)],
    ['passkey', 'x\u0000y'],
    ['passkey', 'a/b'],
    ['oidc', ''],
    ['access', '   '],
  ];
  for (const [provider, input] of bad) {
    const result = parseInviteIdentifier(form(provider), input);
    assert.equal(result.ok, false, `${provider} ${JSON.stringify(input).slice(0, 30)}`);
    assert.ok(!result.ok && result.error.messageRef !== undefined, 'a translatable message');
  }
  const custom: InviteForm = { kind: 'custom', provider: 'acme', displayName: 'Acme', hint: undefined };
  for (const input of ['a b', 'a,b', 'x'.repeat(300), 'a\nb', '']) {
    assert.equal(parseInviteIdentifier(custom, input).ok, false, JSON.stringify(input).slice(0, 20));
  }
});

test('inviting adds the member to the chosen role, moves people between roles, and refuses duplicates and the bound', () => {
  const added = addInvitedMember(file(), 'client', 'google:ann@corp.test');
  assert.ok(added.ok);
  assert.deepEqual(added.value.roles.find((role) => role.id === 'client')?.members, ['google:ann@corp.test']);
  assert.ok(parseProjectRolesSource(serializeProjectRoles(added.value)), 'the result is a valid roles file');
  const again = addInvitedMember(added.value, 'client', 'google:ann@corp.test');
  assert.equal(again.ok ? 'ok' : again.error.messageRef?.key, 'roles.error.memberListed');
  const moved = addInvitedMember(added.value, 'admin', 'google:ann@corp.test');
  assert.ok(moved.ok);
  assert.deepEqual(moved.value.roles.find((role) => role.id === 'client')?.members, [], 'a person belongs to one role');
  assert.equal(addInvitedMember(file(), 'nope', 'google:a@b.test').ok, false);
  const bare = addInvitedMember(file({ client: ['OctoDog'] }), 'client', 'octodog');
  assert.equal(bare.ok, false, 'GitHub logins compare case-insensitively');
  const full = file({ client: Array.from({ length: ROLE_LIMITS.membersMax }, (_, index) => `google:p${index}@corp.test`) });
  const over = addInvitedMember(full, 'client', 'google:one-more@corp.test');
  assert.equal(over.ok ? 'ok' : over.error.messageRef?.key, 'roles.error.membersMax');
});

test('the last admin can be neither removed nor moved away', () => {
  const alone = file({ admin: ['google:boss@corp.test'] });
  const removed = removeInvitedMember(alone, 'google:boss@corp.test');
  assert.equal(removed.ok ? 'ok' : removed.error.messageRef?.key, 'roles.error.lastAdmin');
  const moved = addInvitedMember(alone, 'client', 'google:boss@corp.test');
  assert.equal(moved.ok ? 'ok' : moved.error.messageRef?.key, 'roles.error.lastAdmin');
  const two = file({ admin: ['google:boss@corp.test', 'google:deputy@corp.test'] });
  const fewer = removeInvitedMember(two, 'google:deputy@corp.test');
  assert.ok(fewer.ok);
  assert.equal(removeInvitedMember(two, 'google:stranger@corp.test').ok, false);
});

test('the audit message is one bounded printable line, and the sign-in link is the Studio address', () => {
  assert.equal(rolesChangeMessage({ kind: 'invite', member: 'google:a@b.com', role: 'Editor' }), 'Invite google:a@b.com as Editor');
  assert.equal(rolesChangeMessage({ kind: 'remove', member: 'passkey:zed' }), 'Remove passkey:zed from roles');
  assert.equal(rolesChangeMessage({ kind: 'move', member: 'oidc:a@b.com', role: 'Client' }), 'Move oidc:a@b.com to Client');
  const hostile = rolesChangeMessage({ kind: 'invite', member: 'x\nCo-authored-by: boss', role: 'R'.repeat(500) });
  assert.equal(hostile.split('\n').length, 1);
  assert.ok(hostile.length < 260);
  assert.equal(signInLink('https://studio.example.com/'), 'https://studio.example.com/studio');
});

test('a custom provider may declare an invite hint and parser; bad declarations are refused', () => {
  const base: AuthProvider = {
    id: 'acme',
    displayName: 'Acme',
    begin: () => Promise.resolve(new Response()),
    identify: () => Promise.resolve({ ok: false, error: { problem: 'expired' } }),
  };
  assert.ok(validateAuthProvider({ ...base, inviteHint: 'employee number', parseInviteIdentifier: (input: string) => input }, 'custom').ok);
  for (const bad of [{ inviteHint: 5 }, { inviteHint: 'x'.repeat(81) }, { inviteHint: 'a\nb' }, { parseInviteIdentifier: 'no' }]) {
    assert.equal(validateAuthProvider({ ...base, ...bad }, 'custom').ok, false, JSON.stringify(bad).slice(0, 30));
  }
});
