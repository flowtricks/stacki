// Goal: electron/documents/atomicWrite.ts, the primitives under the document actor's
// disk, replaces a file all at once or not at all, never leaves its temporary
// file behind, keeps the target's mode, writes through symlinks and refuses a
// dangling one, refuses a hard-linked file rather than splitting it, creates
// without ever overwriting, and reports a directory it could not flush as
// `not-durable` rather than success (plan §5.2). Verifying
// the bytes afterwards is the actor's step 9, tested with the host
// (test/electron/documents/documentActors.test.js); the real-filesystem contract is the platform
// suite's (test/electron/documents/).
// Method: real files in a temporary directory; filesystem failures are
// injected by wrapping one `fs` function at a time, since the module calls the
// shared `fs` object.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { protocolLeftovers } = require('../../helpers/platformSupport.js');
const { createFileExclusive, digestOf, isAtomicTemporary, replaceFileAtomic } = require('#dist/electron/documents/atomicWrite.js');

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function directory(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-atomic-'));
  try {
    run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const leftovers = protocolLeftovers;

// Replace fs[name] for the duration of `run`, restoring it even on failure.
function withFailure(name, replacement, run) {
  const original = fs[name];
  fs[name] = (...argumentsList) => replacement(original, ...argumentsList);
  try {
    run();
  } finally {
    fs[name] = original;
  }
}

test('a replace swaps the file, keeps its mode and reports nothing but success', () => {
  directory((root) => {
    const file = path.join(root, 'page.astro');
    fs.writeFileSync(file, 'old\n');
    fs.chmodSync(file, 0o640);
    const result = replaceFileAtomic(file, Buffer.from('new é\n', 'utf8'));
    assert.deepEqual(result, { ok: true, value: undefined });
    assert.equal(fs.readFileSync(file, 'utf8'), 'new é\n');
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(file).mode & 0o777, 0o640);
    }
    assert.deepEqual(leftovers(root), []);
  });
});

test('a creation makes a missing file and never overwrites one', () => {
  directory((root) => {
    const file = path.join(root, 'chunk.html');
    const created = createFileExclusive(file, Buffer.from('<p/>'));
    assert.deepEqual(created, { ok: true, value: undefined });
    assert.equal(fs.readFileSync(file, 'utf8'), '<p/>');
    const again = createFileExclusive(file, Buffer.from('<div/>'));
    assert.equal(again.ok, false);
    assert.equal(again.error.code, 'exists');
    assert.equal(fs.readFileSync(file, 'utf8'), '<p/>', 'the existing bytes stand');
  });
});

test('a failed replace leaves the target untouched and no temporary file', () => {
  directory((root) => {
    const file = path.join(root, 'page.astro');
    fs.writeFileSync(file, 'authored\n');
    for (const name of ['writeFileSync', 'fsyncSync', 'renameSync', 'fchmodSync']) {
      withFailure(
        name,
        () => {
          throw new Error(`Simulated ${name} failure`);
        },
        () => {
          const result = replaceFileAtomic(file, Buffer.from('replacement\n'));
          assert.equal(result.ok, false, name);
          assert.equal(result.error.code, 'filesystem');
          assert.match(result.error.message, new RegExp(`Simulated ${name} failure`));
        },
      );
      assert.equal(fs.readFileSync(file, 'utf8'), 'authored\n', `${name} kept the old bytes`);
      assert.deepEqual(leftovers(root), [], `${name} removed its temporary file`);
    }
  });
});

test('a failed cleanup names the temporary file it could not remove', () => {
  directory((root) => {
    const file = path.join(root, 'page.astro');
    fs.writeFileSync(file, 'authored\n');
    withFailure(
      'renameSync',
      () => {
        throw new Error('no rename');
      },
      () => {
        withFailure(
          'rmSync',
          () => {
            throw new Error('no remove');
          },
          () => {
            const result = replaceFileAtomic(file, Buffer.from('replacement\n'));
            assert.equal(result.error.code, 'filesystem');
            assert.match(result.error.message, /or remove temporary file .*\.stacki-write-.*\.tmp/);
          },
        );
      },
    );
    assert.equal(fs.readFileSync(file, 'utf8'), 'authored\n');
  });
});

const posixOnly = { skip: process.platform === 'win32' };

// The flush after the rename: an I/O error means the new bytes are in place but
// not promised durable — `not-durable`, which the actor reports as uncertain.
// A filesystem that cannot flush directories at all is the platform's promise.
test('a folder flush: EIO is not-durable, an unsupported flush is the platform', posixOnly, () => {
  directory((root) => {
    const file = path.join(root, 'page.astro');
    fs.writeFileSync(file, 'authored\n');
    let flushes = 0;
    const directoryFlush = (code) => (fsync, descriptor) => {
      if (fs.fstatSync(descriptor).isDirectory()) {
        flushes += 1;
        throw Object.assign(new Error(`Simulated ${code}`), { code });
      }
      return fsync(descriptor);
    };
    withFailure('fsyncSync', directoryFlush('EIO'), () => {
      const result = replaceFileAtomic(file, Buffer.from('mine\n'));
      assert.equal(result.ok, false);
      assert.equal(result.error.code, 'not-durable');
    });
    assert.equal(flushes, 2, 'both directories are flushed even when the first fails');
    assert.equal(fs.readFileSync(file, 'utf8'), 'mine\n', 'the bytes are in place');
    withFailure('fsyncSync', directoryFlush('EINVAL'), () => {
      const again = replaceFileAtomic(file, Buffer.from('again\n'));
      assert.deepEqual(again, { ok: true, value: undefined });
    });
    assert.deepEqual(leftovers(root), []);
  });
});

