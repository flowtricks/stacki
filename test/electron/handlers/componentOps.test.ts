// Goal: duplicating and deleting components in main does exactly what the panel promises, and refuses everything else
// with a typed error and the files unchanged. A copy gets a non-colliding name (case-insensitively) and the original's
// bytes; a folder copy brings every component; a used component, a path outside the component folders, a traversal,
// a link and a folder holding non-component files are refused; deleting an unused component goes to the Trash (injected
// here), cleans its `.stacki/components.json` recipe key, nested references and its roles rules; Undo puts the file and
// the settings back byte for byte, and leaves settings alone when they changed since.
// Method: build a generated project in a temp directory, call the operations directly with a recording trash that
// moves the file aside, and compare disk before and after.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseDefaultsSource } from '#dist/shared/properties/componentDefaults.js';
import { err, ok, type Result } from '#dist/shared/core/result.js';
import { parseProjectRolesSource } from '#dist/shared/properties/projectRoles.js';
import { ComponentRemovalStore, duplicateComponentTarget, removeComponentTarget, restoreRemovedComponent } from '#dist/electron/handlers/componentOps.js';

const BUTTON = '---\nconst { label } = Astro.props;\n---\n<button>{label}</button>\n';

function project(extra: Record<string, string> = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-component-ops-'));
  const files: Record<string, string> = {
    'package.json': '{"name":"fixture"}',
    'src/components/Button.astro': BUTTON,
    'src/components/Card.astro': '<div><slot /></div>\n',
    'src/components/ui/Tabs.astro': '<nav />\n',
    'src/components/ui/Tab.astro': '<a />\n',
    'src/pages/index.astro': '---\nimport Card from "../components/Card.astro";\n---\n<Card />\n',
    ...extra,
  };
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}

// A file's project path with `/` on every platform, as the app and the expected values in this file name it (Windows'
// `path.relative` answers with `\`).
function projectKey(root: string, full: string): string {
  return path.relative(root, full).split(path.sep).join('/');
}

function snapshot(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const pending = [root];
  // The fixture is a handful of folders; the cap makes the walk's bound explicit.
  for (let visited = 0; pending.length > 0 && visited < 1000; visited += 1) {
    const directory = pending.pop() ?? root;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.name === 'io') {
        continue;
      }
      if (entry.isSymbolicLink()) {
        result[projectKey(root, full)] = `link:${fs.readlinkSync(full)}`;
      } else if (entry.isDirectory()) {
        pending.push(full);
      } else {
        result[projectKey(root, full)] = fs.readFileSync(full, 'utf8');
      }
    }
  }
  return result;
}

// Writes each text straight to disk, checking it still holds `before`: the document actors' contract without the actors.
function diskWriter() {
  return {
    current: (file: string) => (fs.existsSync(file) ? ok(fs.readFileSync(file, 'utf8')) : err({ code: 'missing', message: file })),
    write: (entry: { readonly file: string; readonly before: string; readonly after: string }) => {
      if (fs.readFileSync(entry.file, 'utf8') !== entry.before) {
        return err({ code: 'write', message: `${entry.file} changed` });
      }
      fs.writeFileSync(entry.file, entry.after);
      return ok(undefined);
    },
    lease: (_texts: readonly unknown[], run: () => Result<void>) => run(),
  };
}

function trashInto(root: string) {
  const moved: string[] = [];
  return {
    moved,
    writer: diskWriter(),
    trash: async (target: string) => {
      moved.push(projectKey(root, target));
      fs.rmSync(target, { recursive: true });
    },
  };
}

const component = (rel: string) => ({ kind: 'component', path: rel }) as const;
const folder = (rel: string) => ({ kind: 'folder', path: rel }) as const;

test('a component copy is the same bytes under the first free name', () => {
  const root = project({ 'src/components/buttoncopy.astro': 'taken, in another case\n' });
  const made = duplicateComponentTarget(root, component('src/components/Button.astro'));
  assert.ok(made.ok);
  assert.equal(made.value.name, 'ButtonCopy2');
  assert.equal(made.value.path, 'src/components/ButtonCopy2.astro');
  assert.equal(fs.readFileSync(path.join(root, made.value.path), 'utf8'), BUTTON);
  assert.equal(fs.readFileSync(path.join(root, 'src/components/Button.astro'), 'utf8'), BUTTON, 'the original is untouched');
  const again = duplicateComponentTarget(root, component('src/components/Button.astro'));
  assert.ok(again.ok);
  assert.equal(again.value.name, 'ButtonCopy3');
});

