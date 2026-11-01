// Goal: pin the OS-facing contract of the write protocol on a real filesystem
// (plan §10, §11 step 5) — what the simulator, which fakes the disk, cannot
// prove: permission bits and ownership survive a save, even under a narrow
// umask; "flush" means fsync of the staged file before the rename and fsync of
// the directory after it; the directory entry is replaced in place; a symlink
// is written through and a symlinked folder reaches the same actor; readers
// that open and read the file continuously (an indexer, an antivirus scanner)
// see the old bytes or the new ones, never a torn or empty file; and a file is
// one actor however it is spelled — on a case-sensitive disk two names are two
// files.
// Method: node:test against the OS temp directory. The flush order is observed
// by wrapping fs.fsyncSync and fs.renameSync without changing what they do.
// The reader is a real second process. Windows-only semantics and a
// case-insensitive disk are in windowsProtocol.test.js; processes that cooperate or
// crash are in processesProtocol.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { protocolLeftovers, realHost, scratch, sha256 } = require('../../helpers/platformSupport.js');

const posixOnly = { skip: process.platform === 'win32' ? 'POSIX permissions and links' : false };

test('permission bits and ownership survive a save, whatever the umask', posixOnly, async () => {
  await scratch(os.tmpdir(), (root) => {
    const documents = realHost();
    const previous = process.umask(0o077);
    try {
      for (const mode of [0o644, 0o600, 0o755, 0o640, 0o664]) {
        const file = path.join(root, `mode-${mode.toString(8)}.astro`);
        fs.writeFileSync(file, 'old\n');
        fs.chmodSync(file, mode);
        const before = fs.statSync(file);
        const report = documents.writeText(file, 'new\n', sha256('old\n'));
        assert.equal(report.tag, 'applied', mode.toString(8));
        const after = fs.statSync(file);
        assert.equal(after.mode & 0o7777, mode, `mode ${mode.toString(8)} kept`);
        assert.equal(after.uid, before.uid, 'owner kept');
        assert.equal(after.gid, before.gid, 'group kept');
        assert.notEqual(after.ino, before.ino, 'a new inode: the replace was a rename');
      }
    } finally {
      process.umask(previous);
    }
    assert.deepEqual(protocolLeftovers(root), []);
  });
});

test('flush: the staged file is fsynced before the rename, the folder after it', async () => {
  await scratch(os.tmpdir(), (root) => {
    const file = path.join(root, 'page.astro');
    fs.writeFileSync(file, 'old\n');
    const documents = realHost();
    documents.current(file);
    const events = [];
    const fsync = fs.fsyncSync;
    const rename = fs.renameSync;
    fs.fsyncSync = (descriptor) => {
      events.push(fs.fstatSync(descriptor).isDirectory() ? 'fsync folder' : 'fsync file');
      return fsync(descriptor);
    };
    fs.renameSync = (from, to) => {
      events.push(path.basename(from).startsWith('.stacki-write-') ? 'rename' : 'other rename');
      return rename(from, to);
    };
    try {
      assert.equal(documents.writeText(file, 'new\n', sha256('old\n')).tag, 'applied');
    } finally {
      fs.fsyncSync = fsync;
      fs.renameSync = rename;
    }
    const expected = process.platform === 'win32' ? ['fsync file', 'rename'] : ['fsync file', 'rename', 'fsync folder', 'fsync folder'];
    assert.deepEqual(events, expected);
    const entries = fs.readdirSync(root);
    assert.deepEqual(entries.sort(), ['.stacki', 'page.astro'], 'the save directory stays stable');
    assert.deepEqual(protocolLeftovers(root), [], 'no temporary or lock file remains');
  });
});

