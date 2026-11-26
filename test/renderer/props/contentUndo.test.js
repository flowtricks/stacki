// Goal: ⌘Z and ⇧⌘Z in the Content field are the page's undo, so the file follows them, and the caret ends where the
// words changed, so typing goes on there.
// Method: the field is marked as one whose undo is the app's (data-app-undo, which the menu and key routes read), and
// the pure caret rule the field uses when its words are replaced (RichContent.tsx). The routes themselves were checked
// in the built app: every step of undo and redo, by the menu's own items and by the keys, matched the file.
const test = require('node:test');
const assert = require('node:assert/strict');
const load = require('../../helpers/rendererModule');
const fs = require('node:fs');
const { repoPath } = require('../../helpers/sources.js');

const { caretAfterChange } = load('src/features/props/RichContent.tsx');

test('a redo puts the caret after what came back, an undo after what is left', () => {
  assert.equal(caretAfterChange('Start words', 'Start words one', 11), 15);
  assert.equal(caretAfterChange('Start words one two', 'Start words one', 19), 15);
});

test('a change behind the caret, or before it, keeps the caret in its words', () => {
  assert.equal(caretAfterChange('one two three', 'one two three four', 3), 3);
  assert.equal(caretAfterChange('one two', 'zero one two', 7), 12);
  assert.equal(caretAfterChange('same', 'same', 2), 2);
});

test('the Content field says its undo is the app’s', () => {
  assert.match(fs.readFileSync(repoPath('src/features/props/RichContent.tsx'), 'utf8'), /data-app-undo=""/);
});
