// Goal: deleting a component from the Components panel takes every instance and import with it, in one step that is
// planned in full before anything is written and undone byte for byte, and refuses (writing nothing) every use it cannot
// rewrite. Also: the confirmation's preview parser accepts what main sends and refuses each malformed shape.
//
// Method: build a small project in a temp directory (pages, a layout, components, a barrel, `.stacki` settings), call
// the planner and the deletion directly with a disk writer and a recording trash, and compare whole files. Import shapes
// are a table: each row is a page's text before and the text it must hold after. Files are written with CRLF in one row,
// and every path is joined with `path.join`, so the test means the same thing on Windows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { err, ok, type Result } from '#dist/shared/core/result.js';
import { parseDefaultsSource } from '#dist/shared/properties/componentDefaults.js';
import { parseComponentRemovalPreview } from '#dist/shared/properties/componentRemoval.js';
import { ComponentRemovalStore, previewRemoveTarget, removeComponentTarget, restoreRemovedComponent } from '#dist/electron/handlers/componentOps.js';
import { globMatchesTarget, planComponentReferences, removalRange } from '#dist/electron/handlers/componentRemovalPlan.js';

const DIV = '---\n---\n<div class="my-class"><slot /></div>\n\n<style>\n  .my-class { padding: 1rem; }\n</style>\n';
const TSCONFIG = JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } });

function project(files: Readonly<Record<string, string>>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-component-removal-'));
  const all: Record<string, string> = { 'tsconfig.json': TSCONFIG, 'src/components/Div.astro': DIV, ...files };
  for (const [relative, text] of Object.entries(all)) {
    const file = path.join(root, ...relative.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  return root;
}

function read(root: string, relative: string): string {
  return fs.readFileSync(path.join(root, ...relative.split('/')), 'utf8');
}

function snapshot(root: string): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  const pending = [root];
  for (let index = 0; index < pending.length; index += 1) {
    const directory = pending[index];
    assert.ok(directory !== undefined);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(full);
      } else {
        result[path.relative(root, full).split(path.sep).join('/')] = fs.readFileSync(full, 'utf8');
      }
    }
  }
  return result;
}

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

function host(root: string) {
  const moved: string[] = [];
  return {
    moved,
    writer: diskWriter(),
    trash: async (target: string) => {
      moved.push(path.relative(root, target).split(path.sep).join('/'));
      fs.rmSync(target, { recursive: true });
    },
  };
}

const div = { kind: 'component', path: 'src/components/Div.astro' } as const;

// ----- import shapes -----

const SHAPES: readonly { readonly name: string; readonly file: string; readonly before: string; readonly after: string }[] = [
  {
    name: 'a relative default import, unused',
    file: 'src/pages/index.astro',
    before: '---\nimport Base from "../layouts/Base.astro";\nimport Div from "../components/Div.astro";\n---\n<Base />\n',
    after: '---\nimport Base from "../layouts/Base.astro";\n---\n<Base />\n',
  },
  {
    name: 'an alias import without the extension',
    file: 'src/pages/about.astro',
    before: "---\nimport Div from '@/components/Div';\nconst title = 'About';\n---\n<h1>{title}</h1>\n",
    after: "---\nconst title = 'About';\n---\n<h1>{title}</h1>\n",
  },
  {
    name: 'an aliased local name with an instance',
    file: 'src/pages/alias.astro',
    before: '---\nimport Box from "@/components/Div.astro";\n---\n<main>\n  <h1>Hi</h1>\n  <Box>inside</Box>\n</main>\n',
    after: '---\n---\n<main>\n  <h1>Hi</h1>\n</main>\n',
  },
  {
    name: 'CRLF line endings, a labelled instance with children',
    file: 'src/pages/crlf.astro',
    before:
      '---\r\nimport Div from "../components/Div.astro";\r\n---\r\n<main>\r\n  <!-- hero -->\r\n  <Div>\r\n    <p>x</p>\r\n  </Div>\r\n  <p>kept</p>\r\n</main>\r\n',
    after: '---\r\n---\r\n<main>\r\n  <p>kept</p>\r\n</main>\r\n',
  },
  {
    name: 'a named import through a barrel keeps the other names',
    file: 'src/pages/barrel.astro',
    before: '---\nimport { Div, Card } from "@/components";\n---\n<Card><Div /></Card>\n',
    after: '---\nimport { Card } from "@/components";\n---\n<Card></Card>\n',
  },
  {
    name: 'a side-effect import',
    file: 'src/layouts/Base.astro',
    before: '---\nimport "../components/Div.astro";\n---\n<html><body><slot /></body></html>\n',
    after: '---\n---\n<html><body><slot /></body></html>\n',
  },
];