test('a folder copy brings every component, under a free folder name', () => {
  const root = project();
  const made = duplicateComponentTarget(root, folder('src/components/ui'));
  assert.ok(made.ok);
  assert.equal(made.value.path, 'src/components/uiCopy');
  assert.equal(made.value.files, 2);
  assert.equal(fs.readFileSync(path.join(root, 'src/components/uiCopy/Tabs.astro'), 'utf8'), '<nav />\n');
  assert.equal(duplicateComponentTarget(root, folder('src/components/ui')).ok && true, true);
  assert.ok(fs.existsSync(path.join(root, 'src/components/uiCopy2/Tab.astro')));
});

test('copying refuses paths outside the component folders, traversal, links, non-components and foreign files', () => {
  const root = project({ 'src/components/ui/notes.txt': 'not a component', 'src/pages/other.astro': '<p />\n' });
  fs.symlinkSync(path.join(root, 'src/pages'), path.join(root, 'src/components/linked'));
  const before = snapshot(root);
  const cases: ReadonlyArray<readonly [ReturnType<typeof component> | ReturnType<typeof folder>, string]> = [
    [component('src/pages/other.astro'), 'outside-components'],
    [component('src/components/../pages/other.astro'), 'outside-components'],
    [component('/etc/passwd'), 'outside-components'],
    [component('src/components'), 'outside-components'],
    [folder('src/components'), 'outside-components'],
    [component('src/components/Missing.astro'), 'missing'],
    [component('src/components/linked/other.astro'), 'outside-components'],
    [folder('src/components/linked'), 'outside-components'],
    [component('src/components/ui'), 'not-a-component'],
    [folder('src/components/Button.astro'), 'not-a-component'],
    [folder('src/components/ui'), 'foreign-files'],
  ];
  for (const [target, code] of cases) {
    const result = duplicateComponentTarget(root, target);
    assert.ok(!result.ok, `${target.path} is refused`);
    assert.equal(result.error.code, code, target.path);
  }
  assert.deepEqual(snapshot(root), before, 'a refusal changes nothing');
});

test('a used component cannot be deleted, and nothing changes', async () => {
  const root = project();
  const before = snapshot(root);
  const store = new ComponentRemovalStore();
  const trash = trashInto(root);
  const result = await removeComponentTarget(root, component('src/components/Card.astro'), store, trash, 'refuse');
  assert.ok(!result.ok);
  assert.equal(result.error.code, 'in-use');
  assert.match(result.error.message, /Card is used in 1 place/);
  assert.deepEqual(trash.moved, []);
  assert.deepEqual(snapshot(root), before);
  const folderResult = await removeComponentTarget(root, folder('src/components/ui'), store, trash, 'refuse');
  assert.ok(folderResult.ok, 'an unused folder may go');
});

