// Goal: the Feedback file parser accepts what Stacki and an agent write and
// refuses what would corrupt the list. Methodology: one known-good file (with an
// agent-appended item that has no keys or createdAt), then each known-bad shape.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseFeedbackFile } from '#dist/shared/ipc/feedback.js';

const item = { id: 'a', keys: ['src/pages/index.astro#0'], label: 'h1', note: 'Fix', done: false };
const agentItem = { id: 'q', keys: [], label: 'Question', note: 'Which font?', done: false };

test('a valid file parses, ignoring the trail main owns', () => {
  const parsed = parseFeedbackFile({
    version: 1,
    items: [{ ...item, trail: ['src/pages/index.astro:1-3'] }, agentItem],
  });
  assert.deepEqual(parsed, { version: 1, items: [item, agentItem] });
});

test('malformed files are refused', () => {
  assert.throws(() => parseFeedbackFile({ version: 2, items: [] }), /version 1/);
  assert.throws(() => parseFeedbackFile({ version: 1 }), /Expected array/);
  assert.throws(() => parseFeedbackFile({ version: 1, items: [item, item] }), /duplicate item id/);
  assert.throws(
    () => parseFeedbackFile({ version: 1, items: [{ ...item, done: undefined }] }),
    /Expected boolean/,
  );
  assert.throws(() => parseFeedbackFile([]), /Expected object/);
});
