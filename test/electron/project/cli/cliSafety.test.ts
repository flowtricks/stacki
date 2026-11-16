// Goal: the CLI never leaves a half-written project, never writes under another CLI writer, and never lets a role do more than roles.json grants.
// Method: (1) atomicity: a two-file plan is applied through a writer that fails on the second file, and both files are checked byte for byte;
// (2) running-app and writer exclusion: the CLI project lock is simulated with a live owner (refused as `locked`), an abandoned one (broken),
// and a file that changed after the plan (`conflict`); (3) roles: each command is run as the admin, an editor and a viewer from a generated
// roles.json, asserting allow and deny by code, that a denial carries no plan, that a restricted role cannot grant itself access through any
// route (roles commands, config on roles.json, config on the apps enablement file), and that the help lists only what the role may run.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { applyStaged, DEFAULT_WRITER, type FileWriter } from '#dist/electron/project/cli/cliApply.js';
import { configEdit, stage } from '#dist/electron/project/cli/cliPlan.js';
import { runCommand, visibleCommands, type RunRequest } from '#dist/electron/project/cli/cliRun.js';
import { resolveRoleContext } from '#dist/electron/project/cli/cliRole.js';
import { helpText } from '#dist/electron/project/cli/cliMain.js';
import { fileSchemaById } from '#dist/shared/properties/cli/stackiFiles.js';
import { COMMANDS } from '#dist/shared/properties/cli/stackiCommands.js';
import { makeProject, readText, removeProjects, ROLES_FIXTURE } from '../../../helpers/cliProject.ts';

afterEach(removeProjects);

function request(
  project: string,
  words: readonly string[],
  args: Record<string, unknown>,
  role: string | undefined,
  apply: 'apply' | 'plan' = 'apply',
): RunRequest {
  return { words, args, project, role: { role }, apply, yes: 'yes', waitSeconds: 0 };
}

test('a failed write puts every file already written back, byte for byte', async () => {
  const guide = fileSchemaById('guide');
  const folders = fileSchemaById('folders');
  assert.ok(guide !== undefined && folders !== undefined);
  const before = '{\n  "version": 1,\n  "folders": {}\n}\n';
  const root = makeProject({ '.stacki/folders.json': before });
  const staged = stage(root, [
    configEdit(guide, [{ kind: 'set', path: ['settings', 'visible'], value: true }]),
    configEdit(folders, [{ kind: 'set', path: ['folders', 'components'], value: ['src/ui'] }]),
  ]);
  assert.ok(staged.ok);
  assert.equal(staged.value.length, 2);
  let writes = 0;
  const failing: FileWriter = {
    remove: DEFAULT_WRITER.remove,
    write: (projectRoot, schema, source, base) => {
      writes += 1;
      return writes === 2
        ? { ok: false, error: { code: 'write-failed', message: 'disk full (injected)' } }
        : DEFAULT_WRITER.write(projectRoot, schema, source, base);
    },
  };
  const result = await applyStaged(root, 'test', staged.value, { waitSeconds: 0, writer: failing });
  assert.ok(!result.ok);
  assert.equal(result.error.code, 'write-failed');
  assert.match(result.error.message, /put back/);
  assert.equal(readText(root, '.stacki/guide.json'), undefined, 'the file created first is gone again');
  assert.equal(readText(root, '.stacki/folders.json'), before, 'the second file is untouched');
});

test('a file changed after the plan is a conflict and nothing is written', async () => {
  const guide = fileSchemaById('guide');
  assert.ok(guide !== undefined);
  const root = makeProject();
  const staged = stage(root, [configEdit(guide, [{ kind: 'set', path: ['settings', 'visible'], value: true }])]);
  assert.ok(staged.ok);
  fs.mkdirSync(path.join(root, '.stacki'), { recursive: true });
  fs.writeFileSync(path.join(root, '.stacki/guide.json'), '{ "version": 1, "settings": {} }\n');
  const result = await applyStaged(root, 'test', staged.value, { waitSeconds: 0, writer: DEFAULT_WRITER });
  assert.ok(!result.ok);
  assert.equal(result.error.code, 'conflict');
  assert.equal(readText(root, '.stacki/guide.json'), '{ "version": 1, "settings": {} }\n');
});

