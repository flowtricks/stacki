// Goal: `stacki apps add` installs a local app folder or .zip as a plan (files and lock entry, no network), `stacki apps remove` takes it out with its
// trust record and settings, undo restores every byte, and an app with a `cli` section is callable after add and enable.
// Method: generated source folders and a generated .zip outside a fixture project; whole-tree comparisons around add/remove/undo; URLs and bad folders are
// refused by code; a failure injected into the effect applier leaves the project as it was; the notes fixture app is added, enabled (admin) and then its
// declarative command is run, and the same commands are checked as MCP tools.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import '#dist/electron/handlers/cliComponentCommands.js';
import { writeStoredZip } from '#dist/shared/properties/appBundle.js';
import { DEFAULT_EFFECTS } from '#dist/electron/project/cli/cliEffects.js';
import { runCommand as run, type RunRequest } from '#dist/electron/project/cli/cliRun.js';
import { loadExtensions } from '#dist/electron/project/cli/cliExtensions.js';
import { McpSession } from '#dist/electron/project/cli/mcpServer.js';
import { NOTES_MODULE, NOTES_PERMISSIONS, notesCli } from '../../../helpers/cliApp.ts';
import { makeProject, readText, removeProjects } from '../../../helpers/cliProject.ts';
import { snapshotTree } from '../../../helpers/cliTree.ts';

/** Runs a command the way the shell does: with the commands the project's enabled apps contribute. */
async function runCommand(input: RunRequest): ReturnType<typeof run> {
  const extensions = await loadExtensions(input.project);
  return run(extensions === undefined ? input : { ...input, extensions });
}

