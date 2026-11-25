// Goal: the Studio server refuses to ADD a component the sender's role hides, as a typed Result and with
// nothing written, even when a modified client skips the palette's filter; while components already on the
// page, other roles, other components and admin without rules stay unaffected, and admin restricted by
// rules is still refused only for inserting (never for settings, which `can()` answers separately).
// Method: build roles with the real parser, resolve views, and run the real checks (componentAccess.ts)
// and the document gate (documentAccess.ts) on insert actions and text edits, each side of every rule.
import assert from 'node:assert/strict';
import test from 'node:test';
import { checkComponentImports, checkComponentInsert, importSpecifiers } from '../src/features/roles/componentAccess';
import { assertComponentInsertAllowed, assertDocumentChangeAllowed } from '../src/features/roles/documentAccess';
import { RoleRefusal } from '../src/features/roles/serverAccess';
import { can, parseProjectRoles, roleViewOf } from '../vendor/stacki/shared/properties/projectRoles';
import type { TreeAction } from '../src/features/source/source';

const roles = parseProjectRoles({
  version: 1,
  roles: [
    { id: 'admin', members: ['owner'], componentRules: [{ kind: 'folder', path: 'src/components/secret' }] },
    {
      id: 'client',
      access: ['panel:pages', 'page:layout'],
      componentRules: [
        { kind: 'folder', path: 'src/components/interactive' },
        { kind: 'component', path: 'src/components/interactive/Tabs.astro', effect: 'show' },
      ],
    },
  ],
});
const client = roleViewOf(roles, 'client');
const admin = roleViewOf(roles, 'admin');
const insert = (importPath: string): TreeAction => ({ kind: 'insert', target: 'a', name: 'X', importPath, paired: false });

test('an insert of a hidden component is refused with a typed error; a shown or other one passes', () => {
  const hidden = checkComponentInsert(client, 'src/pages/index.astro', insert('../components/interactive/Modal.astro'), []);
  assert.equal(hidden.ok, false);
  assert.equal(!hidden.ok && hidden.error.code, 'component-hidden');
  assert.equal(!hidden.ok && hidden.error.file, 'src/components/interactive/Modal.astro');
  assert.equal(
    checkComponentInsert(client, 'src/pages/index.astro', insert('../components/interactive/Tabs.astro'), []).ok,
    true,
    'a show rule re-enables one',
  );
  assert.equal(checkComponentInsert(client, 'src/pages/index.astro', insert('@/components/Card.astro'), []).ok, true);
  assert.equal(checkComponentInsert(client, 'src/pages/index.astro', insert('@/components/interactive/Modal.astro'), []).ok, false, 'the @ alias resolves');
});

test('a configured import path resolves through the project settings, so an alias cannot sidestep the rule', () => {
  const configured = [{ file: 'src/components/interactive/Modal.astro', importPath: 'ui/modal' }];
  assert.equal(checkComponentInsert(client, 'src/pages/index.astro', insert('ui/modal'), configured).ok, false);
  assert.equal(checkComponentInsert(client, 'src/pages/index.astro', insert('ui/modal'), []).ok, true, 'unresolvable without settings: nothing to hide by');
});

test('admin is restricted for inserting like any role, and keeps every other power', () => {
  assert.equal(checkComponentInsert(admin, 'src/pages/index.astro', insert('../components/secret/Key.astro'), []).ok, false);
  assert.equal(can(admin, 'settings:roles'), true, 'rules never touch settings access');
  assert.equal(can(admin, 'code:edit'), true);
});

test('the document gate throws for an insert action and writes nothing; other actions pass', () => {
  assert.throws(() => assertComponentInsertAllowed(client, 'src/pages/index.astro', insert('../components/interactive/Modal.astro'), []), RoleRefusal);
  assertComponentInsertAllowed(client, 'src/pages/index.astro', { kind: 'duplicate', node: 'a' }, []);
  assertComponentInsertAllowed(client, 'src/pages/index.astro', { kind: 'delete', node: 'a' }, []);
});

test('a text edit may not introduce a hidden import, but one already on the page stays and is editable', () => {
  const before = `---\nimport Modal from '../components/interactive/Modal.astro';\n---\n<Modal />\n`;
  const addModal = `---\nimport Modal from '../components/interactive/Modal.astro';\nimport Tabs from '../components/interactive/Tabs.astro';\n---\n<Modal /><Tabs />\n`;
  assertDocumentChangeAllowed(client, 'src/pages/index.astro', before, addModal);
  const bypass = `---\nimport Other from '../components/interactive/Other.astro';\n---\n<Other />\n`;
  assert.throws(() => assertDocumentChangeAllowed(client, 'src/pages/index.astro', `---\n---\n<p />\n`, bypass), RoleRefusal);
  assert.equal(checkComponentImports(client, 'src/pages/index.astro', before, before + '<p />', []).ok, true, 'editing around an existing instance is allowed');
});

test('importSpecifiers is bounded and reads from and dynamic imports', () => {
  assert.deepEqual(importSpecifiers(`import A from "./a.astro"; const b = import('./b.astro'); import c from './c.ts';`), ['./a.astro', './b.astro']);
  assert.equal(importSpecifiers("import A from './a.astro';\n".repeat(5000)).length, 2000);
});
