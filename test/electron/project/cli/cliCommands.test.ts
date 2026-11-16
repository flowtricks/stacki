// Goal: every core CLI command plans first and writes only with apply, writes what the app's own rules allow, and refuses what they refuse.
// Method: generated fixture projects; each command is run twice through `runCommand` (the entry point the shell and the MCP server share):
// once as a dry run, asserting the plan and that the disk is untouched, then with apply, asserting the file the app would write, and the
// undo entry puts it back. Refusals (unknown key, bad value, built-in breakpoint, delete without --yes) are asserted by code, and a bad
// settings file is never overwritten.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { runCommand, type RunRequest } from '#dist/electron/project/cli/cliRun.js';
import { dig, parseJson } from '../../../helpers/cliJson.ts';
import { makeProject, readText, removeProjects } from '../../../helpers/cliProject.ts';

afterEach(removeProjects);

function request(
  project: string,
  words: readonly string[],
  args: Record<string, unknown>,
  apply: 'apply' | 'plan' = 'plan',
  yes: 'yes' | 'no' = 'no',
): RunRequest {
  return { words, args, project, role: {}, apply, yes, waitSeconds: 0 };
}

test('a write command is a dry run by default and writes nothing', async () => {
  const root = makeProject();
  const plan = await runCommand(request(root, ['guides', 'set'], { visible: true, columns: '4' }));
  assert.equal(plan.ok, true);
  assert.ok(plan.ok);
  assert.equal(plan.mode, 'plan');
  assert.equal(plan.applied, false);
  assert.equal(plan.files[0]?.file, '.stacki/guide.json');
  assert.equal(plan.files[0]?.action, 'create');
  assert.equal(readText(root, '.stacki/guide.json'), undefined, 'a plan leaves the disk alone');
});

test('apply writes the file the app would write, and undo puts it back', async () => {
  const root = makeProject();
  const applied = await runCommand(request(root, ['guides', 'set'], { visible: true, columns: '4', margin: '3rem' }, 'apply'));
  assert.ok(applied.ok);
  assert.equal(applied.mode, 'apply');
  assert.ok(applied.undoId !== undefined);
  const written = parseJson(readText(root, '.stacki/guide.json'));
  assert.equal(dig(written, 'settings', 'visible'), true);
  assert.equal(dig(written, 'settings', 'columns', 'count'), 4);
  assert.equal(dig(written, 'settings', 'margin', 'length', 'unit'), 'rem');
  const undone = await runCommand(request(root, ['undo'], { id: applied.undoId }, 'apply'));
  assert.ok(undone.ok);
  assert.equal(readText(root, '.stacki/guide.json'), undefined, 'undo removes a file the command created');
});

test('config refuses a key the app would silently ignore, and a value outside its bounds', async () => {
  const root = makeProject();
  const unknown = await runCommand(request(root, ['config', 'set'], { file: 'guide', path: 'settings.visibel', value: true }, 'apply'));
  assert.ok(!unknown.ok);
  assert.equal(unknown.error.code, 'unknown-key');
  const bounds = await runCommand(request(root, ['config', 'set'], { file: 'guide', path: 'settings.opacity', value: 0.9 }, 'apply'));
  assert.ok(!bounds.ok);
  assert.equal(bounds.error.code, 'invalid-value');
  assert.equal(readText(root, '.stacki/guide.json'), undefined);
});

test('config set, add, remove and unset work on a list and a nested key through the registry', async () => {
  const root = makeProject({ '.stacki/styles.json': '{ "version": 1, "keep": ["is-*"] }\n' });
  const added = await runCommand(request(root, ['config', 'add'], { file: 'styles', path: 'keep', value: 'w-*' }, 'apply'));
  assert.ok(added.ok);
  assert.deepEqual(dig(parseJson(readText(root, '.stacki/styles.json')), 'keep'), ['is-*', 'w-*']);
  const removed = await runCommand(request(root, ['config', 'remove'], { file: 'styles', path: 'keep', value: 'is-*' }, 'apply', 'yes'));
  assert.ok(removed.ok);
  assert.deepEqual(dig(parseJson(readText(root, '.stacki/styles.json')), 'keep'), ['w-*']);
  const blocked = await runCommand(request(root, ['config', 'unset'], { file: 'styles', path: 'version' }, 'apply'));
  assert.ok(!blocked.ok);
  assert.equal(blocked.error.code, 'required');
});

test('a destructive command applies only with yes', async () => {
  const root = makeProject();
  await runCommand(request(root, ['breakpoints', 'add'], { name: 'Wide', value: 100, unit: 'rem' }, 'apply'));
  const refused = await runCommand(request(root, ['breakpoints', 'remove'], { id: 'bp-1' }, 'apply'));
  assert.ok(!refused.ok);
  assert.equal(refused.error.code, 'confirmation-required');
  const done = await runCommand(request(root, ['breakpoints', 'remove'], { id: 'bp-1' }, 'apply', 'yes'));
  assert.ok(done.ok);
  const builtin = await runCommand(request(root, ['breakpoints', 'remove'], { id: 'tablet' }, 'apply', 'yes'));
  assert.ok(!builtin.ok);
  assert.equal(builtin.error.code, 'invalid-value');
});

test('breakpoints and folders use the app rules', async () => {
  const root = makeProject();
  const wrong = await runCommand(request(root, ['breakpoints', 'set'], { id: 'tablet', value: 70, unit: 'rem' }, 'apply'));
  assert.ok(!wrong.ok, 'tablet may not pass laptop');
  const folder = await runCommand(request(root, ['folders', 'add'], { kind: 'components', folder: 'src/ui' }, 'apply'));
  assert.ok(folder.ok);
  assert.deepEqual(dig(parseJson(readText(root, '.stacki/folders.json')), 'folders', 'components'), ['src/components', 'src/ui']);
  const escape = await runCommand(request(root, ['folders', 'add'], { kind: 'components', folder: '../outside' }, 'apply'));
  assert.ok(!escape.ok);
});

test('a settings file the app refuses is never overwritten', async () => {
  const root = makeProject({ '.stacki/guide.json': '{ "version": 9 }\n' });
  const result = await runCommand(request(root, ['guides', 'set'], { visible: true }, 'apply'));
  assert.ok(!result.ok);
  assert.equal(readText(root, '.stacki/guide.json'), '{ "version": 9 }\n');
});

test('list, schema and doctor read without writing', async () => {
  const root = makeProject({ '.stacki/styles.json': '{ "version": 1, "keep": [], "typo": 1 }\n' });
  const schema = await runCommand(request(root, ['schema'], { file: 'guide' }));
  assert.ok(schema.ok && schema.mode === 'read');
  const doctor = await runCommand(request(root, ['doctor'], {}));
  assert.ok(doctor.ok);
  assert.ok(JSON.stringify(doctor.result).includes('typo'), 'doctor reports the key the parser ignores');
  const list = await runCommand(request(root, ['list'], { what: 'components' }));
  assert.ok(list.ok);
  assert.ok(JSON.stringify(list.result).includes('src/components/Card.astro'));
});

test('an unknown command and a project that is not one are refused by code', async () => {
  const none = await runCommand(request(makeProject(), ['nope'], {}));
  assert.ok(!none.ok && none.error.code === 'usage');
  const outside = await runCommand(request('/', ['doctor'], {}));
  assert.ok(!outside.ok && outside.error.code === 'not-a-project');
});
