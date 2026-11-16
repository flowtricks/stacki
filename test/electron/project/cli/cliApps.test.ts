// Goal: an installed app adds commands to the CLI only when it is installed, enabled, trusted and unchanged, and its commands then behave exactly like
// core ones: a dry run by default, the same envelope, role gating through the existing roles, atomic apply and undo. A bad or hostile `cli` section
// switches off that app's commands and nothing else.
// Method: generated fixture projects with a fixture app under `.stacki/apps/notes/` and a lock entry written by the app's own serializer. Commands
// run through `runCommand` with the provider `loadExtensions` builds, as the shell and the MCP server do. Declarative and module commands are planned
// then applied; trust states (not enabled, not trusted, digest changed, enabled by `apps enable`) are asserted by error code; namespace collisions
// with a core command and with another app, a malformed section and an unknown apiVersion are refused without breaking core commands; roles are
// checked for visibility and for the call.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { loadExtensions } from '#dist/electron/project/cli/cliExtensions.js';
import { runCommand, visibleCommands, type RunRequest } from '#dist/electron/project/cli/cliRun.js';
import { resolveRoleContext } from '#dist/electron/project/cli/cliRole.js';
import { dig, parseJson } from '../../../helpers/cliJson.ts';
import { APP_ROLES_FIXTURE, DIGEST_TWO, installApp, listOf, notesCli, notesProject, updateLockDigest } from '../../../helpers/cliApp.ts';
import { readText, removeProjects } from '../../../helpers/cliProject.ts';

afterEach(removeProjects);

async function run(
  root: string,
  words: readonly string[],
  args: Record<string, unknown>,
  options: { readonly apply?: 'apply' | 'plan'; readonly yes?: 'yes' | 'no'; readonly role?: string } = {},
): ReturnType<typeof runCommand> {
  const extensions = await loadExtensions(root);
  const request: RunRequest = {
    words,
    args,
    project: root,
    role: { role: options.role },
    apply: options.apply ?? 'plan',
    yes: options.yes ?? 'no',
    waitSeconds: 0,
    ...(extensions === undefined ? {} : { extensions }),
  };
  return runCommand(request);
}

test('a declarative command plans first, then applies the declared operation to the app file, and undo puts it back', async () => {
  const root = notesProject();
  const plan = await run(root, ['notes', 'set-title'], { title: 'Ideas' });
  assert.ok(plan.ok);
  assert.equal(plan.mode, 'plan');
  assert.equal(plan.files[0]?.file, '.stacki/apps/notes/settings.json');
  assert.equal(readText(root, '.stacki/apps/notes/settings.json'), undefined, 'a plan leaves the disk alone');
  assert.ok(
    plan.notes.some((note) => note.includes('It may touch only: notes.settings (title)')),
    'the plan says what the command may touch',
  );
  assert.ok(plan.notes.some((note) => note.includes('no app code runs')));
  const applied = await run(root, ['notes', 'set-title'], { title: 'Ideas' }, { apply: 'apply' });
  assert.ok(applied.ok);
  assert.equal(applied.applied, true);
  assert.equal(dig(parseJson(readText(root, '.stacki/apps/notes/settings.json')), 'title'), 'Ideas');
  const undone = await run(root, ['undo'], { id: applied.undoId }, { apply: 'apply' });
  assert.ok(undone.ok);
  assert.equal(readText(root, '.stacki/apps/notes/settings.json'), undefined);
});

test('an input is checked against its declared bounds, and a value the registry refuses never reaches a file', async () => {
  const root = notesProject();
  const tooLong = await run(root, ['notes', 'set-title'], { title: 'x'.repeat(41) }, { apply: 'apply' });
  assert.ok(!tooLong.ok);
  assert.equal(tooLong.error.code, 'invalid-value');
  const missing = await run(root, ['notes', 'set-title'], {}, { apply: 'apply' });
  assert.equal(readText(root, '.stacki/apps/notes/settings.json'), undefined);
  assert.ok(!missing.ok || missing.mode === 'plan');
});