test('an unused component goes to the Trash, its settings are cleaned, and Undo restores everything', async () => {
  const defaults = {
    version: 1,
    components: {
      'src/components/Card.astro': { children: [{ component: 'src/components/Button.astro' }] },
      'src/components/Button.astro': { props: { label: 'Hi' } },
    },
  };
  const roles = {
    version: 1,
    roles: [
      { id: 'admin', members: ['owner'] },
      {
        id: 'client',
        componentRules: [
          { kind: 'component', path: 'src/components/Button.astro' },
          { kind: 'folder', path: 'src/components/ui' },
        ],
      },
    ],
  };
  const root = project({
    '.stacki/components.json': `${JSON.stringify(defaults, undefined, 2)}\n`,
    '.stacki/roles.json': `${JSON.stringify(roles, undefined, 2)}\n`,
  });
  const before = snapshot(root);
  const store = new ComponentRemovalStore();
  const trash = trashInto(root);
  const removed = await removeComponentTarget(root, component('src/components/Button.astro'), store, trash, 'remove');
  assert.ok(removed.ok, removed.ok ? '' : removed.error.message);
  assert.deepEqual(trash.moved, ['src/components/Button.astro']);
  assert.ok(!fs.existsSync(path.join(root, 'src/components/Button.astro')));
  const cleaned = parseDefaultsSource(fs.readFileSync(path.join(root, '.stacki/components.json'), 'utf8'));
  assert.ok(cleaned.ok);
  assert.deepEqual(Object.keys(cleaned.value.components), ['src/components/Card.astro']);
  assert.deepEqual(cleaned.value.components['src/components/Card.astro']?.children, []);
  const rolesNow = parseProjectRolesSource(fs.readFileSync(path.join(root, '.stacki/roles.json'), 'utf8'));
  assert.deepEqual(rolesNow.roles.find((role) => role.id === 'client')?.componentRules, [{ kind: 'folder', path: 'src/components/ui', effect: 'hide' }]);

  const restored = restoreRemovedComponent(removed.value.undo, store, diskWriter());
  assert.ok(restored.ok);
  assert.equal(restored.value.metadata, 'restored');
  assert.equal(fs.readFileSync(path.join(root, 'src/components/Button.astro'), 'utf8'), BUTTON);
  assert.ok(before['.stacki/components.json'] !== undefined, 'the snapshot names the settings file by its project path');
  assert.equal(fs.readFileSync(path.join(root, '.stacki/components.json'), 'utf8'), before['.stacki/components.json']);
  const again = restoreRemovedComponent(removed.value.undo, store, diskWriter());
  assert.ok(!again.ok && again.error.code === 'unknown-undo', 'a token works once');
});

test('Undo leaves settings changed since the deletion as they are', async () => {
  const defaults = { version: 1, components: { 'src/components/Button.astro': { props: { label: 'Hi' } } } };
  const root = project({ '.stacki/components.json': `${JSON.stringify(defaults)}\n` });
  const store = new ComponentRemovalStore();
  const removed = await removeComponentTarget(root, component('src/components/Button.astro'), store, trashInto(root), 'remove');
  assert.ok(removed.ok);
  const edited = `${JSON.stringify({ version: 1, components: { 'src/components/Card.astro': { text: 'new' } } })}\n`;
  fs.writeFileSync(path.join(root, '.stacki/components.json'), edited);
  const restored = restoreRemovedComponent(removed.value.undo, store, diskWriter());
  assert.ok(restored.ok);
  assert.equal(restored.value.metadata, 'kept');
  assert.equal(fs.readFileSync(path.join(root, '.stacki/components.json'), 'utf8'), edited);
  assert.ok(fs.existsSync(path.join(root, 'src/components/Button.astro')));
});

test('deleting refuses a path outside the component folders and broken settings, changing nothing', async () => {
  const root = project({ '.stacki/components.json': '{ not json' });
  const before = snapshot(root);
  const store = new ComponentRemovalStore();
  const trash = trashInto(root);
  const outside = await removeComponentTarget(root, component('src/pages/index.astro'), store, trash, 'remove');
  assert.ok(!outside.ok && outside.error.code === 'outside-components');
  const traversal = await removeComponentTarget(root, component('src/components/../../package.json'), store, trash, 'remove');
  assert.ok(!traversal.ok && traversal.error.code === 'outside-components');
  const broken = await removeComponentTarget(root, component('src/components/Button.astro'), store, trash, 'remove');
  assert.ok(!broken.ok && broken.error.code === 'write-failed');
  assert.deepEqual(trash.moved, []);
  assert.deepEqual(snapshot(root), before);
});

test('a failed Trash move puts the cleaned settings back', async () => {
  const defaults = { version: 1, components: { 'src/components/Button.astro': { props: { label: 'Hi' } } } };
  const root = project({ '.stacki/components.json': `${JSON.stringify(defaults)}\n` });
  const before = snapshot(root);
  const result = await removeComponentTarget(
    root,
    component('src/components/Button.astro'),
    new ComponentRemovalStore(),
    {
      writer: diskWriter(),
      trash: async () => {
        throw new Error('no trash here');
      },
    },
    'remove',
  );
  assert.ok(!result.ok && result.error.code === 'write-failed');
  assert.deepEqual(snapshot(root), before);
});
