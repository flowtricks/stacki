// Goal: failed daemon startup exposes its actual error without reading an unbounded log.
// Method: temporary project logs cover fresh, stale, absent and oversized files; a failing
// CLI proves failureDetail still returns the diagnostic after the daemon has stopped.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { readDevServerLog } = require('#dist/electron/preview/devServerLog.js');
const { DevServers } = require('#dist/electron/handlers/devServers.js');

test('failed startup reads the log when the logs CLI is unavailable', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'stacki-startup-log-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const startedAtMs = Date.now();
  assert.equal(await readDevServerLog(directory, startedAtMs), undefined);
  await fs.mkdir(path.join(directory, '.astro'));
  const log = path.join(directory, '.astro/dev.log');
  await fs.writeFile(log, 'Cannot fetch pinned Fern revision: missing cached source\n');
  const servers = new DevServers({ send() {} });
  const detail = await servers.failureDetail(directory, '/missing/astro', startedAtMs);
  assert.match(detail, /Cannot fetch pinned Fern revision/);
  const old = new Date(startedAtMs - 10_000);
  await fs.utimes(log, old, old);
  assert.equal(await readDevServerLog(directory, startedAtMs), undefined);
  await fs.writeFile(log, 'x'.repeat(100_000) + '\nLatest failure');
  const tail = await readDevServerLog(directory, startedAtMs);
  assert.equal(tail.length, 16_384);
  assert.ok(tail.endsWith('Latest failure'));
  await fs.writeFile(log, '');
  assert.equal(await readDevServerLog(directory, startedAtMs), undefined);
  await assert.rejects(readDevServerLog('', startedAtMs), /require a project path/);
  await assert.rejects(readDevServerLog(directory, NaN), /require a start time/);
});
