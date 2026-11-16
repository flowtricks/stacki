// Goal: `stacki components rename|move|duplicate|delete` drive the Components panel's own planner: the plan lists the files and the references it only
// reports, apply writes all or nothing, undo restores every byte, a used component is never deleted, and the same commands are MCP tools.
// Method: generated fixture projects (a page importing a component three ways, defaults, role rules) are run through `runCommand` and an MCP session.
// Each destructive path compares the WHOLE tree (every file's bytes, every folder) before and after; a write failure is injected into the app's own rename
// writer; the case-only rename, quote and alias styles, the in-use refusal, duplicate naming and role gating each have a case.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import '#dist/electron/handlers/cliComponentCommands.js';
import { setRenameWriter } from '#dist/electron/handlers/cliComponentCommands.js';
import { desktopRenameWriter } from '#dist/electron/project/pageRenameDesktop.js';
import { runCommand, type RunRequest } from '#dist/electron/project/cli/cliRun.js';
import { McpSession } from '#dist/electron/project/cli/mcpServer.js';
import { makeProject, readText, removeProjects, ROLES_FIXTURE } from '../../helpers/cliProject.ts';
import { snapshotTree } from '../../helpers/cliTree.ts';

afterEach(() => {
  setRenameWriter(desktopRenameWriter);
  removeProjects();
});

const PAGE = [
  '---',
  "import Card from '../components/Card.astro';",
  'import Alias from "@/components/Card.astro";',
  '---',
  '<main><Card /><Alias /></main>',
  '',
].join('\n');

function project(extra: Readonly<Record<string, string>> = {}): string {
  return makeProject({
    'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } }),
    'src/components/Card.astro': '<div class="card"><slot /></div>\n',
    'src/components/Button.astro': '<button><slot /></button>\n',
    'src/components/ui/.keep': '',
    'src/pages/index.astro': PAGE,
    '.stacki/components.json': `${JSON.stringify({ version: 1, components: { 'src/components/Card.astro': { text: 'Hello' } } }, undefined, 2)}\n`,
    ...extra,
  });
}

function request(
  root: string,
  words: readonly string[],
  args: Record<string, unknown>,
  apply: 'apply' | 'plan' = 'plan',
  yes: 'yes' | 'no' = 'no',
  role?: string,
): RunRequest {
  return { words, args, project: root, role: { role }, apply, yes, waitSeconds: 0 };
}

test('rename plans first: the files that change, the count, and what is only reported', async () => {
  const root = project({ 'notes.txt': 'see src/components/Card.astro for the card\n' });
  const before = snapshotTree(root);
  const plan = await runCommand(request(root, ['components', 'rename'], { path: 'src/components/Card.astro', name: 'Tile' }));
  assert.ok(plan.ok, JSON.stringify(plan));
  assert.equal(plan.mode, 'plan');
  assert.match(plan.summary, /\d+ files will be updated/);
  assert.ok(plan.files.some((file) => file.file === 'src/pages/index.astro' && file.action === 'modify'));
  assert.ok(plan.files.some((file) => file.action === 'move' && file.from === 'src/components/Card.astro' && file.file === 'src/components/Tile.astro'));
  assert.ok(
    plan.notes.some((note) => note.includes('notes.txt')),
    'a text file that still names the path is reported, not changed',
  );
  assert.deepEqual(snapshotTree(root), before, 'a plan writes nothing');
});