test('a declarative command may edit a core file it owns, and a destructive one needs --yes', async () => {
  const root = notesProject();
  const guide = await run(root, ['notes', 'hide-guide'], {}, { apply: 'apply' });
  assert.ok(guide.ok);
  assert.equal(dig(parseJson(readText(root, '.stacki/guide.json')), 'settings', 'visible'), false);
  await run(root, ['notes', 'set-title'], { title: 'Ideas' }, { apply: 'apply' });
  const refused = await run(root, ['notes', 'clear-title'], {}, { apply: 'apply' });
  assert.ok(!refused.ok);
  assert.equal(refused.error.code, 'confirmation-required');
  const cleared = await run(root, ['notes', 'clear-title'], {}, { apply: 'apply', yes: 'yes' });
  assert.ok(cleared.ok);
  assert.equal(dig(parseJson(readText(root, '.stacki/apps/notes/settings.json')), 'title'), undefined);
});

test('a module command is planned from the module answer and applied atomically by the CLI, never by the module', async () => {
  const root = notesProject();
  await run(root, ['notes', 'set-title'], { title: 'quiet' }, { apply: 'apply' });
  const plan = await run(root, ['notes', 'shout'], {});
  assert.ok(plan.ok);
  assert.equal(plan.mode, 'plan');
  assert.equal(dig(parseJson(readText(root, '.stacki/apps/notes/settings.json')), 'title'), 'quiet', 'the module wrote nothing');
  assert.ok(
    plan.notes.some((note) => note.includes('runs code from the notes app')),
    'the plan says app code runs',
  );
  const applied = await run(root, ['notes', 'shout'], {}, { apply: 'apply' });
  assert.ok(applied.ok);
  assert.equal(dig(parseJson(readText(root, '.stacki/apps/notes/settings.json')), 'title'), 'QUIET');
});

test('a module answer outside the keys the command owns is refused and nothing changes', async () => {
  const root = notesProject({
    cli: notesCli({ commands: [{ ...moduleCommand('escape'), writes: true, owns: [{ file: 'notes.settings', keys: ['title'] }] }] }),
  });
  const result = await run(root, ['notes', 'escape'], { mode: 'escape' }, { apply: 'apply' });
  assert.ok(!result.ok);
  assert.match(result.error.message, /outside the keys this command owns/);
  assert.equal(readText(root, '.stacki/guide.json'), undefined);
});

function moduleCommand(name: string): Record<string, unknown> {
  return {
    name,
    description: 'A module command used by a test.',
    input: { type: 'object', properties: { mode: { type: 'string', description: 'What to try.', maxLength: 20 } } },
    writes: false,
    handler: { kind: 'module', entry: 'handler.mjs', timeoutSeconds: 2 },
  };
}

test('an app that is not enabled, is not trusted, or changed since it was trusted adds no tools and its commands refuse with app-untrusted', async () => {
  const root = notesProject({ trust: 'none' });
  const hidden = visibleCommands(roleOf(root), await loadExtensions(root));
  assert.equal(
    hidden.some((spec) => spec.appId === 'notes'),
    false,
    'a disabled app contributes no tool',
  );
  const disabled = await run(root, ['notes', 'set-title'], { title: 'x' });
  assert.ok(!disabled.ok);
  assert.equal(disabled.error.code, 'app-untrusted');
  assert.match(disabled.error.message, /apps enable notes/);
  const enabled = await run(root, ['apps', 'enable'], { app: 'notes' }, { apply: 'apply' });
  assert.ok(enabled.ok);
  assert.ok((await run(root, ['notes', 'set-title'], { title: 'x' })).ok);
  updateLockDigest(root, 'notes', DIGEST_TWO);
  const changed = await run(root, ['notes', 'set-title'], { title: 'x' });
  assert.ok(!changed.ok);
  assert.equal(changed.error.code, 'app-untrusted');
  assert.match(changed.error.message, /changed since it was trusted/);
  assert.equal(
    visibleCommands(roleOf(root), await loadExtensions(root)).some((spec) => spec.appId === 'notes'),
    false,
  );
  const again = await run(root, ['apps', 'enable'], { app: 'notes' }, { apply: 'apply' });
  assert.ok(again.ok);
  assert.equal(dig(parseJson(readText(root, '.stacki/cli.json')), 'apps', 'notes', 'sha256'), DIGEST_TWO);
});

