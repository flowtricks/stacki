// Goal: commands without stdin data cannot fail merely because Git closes its input pipe early.
// Method: use real writable streams to distinguish EOF from writes and simulate broken pipes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { finishGitInput } from '../src/features/publishing/publishGitInput';

test('empty input sends EOF without a write and tolerates an already closed pipe', () => {
  let writes = 0;
  let failures = 0;
  const stream = new Writable({
    write(_chunk, _encoding, callback) {
      writes++;
      callback();
    },
  });
  finishGitInput(stream, '', () => failures++);
  stream.emit('error', new Error('EPIPE'));
  assert.equal(stream.writableEnded, true);
  assert.equal(writes, 0);
  assert.equal(failures, 0);
});

test('nonempty input is delivered and a closed pipe still reports lost data', () => {
  let bytes = 0;
  let failures = 0;
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      callback();
    },
  });
  finishGitInput(stream, 'commit message', () => failures++);
  stream.emit('error', new Error('EPIPE'));
  assert.equal(bytes, Buffer.byteLength('commit message'));
  assert.equal(stream.writableEnded, true);
  assert.equal(failures, 1);
});