test('rename updates every reference, keeps quote and alias styles, and undo restores every byte', async () => {
  const root = project();
  const before = snapshotTree(root);
  const applied = await runCommand(request(root, ['components', 'rename'], { path: 'src/components/Card.astro', name: 'Tile' }, 'apply'));
  assert.ok(applied.ok, JSON.stringify(applied));
  const page = readText(root, 'src/pages/index.astro') ?? '';
  assert.match(page, /import Tile from '\.\.\/components\/Tile\.astro';/, 'single quotes and the relative form are kept');
  assert.match(page, /@\/components\/Tile\.astro"/, 'the alias and its double quotes are kept');
  assert.match(page, /<Tile \/>/);
  assert.ok(fs.existsSync(path.join(root, 'src/components/Tile.astro')) && !fs.existsSync(path.join(root, 'src/components/Card.astro')));
  assert.ok((readText(root, '.stacki/components.json') ?? '').includes('src/components/Tile.astro'), 'the recipe key follows');
  const undone = await runCommand(request(root, ['undo'], { id: applied.undoId }, 'apply'));
  assert.ok(undone.ok, JSON.stringify(undone));
  assert.deepEqual(snapshotTree(root), before, 'every file is byte for byte as before');
});

test('move relinks relative imports, and a move then a rename undo in reverse order', async () => {
  const root = project();
  const before = snapshotTree(root);
  const moved = await runCommand(request(root, ['components', 'move'], { path: 'src/components/Card.astro', folder: 'src/components/ui' }, 'apply'));
  assert.ok(moved.ok, JSON.stringify(moved));
  assert.match(readText(root, 'src/pages/index.astro') ?? '', /'\.\.\/components\/ui\/Card\.astro'/);
  const renamed = await runCommand(request(root, ['components', 'rename'], { path: 'src/components/ui/Card.astro', name: 'Tile' }, 'apply'));
  assert.ok(renamed.ok, JSON.stringify(renamed));
  for (const id of [renamed.undoId, moved.undoId]) {
    const undone = await runCommand(request(root, ['undo'], { id }, 'apply'));
    assert.ok(undone.ok, JSON.stringify(undone));
  }
  assert.deepEqual(snapshotTree(root), before);
});

test('a write failure inside the app writer leaves the whole project as it was', async () => {
  const root = project();
  const before = snapshotTree(root);
  setRenameWriter(() => {
    const real = desktopRenameWriter();
    let writes = 0;
    return {
      ...real,
      write: (entry) => {
        writes += 1;
        return writes === 2 ? { ok: false, error: { code: 'write', message: 'disk full (injected)' } } : real.write(entry);
      },
    };
  });
  const result = await runCommand(request(root, ['components', 'rename'], { path: 'src/components/Card.astro', name: 'Tile' }, 'apply'));
  assert.ok(!result.ok);
  assert.equal(result.error.code, 'write-failed');
  assert.deepEqual(snapshotTree(root), before);
});

test('a case-only rename works and undoes', async () => {
  const root = project();
  const before = snapshotTree(root);
  const applied = await runCommand(request(root, ['components', 'rename'], { path: 'src/components/Card.astro', name: 'CARD' }, 'apply'));
  assert.ok(applied.ok, JSON.stringify(applied));
  assert.ok(fs.readdirSync(path.join(root, 'src/components')).includes('CARD.astro'));
  const undone = await runCommand(request(root, ['undo'], { id: applied.undoId }, 'apply'));
  assert.ok(undone.ok);
  assert.deepEqual(snapshotTree(root), before);
});

test('rename refuses a name that is taken or not a component name, changing nothing', async () => {
  const root = project();
  const before = snapshotTree(root);
  for (const name of ['Button', 'til/e', 'Fragment', '2']) {
    const result = await runCommand(request(root, ['components', 'rename'], { path: 'src/components/Card.astro', name }, 'apply'));
    assert.ok(!result.ok, name);
  }
  assert.deepEqual(snapshotTree(root), before);
});

test('duplicate names a copy like the app, FooCopy then FooCopy2, and undo removes it', async () => {
  const root = project();
  const before = snapshotTree(root);
  const first = await runCommand(request(root, ['components', 'duplicate'], { path: 'src/components/Button.astro' }, 'apply'));
  assert.ok(first.ok, JSON.stringify(first));
  const second = await runCommand(request(root, ['components', 'duplicate'], { path: 'src/components/Button.astro' }, 'apply'));
  assert.ok(second.ok);
  assert.equal(readText(root, 'src/components/ButtonCopy.astro'), '<button><slot /></button>\n');
  assert.equal(readText(root, 'src/components/ButtonCopy2.astro'), '<button><slot /></button>\n');
  for (const id of [second.undoId, first.undoId]) {
    assert.ok((await runCommand(request(root, ['undo'], { id }, 'apply'))).ok);
  }
  assert.deepEqual(snapshotTree(root), before);
});

test('delete refuses a component in use, and a used one is untouched', async () => {
  const root = project();
  const before = snapshotTree(root);
  const result = await runCommand(request(root, ['components', 'delete'], { path: 'src/components/Card.astro' }, 'apply', 'yes'));
  assert.ok(!result.ok);
  assert.match(result.error.message, /Used in|used in|in \d+ place/i);
  assert.deepEqual(snapshotTree(root), before);
});

test('delete needs yes, cleans the settings that name it, and undo restores every byte', async () => {
  const root = project({
    '.stacki/roles.json': ROLES_FIXTURE,
    '.stacki/components.json': `${JSON.stringify({ version: 1, components: { 'src/components/Button.astro': { text: 'Go' } } }, undefined, 2)}\n`,
  });
  const before = snapshotTree(root);
  const unconfirmed = await runCommand(request(root, ['components', 'delete'], { path: 'src/components/Button.astro' }, 'apply'));
  assert.ok(!unconfirmed.ok && unconfirmed.error.code === 'confirmation-required');
  const plan = await runCommand(request(root, ['components', 'delete'], { path: 'src/components/Button.astro' }));
  assert.ok(plan.ok && plan.files.some((file) => file.action === 'delete' && file.file === 'src/components/Button.astro'));
  assert.ok(
    plan.notes.some((note) => note.includes('undo journal')),
    'it says where the deleted file goes',
  );
  const applied = await runCommand(request(root, ['components', 'delete'], { path: 'src/components/Button.astro' }, 'apply', 'yes'));
  assert.ok(applied.ok, JSON.stringify(applied));
  assert.ok(!fs.existsSync(path.join(root, 'src/components/Button.astro')));
  assert.ok(!(readText(root, '.stacki/components.json') ?? '').includes('Button.astro'), 'the recipe is dropped');
  const undone = await runCommand(request(root, ['undo'], { id: applied.undoId }, 'apply'));
  assert.ok(undone.ok, JSON.stringify(undone));
  assert.deepEqual(snapshotTree(root), before);
});

test('components commands need cli:components, and the MCP tools are the same commands', async () => {
  const root = project({ '.stacki/roles.json': ROLES_FIXTURE });
  const denied = await runCommand(request(root, ['components', 'duplicate'], { path: 'src/components/Button.astro' }, 'apply', 'no', 'editor'));
  assert.ok(!denied.ok && denied.error.code === 'role-denied');
  const session = new McpSession({ project: root });
  const list = JSON.stringify(await session.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
  for (const name of ['stacki_components_rename', 'stacki_components_move', 'stacki_components_duplicate', 'stacki_components_delete']) {
    assert.ok(list.includes(name), name);
  }
  const call = (id: number, name: string, args: Record<string, unknown>) =>
    session.handle({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
  const dry = JSON.stringify(await call(2, 'stacki_components_rename', { path: 'src/components/Card.astro', name: 'Tile' }));
  assert.ok(dry.includes('"mode":"plan"') && dry.includes('files will be updated'));
  assert.ok(fs.existsSync(path.join(root, 'src/components/Card.astro')));
  const applied = JSON.stringify(await call(3, 'stacki_components_rename', { path: 'src/components/Card.astro', name: 'Tile', apply: true }));
  assert.ok(applied.includes('"mode":"apply"'));
  assert.ok(fs.existsSync(path.join(root, 'src/components/Tile.astro')));
});
