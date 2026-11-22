// Goal: one rule decides what a closed component offers on one instance (closedComponentReach.ts): words or a picture are
// hovered, labelled, typed in or opened in the image popup only when a prop or the slot of this instance decides them.
// Hardcoded or computed insides, and anything whose catalog has not arrived yet, offer nothing.
// Method: a table of every reach the canvas can name, then every way words can be covered by the text catalog (a prop
// target, a slot target, a prop the catalog names as blocked, the open file's own words, no entry, no catalog), each
// checked against the answer the hover, the editor and the popup must agree on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLOSED_COMPONENT_REACHES, isEditableThroughProps, textReach, type ClosedComponentReach } from '#dist/shared/properties/closedComponentReach.js';

test('only a prop or the slot of the instance makes a closed part editable', () => {
  const expected: Readonly<Record<ClosedComponentReach, boolean>> = { pending: false, prop: true, slot: true, internal: false };
  assert.deepEqual([...CLOSED_COMPONENT_REACHES].sort(), Object.keys(expected).sort(), 'the table names every reach');
  for (const reach of CLOSED_COMPONENT_REACHES) {
    assert.equal(isEditableThroughProps(reach), expected[reach], reach);
  }
});

test('words are reached by the catalog entry that covers them', () => {
  const rows: readonly { readonly name: string; readonly words: Parameters<typeof textReach>[0]; readonly reach: ClosedComponentReach }[] = [
    { name: 'text bound to a prop (`<h2>{title}</h2>`)', words: { loaded: true, covering: { from: 'prop' } }, reach: 'prop' },
    { name: 'text the page writes in the slot', words: { loaded: true, covering: { from: 'slot' } }, reach: 'slot' },
    { name: 'hardcoded or computed text: no entry covers it', words: { loaded: true, covering: undefined }, reach: 'internal' },
    { name: "the open file's own words are no instance's", words: { loaded: true, covering: {} }, reach: 'internal' },
    { name: 'the catalog has not arrived: nothing yet', words: { loaded: false, covering: { from: 'prop' } }, reach: 'pending' },
    { name: 'no catalog and no entry', words: { loaded: false, covering: undefined }, reach: 'pending' },
  ];
  for (const row of rows) {
    assert.equal(textReach(row.words), row.reach, row.name);
  }
  // The negative space: whatever covers words, nothing is offered before the catalog arrives.
  for (const covering of [undefined, {}, { from: 'prop' as const }, { from: 'slot' as const }]) {
    assert.equal(isEditableThroughProps(textReach({ loaded: false, covering })), false);
  }
});
