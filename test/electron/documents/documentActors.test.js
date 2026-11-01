// Goal: electron/documents/documentActors.ts, the host of the main process's document
// actors, keeps the plan's promises on a real disk: a program's text write (a
// `rewrite-text` of the diff, since step 10) applies and hands back the
// checksum the persistence layer adopts (§5.2); a stale
// base, another writer after the rename, and a missing file are typed
// rejections, never overwrites; installed code (node_modules), whatever path
// reaches it, is refused; a replace whose folder could not be flushed is
// `uncertain` and reconciled at once by comparison (§3.5); a full queue
// answers `backpressured` (§3.5); a batch leases its actors in sorted canonical
// order whatever order it names them in (§3.3); two spellings of one file meet
// at one actor; the actor count stays inside its bound; the watcher's hint
// refreshes off the intent path (§7); a watcher tick is the app's own echo only
// while the file holds the bytes its actor wrote (§11.9); and the telemetry line carries a hashed
// path and no source bytes (§9a).
// Method: real files under a mkdtemp directory, a host built from the real
// disk, planner and projector; filesystem failures injected by wrapping one
// `fs` function, as test/electron/documents/atomicWrite.test.js does. The deferred drain mode
// holds submissions in the actor's queue so the bound can be reached.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DocumentActors } = require('#dist/electron/documents/documentActors.js');
const { NODE_PROJECTOR, NodeDocumentDisk } = require('#dist/electron/documents/documentDisk.js');
const { createDocumentTelemetry, hashPath } = require('#dist/electron/documents/documentTelemetry.js');
const { LIMITS } = require('#dist/shared/core/limits.js');
const { planIntent } = require('#dist/shared/engine/planner.js');

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

function host({ drain = 'immediate', onLease } = {}) {
  const lines = [];
  const scheduled = [];
  const documents = new DocumentActors({
    disk: new NodeDocumentDisk(),
    projector: NODE_PROJECTOR,
    planner: planIntent,
    telemetry: createDocumentTelemetry((line) => lines.push(line)),
    drain,
    schedule: (task) => scheduled.push(task),
    ...(onLease === undefined ? {} : { onLease }),
  });
  return { documents, lines, scheduled };
}

