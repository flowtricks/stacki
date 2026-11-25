// Goal: publish metadata accepts only bounded regular files and trusted connection shapes.
// Method: exercise valid records and each malformed field without contacting GitHub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePublishTreeFile } from '../src/features/publishing/publishSource';
import { parsePublishConnection } from '../src/shared/publishConnection';

const hash = 'a'.repeat(40);
test('tree entries reject links, invalid identifiers, oversized files and unsafe paths', () => {
  assert.deepEqual(parsePublishTreeFile(`100644 blob ${hash} 0\tpublic/a.png`), {
    ok: true,
    value: { path: 'public/a.png', sha: hash, size: 0, mode: '100644' },
  });
  assert.equal(parsePublishTreeFile(`100755 blob ${hash} 1\tsrc/a.ts`).ok, true);
  for (const record of [
    `120000 blob ${hash} 1\tpublic/a.png`,
    `160000 commit ${hash} -\tsrc/module`,
    `100644 blob bad 0\ta`,
    `100644 blob ${hash} 104857601\ta`,
    `100644 blob ${hash} 1\t../escape`,
    `100644 blob ${hash} 1\t/absolute`,
    `100644 blob ${hash} 1\t.git/config`,
    `100644 blob ${hash} 1\ta\\b`,
  ]) {
    assert.equal(parsePublishTreeFile(record).ok, false, record);
  }
});
test('connection parser rejects injected credentials, destinations and branch options', () => {
  const good = { repository: 'owner/site', branch: 'main', token: 'test-token' };
  assert.equal(parsePublishConnection(good).ok, true);
  for (const value of [
    null,
    {},
    { ...good, token: 'x\nheader' },
    { ...good, repository: 'https://evil.test' },
    { ...good, repository: '../site' },
    { ...good, branch: '--upload-pack=evil' },
    { ...good, branch: 'a/../b' },
    { ...good, branch: 'refs/a.lock' },
    { ...good, token: 'x'.repeat(501) },
  ]) {
    assert.equal(parsePublishConnection(value).ok, false);
  }
});