test('an app marked enabled but not trusted adds no tools', async () => {
  const root = notesProject({
    extra: { '.stacki/cli.json': `${JSON.stringify({ version: 1, apps: { notes: { enabled: true, trusted: false, sha256: 'a'.repeat(64) } } })}\n` },
  });
  const result = await run(root, ['notes', 'set-title'], { title: 'x' });
  assert.ok(!result.ok);
  assert.equal(result.error.code, 'app-untrusted');
});

function roleOf(root: string): ReturnType<typeof unwrapRole> {
  return unwrapRole(resolveRoleContext(root, {}));
}

function unwrapRole(result: ReturnType<typeof resolveRoleContext>) {
  assert.ok(result.ok);
  return result.value;
}

test('apps enable plans what it grants: the commands, the files they may touch, the app code and the network declaration', async () => {
  const root = notesProject({ trust: 'none', cli: notesCli({ network: true }) });
  const plan = await run(root, ['apps', 'enable'], { app: 'notes' });
  assert.ok(plan.ok);
  assert.equal(plan.mode, 'plan');
  const notes = plan.notes.join('\n');
  assert.match(notes, /stacki notes set-title/);
  assert.match(notes, /stacki notes shout.*runs app code/);
  assert.match(notes, /guide settings\.visible/);
  assert.match(notes, /NOT approved/);
  assert.equal(readText(root, '.stacki/cli.json'), undefined);
  const withNetwork = await run(root, ['apps', 'enable'], { app: 'notes', network: true }, { apply: 'apply' });
  assert.ok(withNetwork.ok);
  assert.equal(dig(parseJson(readText(root, '.stacki/cli.json')), 'apps', 'notes', 'network'), true);
});

test('a module command of an app that declares network use refuses until the admin approved it', async () => {
  const root = notesProject({ cli: notesCli({ network: true }) });
  const refused = await run(root, ['notes', 'shout'], {});
  assert.ok(!refused.ok);
  assert.equal(refused.error.code, 'app-untrusted');
  assert.match(refused.error.message, /--network/);
  assert.ok((await run(root, ['notes', 'set-title'], { title: 'declarative needs no network' })).ok);
});

test('apps disable turns the commands and the file off, and apps commands reports every state with its reason', async () => {
  const root = notesProject();
  assert.ok((await run(root, ['notes', 'set-title'], { title: 'x' })).ok);
  const listed = await run(root, ['apps', 'commands'], {});
  assert.ok(listed.ok);
  assert.equal(dig(listed.result, 'apps', 0, 'state'), 'active');
  assert.equal(dig(listed.result, 'apps', 0, 'commands', 0, 'tool'), 'stacki_notes_set-title');
  const disabled = await run(root, ['apps', 'disable'], { app: 'notes' }, { apply: 'apply' });
  assert.ok(disabled.ok);
  const after = await run(root, ['apps', 'commands'], {});
  assert.ok(after.ok);
  assert.equal(dig(after.result, 'apps', 0, 'state'), 'disabled');
  assert.match(String(dig(after.result, 'apps', 0, 'reason')), /apps enable notes/);
  const schema = await run(root, ['schema'], {});
  assert.ok(schema.ok);
  assert.equal(JSON.stringify(schema.result).includes('notes.settings'), false, 'the app file leaves the registry with the app');
});

