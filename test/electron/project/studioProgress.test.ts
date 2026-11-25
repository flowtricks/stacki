// Goal: installation output arrives while commands run and remains bounded.
// Method: real short Node processes exercise both streams, failure and timeout;
// reporter snapshots verify batching, terminal cleanup, final flush and disposal.
import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { setToolPathHome } from '#dist/electron/lib/nodeTools.js';
import { runStudioCommand } from '#dist/electron/project/studioCommand.js';
import { createStudioProgress } from '#dist/electron/project/studioProgress.js';
import { STUDIO_LOG_CHARS_MAX, type StudioInstallProgress } from '#dist/shared/ipc/studioProgress.js';

setToolPathHome(os.homedir());
const command = (script: string, timeoutMs = 2000) => ({
  command: process.execPath,
  argumentsList: ['-e', script],
  directory: os.tmpdir(),
  project: os.tmpdir(),
  timeoutMs,
});

test('command streams stdout and stderr before resolving', async () => {
  const output: string[] = [];
  let complete = false;
  const result = await runStudioCommand(
    command('process.stdout.write("Installing\\n");' + 'setTimeout(() => process.stderr.write("Checked\\n"), 120);'),
    (chunk) => {
      assert.equal(complete, false);
      output.push(chunk);
    },
  );
  complete = true;
  assert.equal(result.ok, true);
  assert.equal(output.join(''), 'Installing\nChecked\n');
});

test('failed commands retain diagnostics and command time is bounded', async () => {
  let output = '';
  const failed = await runStudioCommand(command('process.stderr.write("Build failed\\n"); process.exitCode = 2;'), (chunk) => {
    output += chunk;
  });
  assert.equal(failed.ok, false);
  assert.match(output, /Build failed/);
  const timeout = await runStudioCommand(command('setTimeout(() => {}, 5000)', 100), () => {});
  assert.equal(timeout.ok, false);
  assert.throws(() => runStudioCommand(command('', 0), () => {}), /timeout is positive/);
  assert.throws(() => runStudioCommand(command('', 180001), () => {}), /timeout stays bounded/);
});

test('excessive command output fails instead of buffering without a limit', async () => {
  const result = await runStudioCommand(command('process.stdout.write("x".repeat(3 * 1024 * 1024));'), () => {});
  assert.equal(result.ok, false);
});

test('progress batches bounded output, flushes on stages and stops after close', async () => {
  const snapshots: StudioInstallProgress[] = [];
  const reporter = createStudioProgress({ projectPath: '/site', requestId: 'test-install' }, (progress) => snapshots.push(progress));
  reporter.update({ kind: 'stage', stage: 'dependencies' });
  reporter.update({ kind: 'output', text: '\u001b[32mInstalling\u001b[0m\n' });
  reporter.update({ kind: 'output', text: 'Packages\n' });
  assert.equal(snapshots.length, 1);
  await delay(200);
  assert.equal(snapshots.length, 2);
  assert.equal(snapshots.at(-1)?.output, 'Installing\nPackages\n');
  reporter.update({ kind: 'output', text: 'x'.repeat(STUDIO_LOG_CHARS_MAX + 1) });
  reporter.update({ kind: 'stage', stage: 'check' });
  assert.equal(snapshots.at(-1)?.output.length, STUDIO_LOG_CHARS_MAX);
  assert.equal(snapshots.at(-1)?.stage, 'check');
  reporter.update({ kind: 'output', text: '\nFinal diagnostic' });
  reporter.close();
  const count = snapshots.length;
  assert.match(snapshots.at(-1)?.output ?? '', /Final diagnostic$/);
  reporter.update({ kind: 'stage', stage: 'complete' });
  reporter.close();
  await delay(200);
  assert.equal(snapshots.length, count);
});