function directory(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-actors-'));
  try {
    run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function withFailure(name, replacement, run) {
  const original = fs[name];
  fs[name] = (...argumentsList) => replacement(original, ...argumentsList);
  try {
    run();
  } finally {
    fs[name] = original;
  }
}

test('a replace applies, returns the new checksum, and the actor holds it', () => {
  directory((root) => {
    const file = path.join(root, 'index.astro');
    fs.writeFileSync(file, '<h1 title="Old">Hi</h1>\n');
    const { documents, lines } = host();
    const report = documents.writeText(file, '<h1 title="New">Hi</h1>\n', sha256(fs.readFileSync(file)));
    // The inverse is the replacement's changed region only (minimal splices).
    assert.deepEqual(report, {
      tag: 'applied',
      checksum: sha256('<h1 title="New">Hi</h1>\n'),
      inverse: [{ span: { start: 11, end: 14 }, text: 'Old' }],
    });
    assert.equal(fs.readFileSync(file, 'utf8'), '<h1 title="New">Hi</h1>\n');
    const current = documents.current(file);
    assert.equal(current.ok, true);
    assert.equal(current.value.checksum, report.checksum, 'the next baseline is the written one');
    assert.equal(lines.length, 1, 'one telemetry line per outcome');
    const line = JSON.parse(lines[0]);
    assert.deepEqual(Object.keys(line).sort(), ['count', 'event', 'file', 'intent', 'outcome']);
    assert.equal(line.file, hashPath(fs.realpathSync.native(file)));
    assert.equal(lines[0].includes(root), false, 'no raw path');
    assert.equal(lines[0].includes('New'), false, 'no source bytes');
    assert.deepEqual(fs.readdirSync(root).sort(), ['.stacki', 'index.astro']);
    assert.deepEqual(fs.readdirSync(path.join(root, '.stacki', 'io')), [], 'no save files remain');
  });
});

test('a text identical to the file rewrites it unchanged, as one empty hunk', () => {
  directory((root) => {
    const file = path.join(root, 'index.astro');
    fs.writeFileSync(file, '<h1>Hi</h1>\n');
    const { documents } = host();
    const report = documents.writeText(file, '<h1>Hi</h1>\n', sha256('<h1>Hi</h1>\n'));
    assert.deepEqual(report, {
      tag: 'applied',
      checksum: sha256('<h1>Hi</h1>\n'),
      inverse: [], // Nothing changed, so there is nothing to undo.
    });
    assert.equal(fs.readFileSync(file, 'utf8'), '<h1>Hi</h1>\n');
  });
});

test('a stale base is refused with the disk checksum and nothing is written', () => {
  directory((root) => {
    const file = path.join(root, 'index.astro');
    fs.writeFileSync(file, 'authored\n');
    const base = sha256('authored\n');
    fs.writeFileSync(file, 'outside\n');
    const { documents } = host();
    assert.deepEqual(documents.writeText(file, 'mine\n', base), {
      tag: 'rejected',
      reason: 'region-externally-modified',
      message: '',
      diskChecksum: sha256('outside\n'),
    });
    assert.equal(fs.readFileSync(file, 'utf8'), 'outside\n');
  });
});

test('another writer landing right after the rename is a write-race', () => {
  directory((root) => {
    const file = path.join(root, 'page.astro');
    fs.writeFileSync(file, 'authored\n');
    const { documents } = host();
    withFailure(
      'renameSync',
      (rename, from, to) => {
        rename(from, to);
        if (path.basename(from).startsWith('.stacki-write-')) {
          fs.writeFileSync(to, 'theirs\n');
        }
      },
      () => {
        const report = documents.writeText(file, 'mine\n', sha256('authored\n'));
        assert.equal(report.tag, 'rejected');
        assert.equal(report.reason, 'write-race');
      },
    );
    assert.equal(fs.readFileSync(file, 'utf8'), 'theirs\n', 'the other writer keeps its bytes');
    assert.equal(documents.current(file).value.checksum, sha256('theirs\n'));
  });
});

const posixOnly = { skip: process.platform === 'win32' };
test('a replace whose folder cannot be flushed is uncertain, reconciled by comparison', posixOnly, () => {
  directory((root) => {
    const file = path.join(root, 'page.astro');
    fs.writeFileSync(file, 'authored\n');
    const { documents, lines } = host();
    withFailure(
      'fsyncSync',
      (fsync, descriptor) => {
        if (fs.fstatSync(descriptor).isDirectory()) {
          throw Object.assign(new Error('Simulated EIO'), { code: 'EIO' });
        }
        return fsync(descriptor);
      },
      () => {
        const report = documents.writeText(file, 'mine\n', sha256('authored\n'));
        assert.equal(report.tag, 'uncertain');
        assert.equal(report.candidateChecksum, sha256('mine\n'));
        assert.equal(report.reconciliation, 'applied', 'the candidate is on disk');
      },
    );
    assert.equal(JSON.parse(lines.at(-1)).outcome, 'uncertain');
  });
});

test('a missing file: writeText refuses, writeCurrent and create make it', () => {
  directory((root) => {
    const file = path.join(root, 'chunk.html');
    const { documents } = host();
    const refused = documents.writeText(file, '<p/>', sha256(''));
    assert.equal(refused.tag, 'rejected');
    assert.equal(refused.reason, 'write-failed');
    assert.equal(fs.existsSync(file), false);
    assert.deepEqual(documents.writeCurrent(file, '<p/>'), {
      tag: 'applied',
      checksum: sha256('<p/>'),
      inverse: [], // A created file has no bytes to go back to.
    });
    assert.equal(documents.writeCurrent(file, '<div/>').tag, 'applied', 'then it is replaced');
    const created = documents.create(file, '<b/>');
    assert.equal(created.ok, false);
    assert.equal(created.error.code, 'exists');
    assert.equal(fs.readFileSync(file, 'utf8'), '<div/>');
  });
});

// The reported case: pnpm installs a `file:` dependency as hard links under the
// site's own node_modules, so a save through that path reached the package's
// source, shared by every site that uses it. Installed code is refused before a
// lock file is made beside it, and every byte stays as it was.
test('a pnpm-installed file is refused, and so is creating one beside it', () => {
  directory((root) => {
    const source = path.join(root, 'engine', 'Hero.astro');
    const installed = path.join(root, 'site', 'node_modules', '.pnpm', 'engine@file+..+engine');
    const folder = path.join(installed, 'node_modules', '@scope', 'engine');
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(source, '<h1>old</h1>\n');
    const copy = path.join(folder, 'Hero.astro');
    fs.linkSync(source, copy);
    const { documents } = host();
    const refused = documents.writeCurrent(copy, '<h1>new</h1>\n');
    assert.equal(refused.tag, 'rejected');
    assert.equal(refused.reason, 'write-failed');
    assert.match(refused.message, /Hero\.astro belongs to the installed package @scope\/engine/);
    assert.equal(fs.readFileSync(source, 'utf8'), '<h1>old</h1>\n');
    assert.equal(fs.statSync(copy).nlink, 2, 'the link is not split');
    assert.deepEqual(fs.readdirSync(folder), ['Hero.astro'], 'no lock or temporary file');
    const created = documents.create(path.join(folder, 'New.astro'), '<p/>');
    assert.equal(created.ok, false);
    assert.equal(created.error.code, 'failed');
    assert.deepEqual(fs.readdirSync(folder), ['Hero.astro']);
  });
});

test('a project folder linked into node_modules is installed code too', posixOnly, () => {
  directory((root) => {
    const folder = path.join(root, 'node_modules', 'cards');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'Card.astro'), '<p>old</p>\n');
    fs.mkdirSync(path.join(root, 'src'));
    fs.symlinkSync(folder, path.join(root, 'src', 'cards'));
    const { documents } = host();
    const reached = path.join(root, 'src', 'cards', 'Card.astro');
    const refused = documents.writeCurrent(reached, '<p>new</p>\n');
    assert.equal(refused.tag, 'rejected');
    assert.match(refused.message, /Card\.astro belongs to the installed package cards/);
    assert.equal(fs.readFileSync(reached, 'utf8'), '<p>old</p>\n');
  });
});

