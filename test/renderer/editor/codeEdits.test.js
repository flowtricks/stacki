// Goal: the renderer's half of step 8 — typed code is saved as a patch through
// the page's actor (src/editor/codeEdits.ts) from the baseline the text descends from
// (src/editor/pageEdits.ts, the `code` queue) — keeps plan §3.6 and §7. Typing takes
// its baseline from the page as shown and keeps it until the page is clean; a
// refused page's text is patched over the disk only after "Save this version";
// a save that lands while the user kept typing, holding more than it sent,
// has the typing merged into it, so the next save never takes the merged edit
// back out; typing that cannot merge is a `merge-conflict`, and every refusal
// keeps the text. Invalid intermediates save like any text, and the page
// comes back editable when it parses.
// Method: the real modules, bundled with esbuild, driven directly. The queue's
// transitions are checked one by one; `sendCode` runs against a fake `send`
// and `read` for its outcome table, then against main's real handlers in the
// windowless harness on a temporary project, with outside edits made on disk.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');
const { parsePageDiskRead, parsePageEditResult } = require('#dist/shared/ipc/pageSave.js');
const { applyCodePatch } = require('#dist/shared/engine/codePatch.js');
const { LIMITS } = require('#dist/shared/core/limits.js');
const { repoPath } = require('../../helpers/sources.js');

const buildDirectory = repoPath('node_modules/.stacki-test/code-edits');
fs.mkdirSync(buildDirectory, { recursive: true });
esbuild.buildSync({
  // Named entries: each output is <name>.js wherever its source lives.
  entryPoints: {
    pageEdits: repoPath('src/editor/pageEdits.ts'),
    codeEdits: repoPath('src/editor/codeEdits.ts'),
  },
  outdir: buildDirectory,
  bundle: true,
  format: 'cjs',
  platform: 'node',
  logLevel: 'silent',
});
const edits = require(path.join(buildDirectory, 'pageEdits.js'));
const code = require(path.join(buildDirectory, 'codeEdits.js'));

const sum = (digit) => String(digit).repeat(64);
const clean = (digit) => ({ tag: 'clean', checksum: sum(digit) });
const dirty = (digit) => ({ tag: 'dirty', baseChecksum: sum(digit) });
const known = (digit, source, typedFrom = source) => ({
  tag: 'known',
  checksum: sum(digit),
  source,
  typedFrom,
});
const record = () => ({ outcome: { tag: 'applied', applied: [] } });
const REF = { path: [0], kind: 'element', span: { start: 0, end: 4 } };

const shown = (save, source) => ({ save, source, origin: undefined });
const shownPage = (read) => shown({ tag: 'clean', checksum: read.checksum }, read.source);

test('typing takes its baseline from the page as shown, and keeps it while owed', () => {
  const store = new edits.EditDrafts();
  const step = record();
  store.typeCode('/p', shown(clean(1), 'one'), step);
  assert.deepEqual(store.codeBaseline('/p'), known(1, 'one'));
  store.typeCode('/p', shown(dirty(1), 'one!'), step);
  assert.deepEqual(store.codeBaseline('/p'), known(1, 'one'), 'more typing keeps the baseline');
  store.codeSaved('/p', { checksum: sum(2), source: 'one!', typedFrom: 'one!' });
  assert.deepEqual(store.codeBaseline('/p'), known(2, 'one!'));
  // Sent and saved, the entry is gone: the next keystroke starts over.
  store.shift('/p');
  store.typeCode('/p', shown(clean(3), 'three'), record());
  assert.deepEqual(store.codeBaseline('/p'), known(3, 'three'));
  // Another page starts over too.
  store.typeCode('/q', shown(dirty(4), 'four'), record());
  assert.deepEqual(store.codeBaseline('/q'), known(4, 'four'));
  assert.equal(store.entries('/p').length, 0, 'one page at a time, as before');
});