test('every import shape and instance is taken out, and nothing else moves', async () => {
  const files: Record<string, string> = {
    'src/components/Card.astro': '---\n---\n<article><slot /></article>\n',
    'src/components/index.ts': "export { default as Div } from './Div.astro';\nexport { default as Card } from './Card.astro';\n",
  };
  for (const shape of SHAPES) {
    files[shape.file] = shape.before;
  }
  const root = project(files);
  const removed = await removeComponentTarget(root, div, new ComponentRemovalStore(), host(root), 'remove');
  assert.ok(removed.ok, removed.ok ? '' : removed.error.message);
  for (const shape of SHAPES) {
    assert.equal(read(root, shape.file), shape.after, shape.name);
  }
  assert.equal(read(root, 'src/components/index.ts'), "export { default as Card } from './Card.astro';\n", 'the barrel loses its export');
  assert.equal(fs.existsSync(path.join(root, 'src/components/Div.astro')), false);
});

test('the preview counts instances and imports per file, and the settings it cleans', () => {
  const defaults = {
    version: 1,
    components: { 'src/components/Div.astro': { props: {} }, 'src/components/Card.astro': { children: [{ component: 'src/components/Div.astro' }] } },
  };
  const root = project({
    '.stacki/components.json': `${JSON.stringify(defaults, undefined, 2)}\n`,
    'src/components/Card.astro': '---\n---\n<article><slot /></article>\n',
    'src/pages/index.astro': '---\nimport Div from "../components/Div.astro";\n---\n<Div /><Div><Div /></Div>\n',
    'src/pages/unused.astro': '---\nimport Div from "../components/Div.astro";\n---\n<p />\n',
  });
  const preview = previewRemoveTarget(root, div);
  assert.ok(preview.ok, preview.ok ? '' : preview.error.message);
  assert.equal(preview.value.name, 'Div');
  assert.equal(preview.value.files, 1);
  assert.deepEqual(preview.value.instances, [{ path: 'src/pages/index.astro', count: 3 }]);
  assert.deepEqual(preview.value.imports, [
    { path: 'src/pages/index.astro', count: 1 },
    { path: 'src/pages/unused.astro', count: 1 },
  ]);
  assert.deepEqual(preview.value.settings, ['.stacki/components.json']);
  assert.deepEqual(preview.value.reviews, []);
  assert.deepEqual(parseComponentRemovalPreview(JSON.parse(JSON.stringify(preview.value))), preview.value, 'the preview survives the wire');
});