test('a full queue answers backpressured; draining gives each accepted intent one outcome', () => {
  directory((root) => {
    const file = path.join(root, 'page.astro');
    fs.writeFileSync(file, 'v0\n');
    const { documents, lines } = host({ drain: 'deferred' });
    const base = sha256('v0\n');
    const answers = [];
    for (let index = 0; index <= LIMITS.intentsPendingMax; index++) {
      answers.push(documents.submitDeferred(file, `v${index + 1}\n`, base));
    }
    assert.equal(answers.filter((answer) => answer === 'accepted').length, LIMITS.intentsPendingMax);
    assert.equal(answers.at(-1), 'backpressured');
    documents.drain();
    assert.equal(documents.quiescent(), true);
    const outcomes = lines.map((line) => JSON.parse(line));
    assert.equal(outcomes.filter((line) => line.outcome === 'backpressured').length, 1);
    const terminal = outcomes.filter((line) => line.intent !== undefined);
    assert.equal(terminal.length, LIMITS.intentsPendingMax, 'one outcome per accepted intent');
    assert.equal(terminal[0].outcome, 'applied', 'the first authored against v0 applies');
    assert.ok(
      terminal.slice(1).every((line) => line.reason === 'region-externally-modified'),
      'the rest were authored against bytes that are gone',
    );
    assert.equal(fs.readFileSync(file, 'utf8'), 'v1\n');
  });
});

test('a batch leases in sorted canonical order, whatever order it names its files', () => {
  directory((root) => {
    const files = ['c.astro', 'a.astro', 'b.astro'].map((name) => path.join(root, name));
    for (const file of files) {
      fs.writeFileSync(file, 'x\n');
    }
    const order = [];
    const { documents } = host({ onLease: (file) => order.push(path.basename(file)) });
    const seen = [];
    const run = (items) => documents.withLeases(items, (ordered) => seen.push(ordered.map((item) => path.basename(item.file))));
    assert.equal(run(files.map((file) => ({ file }))).ok, true);
    assert.equal(run([...files].reverse().map((file) => ({ file }))).ok, true);
    assert.deepEqual(order.slice(0, 3), order.slice(3), 'both batches acquire in one order');
    assert.deepEqual(seen[0], seen[1], 'and run their items in it');
    assert.throws(() => documents.withLeases([{ file: files[0] }, { file: files[0] }], () => undefined), /Assertion failed: A batch names each file once/);
  });
});