test('typing over unsent gestures drops them', () => {
  const store = new edits.EditDrafts();
  const step = record();
  const gesture = {
    coalesceKey: undefined,
    urgency: false,
    stream: undefined,
    request: () => [],
    apply: (model) => model,
  };
  store.addGesture('/p', gesture, step);
  assert.equal(step.outcome.tag, 'pending');
  store.typeCode('/p', shown(dirty(1), 'text of 1'), record());
  assert.deepEqual(step.outcome, { tag: 'dropped' }, 'its undo step has nothing of its own');
  assert.deepEqual(store.codeBaseline('/p'), known(1, 'text of 1'));
  assert.deepEqual(
    store.entries('/p').map((entry) => entry.tag),
    ['code'],
    'nothing else is sent',
  );
});

test('a refused page patches the disk only after the user keeps their text', () => {
  const store = new edits.EditDrafts();
  const refused = { tag: 'conflicted', baseChecksum: sum(1), diskChecksum: sum(2) };
  store.typeCode('/p', shown(refused, 'a review of the model'), record());
  assert.deepEqual(store.codeBaseline('/p'), { tag: 'disk' }, 'its text is not bytes on disk');
  store.typeCode('/q', shown(clean(1), 'mine'), record());
  store.acceptDisk('/q');
  assert.deepEqual(store.codeBaseline('/q'), { tag: 'disk' });
  assert.throws(() => store.codeBaseline('/z'), /Only a code entry has a baseline/);
});

// --- sendCode against fakes ---------------------------------------------------------

function harness(baseline, answers = []) {
  const store = new edits.EditDrafts();
  store.typeCode('/p', { save: clean(1), source: 'unused', origin: undefined }, record());
  if (baseline.tag === 'disk') {
    store.acceptDisk('/p');
  } else {
    store.codeSaved('/p', baseline);
  }
  const sent = [];
  const reads = [];
  const send = async (request) => {
    sent.push(request);
    const answer = answers.shift();
    assert.ok(answer !== undefined, 'a send the test expected');
    return answer;
  };
  const read = async (file) => {
    reads.push(file);
    return { ...page('disk text'), checksum: sum(7) };
  };
  return { store, sent, reads, send, read };
}

function page(source) {
  return { editable: false, reason: 'x', bail: undefined, source, checksum: sum(9) };
}

const applied = (digit, source) => ({
  ok: true,
  value: { ...page(source), checksum: sum(digit), inverse: [] },
});
const rejected = (reason, disk) => ({
  ok: false,
  error: {
    code: 'rejected',
    reason,
    message: reason,
    diskChecksum: disk === undefined ? undefined : sum(disk),
  },
});

async function save(fake, text, base = sum(1), stateBase = sum(1)) {
  return code.sendCode({
    path: '/p',
    text,
    baseline: fake.store.codeBaseline('/p'),
    base,
    stateBase,
    store: fake.store,
    send: fake.send,
    read: fake.read,
  });
}