test('a command whose words collide with a core command namespace, or with another app, is refused naming both, and core commands keep working', async () => {
  const root = notesProject({ trust: 'none' });
  installApp(root, { id: 'guides', manifest: { cli: { apiVersion: 1, commands: [simpleCommand('set')] } } });
  installApp(root, { id: 'dup', manifest: { cli: { apiVersion: 1, commands: [simpleCommand('x')] } } });
  const listed = await run(root, ['apps', 'commands'], {});
  assert.ok(listed.ok);
  const states = byApp(dig(listed.result, 'apps'));
  assert.equal(states['guides']?.state, 'refused');
  assert.match(states['guides']?.reason ?? '', /guides.*core command "stacki guides/s);
  assert.equal(states['dup']?.state, 'disabled', 'a unique namespace is fine');
  assert.ok((await run(root, ['guides', 'set'], { visible: true }, { apply: 'apply' })).ok, 'the core command is unharmed');
  const enable = await run(root, ['apps', 'enable'], { app: 'guides' }, { apply: 'apply' });
  assert.ok(!enable.ok);
  assert.match(enable.error.message, /cannot be enabled/);
});

interface AppRow {
  readonly state: string;
  readonly reason: string;
}

/** The rows of `apps commands` by app id, read without an assertion. */
function byApp(rows: unknown): Record<string, AppRow> {
  return Object.fromEntries(
    listOf(rows).map((row) => [String(dig(row, 'app')), { state: String(dig(row, 'state')), reason: String(dig(row, 'reason') ?? '') }]),
  );
}

function simpleCommand(name: string): Record<string, unknown> {
  return {
    name,
    description: 'A command used by a test.',
    writes: true,
    owns: [{ file: 'guide', keys: ['settings.visible'] }],
    handler: { kind: 'declarative', operations: [{ op: 'set', file: 'guide', path: 'settings.visible', value: true }] },
  };
}

test('a malformed section and an unknown apiVersion disable that app commands only, with the reason, and the app still lists', async () => {
  const root = notesProject({ trust: 'none' });
  installApp(root, { id: 'badapp', manifest: { cli: { apiVersion: 2, commands: [] } } });
  installApp(root, {
    id: 'sloppy',
    manifest: { cli: { apiVersion: 1, commands: [{ name: 'Bad Name', description: 'x', writes: true, handler: { kind: 'declarative', operations: [] } }] } },
  });
  installApp(root, { id: 'broken', manifest: { cli: 'nope' } });
  const listed = await run(root, ['apps', 'commands'], {});
  assert.ok(listed.ok);
  const byId = byApp(dig(listed.result, 'apps'));
  assert.equal(byId['badapp']?.state, 'refused');
  assert.match(byId['badapp']?.reason ?? '', /apiVersion 2 is not supported/);
  assert.equal(byId['sloppy']?.state, 'refused');
  assert.equal(byId['broken']?.state, 'refused');
  assert.equal(byId['notes']?.state, 'disabled', 'the healthy app is unaffected');
  assert.ok((await run(root, ['list'], { what: 'apps' })).ok, 'core commands run');
  const enable = await run(root, ['apps', 'enable'], { app: 'badapp' });
  assert.ok(!enable.ok);
});

test('config on an app file is validated by the declared schema: a known key is set, an unknown key and a bad value are refused', async () => {
  const root = notesProject();
  const listed = await run(root, ['schema'], {});
  assert.ok(listed.ok);
  assert.ok(JSON.stringify(listed.result).includes('notes.settings'), 'stacki schema lists the app file');
  const reference = await run(root, ['schema'], { file: 'notes.settings' });
  assert.ok(reference.ok);
  assert.equal(dig(reference.result, 'keys', 'pageSize', 'type'), 'integer 1..100');
  const set = await run(root, ['config', 'set'], { file: 'notes.settings', path: 'pageSize', value: 30 }, { apply: 'apply' });
  assert.ok(set.ok);
  assert.equal(dig(parseJson(readText(root, '.stacki/apps/notes/settings.json')), 'pageSize'), 30);
  const unknown = await run(root, ['config', 'set'], { file: 'notes.settings', path: 'pagesize', value: 30 }, { apply: 'apply' });
  assert.ok(!unknown.ok);
  assert.equal(unknown.error.code, 'unknown-key');
  const bad = await run(root, ['config', 'set'], { file: 'notes.settings', path: 'pageSize', value: 1000 }, { apply: 'apply' });
  assert.ok(!bad.ok);
  assert.equal(bad.error.code, 'invalid-value');
  const doctor = await run(root, ['doctor'], {});
  assert.ok(doctor.ok);
  assert.equal(dig(doctor.result, 'healthy'), true);
  const byPath = await run(root, ['config', 'get'], { file: '.stacki/apps/notes/settings.json' });
  assert.ok(byPath.ok);
});

test('roles: a viewer neither sees nor runs an app command; an editor with cli:apps, app:notes and the permission switch on can', async () => {
  const root = notesProject({ extra: { '.stacki/roles.json': APP_ROLES_FIXTURE } });
  const extensions = await loadExtensions(root);
  const names = (role: string): string[] =>
    visibleCommands(unwrapRole(resolveRoleContext(root, { role })), extensions)
      .filter((spec) => spec.appId === 'notes')
      .map((spec) => spec.words[1] ?? '');
  assert.deepEqual(names('viewer'), []);
  assert.deepEqual(names('noapp'), [], 'cli:apps without the app grant sees nothing');
  assert.ok(names('noswitch').includes('set-title'));
  assert.equal(names('noswitch').includes('clear-title'), false, 'the declared permission is off for this role');
  assert.ok(names('editor').includes('clear-title'));
  assert.ok(names('admin').includes('clear-title'));
  const viewer = await run(root, ['notes', 'set-title'], { title: 'x' }, { role: 'viewer', apply: 'apply' });
  assert.ok(!viewer.ok);
  assert.equal(viewer.error.code, 'role-denied');
  const noApp = await run(root, ['notes', 'set-title'], { title: 'x' }, { role: 'noapp', apply: 'apply' });
  assert.ok(!noApp.ok);
  assert.match(noApp.error.message, /app:notes/);
  const noSwitch = await run(root, ['notes', 'clear-title'], {}, { role: 'noswitch', apply: 'apply', yes: 'yes' });
  assert.ok(!noSwitch.ok);
  assert.match(noSwitch.error.message, /permission "reset"/);
  const editor = await run(root, ['notes', 'set-title'], { title: 'Editor title' }, { role: 'editor', apply: 'apply' });
  assert.ok(editor.ok, JSON.stringify(editor));
  const config = await run(root, ['config', 'set'], { file: 'notes.settings', path: 'pageSize', value: 5 }, { role: 'viewer', apply: 'apply' });
  assert.ok(!config.ok);
  assert.equal(config.error.code, 'role-denied');
  const editorConfig = await run(root, ['config', 'set'], { file: 'notes.settings', path: 'pageSize', value: 5 }, { role: 'editor', apply: 'apply' });
  assert.ok(editorConfig.ok, 'config on an app file needs cli:apps');
  const guide = await run(root, ['notes', 'hide-guide'], {}, { role: 'editor', apply: 'apply' });
  assert.ok(!guide.ok, "editing a core file still needs that file's own access");
  assert.equal(guide.error.code, 'role-denied');
});

test('an app cannot own the files that decide who may do what', async () => {
  for (const file of ['roles', 'cli', 'apps']) {
    const root = notesProject({
      trust: 'none',
      cli: {
        apiVersion: 1,
        commands: [
          {
            ...simpleCommand('grab'),
            owns: [{ file, keys: ['apps'] }],
            handler: { kind: 'declarative', operations: [{ op: 'set', file, path: 'apps', value: {} }] },
          },
        ],
      },
    });
    const listed = await run(root, ['apps', 'commands'], {});
    assert.ok(listed.ok);
    assert.equal(dig(listed.result, 'apps', 0, 'state'), 'refused', file);
    assert.match(String(dig(listed.result, 'apps', 0, 'reason')), /cannot be owned by an app/);
  }
});

test("an app file may not claim a core path or another app's settings", async () => {
  for (const path of [
    '.stacki/guide.json',
    '.stacki/cli.json',
    '.stacki/apps/other/x.json',
    '.stacki/apps/notes/stacki-app.json',
    '.stacki/apps/notes/../../guide.json',
    '.stacki/preview/x.json',
  ]) {
    const cli = notesCli();
    const root = notesProject({ trust: 'none', cli: { ...cli, commands: [], files: [{ ...Object(dig(cli, 'files', 0)), path }] } });
    const listed = await run(root, ['apps', 'commands'], {});
    assert.ok(listed.ok);
    assert.equal(dig(listed.result, 'apps', 0, 'state'), 'refused', path);
  }
});