test('two spellings of one file meet at one actor', posixOnly, () => {
  directory((root) => {
    fs.mkdirSync(path.join(root, 'pages'));
    fs.symlinkSync(path.join(root, 'pages'), path.join(root, 'alias'));
    const file = path.join(root, 'pages', 'index.astro');
    fs.writeFileSync(file, 'x\n');
    const { documents } = host();
    documents.current(file);
    documents.current(path.join(root, 'alias', 'index.astro'));
    documents.current(path.join(root, 'pages', '..', 'pages', 'index.astro'));
    assert.equal(documents.actorCount(), 1);
  });
});

test('the actor count stays inside its bound; idle actors are dropped first', () => {
  directory((root) => {
    const { documents } = host();
    for (let index = 0; index < LIMITS.documentActorsMax + 8; index++) {
      const file = path.join(root, `f${index}.css`);
      fs.writeFileSync(file, `/* ${index} */\n`);
      assert.equal(documents.current(file).ok, true);
    }
    assert.ok(documents.actorCount() <= LIMITS.documentActorsMax, `${documents.actorCount()} actors`);
    const first = path.join(root, 'f0.css');
    assert.equal(documents.writeText(first, 'y\n', sha256('/* 0 */\n')).tag, 'applied', 'a dropped actor re-reads');
  });
});

test('the watcher hint refreshes the actor on the next tick, off the intent path', () => {
  directory((root) => {
    const file = path.join(root, 'page.astro');
    fs.writeFileSync(file, 'v1\n');
    const { documents, scheduled } = host();
    documents.current(file);
    fs.writeFileSync(file, 'v2\n');
    documents.noteExternalChange(file);
    documents.noteExternalChange(file);
    assert.equal(scheduled.length, 1, 'hints coalesce into one tick');
    scheduled[0]();
    assert.equal(documents.current(file).value.checksum, sha256('v2\n'));
    documents.noteExternalChange(path.join(root, 'unknown.astro'));
    assert.equal(scheduled.length, 1, 'a file without an actor schedules nothing');
  });
});

// The watcher's question (plan §11.9, formerly electron/selfWrites.ts): is this
// tick the app hearing its own write? The actor knows the bytes it wrote, so the
// answer is a comparison of bytes, never of elapsed time.
test('a watcher tick echoes only while the file holds the bytes its actor wrote', () => {
  directory((root) => {
    const file = path.join(root, 'page.astro');
    fs.writeFileSync(file, 'v1\n');
    const { documents } = host();
    assert.equal(documents.echoes(file), false, 'a file the app never wrote is nobody’s echo');
    documents.current(file);
    assert.equal(documents.echoes(file), false, 'reading a file is not writing it');
    assert.equal(documents.writeText(file, 'v2\n', sha256('v1\n')).tag, 'applied');
    assert.equal(documents.echoes(file), true, 'the app’s own write comes back as its echo');
    assert.equal(documents.echoes(file), true, 'and stays one while the bytes are ours');
    // The case a stopwatch never got right: an editor's save right after ours.
    fs.writeFileSync(file, 'v3\n');
    assert.equal(documents.echoes(file), false, 'an outside write a moment later is heard');
    fs.writeFileSync(file, 'v2\n');
    assert.equal(documents.echoes(file), true, 'bytes identical to ours change nothing');
    fs.rmSync(file);
    assert.equal(documents.echoes(file), false, 'a file gone since holds no write of ours');
    const created = path.join(root, 'new.astro');
    assert.equal(documents.create(created, 'fresh\n').ok, true);
    assert.equal(documents.echoes(created), true, 'a created file is the app’s own write too');
    assert.equal(documents.echoes(path.join(root, 'gone', 'x.astro')), false, 'no folder, no echo');
    documents.clear();
    assert.equal(documents.echoes(created), false, 'closing the project forgets every write');
  });
});