const scratch: string[] = [];
afterEach(() => {
  removeProjects();
  for (const folder of scratch.splice(0)) {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

/** An app folder outside any project, with the notes `cli` section and a module. */
function sourceFolder(id: string, extra: Readonly<Record<string, unknown>> = {}): string {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-app-src-'));
  scratch.push(folder);
  const manifest = {
    manifestVersion: 1,
    id,
    name: `Fixture ${id}`,
    version: '1.0.0',
    entry: 'index.html',
    permissions: NOTES_PERMISSIONS,
    cli: notesCli(),
    ...extra,
  };
  fs.writeFileSync(path.join(folder, 'stacki-app.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(folder, 'index.html'), '<!doctype html><title>x</title>\n');
  fs.writeFileSync(path.join(folder, 'handler.mjs'), NOTES_MODULE);
  fs.mkdirSync(path.join(folder, 'img'));
  fs.writeFileSync(path.join(folder, 'img', 'dot.png'), Buffer.from([137, 80, 78, 71, 0, 255, 1, 2]));
  return folder;
}

function request(
  root: string,
  words: readonly string[],
  args: Record<string, unknown>,
  apply: 'apply' | 'plan' = 'plan',
  yes: 'yes' | 'no' = 'no',
): RunRequest {
  return { words, args, project: root, role: {}, apply, yes, waitSeconds: 0 };
}

test('add plans the files and the lock entry, and writes nothing without apply', async () => {
  const root = makeProject();
  const before = snapshotTree(root);
  const plan = await runCommand(request(root, ['apps', 'add'], { source: sourceFolder('notes') }));
  assert.ok(plan.ok, JSON.stringify(plan));
  assert.equal(plan.mode, 'plan');
  assert.ok(plan.files.some((file) => file.file === '.stacki/apps/notes/stacki-app.json' && file.action === 'create'));
  assert.ok(plan.files.some((file) => file.file === '.stacki/apps/apps.json'));
  assert.deepEqual(snapshotTree(root), before);
});

test('add then remove then undo: bytes of binary files and every other file are restored', async () => {
  const root = makeProject();
  const empty = snapshotTree(root);
  const added = await runCommand(request(root, ['apps', 'add'], { source: sourceFolder('notes') }, 'apply'));
  assert.ok(added.ok, JSON.stringify(added));
  assert.deepEqual([...fs.readFileSync(path.join(root, '.stacki/apps/notes/img/dot.png'))], [137, 80, 78, 71, 0, 255, 1, 2]);
  assert.match(readText(root, '.stacki/apps/apps.json') ?? '', /"id": "notes"/);
  const installed = snapshotTree(root);
  const unconfirmed = await runCommand(request(root, ['apps', 'remove'], { app: 'notes' }, 'apply'));
  assert.ok(!unconfirmed.ok && unconfirmed.error.code === 'confirmation-required');
  const removed = await runCommand(request(root, ['apps', 'remove'], { app: 'notes' }, 'apply', 'yes'));
  assert.ok(removed.ok, JSON.stringify(removed));
  assert.ok(!fs.existsSync(path.join(root, '.stacki/apps/notes')));
  assert.ok(!(readText(root, '.stacki/apps/apps.json') ?? '').includes('"notes"'));
  const restored = await runCommand(request(root, ['undo'], { id: removed.undoId }, 'apply'));
  assert.ok(restored.ok, JSON.stringify(restored));
  assert.deepEqual(snapshotTree(root), installed, 'undo of the removal restores every byte');
  const gone = await runCommand(request(root, ['undo'], { id: added.undoId }, 'apply'));
  assert.ok(gone.ok, JSON.stringify(gone));
  assert.deepEqual(
    Object.keys(snapshotTree(root)).filter((name) => name.startsWith('.stacki/apps/notes')),
    [],
    'undo of the add removes the folder',
  );
  assert.deepEqual(snapshotTree(root), empty, 'the project is as it was before the add');
});

test('a .zip installs like a folder', async () => {
  const root = makeProject();
  const manifest = { manifestVersion: 1, id: 'zipped', name: 'Zipped', version: '2.0.0', entry: 'index.html' };
  const archive = writeStoredZip([
    { path: 'stacki-app.json', bytes: new TextEncoder().encode(JSON.stringify(manifest)) },
    { path: 'index.html', bytes: new TextEncoder().encode('<!doctype html><title>z</title>') },
  ]);
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-app-zip-'));
  scratch.push(folder);
  const file = path.join(folder, 'zipped.zip');
  fs.writeFileSync(file, archive);
  const added = await runCommand(request(root, ['apps', 'add'], { source: file }, 'apply'));
  assert.ok(added.ok, JSON.stringify(added));
  assert.ok(fs.existsSync(path.join(root, '.stacki/apps/zipped/index.html')));
});

test('add refuses downloads, a bad folder, a duplicate and a link, naming the way to install', async () => {
  const root = makeProject();
  const before = snapshotTree(root);
  for (const source of ['https://example.com/app.zip', 'github:owner/repo', 'npm:some-app']) {
    const result = await runCommand(request(root, ['apps', 'add'], { source }, 'apply'));
    assert.ok(!result.ok, source);
    assert.match(result.error.message, /Apps panel/);
  }
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-app-empty-'));
  scratch.push(empty);
  assert.ok(!(await runCommand(request(root, ['apps', 'add'], { source: empty }, 'apply'))).ok);
  assert.deepEqual(snapshotTree(root), before);
  assert.ok((await runCommand(request(root, ['apps', 'add'], { source: sourceFolder('notes') }, 'apply'))).ok);
  const again = await runCommand(request(root, ['apps', 'add'], { source: sourceFolder('notes') }, 'apply'));
  assert.ok(!again.ok && again.error.code === 'exists');
});

test('a failure while writing the folder leaves the project as it was', async () => {
  const root = makeProject();
  const before = snapshotTree(root);
  const result = await runCommand({
    ...request(root, ['apps', 'add'], { source: sourceFolder('notes') }, 'apply'),
    effectApplier: { apply: () => ({ ok: false, error: { code: 'write-failed', message: 'disk full (injected)' } }) },
  });
  assert.ok(!result.ok && result.error.code === 'write-failed');
  assert.deepEqual(snapshotTree(root), before);
  const unchanged = await runCommand({ ...request(root, ['apps', 'add'], { source: sourceFolder('notes2') }, 'apply'), effectApplier: DEFAULT_EFFECTS });
  assert.ok(unchanged.ok);
});

test('remove forgets the app trust record and its non-secret settings', async () => {
  const root = makeProject();
  assert.ok((await runCommand(request(root, ['apps', 'add'], { source: sourceFolder('notes') }, 'apply'))).ok);
  assert.ok((await runCommand(request(root, ['apps', 'enable'], { app: 'notes' }, 'apply'))).ok);
  assert.ok((await runCommand(request(root, ['apps', 'settings', 'set'], { app: 'notes', setting: 'color', value: 'red' }, 'apply'))).ok);
  const removed = await runCommand(request(root, ['apps', 'remove'], { app: 'notes' }, 'apply', 'yes'));
  assert.ok(removed.ok, JSON.stringify(removed));
  assert.ok(!(readText(root, '.stacki/cli.json') ?? '').includes('"notes"'));
  assert.ok(!(readText(root, '.stacki/apps/settings.json') ?? '').includes('"notes"'));
  const missing = await runCommand(request(root, ['apps', 'remove'], { app: 'notes' }, 'apply', 'yes'));
  assert.ok(!missing.ok && missing.error.code === 'missing');
});

test('an added app with a cli section becomes callable after enable, in the shell and as MCP tools', async () => {
  const root = makeProject();
  assert.ok((await runCommand(request(root, ['apps', 'add'], { source: sourceFolder('notes') }, 'apply'))).ok);
  const session = new McpSession({ project: root });
  const names = async (): Promise<string> => JSON.stringify(await session.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
  assert.ok(!(await names()).includes('stacki_notes_set-title'), 'an app that is not enabled adds no tool');
  const refused = await runCommand(request(root, ['notes', 'set-title'], { title: 'Hi' }, 'apply'));
  assert.ok(!refused.ok);
  assert.ok((await runCommand(request(root, ['apps', 'enable'], { app: 'notes' }, 'apply'))).ok);
  assert.ok((await names()).includes('stacki_notes_set-title'), 'enabling adds the tool on the next call');
  const ran = await runCommand(request(root, ['notes', 'set-title'], { title: 'Hello' }, 'apply'));
  assert.ok(ran.ok, JSON.stringify(ran));
  assert.match(readText(root, '.stacki/apps/notes/settings.json') ?? '', /Hello/);
  assert.ok((await runCommand(request(root, ['apps', 'remove'], { app: 'notes' }, 'apply', 'yes'))).ok);
  assert.ok(!(await names()).includes('stacki_notes_set-title'), 'removing drops the tool');
});