test('a symlinked page is written through; a dangling link is refused', posixOnly, () => {
  directory((root) => {
    const real = path.join(root, 'real.astro');
    const link = path.join(root, 'link.astro');
    fs.writeFileSync(real, 'old\n');
    fs.symlinkSync(real, link);
    assert.equal(replaceFileAtomic(link, Buffer.from('new\n')).ok, true);
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
    assert.equal(fs.readFileSync(real, 'utf8'), 'new\n');
    const dangling = path.join(root, 'dangling.astro');
    fs.symlinkSync(path.join(root, 'missing.astro'), dangling);
    const result = replaceFileAtomic(dangling, Buffer.from('x\n'));
    assert.equal(result.ok, false);
    assert.match(result.error.message, /symlink to a missing file/);
    assert.equal(fs.lstatSync(dangling).isSymbolicLink(), true, 'the link is left alone');
    assert.equal(fs.existsSync(path.join(root, 'missing.astro')), false);
  });
});

// A rename gives the path a new file, so a hard link would be split in two: the
// other link keeps the old bytes. That is how a save to pnpm's hard-linked copy
// of a `file:` dependency used to fork the package without a word.
test('a hard-linked file is refused and every link keeps its bytes', () => {
  directory((root) => {
    const source = path.join(root, 'source.astro');
    const linked = path.join(root, 'linked.astro');
    fs.writeFileSync(source, 'old\n');
    fs.linkSync(source, linked);
    const result = replaceFileAtomic(linked, Buffer.from('new\n'));
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'filesystem');
    assert.match(result.error.message, /linked\.astro is hard-linked to another file/);
    assert.equal(fs.readFileSync(source, 'utf8'), 'old\n');
    assert.equal(fs.readFileSync(linked, 'utf8'), 'old\n');
    assert.equal(fs.statSync(linked).nlink, 2, 'the link is not split');
    assert.deepEqual(leftovers(root), []);
    fs.rmSync(source);
    assert.equal(replaceFileAtomic(linked, Buffer.from('new\n')).ok, true, 'one link writes');
  });
});

// Ownership: a replacement keeps the target's owner and group, and when the OS
// will not allow that, the save is refused rather than silently handing the
// file to another owner. Changing a file's real owner needs root, so the
// target's owner is faked through statSync and the refusal through fchownSync.
test('a replace that cannot keep the owner is refused', posixOnly, () => {
  directory((root) => {
    const file = path.join(root, 'page.astro');
    fs.writeFileSync(file, 'authored\n');
    withFailure(
      'statSync',
      (stat, ...args) => {
        const stats = stat(...args);
        const other = Object.create(Object.getPrototypeOf(stats));
        return Object.assign(other, stats, { uid: stats.uid + 1 });
      },
      () => {
        withFailure(
          'fchownSync',
          () => {
            throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
          },
          () => {
            const result = replaceFileAtomic(file, Buffer.from('mine\n'));
            assert.equal(result.ok, false);
            assert.match(result.error.message, /would change the file's owner/);
          },
        );
      },
    );
    assert.equal(fs.readFileSync(file, 'utf8'), 'authored\n');
    assert.deepEqual(leftovers(root), []);
  });
});

test('only the module’s own temporary and lock names are treated as temporary', () => {
  assert.equal(isAtomicTemporary('/p/src/pages/.stacki-write-1b2c.tmp'), true);
  assert.equal(isAtomicTemporary('/p/src/pages/.stacki-lock-0123abcd.lock'), true);
  assert.equal(isAtomicTemporary('.stacki-lock-0123abcd.astro'), false);
  assert.equal(isAtomicTemporary('.stacki-write-1b2c.tmp'), true);
  assert.equal(isAtomicTemporary('.stacki-write-1b2c.astro'), false);
  assert.equal(isAtomicTemporary('page.tmp'), false);
  assert.equal(isAtomicTemporary('stacki-write-1.tmp'), false);
  assert.equal(isAtomicTemporary('/p/.stacki/io'), true);
  assert.equal(isAtomicTemporary('G:\\code\\.stacki\\io\\save.tmp'), true);
  assert.equal(isAtomicTemporary('/p/.stacki/components.json'), false);
  assert.equal(isAtomicTemporary('/p/.stacki/io.astro'), false);
  assert.equal(isAtomicTemporary('/p/src/pages/.stacki-io'), true);
  assert.equal(isAtomicTemporary('G:\\code\\src\\pages\\.stacki-io\\save.tmp'), true);
  assert.equal(isAtomicTemporary('/p/src/pages/.stacki-io.astro'), false);
});
