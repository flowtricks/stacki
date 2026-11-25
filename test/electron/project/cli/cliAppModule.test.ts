// Goal: an app's module handler runs only inside the limits the CLI can enforce: no inherited environment, no read outside its own folder, no file
// write, no child process, a wall-clock limit, a bounded answer, and a typed one-line JSON protocol whose answer the CLI validates before anything
// is written. The handler is never told the role.
// Method: a generated fixture app whose module tries each forbidden thing and reports what happened. A fake secret is set in the parent environment
// and written to a `.env` in the fixture project; the module must see neither. Hanging, oversized, malformed and failing answers are each asserted by
// refusal text and by the disk staying untouched. Nothing here touches a real project or a real secret.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { loadExtensions } from '#dist/electron/project/cli/cliExtensions.js';
import { runCommand } from '#dist/electron/project/cli/cliRun.js';
import { readAnswer } from '#dist/electron/project/cli/cliAppModule.js';
import { dig } from '../../../helpers/cliJson.ts';
import { listOf, notesProject } from '../../../helpers/cliApp.ts';
import { removeProjects } from '../../../helpers/cliProject.ts';

afterEach(removeProjects);

// Variables the operating system adds to every child however empty its environment is, so no CLI can withhold them: macOS sets the text encoding,
// and on Windows libuv copies the variables a Windows process needs to start (src/win/process.c, `required_vars`) from the parent. None of them
// can carry the parent's secret, which the test checks separately.
const PLATFORM_ADDED_VARIABLES: readonly string[] =
  process.platform === 'win32'
    ? ['HOMEDRIVE', 'HOMEPATH', 'LOGONSERVER', 'PATH', 'SYSTEMDRIVE', 'SYSTEMROOT', 'TEMP', 'USERDOMAIN', 'USERNAME', 'USERPROFILE', 'WINDIR']
    : ['__CF_USER_TEXT_ENCODING'];

async function probe(root: string, input: Record<string, unknown>): ReturnType<typeof runCommand> {
  const extensions = await loadExtensions(root);
  assert.ok(extensions !== undefined);
  return runCommand({ words: ['notes', 'probe'], args: input, project: root, role: {}, apply: 'plan', yes: 'no', waitSeconds: 0, extensions });
}

test('the module sees no inherited variable, cannot read the project .env, cannot write a file and cannot start a program', async () => {
  const root = notesProject();
  process.env['STACKI_TEST_SECRET'] = 'fixture-not-a-secret';
  try {
    const result = await probe(root, { mode: 'probe', envPath: path.join(root, '.env') });
    assert.ok(result.ok, JSON.stringify(result));
    assert.equal(dig(result.result, 'secret'), 'absent', 'the parent secret is not inherited');
    assert.equal(dig(result.result, 'protocol'), '1');
    const keys = listOf(dig(result.result, 'envKeys')).map(String);
    assert.ok(keys.includes('STACKI_CLI_PROTOCOL'));
    for (const key of keys) {
      assert.ok(key === 'STACKI_CLI_PROTOCOL' || PLATFORM_ADDED_VARIABLES.includes(key.toUpperCase()), `unexpected variable ${key}`);
    }
    assert.equal(JSON.stringify(result).includes('fixture-not-a-secret'), false, 'the secret reaches neither the env nor the .env read');
    assert.deepEqual(dig(result.result, 'dotenv'), { ok: false, code: 'ERR_ACCESS_DENIED' });
    assert.deepEqual(dig(result.result, 'write'), { ok: false, code: 'ERR_ACCESS_DENIED' });
    assert.deepEqual(dig(result.result, 'spawn'), { ok: false, code: 'ERR_ACCESS_DENIED' });
    assert.equal(dig(result.result, 'own', 'ok'), true, 'its own folder is readable');
    assert.equal(fs.existsSync(path.join(root, '.stacki', 'apps', 'notes', 'probe-write.txt')), false);
  } finally {
    delete process.env['STACKI_TEST_SECRET'];
  }
});

test('the module is sent the typed request and is never told the role', async () => {
  const root = notesProject();
  const result = await probe(root, { mode: 'probe', envPath: path.join(root, '.env') });
  assert.ok(result.ok);
  assert.equal(dig(result.result, 'phase'), 'plan');
  assert.equal(dig(result.result, 'command'), 'notes probe');
  assert.equal(dig(result.result, 'hasRole'), false);
  assert.deepEqual(dig(result.result, 'state'), {}, 'a command that owns no file is sent no state');
});

test('a module that does not answer in time is killed and nothing changes', async () => {
  const root = notesProject();
  const started = Date.now();
  const result = await probe(root, { mode: 'hang' });
  assert.ok(!result.ok);
  assert.match(result.error.message, /did not answer within 1 seconds and was stopped/);
  assert.ok(Date.now() - started < 8000, 'the wait is the limit, not longer');
});

test('an oversized answer, a failure, malformed output and a refusal each end the command with a message and no change', async () => {
  const root = notesProject();
  const huge = await probe(root, { mode: 'huge' });
  assert.ok(!huge.ok);
  assert.match(huge.error.message, /printed more than/);
  const failed = await probe(root, { mode: 'fail' });
  assert.ok(!failed.ok);
  assert.match(failed.error.message, /exit 3.*the handler broke/);
  const bad = await probe(root, { mode: 'badjson' });
  assert.ok(!bad.ok);
  assert.match(bad.error.message, /not JSON/);
  const refused = await probe(root, { mode: 'refuse' });
  assert.ok(!refused.ok);
  assert.match(refused.error.message, /Nothing to do today/);
  const readonly = await probe(root, { mode: 'readonly-writes' });
  assert.ok(!readonly.ok);
  assert.match(readonly.error.message, /declared read-only/);
});

test('a link inside the app folder stops the module from running', async () => {
  const root = notesProject();
  fs.symlinkSync(path.join(root, '.env'), path.join(root, '.stacki', 'apps', 'notes', 'leak.json'));
  const result = await probe(root, { mode: 'probe', envPath: path.join(root, '.env') });
  assert.ok(!result.ok);
  assert.match(result.error.message, /link/);
});

test('readAnswer takes exactly one JSON line with ok true or false', () => {
  assert.ok(readAnswer('{"ok":true,"summary":"fine"}\n').ok);
  assert.ok(!readAnswer('').ok);
  assert.ok(!readAnswer('{"ok":true,"summary":"a"}\n{"ok":true,"summary":"b"}\n').ok);
  assert.ok(!readAnswer('{"ok":true}').ok, 'a summary is required');
  assert.ok(!readAnswer('[1]').ok);
  const refusal = readAnswer('{"ok":false,"message":"no\\u0007 way"}');
  assert.ok(refusal.ok && !refusal.value.ok && refusal.value.message === 'no way');
});
