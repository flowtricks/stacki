// Goal: a role without code permission cannot rename its way into code. It may type any text into `page.md`; the same
// text in `page.mdx` or `page.astro` runs. Renaming and moving pages and folders otherwise work as before, and a role
// with a code permission renames freely.
// Method: ask the rule the rename route runs, with both kinds of rename request.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertRenameAllowed } from '../src/features/roles/writeRules';
import { ADMIN_VIEW, DEFAULT_PROJECT_ROLES, roleViewOf } from '../vendor/stacki/shared/properties/projectRoles';

const CLIENT = roleViewOf(DEFAULT_PROJECT_ROLES, 'client');

test('a rename keeps the kind of file, whichever way the request names it', () => {
  for (const kind of ['page', 'folder'] as const) {
    for (const [from, to] of [
      ['note.md', 'note.mdx'],
      ['note.md', 'note.astro'],
      ['note.md', 'other.MD'],
      ['note', 'note.astro'],
    ] as const) {
      const change = { kind, from, to };
      assert.throws(() => assertRenameAllowed(CLIENT, change), /cannot add or change code/, `${kind} ${from} to ${to}`);
      assert.doesNotThrow(() => assertRenameAllowed(ADMIN_VIEW, change));
    }
  }
});

test('ordinary renames and moves still work', () => {
  assert.doesNotThrow(() => assertRenameAllowed(CLIENT, { from: 'about.astro', to: 'team/about-us.astro' }));
  assert.doesNotThrow(() => assertRenameAllowed(CLIENT, { from: 'blog/a.mdx', to: 'blog/b.mdx' }));
  assert.doesNotThrow(() => assertRenameAllowed(CLIENT, { from: 'blog', to: 'news' }));
  assert.doesNotThrow(() => assertRenameAllowed(CLIENT, { from: 'docs.v1', to: 'docs.v2' }));
});