test('sendCode: the patch from the baseline, and every outcome', async () => {
  const base = '<h1>Title</h1>\n<p>Body</p>\n';
  // Applied: the request is the patch, and the baseline advances to the reply.
  let fake = harness({ checksum: sum(1), source: base, typedFrom: base }, [applied(2, 'reply')]);
  const typed = base.replace('Body', 'Text');
  let outcome = await save(fake, typed);
  assert.equal(outcome.tag, 'applied');
  const [request] = fake.sent;
  assert.equal(request.authoredChecksum, sum(1));
  assert.equal(request.edit.tag, 'code-patch');
  assert.equal(applyCodePatch(base, request.edit.hunks), typed, 'the hunks are the typing');
  assert.deepEqual(fake.store.codeBaseline('/p'), known(2, 'reply', typed));
  // Refused over changed bytes: the notice, relative to the authored bytes.
  fake = harness({ checksum: sum(1), source: base, typedFrom: base }, [rejected('merge-conflict', 3)]);
  outcome = await save(fake, typed);
  assert.deepEqual(outcome, {
    tag: 'refused',
    reason: 'merge-conflict',
    baseChecksum: sum(1),
    diskChecksum: sum(3),
  });
  assert.deepEqual(fake.store.codeBaseline('/p'), known(1, base), 'the baseline is kept');
  // Refused over unchanged bytes (main's payload bound), unreadable, or
  // transient: a failed save, the text kept, the same patch sent next time.
  for (const answer of [
    rejected('resource-limit', 1),
    rejected('write-failed', undefined),
    { ok: false, error: { code: 'filesystem', message: 'disk full' } },
    { ok: false, error: { code: 'uncertain', message: 'maybe' } },
  ]) {
    fake = harness({ checksum: sum(1), source: base, typedFrom: base }, [answer]);
    outcome = await save(fake, typed);
    assert.equal(outcome.tag, 'failed', JSON.stringify(answer));
    assert.deepEqual(fake.store.codeBaseline('/p'), known(1, base));
  }
});

test('sendCode merges typing into a save that came back holding more', async () => {
  const sent = '<h1>Title</h1>\n<p>Body</p>\n<footer>End</footer>\n';
  const reply = sent.replace('End', 'Fin'); // An outside edit the host merged in.
  const typing = sent.replace('Title', 'Heading'); // Typed while the save was out.
  const fake = harness({ checksum: sum(2), source: reply, typedFrom: sent }, [applied(3, 'x')]);
  const outcome = await save(fake, typing, sum(2), sum(1));
  assert.equal(outcome.tag, 'applied');
  const [request] = fake.sent;
  assert.equal(request.authoredChecksum, sum(2));
  assert.equal(applyCodePatch(reply, request.edit.hunks), '<h1>Heading</h1>\n<p>Body</p>\n<footer>Fin</footer>\n', 'the outside edit stays');
  // Typing on the merged word cannot be ordered against it: nothing is sent.
  const clash = harness({ checksum: sum(2), source: reply, typedFrom: sent });
  const refused = await save(clash, sent.replace('End', 'Done'), sum(2), sum(1));
  assert.deepEqual(refused, {
    tag: 'refused',
    reason: 'merge-conflict',
    baseChecksum: sum(1),
    diskChecksum: sum(2),
  });
  assert.equal(clash.sent.length, 0);
});

test('sendCode over the disk: read first, and asked again if it moved', async () => {
  const moved = harness({ tag: 'disk' });
  const outcome = await save(moved, 'mine', sum(6));
  assert.deepEqual(outcome, {
    tag: 'refused',
    reason: undefined,
    baseChecksum: sum(6),
    diskChecksum: sum(7),
  });
  assert.deepEqual(moved.reads, ['/p']);
  const still = harness({ tag: 'disk' }, [applied(8, 'mine')]);
  assert.equal((await save(still, 'mine', sum(7))).tag, 'applied');
  assert.equal(applyCodePatch('disk text', still.sent[0].edit.hunks), 'mine');
});

test('sendCode refuses text past the bound before sending; a no-op save reads', async () => {
  const fake = harness({ checksum: sum(1), source: 'x', typedFrom: 'x' });
  const outcome = await save(fake, 'y'.repeat(LIMITS.sourceBytesMax + 1));
  assert.deepEqual(outcome, { tag: 'failed', message: 'The change exceeds a size limit.' });
  assert.equal(fake.sent.length, 0, 'never truncated, never sent');
  // Typed back to the baseline: nothing to send; the disk read settles it.
  const same = harness({ checksum: sum(7), source: 'disk text', typedFrom: 'disk text' });
  assert.equal((await save(same, 'disk text', sum(7))).tag, 'applied');
  assert.equal(same.sent.length, 0);
  const gone = harness({ checksum: sum(1), source: 'disk text', typedFrom: 'disk text' });
  assert.equal((await save(gone, 'disk text')).tag, 'refused', 'the disk moved under it');
});

