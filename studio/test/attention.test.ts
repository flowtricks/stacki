// Goal: the "Needs attention" status always explains itself.
// Method: drive the pure model (causes in, label and menu rows out) with every cause kind, plus the negative space: no cause, several
// causes, a repeated kind, an oversized server message, and the bound on how many causes are held.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ENGLISH_TRANSLATE } from '../vendor/stacki/shared/properties/i18n/englishTranslator';
import {
  ATTENTION_DETAIL_CHARS_MAX,
  addCause,
  attentionEntries,
  attentionLabel,
  causeAction,
  causeFromServerError,
  type AttentionCause,
} from '../src/features/collaboration/attention';
import { saveStatusLabel } from '../src/features/collaboration/saveStatus';

const handlers = { retry: () => undefined, copyDraft: () => undefined };
const ALL: readonly AttentionCause[] = [
  { kind: 'save-unconfirmed' },
  { kind: 'draft-failed' },
  { kind: 'draft-replaced' },
  { kind: 'file-removed' },
  { kind: 'edit-failed', detail: 'EACCES: permission denied' },
];

test('exactly one cause names itself in the status; several or none keep the general words', () => {
  assert.equal(attentionLabel([{ kind: 'draft-failed' }], ENGLISH_TRANSLATE), 'Draft not saved');
  assert.equal(attentionLabel([], ENGLISH_TRANSLATE), 'Needs attention');
  assert.equal(attentionLabel([{ kind: 'draft-failed' }, { kind: 'file-removed' }], ENGLISH_TRANSLATE), 'Needs attention');
  assert.equal(saveStatusLabel('Needs attention', ENGLISH_TRANSLATE, [{ kind: 'save-unconfirmed' }]), 'Save not confirmed');
  assert.equal(saveStatusLabel('Saved', ENGLISH_TRANSLATE, [{ kind: 'save-unconfirmed' }]), 'Saved');
});

test('every cause draws a heading and a note, and an action row exactly when it has a fix', () => {
  for (const cause of ALL) {
    const entries = attentionEntries([cause], ENGLISH_TRANSLATE, handlers);
    assert.deepEqual(
      entries.map((entry) => entry.kind),
      causeAction(cause) === undefined ? ['heading', 'note'] : ['heading', 'note', 'item'],
      cause.kind,
    );
    assert.ok(entries.every((entry) => entry.id.startsWith(cause.kind)));
  }
  const detail = attentionEntries([{ kind: 'edit-failed', detail: 'EACCES: permission denied' }], ENGLISH_TRANSLATE, handlers)[1];
  assert.equal(detail?.kind === 'note' && detail.text.includes('EACCES: permission denied'), true);
});

test('causes are separated by a divider, and a row runs its own handler', () => {
  const calls: string[] = [];
  const entries = attentionEntries([{ kind: 'save-unconfirmed' }, { kind: 'draft-replaced' }], ENGLISH_TRANSLATE, {
    retry: () => calls.push('retry'),
    copyDraft: () => calls.push('copy'),
  });
  assert.equal(entries.filter((entry) => entry.kind === 'divider').length, 1);
  for (const entry of entries) {
    if (entry.kind === 'item') {
      entry.onSelect();
    }
  }
  assert.deepEqual(calls, ['retry', 'copy']);
  assert.equal(new Set(entries.map((entry) => entry.id)).size, entries.length);
});

test('a server error maps to its own cause, and anything else is an edit failure with a bounded detail', () => {
  assert.deepEqual(causeFromServerError('studio.collab.draftFailed', 'x'), { kind: 'draft-failed' });
  assert.deepEqual(causeFromServerError('studio.collab.fileRemoved', 'x'), { kind: 'file-removed' });
  assert.deepEqual(causeFromServerError(undefined, 'Error: disk full'), { kind: 'edit-failed', detail: 'Error: disk full' });
  const long = causeFromServerError('studio.collab.editFailed', 'a'.repeat(5000));
  assert.equal(long.kind === 'edit-failed' && long.detail.length, ATTENTION_DETAIL_CHARS_MAX);
});

test('a cause is held once per kind, newest detail wins, and the list stays bounded', () => {
  const once = addCause([{ kind: 'edit-failed', detail: 'old' }], { kind: 'edit-failed', detail: 'new' });
  assert.deepEqual(once, [{ kind: 'edit-failed', detail: 'new' }]);
  let held: readonly AttentionCause[] = [];
  for (const cause of [...ALL, ...ALL]) {
    held = addCause(held, cause);
  }
  assert.equal(held.length, ALL.length);
});