test('Undo restores every page, the component and the settings byte for byte, component first', async () => {
  const defaults = { version: 1, components: { 'src/components/Div.astro': { props: {} } } };
  const root = project({
    '.stacki/components.json': `${JSON.stringify(defaults, undefined, 2)}\n`,
    'src/pages/index.astro': '---\r\nimport Div from "../components/Div.astro";\r\n---\r\n<main>\r\n  <Div tone="a" />\r\n</main>\r\n',
    'src/layouts/Base.astro': '---\nimport Div from "@/components/Div.astro";\n---\n<slot />\n',
  });
  const before = snapshot(root);
  const store = new ComponentRemovalStore();
  const removed = await removeComponentTarget(root, div, store, host(root), 'remove');
  assert.ok(removed.ok);
  assert.notDeepEqual(snapshot(root), before);
  const order: string[] = [];
  const writer = diskWriter();
  const watched = {
    ...writer,
    write: (entry: { readonly file: string; readonly before: string; readonly after: string }) => {
      order.push(fs.existsSync(path.join(root, 'src/components/Div.astro')) ? 'page after component' : 'page before component');
      return writer.write(entry);
    },
  };
  const restored = restoreRemovedComponent(removed.value.undo, store, watched);
  assert.ok(restored.ok, restored.ok ? '' : restored.error.message);
  assert.deepEqual(snapshot(root), before, 'every byte is back');
  assert.deepEqual(order, ['page after component', 'page after component'], 'the component exists before any page imports it again');
});

test('Undo refuses, changing nothing, when a page was edited since, and stays available', async () => {
  const root = project({ 'src/pages/index.astro': '---\nimport Div from "../components/Div.astro";\n---\n<Div />\n<p>x</p>\n' });
  const store = new ComponentRemovalStore();
  const removed = await removeComponentTarget(root, div, store, host(root), 'remove');
  assert.ok(removed.ok);
  const page = path.join(root, 'src/pages/index.astro');
  const edited = `${fs.readFileSync(page, 'utf8')}<p>later</p>\n`;
  fs.writeFileSync(page, edited);
  const after = snapshot(root);
  const refused = restoreRemovedComponent(removed.value.undo, store, diskWriter());
  assert.ok(!refused.ok);
  assert.equal(refused.error.message, 'src/pages/index.astro changed since. Nothing was changed; try again.');
  assert.deepEqual(snapshot(root), after);
  fs.writeFileSync(page, '---\n---\n<p>x</p>\n');
  const again = restoreRemovedComponent(removed.value.undo, store, diskWriter());
  assert.ok(again.ok, 'the token was kept for a later try');
});

// ----- refusals -----

const REFUSALS: readonly { readonly name: string; readonly files: Readonly<Record<string, string>>; readonly kind: string; readonly place: string }[] = [
  {
    name: 'a dynamic import',
    files: { 'src/pages/lazy.astro': '---\nconst Div = (await import("../components/Div.astro")).default;\n---\n<p />\n' },
    kind: 'dynamic-import',
    place: 'src/pages/lazy.astro:2',
  },
  {
    name: 'an import.meta.glob that matches the file',
    files: { 'src/pages/all.astro': '---\nconst all = import.meta.glob("../components/*.astro");\n---\n<p />\n' },
    kind: 'glob',
    place: 'src/pages/all.astro:2',
  },
  {
    name: 'the component used as a value in a template expression',
    files: { 'src/pages/value.astro': '---\nimport Div from "../components/Div.astro";\nconst list = [1];\n---\n<p>{list.map(() => Div)}</p>\n' },
    kind: 'value',
    place: 'src/pages/value.astro:5',
  },
  {
    name: 'the component used as a value in the frontmatter',
    files: { 'src/pages/map.astro': '---\nimport Div from "../components/Div.astro";\nconst components = { Div };\n---\n<p />\n' },
    kind: 'value',
    place: 'src/pages/map.astro:3',
  },
  {
    name: 'an instance inside an expression',
    files: { 'src/pages/cond.astro': '---\nimport Div from "../components/Div.astro";\nconst on = true;\n---\n{on && <Div />}\n' },
    kind: 'expression',
    place: 'src/pages/cond.astro:5',
  },
  {
    name: 'a barrel of a barrel',
    files: {
      'src/components/index.ts': "export { default as Div } from './Div.astro';\n",
      'src/lib/ui.ts': "export { Div } from '../components/index';\n",
    },
    kind: 're-export',
    place: 'src/lib/ui.ts:1',
  },
  {
    name: 'an instance in MDX',
    files: { 'src/pages/post.mdx': 'import Div from "../components/Div.astro";\n\n# Post\n\n<Div />\n' },
    kind: 'content',
    place: 'src/pages/post.mdx:5',
  },
];