// --- End to end: main's real handlers -----------------------------------------------

test('typed code reaches the page as patches: invalid, merged, refused, kept', async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-code-edits-'));
  fs.mkdirSync(path.join(root, 'src/pages'), { recursive: true });
  fs.mkdirSync(path.join(root, 'user'));
  fs.writeFileSync(path.join(root, 'package.json'), '{"dependencies":{"astro":"*"}}');
  const { mainHarness } = await import('../../helpers/mainHarness.ts');
  const main = mainHarness(path.join(root, 'user'));
  context.after(() => {
    main.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const file = path.join(root, 'src/pages/index.astro');
  // Edits merge when each keeps 64 bytes of untouched context (shared/engine/planText.ts):
  // the paragraphs keep the heading, the body and the footer that far apart.
  const filler = Array.from({ length: 6 }, (_, index) => `  <p>Paragraph ${index}</p>\n`).join('');
  const body = `  <p>Body</p>\n${filler}  <footer>End</footer>\n`;
  const text = `<main>\n  <h1>Title</h1>\n${filler}${body}</main>\n`;
  fs.writeFileSync(file, text);
  const read = async () => parsePageDiskRead(await main.invoke('page:read', file));
  const send = async (request) => parsePageEditResult(await main.invoke('page:edit', request));
  const store = new edits.EditDrafts();
  const shown = await read();
  const saveText = (value, base, stateBase = base) =>
    code.sendCode({
      path: file,
      text: value,
      baseline: store.codeBaseline(file),
      base,
      stateBase,
      store,
      send,
      read,
    });
  // An unclosed tag mid-typing is written; the page reads as a parse error.
  const typing = shownPage(shown);
  store.typeCode(file, typing, record());
  const broken = text.replace('</p>', '</p>\n  <div');
  const first = await saveText(broken, shown.checksum);
  assert.equal(first.tag, 'applied');
  assert.equal(first.last.editable, false);
  assert.equal(fs.readFileSync(file, 'utf8'), broken);
  // More typing closes it: editable again, with no reload.
  const closed = broken.replace('<div', '<div></div>');
  const second = await saveText(closed, first.last.checksum, shown.checksum);
  assert.equal(second.tag, 'applied');
  assert.equal(second.last.editable, true);
  // An outside edit lands; the next save merges with it and keeps it.
  const outside = closed.replace('End', 'Fin');
  fs.writeFileSync(file, outside);
  const typed = closed.replace('Title', 'Heading');
  const third = await saveText(typed, second.last.checksum, shown.checksum);
  assert.equal(third.tag, 'applied');
  const merged = outside.replace('Title', 'Heading');
  assert.equal(fs.readFileSync(file, 'utf8'), merged);
  // The user kept typing while that save was out: the next save keeps "Fin".
  const more = typed.replace('Body', 'Text');
  const fourth = await saveText(more, third.last.checksum, shown.checksum);
  assert.equal(fourth.tag, 'applied');
  assert.equal(fs.readFileSync(file, 'utf8'), merged.replace('Body', 'Text'));
  // An outside edit on the word being typed: refused, the disk untouched.
  const theirs = merged.replace('Body', 'Copy');
  fs.writeFileSync(file, theirs);
  const mine = more.replace('Text', 'Prose');
  const fifth = await saveText(mine, fourth.last.checksum, shown.checksum);
  assert.equal(fifth.tag, 'refused');
  assert.equal(fifth.reason, 'merge-conflict');
  assert.equal(fs.readFileSync(file, 'utf8'), theirs);
  // "Save this version": the user's text over the disk, deliberately.
  store.acceptDisk(file);
  const kept = await saveText(mine, fifth.diskChecksum);
  assert.equal(kept.tag, 'applied');
  assert.equal(fs.readFileSync(file, 'utf8'), mine);
});
