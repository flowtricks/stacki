// Goal: pin every SaveState transition (plan §7), the refused ones included.
// Method: bundle src/editor/saveState.ts and apply each transition to each state. A
// transition a state does not accept is a programmer error, so those cases
// assert and the test pins the message; the accepted ones pin the result.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const esbuild = require('esbuild');
const { repoPath } = require('../../helpers/sources.js');

const buildDirectory = repoPath('node_modules/.stacki-test/save-state');
fs.mkdirSync(buildDirectory, { recursive: true });
esbuild.buildSync({
  entryPoints: [repoPath('src/editor/saveState.ts')],
  outdir: buildDirectory,
  bundle: true,
  format: 'cjs',
  platform: 'node',
  logLevel: 'silent',
});
const save = require(path.join(buildDirectory, 'saveState.js'));

const base = 'a'.repeat(64);
const disk = 'b'.repeat(64);
const written = 'c'.repeat(64);
const states = {
  clean: { tag: 'clean', checksum: base },
  dirty: { tag: 'dirty', baseChecksum: base },
  saving: { tag: 'saving', baseChecksum: base },
  failed: { tag: 'failed', baseChecksum: base, message: 'EPERM' },
  conflicted: { tag: 'conflicted', baseChecksum: base, diskChecksum: disk },
};

test('reading or writing a file yields a clean state naming its bytes', () => {
  assert.deepEqual(save.saveStateClean(written), { tag: 'clean', checksum: written });
});

test('an edit applies in every state; only its path to disk differs', () => {
  assert.deepEqual(save.saveStateEdited(states.clean), states.dirty);
  assert.equal(save.saveStateEdited(states.dirty), states.dirty);
  // The write in flight does not carry this edit, so another must follow.
  assert.deepEqual(save.saveStateEdited(states.saving), states.dirty);
  assert.deepEqual(save.saveStateEdited(states.failed), states.dirty);
  // A conflicted page keeps its edits locally and keeps autosave off.
  assert.equal(save.saveStateEdited(states.conflicted), states.conflicted);
});

test('new and failed edits can start a save', () => {
  assert.deepEqual(save.saveStateStarted(states.dirty), states.saving);
  assert.deepEqual(save.saveStateStarted(states.failed), states.saving);
  for (const tag of ['clean', 'saving', 'conflicted']) {
    assert.throws(() => save.saveStateStarted(states[tag]), new RegExp(`Assertion failed: Only an unsaved page starts a save, not ${tag}`));
  }
});

test('a failed save retains its error and base, including typing during the save', () => {
  for (const tag of ['saving', 'dirty', 'failed']) {
    assert.deepEqual(save.saveStateFailed(states[tag], 'EPERM'), states.failed);
  }
  assert.throws(() => save.saveStateFailed(states.clean, 'EPERM'), /no failed save/);
  assert.throws(() => save.saveStateFailed(states.conflicted, 'EPERM'), /dismiss a conflict/);
  assert.throws(() => save.saveStateFailed(states.saving, ''), /explains why/);
});

test('a refusal records the base compared and the bytes found on disk', () => {
  const conflicted = { tag: 'conflicted', baseChecksum: written, diskChecksum: disk };
  for (const tag of ['dirty', 'saving', 'failed', 'conflicted']) {
    assert.deepEqual(save.saveStateRefused(states[tag], written, disk), conflicted);
  }
  assert.throws(() => save.saveStateRefused(states.clean, base, disk), /A clean page has nothing to refuse/);
  assert.throws(() => save.saveStateRefused(states.dirty, disk, disk), /A refusal names bytes other than the base/);
});

test('keeping the local version after review rebases it on the disk bytes', () => {
  assert.deepEqual(save.saveStateAccepted(states.conflicted), {
    tag: 'dirty',
    baseChecksum: disk,
  });
  for (const tag of ['clean', 'dirty', 'saving', 'failed']) {
    assert.throws(() => save.saveStateAccepted(states[tag]), new RegExp(`Only a conflicted page can be accepted, not ${tag}`));
  }
});

test('autosave can retry a failed state', () => {
  assert.deepEqual(
    Object.keys(states).filter((tag) => save.saveStateNeedsWrite(states[tag])),
    ['dirty', 'failed'],
  );
});

test('every state names the checksum it is relative to', () => {
  for (const tag of Object.keys(states)) {
    assert.equal(save.saveStateBase(states[tag]), base);
  }
});
