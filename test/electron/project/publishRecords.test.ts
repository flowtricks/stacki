// Goal: Git listings stay bounded and lossless across arbitrary pipe chunk boundaries.
// Method: exercise the real record decoder and tree parser with valid and malformed byte streams.
import assert from 'node:assert/strict';
import test from 'node:test';
import childProcess from 'node:child_process';
import { homedir } from 'node:os';
import { setToolPathHome } from '#dist/electron/lib/nodeTools.js';
import { ok } from '#dist/shared/core/result.js';
import { readPublishRecords } from '#dist/electron/project/publishRecords.js';
import { PublishRecords, PUBLISH_RECORD_LIMITS } from '#dist/electron/project/publishRecords.js';
import { parsePublishTreeEntry } from '#dist/electron/project/publishSize.js';

const identifier = 'a'.repeat(40);
setToolPathHome(homedir());

test('NUL records preserve whitespace and UTF-8 split between chunks', () => {
  const expected = ['public/café photo.png', 'page\nwith\ttabs.astro'];
  const bytes = Buffer.from(`${expected.join('\0')}\0`);
  const decoder = new PublishRecords();
  const actual: string[] = [];
  for (const byte of bytes) {
    const decoded = decoder.accept(Buffer.from([byte]));
    assert.ok(decoded.ok);
    actual.push(...decoded.value);
  }
  assert.deepEqual(actual, expected);
  assert.deepEqual(decoder.finish(), { ok: true, value: undefined });
});

test('incomplete, empty, invalid UTF-8 and oversized records fail explicitly', () => {
  const partial = new PublishRecords();
  assert.ok(partial.accept(Buffer.from('unfinished')).ok);
  assert.equal(partial.finish().ok, false);
  for (const input of [
    'not bytes',
    Buffer.from([0]),
    Buffer.from([0xff, 0]),
    Buffer.alloc(PUBLISH_RECORD_LIMITS.recordBytesMax + 1, 97),
    Buffer.alloc(PUBLISH_RECORD_LIMITS.chunkBytesMax + 1),
  ]) {
    assert.equal(new PublishRecords().accept(input).ok, false);
  }
});

test('record length and count accept their exact boundary and reject the next value', () => {
  const length = new PublishRecords();
  assert.ok(length.accept(Buffer.from(`${'a'.repeat(PUBLISH_RECORD_LIMITS.recordBytesMax)}\0`)).ok);
  const count = new PublishRecords();
  assert.ok(count.accept(Buffer.from('a\0'.repeat(PUBLISH_RECORD_LIMITS.recordsMax))).ok);
  const exceeded = count.accept(Buffer.from('b\0'));
  assert.equal(exceeded.ok, false);
  if (!exceeded.ok) {
    assert.equal(exceeded.error.code, 'git-limit');
  }
});

test('tree records validate exact object identifiers, paths, kinds and safe byte counts', () => {
  for (const mode of ['100644', '100755', '120000']) {
    assert.deepEqual(parsePublishTreeEntry(`${mode} blob ${identifier}     12\tpublic/a\nb.png`), {
      ok: true,
      value: 12,
    });
  }
  for (const record of [
    `100644 blob ${identifier} 9007199254740992\tfile`,
    `100644 blob ${identifier} -1\tfile`,
    `100644 blob ${identifier}x 1\tfile`,
    `100644 blob ${identifier} 1\t../outside`,
    `100644 blob ${identifier} 1\t/absolute`,
    `100644 blob ${identifier} 1\t`,
    `160000 commit ${identifier} -\tmodule`,
    'malformed',
  ]) {
    assert.equal(parsePublishTreeEntry(record).ok, false, record);
  }
});

for (const scenario of [
  { name: 'incomplete output', script: "process.stdout.write('file');" },
  { name: 'failed child', script: 'process.exitCode = 1;' },
  { name: 'oversized diagnostics', script: "process.stderr.write('x'.repeat(2 * 1024 * 1024));" },
]) {
  test(`stream reports ${scenario.name} as an operating failure`, async (context) => {
    const spawn = childProcess.spawn;
    context.mock.method(childProcess, 'spawn', () => spawn(process.execPath, ['-e', scenario.script], { stdio: ['ignore', 'pipe', 'pipe'] }));
    const result = await readPublishRecords(process.cwd(), [], process.env, () => Promise.resolve(ok(undefined)));
    assert.equal(result.ok, false);
  });
}

test('stream timeout kills and reaps a child that never produces records', async (context) => {
  const spawn = childProcess.spawn;
  context.mock.timers.enable({ apis: ['setTimeout'] });
  context.mock.method(childProcess, 'spawn', () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.once('spawn', () => context.mock.timers.tick(PUBLISH_RECORD_LIMITS.timeoutMs + 1));
    return child;
  });
  const result = await readPublishRecords(process.cwd(), [], process.env, () => Promise.resolve(ok(undefined)));
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error.message, /ten-minute/);
  }
});

test('stream cleanup preserves visitor assertion failures', async (context) => {
  const spawn = childProcess.spawn;
  context.mock.method(childProcess, 'spawn', () =>
    spawn(process.execPath, ['-e', "process.stdout.write('file\\0');"], {
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  );
  await assert.rejects(
    readPublishRecords(process.cwd(), [], process.env, () => {
      assert.fail('Visitor invariant');
    }),
    /Visitor invariant/,
  );
});