test('a symlink is written through; a symlinked folder reaches the same actor', posixOnly, async () => {
  await scratch(os.tmpdir(), (root) => {
    fs.mkdirSync(path.join(root, 'real'));
    fs.mkdirSync(path.join(root, 'other'));
    const target = path.join(root, 'other', 'page.astro');
    fs.writeFileSync(target, 'old\n');
    const link = path.join(root, 'real', 'page.astro');
    fs.symlinkSync(target, link);
    fs.symlinkSync(path.join(root, 'real'), path.join(root, 'alias'));
    const documents = realHost();
    assert.equal(documents.writeText(link, 'new\n', sha256('old\n')).tag, 'applied');
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true, 'the link is still a link');
    assert.equal(fs.readFileSync(target, 'utf8'), 'new\n', 'the file it names was written');
    assert.deepEqual(protocolLeftovers(path.join(root, 'other')), [], 'staged beside the target');
    const viaAlias = documents.current(path.join(root, 'alias', 'page.astro'));
    assert.equal(viaAlias.ok, true);
    assert.equal(documents.actorCount(), 1, 'one file, one actor');
    const dangling = path.join(root, 'real', 'gone.astro');
    fs.symlinkSync(path.join(root, 'nowhere.astro'), dangling);
    const refused = documents.writeCurrent(dangling, 'x\n');
    assert.equal(refused.tag, 'rejected');
    assert.equal(fs.existsSync(path.join(root, 'nowhere.astro')), false, 'no guessed target');
  });
});

// An indexer or antivirus scanner opens and reads files as they change. A real
// second process reads the page in a tight loop while this one saves it many
// times; every read it makes must be a whole version, never torn or empty.
test('continuous readers see whole versions only, never a torn or empty file', async () => {
  await scratch(os.tmpdir(), async (root) => {
    const file = path.join(root, 'page.astro');
    const versions = Array.from({ length: 60 }, (_, index) => `<p>${String(index).repeat(4096)}</p>\n`);
    fs.writeFileSync(file, versions[0]);
    const reader = spawn(process.execPath, ['-e', READER, file], {
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    let seen = '';
    reader.stdout.on('data', (chunk) => {
      seen += String(chunk);
    });
    await new Promise((resolve) => reader.stdout.once('data', resolve));
    const documents = realHost();
    let base = sha256(versions[0]);
    for (const version of versions.slice(1)) {
      const report = documents.writeText(file, version, base);
      assert.equal(report.tag, 'applied');
      base = report.checksum;
    }
    reader.stdin.end();
    await new Promise((resolve) => reader.on('exit', resolve));
    const known = new Set(versions.map(sha256));
    const reads = seen.split('\n').filter((line) => line.length === 64);
    assert.ok(reads.length > 20, `the reader read throughout (${reads.length} reads)`);
    for (const digest of reads) {
      assert.ok(known.has(digest), 'every read is one whole version');
    }
    assert.deepEqual(protocolLeftovers(root), []);
  });
});

// The reader: print the SHA-256 of every read until stdin closes. A file it
// cannot open for an instant would print "missing" and fail the test.
const READER = `
const fs = require('node:fs'); const { createHash } = require('node:crypto');
const file = process.argv[1]; let open = true;
process.stdin.on('end', () => { open = false; }); process.stdin.resume();
const loop = () => {
  for (let i = 0; i < 50; i++) {
    let line;
    try { line = createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
    catch (error) { line = 'missing ' + error.code; }
    process.stdout.write(line + '\\n');
  }
  if (open) { setImmediate(loop); }
};
loop();
`;

test('two names that differ in case are two files on a case-sensitive disk', async (context) => {
  await scratch(os.tmpdir(), (root) => {
    fs.writeFileSync(path.join(root, 'Page.astro'), 'upper\n');
    if (fs.existsSync(path.join(root, 'page.astro'))) {
      context.skip('the OS temp folder is case-insensitive here; windowsProtocol.test.js covers it');
      return;
    }
    fs.writeFileSync(path.join(root, 'page.astro'), 'lower\n');
    const documents = realHost();
    assert.equal(documents.current(path.join(root, 'Page.astro')).value.checksum, sha256('upper\n'));
    assert.equal(documents.current(path.join(root, 'page.astro')).value.checksum, sha256('lower\n'));
    assert.equal(documents.actorCount(), 2);
  });
});
