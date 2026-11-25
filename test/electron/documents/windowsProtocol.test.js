// Goal: Windows replacement semantics and a case-insensitive disk, for real
// (plan §10, §11 step 5). On NTFS a rename over a file that another process
// holds open without delete sharing — an antivirus scan, an indexer, an editor
// — fails. The actor must report `write-failed` with the target untouched and
// no temporary or lock file left, and never retry; with delete sharing the
// save goes through when the host honors it, or refuses safely until release.
// On a case-insensitive disk every spelling of a name is one
// file, so it must be one actor and one lock.
// Method: runs on native Windows, or on WSL against the NTFS temp folder with a
// Windows PowerShell process holding the file (helpers/platformSupport.js detects both, and
// the tests skip with the reason anywhere else). Real files, real processes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { holdFromWindows, protocolLeftovers, realHost, scratch, sha256, windowsFilesystem } = require('../../helpers/platformSupport.js');

const load = require('../../helpers/rendererModule');
const { sendPageEditWithRetry } = load('src/ipc/saveRetry.ts');
const { pageEditError } = require('#dist/electron/documents/pageRequests.js');

const windows = windowsFilesystem();
const onWindows = { skip: windows.skip ?? false, timeout: 60_000 };

test('a rename over a file held without delete sharing is write-failed, untouched', onWindows, async () => {
  await scratch(windows.directory, async (root) => {
    const file = path.join(root, 'page.astro');
    fs.writeFileSync(file, 'old\n');
    const documents = realHost();
    const release = await holdFromWindows(windows, file, 'Read');
    let report;
    try {
      report = documents.writeText(file, 'new\n', sha256('old\n'));
    } finally {
      await release();
    }
    assert.equal(report.tag, 'rejected');
    assert.equal(report.reason, 'write-failed');
    assert.match(report.message, /EACCES|EPERM|EBUSY/);
    assert.equal(fs.readFileSync(file, 'utf8'), 'old\n', 'the target is untouched');
    assert.deepEqual(protocolLeftovers(root), [], 'no temporary or lock file is left');
    // Released: the same save, resubmitted deliberately, goes through.
    const retry = documents.writeText(file, 'new\n', sha256('old\n'));
    assert.equal(retry.tag, 'applied', JSON.stringify(retry));
  });
});

test('a file held with delete sharing applies or safely waits for release', onWindows, async () => {
  await scratch(windows.directory, async (root) => {
    const file = path.join(root, 'page.astro');
    fs.writeFileSync(file, 'old\n');
    const documents = realHost();
    const release = await holdFromWindows(windows, file, 'ReadWrite, Delete');
    let report;
    try {
      report = documents.writeText(file, 'new\n', sha256('old\n'));
    } finally {
      await release();
    }
    if (report.tag === 'applied') {
      assert.equal(fs.readFileSync(file, 'utf8'), 'new\n');
    } else {
      assert.equal(report.tag, 'rejected');
      assert.equal(report.reason, 'write-failed');
      assert.match(report.message, /EACCES|EPERM|EBUSY/);
      assert.equal(fs.readFileSync(file, 'utf8'), 'old\n', 'a refusal leaves the target untouched');
      const retry = documents.writeText(file, 'new\n', sha256('old\n'));
      assert.equal(retry.tag, 'applied', JSON.stringify(retry));
    }
  });
});

test('on a case-insensitive disk every spelling is one actor and one lock', onWindows, async () => {
  await scratch(windows.directory, (root) => {
    const file = path.join(root, 'Page.astro');
    fs.writeFileSync(file, 'old\n');
    assert.equal(fs.existsSync(path.join(root, 'page.astro')), true, 'the disk ignores case');
    const documents = realHost();
    assert.equal(documents.current(file).ok, true);
    assert.equal(documents.current(path.join(root, 'PAGE.ASTRO')).ok, true);
    assert.equal(documents.actorCount(), 1, 'one file, one actor');
    // A write under one spelling is seen as the base under another.
    const report = documents.writeText(path.join(root, 'page.astro'), 'new\n', sha256('old\n'));
    assert.equal(report.tag, 'applied');
    assert.equal(documents.current(file).value.checksum, sha256('new\n'));
    assert.deepEqual(protocolLeftovers(root), []);
  });
});

test('the renderer retries a native sharing failure after the Windows handle closes', onWindows, async () => {
  await scratch(windows.directory, async (root) => {
    const file = path.join(root, 'page.astro');
    fs.writeFileSync(file, 'old\n');
    const documents = realHost();
    const release = await holdFromWindows(windows, file, 'Read');
    let releasePromise;
    const releaseOnce = () => (releasePromise ??= release());
    let attempts = 0;
    try {
      const request = {
        pagePath: file,
        authoredChecksum: sha256('old\n'),
        edit: { tag: 'code-patch', hunks: [] },
      };
      const result = await sendPageEditWithRetry(request, {
        send: async (attempt) => {
          attempts += 1;
          const report = documents.writeText(attempt.pagePath, 'new\n', attempt.authoredChecksum);
          if (report.tag !== 'applied') {
            assert.equal(attempts, 1);
            assert.equal(report.tag, 'rejected');
            assert.equal(report.reason, 'write-failed');
            assert.equal(fs.readFileSync(file, 'utf8'), 'old\n');
            await releaseOnce();
            return { ok: false, error: pageEditError(file, report) };
          }
          return { ok: true, value: report };
        },
      });
      assert.equal(result.ok, true);
      assert.equal(attempts, 2);
      assert.equal(fs.readFileSync(file, 'utf8'), 'new\n');
      assert.deepEqual(protocolLeftovers(root), []);
    } finally {
      await releaseOnce();
    }
  });
});
