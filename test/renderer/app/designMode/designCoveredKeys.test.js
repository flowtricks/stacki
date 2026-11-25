// Goal: while Design mode covers the editor, the chords that would still act on it (the insert palette, which writes
// to the page; the rail's panels, hidden under the cover; the preview) are kept from it, and nothing else is: the AI
// panel's own chord, a field's Option letters, a code editor's find and Design mode's own keys pass.
//
// Method: the real rule over the real rail table, bundled by test/helpers/rendererModule.js; every rail action's
// chord is checked, so a new panel is covered without a change here.
const test = require('node:test');
const assert = require('node:assert/strict');
const load = require('../../../helpers/rendererModule');

const { reachesCoveredEditor } = load('src/app/designMode/model/designCoveredKeys.ts');
const { RAIL_SHORTCUTS } = load('src/app/railShortcuts.ts');

const press = (key, modifiers = {}) => ({
  key,
  code: /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : key,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ctrlKey: false,
  ...modifiers,
});
const idle = { typing: false, inCodeEditor: false };

test("the insert palette's chords are kept from the editor, from a field too, but not from a code editor", () => {
  for (const letter of ['f', 'e', 'k']) {
    assert.equal(reachesCoveredEditor(press(letter, { metaKey: true }), idle), true, letter);
    assert.equal(reachesCoveredEditor(press(letter, { ctrlKey: true }), { typing: true, inCodeEditor: false }), true, letter);
    assert.equal(reachesCoveredEditor(press(letter, { metaKey: true }), { typing: true, inCodeEditor: true }), false, letter);
  }
});

test("every panel chord but the AI panel's is kept from the editor, and a field keeps its Option letters", () => {
  assert.ok(RAIL_SHORTCUTS.length > 10);
  for (const shortcut of RAIL_SHORTCUTS) {
    const event = press(shortcut.letter, { altKey: shortcut.alt, shiftKey: shortcut.shift });
    assert.equal(reachesCoveredEditor(event, idle), shortcut.action !== 'ai', shortcut.action);
    assert.equal(reachesCoveredEditor(event, { typing: true, inCodeEditor: false }), false, shortcut.action);
  }
});

test('the preview chord is kept from the editor', () => {
  assert.equal(reachesCoveredEditor(press('p', { altKey: true, shiftKey: true }), idle), true);
});

test("Design mode's own keys and the ordinary editing chords pass", () => {
  for (const event of [
    press('v'),
    press('t'),
    press('r'),
    press('h'),
    press('Escape'),
    press('Enter'),
    press('Backspace'),
    press('ArrowLeft'),
    press('d', { metaKey: true }),
    press('c', { metaKey: true }),
    press('v', { metaKey: true }),
    press('z', { metaKey: true }),
    press('0', { metaKey: true }),
    press('h', { metaKey: true, shiftKey: true }),
    press('!', { shiftKey: true }),
  ]) {
    assert.equal(reachesCoveredEditor(event, idle), false, `${event.metaKey ? 'mod+' : ''}${event.key}`);
  }
});
