// Goal: the demo's Reset pill shows only while the visitor has something Reset
// would undo. A fresh visit shows none; the first edit shows it; undoing back to the
// baked text hides it again, even though the undone updates stay in storage; a
// returning visitor with edits sees it at once; a saved settings file or upload
// counts, the demo's own pretend-publish record does not.
// Method: drive EditPresence with baked texts, the edits a reload would restore and
// changes as the rooms report them, recording every announcement. Then check the
// chrome hides its bar until told there are edits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditPresence } from '../demo/editPresence';
import { DEMO_PUBLISH_STATE_FILE } from '../demo/publish';

const BAKED: Readonly<Record<string, string>> = { 'src/pages/index.astro': '<h1>Hi</h1>\n', 'src/components/Card.astro': '<div />\n' };
const baked = (file: string): string | undefined => BAKED[file];

function presence(initial: { readonly edited?: ReadonlyMap<string, string>; readonly savedFiles?: readonly string[] } = {}) {
  const heard: boolean[] = [];
  const tracker = new EditPresence(baked, { edited: initial.edited ?? new Map(), savedFiles: initial.savedFiles ?? [] }, (present) => heard.push(present));
  return { tracker, heard };
}

test('a fresh visit has nothing to reset, and the first edit shows Reset', () => {
  const { tracker, heard } = presence();
  assert.equal(tracker.has(), false);
  tracker.text('src/pages/index.astro', '<h1>Hi there</h1>\n');
  assert.equal(tracker.has(), true);
  assert.deepEqual(heard, [true], 'announced once, as the first edit lands');
  tracker.text('src/pages/index.astro', '<h1>Hi there!</h1>\n');
  assert.deepEqual(heard, [true], 'a second edit changes nothing to announce');
});

test('undoing back to the baked text hides Reset again', () => {
  const { tracker, heard } = presence();
  tracker.text('src/pages/index.astro', '<h1>Hey</h1>\n');
  tracker.text('src/components/Card.astro', '<div class="x" />\n');
  tracker.text('src/pages/index.astro', BAKED['src/pages/index.astro'] ?? '');
  assert.equal(tracker.has(), true, 'the component still differs');
  tracker.text('src/components/Card.astro', BAKED['src/components/Card.astro'] ?? '');
  assert.equal(tracker.has(), false);
  assert.deepEqual(heard, [true, false]);
});

test('a returning visitor with edits sees Reset on load, one whose edits were undone does not', () => {
  assert.equal(presence({ edited: new Map([['src/pages/index.astro', '<h1>Saved</h1>\n']]) }).tracker.has(), true);
  assert.equal(presence({ edited: new Map([['src/pages/index.astro', BAKED['src/pages/index.astro'] ?? '']]) }).tracker.has(), false);
  assert.equal(presence({ savedFiles: ['.stacki/guide.json'] }).tracker.has(), true, 'a saved setting is an edit');
  assert.equal(presence({ savedFiles: [DEMO_PUBLISH_STATE_FILE] }).tracker.has(), false, 'a pretend publish is not');
});

test('a saved setting or upload shows Reset as it lands', () => {
  const { tracker, heard } = presence();
  tracker.file(DEMO_PUBLISH_STATE_FILE);
  assert.deepEqual(heard, [], 'the publish record announces nothing');
  tracker.file('public/uploads/photo.png');
  assert.deepEqual(heard, [true]);
});
