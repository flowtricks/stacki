// Goal: Studio's editor, which polls `.stacki/apps/` stamps in place of a file
// watcher, announces a change only once the folder settled, as Desktop's watcher
// does: an agent writing an app across several polls makes one notice naming
// every folder that moved, never one per poll mid-write, and a folder that moved
// and moved back announces nothing.
// Method: settledFolderChange (src/features/apps/appFoldersClient.ts) fed a
// sequence of stamp readings by hand, one per poll, comparing each answer.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { settledFolderChange, type AppFolderPollState } from '../src/features/apps/appFoldersClient';

const stamps = (folders: Record<string, string>, files = '00') => ({ folders, files });

test('a change is announced once, on the first quiet poll, naming every folder that moved', () => {
  const state: AppFolderPollState = { announced: undefined, latest: undefined };
  assert.equal(settledFolderChange(state, stamps({ pins: 'a1', maps: 'b1' })), undefined, 'The first reading is the baseline');
  assert.equal(settledFolderChange(state, stamps({ pins: 'a1', maps: 'b1' })), undefined, 'Nothing moved');
  // An agent writes across three polls: still moving each time.
  assert.equal(settledFolderChange(state, stamps({ pins: 'a2', maps: 'b1' })), undefined);
  assert.equal(settledFolderChange(state, stamps({ pins: 'a3', maps: 'b1' })), undefined);
  assert.equal(settledFolderChange(state, stamps({ pins: 'a4', maps: 'b2' })), undefined);
  // Quiet: one notice against what was last announced.
  assert.deepEqual(settledFolderChange(state, stamps({ pins: 'a4', maps: 'b2' })), { folders: ['maps', 'pins'] });
  assert.equal(settledFolderChange(state, stamps({ pins: 'a4', maps: 'b2' })), undefined, 'A settled folder is announced once');
});

test('a folder that moved and moved back, or a removed folder, settles to what differs', () => {
  const state: AppFolderPollState = { announced: undefined, latest: undefined };
  settledFolderChange(state, stamps({ pins: 'a1' }));
  assert.equal(settledFolderChange(state, stamps({ pins: 'zz' })), undefined);
  assert.equal(settledFolderChange(state, stamps({ pins: 'a1' })), undefined);
  assert.equal(settledFolderChange(state, stamps({ pins: 'a1' })), undefined, 'Back where it was: nothing to announce');
  assert.equal(settledFolderChange(state, stamps({})), undefined);
  assert.deepEqual(settledFolderChange(state, stamps({})), { folders: ['pins'] }, 'A deleted folder is announced once it stays gone');
  // The lockfile beside the folders moves the lists, though no folder did.
  assert.equal(settledFolderChange(state, stamps({}, '11')), undefined);
  assert.deepEqual(settledFolderChange(state, stamps({}, '11')), { folders: [] });
});