test('each use Stacki cannot rewrite refuses the deletion with its place, and nothing is written', async () => {
  for (const refusal of REFUSALS) {
    const root = project(refusal.files);
    const before = snapshot(root);
    const preview = previewRemoveTarget(root, div);
    assert.ok(preview.ok, refusal.name);
    assert.deepEqual(
      preview.value.reviews.map((review) => `${review.kind} ${review.path}:${String(review.line)}`),
      [`${refusal.kind} ${refusal.place}`],
      refusal.name,
    );
    const trash = host(root);
    const removed = await removeComponentTarget(root, div, new ComponentRemovalStore(), trash, 'remove');
    assert.ok(!removed.ok, refusal.name);
    assert.equal(removed.error.code, 'in-use', refusal.name);
    assert.equal(removed.error.message, `Change 1 place first: ${refusal.place}.`, refusal.name);
    assert.deepEqual(trash.moved, [], refusal.name);
    assert.deepEqual(snapshot(root), before, `${refusal.name}: nothing written`);
  }
});

test('a file that names the component but does not parse refuses the whole plan; no other page is written', async () => {
  const root = project({
    'src/pages/a.astro': '---\nimport Div from "../components/Div.astro";\n---\n<Div />\n',
    'src/pages/b.astro': '---\nimport Div from "../components/Div.astro";\nconst = ;\n---\n<p />\n',
  });
  const before = snapshot(root);
  const preview = previewRemoveTarget(root, div);
  assert.ok(preview.ok);
  assert.deepEqual(preview.value.reviews, [{ kind: 'unreadable', path: 'src/pages/b.astro', line: 2 }]);
  const removed = await removeComponentTarget(root, div, new ComponentRemovalStore(), host(root), 'remove');
  assert.ok(!removed.ok);
  assert.equal(removed.error.message, 'Change 1 place first: src/pages/b.astro:2.');
  assert.deepEqual(snapshot(root), before, 'a.astro keeps its instance: all files or none');
});

test('a failed page write puts back every page already written, and the component stays', async () => {
  const root = project({
    'src/pages/a.astro': '---\nimport Div from "../components/Div.astro";\n---\n<Div />\n',
    'src/pages/b.astro': '---\nimport Div from "../components/Div.astro";\n---\n<p />\n',
  });
  const before = snapshot(root);
  const writer = diskWriter();
  let writes = 0;
  const failing = {
    ...writer,
    write: (entry: { readonly file: string; readonly before: string; readonly after: string }) => {
      writes += 1;
      return writes === 2 ? err({ code: 'write', message: 'disk full' }) : writer.write(entry);
    },
  };
  const trash = host(root);
  const removed = await removeComponentTarget(root, div, new ComponentRemovalStore(), { ...trash, writer: failing }, 'remove');
  assert.ok(!removed.ok);
  assert.equal(removed.error.message, 'disk full');
  assert.deepEqual(trash.moved, []);
  assert.deepEqual(snapshot(root), before);
});

test('settings recipes nesting the component are cleaned with it', async () => {
  const defaults = { version: 1, components: { 'src/components/Card.astro': { children: [{ component: 'src/components/Div.astro' }, { literal: 'x' }] } } };
  const root = project({ '.stacki/components.json': `${JSON.stringify(defaults)}\n`, 'src/components/Card.astro': '<article />\n' });
  const removed = await removeComponentTarget(root, div, new ComponentRemovalStore(), host(root), 'remove');
  assert.ok(removed.ok);
  const cleaned = parseDefaultsSource(read(root, '.stacki/components.json'));
  assert.ok(cleaned.ok);
  assert.deepEqual(cleaned.value.components['src/components/Card.astro']?.children, [{ literal: 'x' }]);
});

