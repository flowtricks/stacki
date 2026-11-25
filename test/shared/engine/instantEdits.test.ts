// Goal: no operation the planner can write is missing from the instant-edit table, every shipped
// strategy names a module that exists, and every gap says why. The compile-time half is the
// table's own type (`Record<OperationTag, ...>`); this test holds the runtime half and fails
// when the planner's source lists an operation the table does not, so a file edited without the
// type checker (a script, a generated list) is caught too.
// Method: read the operation tags out of shared/engine/intent.ts and compare with the table.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { INSTANT_EDITS } from '#dist/shared/engine/instantEdits.js';

const ROOT = new URL('../../../', import.meta.url);

test('every planner operation declares how the canvas shows it', () => {
  const source = readFileSync(new URL('shared/engine/intent.ts', ROOT), 'utf8');
  const operations = source.slice(source.indexOf('export type Operation ='), source.indexOf('export type OperationTag'));
  const tags = [...operations.matchAll(/readonly tag: '([a-z-]+)'/g)].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));
  assert.ok(tags.length >= 15, 'the operation union was read');
  for (const tag of tags) {
    assert.ok(tag in INSTANT_EDITS, `${tag} has no instant-edit strategy: add it to shared/engine/instantEdits.ts`);
  }
  assert.deepEqual(Object.keys(INSTANT_EDITS).sort(), [...new Set(tags)].sort(), 'the table names no operation the planner lacks');
});

test('shipped strategies name a module that exists, and gaps say why', () => {
  for (const [tag, entry] of Object.entries(INSTANT_EDITS)) {
    if (entry.status === 'shipped') {
      assert.ok(existsSync(new URL(entry.module, ROOT)), `${tag}: ${entry.module} exists`);
    } else {
      assert.equal(entry.status, 'unpredictable', `${tag}: no operation is left planned; it ships or says why it cannot`);
      assert.ok(entry.reason.length > 20, `${tag} says why it cannot be shown before the write`);
    }
  }
});
