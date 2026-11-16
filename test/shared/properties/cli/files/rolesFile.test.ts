// Goal: the registry of `.stacki/roles.json` accepts exactly what the app writes and refuses what it would silently ignore or reject.
// Method: a realistic document in the shape serializeProjectRoles writes must pass both the registry (checkValue) and the app's
// parser (refusalOfSource); then one known-bad document per failure class (unknown key, wrong type, out of bounds, missing
// required, ungrantable feature) must be refused by the registry.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ROLES_FILE } from '#dist/shared/properties/cli/files/rolesFile.js';
import { refusalOfSource } from '#dist/shared/properties/cli/stackiFiles.js';
import { checkValue } from '#dist/shared/properties/cli/stackiSchema.js';

const registryRefusal = (document: unknown): string | undefined => checkValue({ kind: 'object', fields: ROLES_FILE.fields }, document, 'roles');

const good = {
  version: 1,
  defaultRole: 'client',
  roles: [
    { id: 'admin', name: 'Admin', members: ['octocat'], pinnedApps: ['forms'], componentRules: [{ kind: 'folder', path: 'src/components/internal' }] },
    { id: 'client', name: 'Client', members: ['jane-doe'], access: ['panel:pages', 'publish'] },
    {
      id: 'editor',
      name: 'Editor',
      members: [],
      access: ['panel:pages', 'panel:apps', 'app:forms', 'app:*'],
      appPermissions: { forms: { 'export-data': false } },
      pinnedApps: ['forms'],
      componentRules: [{ kind: 'component', path: 'src/components/internal/Hero.astro', effect: 'show' }],
    },
  ],
};

test('a document written the way the app writes it passes the registry and the app parser', () => {
  assert.equal(registryRefusal(good), undefined);
  assert.equal(refusalOfSource(ROLES_FILE, JSON.stringify(good, undefined, 2)), undefined);
});

test('the empty document passes both', () => {
  assert.equal(registryRefusal(ROLES_FILE.empty), undefined);
  assert.equal(refusalOfSource(ROLES_FILE, JSON.stringify(ROLES_FILE.empty)), undefined);
});

test('known-bad documents are refused by the registry', () => {
  const role = { id: 'editor', name: 'Editor' };
  const bad: ReadonlyArray<readonly [string, unknown, RegExp]> = [
    ['an unknown top-level key', { ...good, defualtRole: 'admin' }, /unknown key/],
    ['an unknown role key', { version: 1, roles: [{ ...role, acess: [] }] }, /unknown key/],
    ['a wrong type', { version: 1, roles: [{ ...role, members: 'octocat' }] }, /expected a list/],
    ['a wrong version', { ...good, version: 2 }, /expected 1/],
    ['a missing required roles list', { version: 1 }, /roles: required/],
    ['a missing role id', { version: 1, roles: [{ name: 'Editor' }] }, /id: required/],
    ['an unknown feature', { version: 1, roles: [{ ...role, access: ['panel:nowhere'] }] }, /does not match/],
    ['the ungrantable roles feature', { version: 1, roles: [{ ...role, access: ['settings:roles'] }] }, /does not match/],
    ['an invalid GitHub login', { version: 1, roles: [{ ...role, members: ['-bad-'] }] }, /does not match/],
    ['an uppercase role id', { version: 1, roles: [{ ...role, id: 'Editor' }] }, /does not match/],
    ['too many pinned apps', { version: 1, roles: [{ ...role, pinnedApps: Array.from({ length: 13 }, (_, index) => `app-${index}`) }] }, /at most/],
    [
      'a rule with an unknown effect',
      { version: 1, roles: [{ ...role, componentRules: [{ kind: 'folder', path: 'src', effect: 'maybe' }] }] },
      /expected one of/,
    ],
    ['a rule with no path', { version: 1, roles: [{ ...role, componentRules: [{ kind: 'folder' }] }] }, /path: required/],
    ['a permission that is not a boolean', { version: 1, roles: [{ ...role, appPermissions: { forms: { export: 'no' } } }] }, /true or false/],
  ];
  for (const [what, document, reason] of bad) {
    const refusal = registryRefusal(document);
    assert.ok(refusal !== undefined && reason.test(refusal), `${what}: ${String(refusal)}`);
  }
});