test('refuse mode keeps the old rule: a used component is refused', async () => {
  const root = project({ 'src/pages/index.astro': '---\nimport Div from "../components/Div.astro";\n---\n<Div />\n' });
  const removed = await removeComponentTarget(root, div, new ComponentRemovalStore(), host(root), 'refuse');
  assert.ok(!removed.ok);
  assert.equal(removed.error.code, 'in-use');
});

// ----- helpers -----

test('a removal takes the whitespace before, else through the line break after, else the node alone', () => {
  const lined = '<main>\n  <Div />\n  <p />\n</main>';
  const first = lined.indexOf('<Div');
  assert.deepEqual(removalRange(lined, first, first + '<Div />'.length), { start: '<main>'.length, end: first + '<Div />'.length });
  const opening = '<Div />\n<p />';
  assert.deepEqual(removalRange(opening, 0, '<Div />'.length), { start: 0, end: '<Div />\n'.length });
  const inline = '<p>a<Div />b</p>';
  const at = inline.indexOf('<Div');
  assert.deepEqual(removalRange(inline, at, at + '<Div />'.length), { start: at, end: at + '<Div />'.length });
  assert.throws(() => removalRange(inline, -1, 2), /Assertion failed: A removal starts inside the text/);
});

test('glob patterns match the way Vite reads them', () => {
  const root = path.join(os.tmpdir(), 'site');
  const page = path.join(root, 'src', 'pages', 'index.astro');
  const targets = [path.join(root, 'src', 'components', 'Div.astro')];
  const context = { root, targets };
  assert.equal(globMatchesTarget('../components/*.astro', page, context), true);
  assert.equal(globMatchesTarget('/src/**/*.astro', page, context), true);
  assert.equal(globMatchesTarget('../components/{Div,Card}.astro', page, context), true);
  assert.equal(globMatchesTarget('../layouts/*.astro', page, context), false);
  assert.equal(globMatchesTarget('!../components/*.astro', page, context), false);
});

test('the planner asserts its preconditions', () => {
  assert.throws(() => planComponentReferences('relative', ['x']), /Assertion failed: A removal plan starts from an absolute project root/);
  assert.throws(() => planComponentReferences(os.tmpdir(), []), /Assertion failed: A removal plan names at least one component file/);
});

// ----- the preview at the boundary -----

test('the preview parser accepts a known-good preview and refuses each bad shape', () => {
  const good = {
    name: 'Div',
    files: 1,
    instances: [{ path: 'src/pages/index.astro', count: 2 }],
    imports: [{ path: 'src/pages/index.astro', count: 1 }],
    settings: ['.stacki/components.json'],
    reviews: [{ kind: 'glob', path: 'src/pages/all.astro', line: 3 }],
  };
  assert.deepEqual(parseComponentRemovalPreview(good), good);
  const bad: readonly unknown[] = [
    undefined,
    'Div',
    { ...good, name: ' ' },
    { ...good, files: 0 },
    { ...good, files: -1 },
    { ...good, instances: [{ path: 'x', count: 0 }] },
    { ...good, imports: [{ path: 3, count: 1 }] },
    { ...good, settings: [7] },
    { ...good, reviews: [{ kind: 'nope', path: 'x', line: 1 }] },
    { ...good, reviews: [{ kind: 'glob', path: 'x', line: 0 }] },
    { ...good, reviews: Array.from({ length: 257 }, () => ({ kind: 'glob', path: 'x', line: 1 })) },
    { ...good, instances: Array.from({ length: 513 }, (_, index) => ({ path: `p${String(index)}`, count: 1 })) },
  ];
  for (const shape of bad) {
    assert.throws(() => parseComponentRemovalPreview(shape), JSON.stringify(shape)?.slice(0, 80));
  }
});