test('another live CLI writer holds the project: locked; an abandoned lock is broken', async () => {
  const root = makeProject();
  const lock = path.join(root, '.stacki/io/cli-project.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, JSON.stringify({ pid: process.ppid, at: Date.now() }));
  const held = await runCommand(request(root, ['guides', 'set'], { visible: true }, undefined));
  assert.ok(!held.ok);
  assert.equal(held.error.code, 'locked');
  assert.equal(readText(root, '.stacki/guide.json'), undefined);
  fs.writeFileSync(lock, JSON.stringify({ pid: 2_147_483_000, at: Date.now() }));
  const freed = await runCommand(request(root, ['guides', 'set'], { visible: true }, undefined));
  assert.ok(freed.ok, 'a lock whose owner is gone is taken over');
  assert.equal(fs.existsSync(lock), false, 'the lock is released after the apply');
});

test('roles: allow and deny per command, with no plan in a denial', async () => {
  const root = makeProject({ '.stacki/roles.json': ROLES_FIXTURE });
  const editorGuide = await runCommand(request(root, ['guides', 'set'], { visible: true }, 'editor'));
  assert.ok(editorGuide.ok, 'the editor holds cli:guides and settings:editor');
  const editorBreakpoints = await runCommand(request(root, ['breakpoints', 'add'], { name: 'Wide', value: 100, unit: 'rem' }, 'editor'));
  assert.ok(!editorBreakpoints.ok);
  assert.equal(editorBreakpoints.error.code, 'role-denied');
  assert.match(editorBreakpoints.error.message, /cli:breakpoints/);
  assert.equal(JSON.stringify(editorBreakpoints).includes('files'), false, 'a denial carries no plan');
  const viewerWrite = await runCommand(request(root, ['guides', 'set'], { visible: true }, 'viewer'));
  assert.ok(!viewerWrite.ok && viewerWrite.error.code === 'role-denied');
  const viewerRead = await runCommand(request(root, ['list'], { what: 'roles' }, 'viewer'));
  assert.ok(viewerRead.ok, 'cli:read is granted to every role');
  const unknown = await runCommand(request(root, ['doctor'], {}, 'ghost'));
  assert.ok(!unknown.ok && unknown.error.code === 'usage');
});

test('roles: a restricted role cannot grant itself access by any route', async () => {
  const root = makeProject({ '.stacki/roles.json': ROLES_FIXTURE });
  const attempts: ReadonlyArray<readonly [readonly string[], Record<string, unknown>]> = [
    [['roles', 'access', 'grant'], { role: 'editor', feature: 'cli:components' }],
    [['config', 'set'], { file: 'roles', path: 'roles[1].access', value: ['cli:roles'] }],
    [['config', 'add'], { file: 'roles', path: 'roles[1].access', value: 'cli:config' }],
    [['config', 'set'], { file: '.stacki/roles.json', path: 'defaultRole', value: 'editor' }],
    [['roles', 'members', 'add'], { role: 'admin', login: 'ed' }],
    [['apps', 'enable'], { app: 'notes' }],
  ];
  for (const [words, args] of attempts) {
    const result = await runCommand(request(root, words, args, 'editor'));
    assert.ok(!result.ok, `${words.join(' ')} is refused for the editor`);
    assert.equal(result.error.code, 'role-denied', words.join(' '));
  }
  assert.equal(readText(root, '.stacki/roles.json'), ROLES_FIXTURE, 'roles.json is untouched');
  const admin = await runCommand(request(root, ['roles', 'access', 'grant'], { role: 'viewer', feature: 'cli:guides' }, 'admin'));
  assert.ok(admin.ok, 'the admin can');
  const hidden = await runCommand(request(root, ['roles', 'access', 'grant'], { role: 'viewer', feature: 'cli:roles' }, 'admin'));
  assert.ok(!hidden.ok, 'cli:roles is never grantable, even by the admin');
});

test('roles: help and the command list show only what the role may run', async () => {
  const root = makeProject({ '.stacki/roles.json': ROLES_FIXTURE });
  const viewer = resolveRoleContext(root, { role: 'viewer' });
  assert.ok(viewer.ok);
  const shown = visibleCommands(viewer.value, undefined).map((spec) => spec.words.join(' '));
  assert.ok(shown.includes('schema') && shown.includes('doctor'));
  assert.ok(!shown.includes('guides set') && !shown.includes('roles add'));
  const help = await helpText(root, { role: 'viewer' });
  assert.ok(!help.includes('guides set'), 'help for the viewer hides write commands');
  assert.ok(help.includes('cooperative guardrail'), 'help says plainly that roles on a shell are cooperative');
  const admin = resolveRoleContext(root, {});
  assert.ok(admin.ok);
  assert.equal(visibleCommands(admin.value, undefined).length, COMMANDS.length, 'the owner sees every command');
});

test('a role file with no admin entry cannot be written by the CLI', async () => {
  const root = makeProject({ '.stacki/roles.json': ROLES_FIXTURE });
  const result = await runCommand(request(root, ['roles', 'members', 'remove'], { role: 'admin', login: 'owner' }, 'admin'));
  assert.ok(!result.ok, 'the app refuses a file with an admin and no members');
  assert.equal(readText(root, '.stacki/roles.json'), ROLES_FIXTURE);
});
