// Goal: renaming a component, or moving it to another folder under the components root, rewrites every real reference in the
// project and nothing else, all files or none, and undo restores every byte. Real references: module specifiers (relative, alias
// styles kept, `?raw` suffixes, `import type`, side-effect, dynamic import, re-exports), the local binding and the template's tags
// when the file imports the component under its own name, the moved file's own relative imports, `.stacki/components.json` keys
// and nested references, role rules, and a markdown `layout:` line. Not references: prose and strings that merely contain the
// name, comments, identifiers that only contain it (`CardWrapper`), a differently named local alias (only its specifier moves).
// A file that would not parse and does not mention the component is skipped with a notice; one that does mention it refuses the
// whole rename with nothing written. CSS is never rewritten; a mention of the old file name in it is reported.
// Method: generate a small project in a temp directory, plan and apply with the real writer, read the files back, then undo and
// compare every byte; an injected writer fails on the Nth write to prove nothing is left half done.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { planComponentRenameWork } from '#dist/electron/handlers/componentRenamePlan.js';
import { applyComponentRename, revertComponentRename } from '#dist/electron/handlers/componentRenameApply.js';
import { desktopRenameWriter } from '#dist/electron/project/pageRenameDesktop.js';
import { parseDefaultsSource } from '#dist/shared/properties/componentDefaults.js';
import { runSync } from '#dist/electron/lib/slicedWork.js';

const FILES: Record<string, string> = {
  'package.json': '{"name":"fixture"}',
  'tsconfig.json': '{"compilerOptions":{"baseUrl":".","paths":{"@/*":["src/*"],"~/*":["src/*"]}}}',
  'src/components/Card.astro':
    '---\nimport helper from "../lib/helper.ts";\nconst { title } = Astro.props;\n---\n<article>{title}{helper}</article>\n<style>\n  article { color: red; }\n</style>\n',
  'src/lib/helper.ts': 'export default "h";\n',
  'src/components/Hero.astro':
    '---\nimport Card from "./Card.astro";\nconst CardWrapper = 1;\n---\n<!-- <Card /> stays in the comment -->\n<p>Card is a word here, and so is {"Card"}</p>\n<Card title="x" />\n<Card>\n  <span>{CardWrapper}</span>\n</Card>\n<script>\n  const text = "<Card />";\n</script>\n',
  'src/pages/index.astro': "---\nimport Card from '@/components/Card.astro';\nimport Foo from '../components/Card.astro?raw';\n---\n<Card />\n<Foo />\n",
  'src/pages/about.mdx': 'import Card from \'../components/Card.astro\';\n\n# About\n\nCard in prose.\n\n<Card title="a" />\n',
  'src/pages/post.md': '---\nlayout: ../components/Card.astro\n---\n# Post\n',
  'src/components/index.ts': "export { default as Card } from './Card.astro';\nexport type { Props } from './Card.astro';\n",
  'src/lib/loader.ts':
    "import type Card from '../components/Card.astro';\nimport '../components/Card.astro';\nexport const load = () => import('../components/Card.astro?url');\nconst text = \"import x from '../components/Card.astro'\";\n",
  'src/pages/crowded.astro': '---\nimport Card from "../components/Card.astro";\nconst ContactCard = 2;\n---\n<Card />{ContactCard}\n',
  'src/pages/broken.astro': '---\nconst = ;\nimport {{{ \n---\n<p />\n',
  'src/styles/global.css': '/* see Card.astro for the card */\n.card { color: blue; }\n',
  '.stacki/components.json': `${JSON.stringify(
    {
      version: 1,
      components: {
        'src/components/Card.astro': { props: { title: 'Hi' } },
        'src/components/Hero.astro': { children: [{ component: 'src/components/Card.astro' }] },
      },
    },
    undefined,
    2,
  )}\n`,
  '.stacki/roles.json': `${JSON.stringify(
    {
      version: 1,
      roles: [
        { id: 'admin', members: ['owner'] },
        { id: 'client', componentRules: [{ kind: 'component', path: 'src/components/Card.astro' }] },
      ],
    },
    undefined,
    2,
  )}\n`,
};

function project(overrides: Record<string, string | undefined> = {}): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-component-rename-')));
  for (const [rel, text] of Object.entries({ ...FILES, ...overrides })) {
    if (text !== undefined) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), text);
    }
  }
  return root;
}

function snapshot(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const pending = [root];
  for (let visited = 0; pending.length > 0 && visited < 1000; visited += 1) {
    const directory = pending.pop() ?? root;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.name === 'io') {
        continue;
      }
      if (entry.isDirectory()) {
        pending.push(full);
      } else {
        result[path.relative(root, full)] = fs.readFileSync(full, 'utf8');
      }
    }
  }
  return result;
}

const read = (root: string, rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
const plan = (root: string, from: string, to: string) => runSync(planComponentRenameWork(root, { from, to }));

test('renaming rewrites real references and leaves prose, comments, strings and look-alike names alone', () => {
  const root = project();
  const planned = plan(root, 'src/components/Card.astro', 'src/components/ContactCard.astro');
  assert.ok(planned.ok, planned.ok ? '' : planned.error.message);
  assert.ok(applyComponentRename(planned.value, desktopRenameWriter()).ok);

  assert.ok(!fs.existsSync(path.join(root, 'src/components/Card.astro')));
  assert.ok(fs.existsSync(path.join(root, 'src/components/ContactCard.astro')));
  const hero = read(root, 'src/components/Hero.astro');
  assert.match(hero, /import ContactCard from "\.\/ContactCard\.astro";/);
  assert.match(hero, /<ContactCard title="x" \/>/);
  assert.match(hero, /<ContactCard>\n {2}<span>\{CardWrapper\}<\/span>\n<\/ContactCard>/);
  assert.match(hero, /<!-- <Card \/> stays in the comment -->/);
  assert.match(hero, /Card is a word here, and so is \{"Card"\}/);
  assert.match(hero, /const text = "<Card \/>";/);
  assert.match(hero, /const CardWrapper = 1;/);

  const index = read(root, 'src/pages/index.astro');
  assert.match(index, /import ContactCard from '@\/components\/ContactCard\.astro';/, 'the alias style and quotes are kept');
  assert.match(index, /import Foo from '\.\.\/components\/ContactCard\.astro\?raw';/, 'a local alias keeps its name and the ?raw suffix stays');
  assert.match(index, /<ContactCard \/>\n<Foo \/>/);

  assert.match(
    read(root, 'src/pages/about.mdx'),
    /import ContactCard from '\.\.\/components\/ContactCard\.astro';[\s\S]*Card in prose\.[\s\S]*<ContactCard title="a" \/>/,
  );
  assert.match(read(root, 'src/pages/post.md'), /layout: \.\.\/components\/ContactCard\.astro/);
  const barrel = read(root, 'src/components/index.ts');
  assert.match(barrel, /export \{ default as Card \} from '\.\/ContactCard\.astro';/, 'a barrel keeps its public name');
  assert.match(barrel, /export type \{ Props \} from '\.\/ContactCard\.astro';/);
  const loader = read(root, 'src/lib/loader.ts');
  assert.match(loader, /import type Card from '\.\.\/components\/ContactCard\.astro';/);
  assert.match(loader, /import '\.\.\/components\/ContactCard\.astro';/);
  assert.match(loader, /import\('\.\.\/components\/ContactCard\.astro\?url'\)/);
  assert.match(loader, /"import x from '\.\.\/components\/Card\.astro'"/, 'a string that only looks like an import is untouched');
  assert.match(read(root, 'src/styles/global.css'), /see Card\.astro/, 'CSS is never rewritten');
  assert.match(read(root, 'src/components/ContactCard.astro'), /article \{ color: red; \}/);

  const defaults = parseDefaultsSource(read(root, '.stacki/components.json'));
  assert.ok(defaults.ok);
  assert.deepEqual(Object.keys(defaults.value.components).sort(), ['src/components/ContactCard.astro', 'src/components/Hero.astro']);
  assert.deepEqual(defaults.value.components['src/components/Hero.astro']?.children, [{ component: 'src/components/ContactCard.astro' }]);
  assert.match(read(root, '.stacki/roles.json'), /src\/components\/ContactCard\.astro/);
  assert.doesNotMatch(read(root, '.stacki/roles.json'), /components\/Card\.astro/);
});

test('a file that already uses the new name keeps its local binding, with a notice', () => {
  const root = project();
  const planned = plan(root, 'src/components/Card.astro', 'src/components/ContactCard.astro');
  assert.ok(planned.ok);
  assert.ok(applyComponentRename(planned.value, desktopRenameWriter()).ok);
  const crowded = read(root, 'src/pages/crowded.astro');
  assert.match(crowded, /import Card from "\.\.\/components\/ContactCard\.astro";/);
  assert.match(crowded, /<Card \/>\{ContactCard\}/);
  assert.ok(planned.value.summary.notices.some((notice) => notice.file === 'src/pages/crowded.astro' && notice.kind === 'kept-local-name'));
});

test('notices report what was seen and not changed: CSS mentions and an unreadable file that does not mention the component', () => {
  const root = project();
  const planned = plan(root, 'src/components/Card.astro', 'src/components/ContactCard.astro');
  assert.ok(planned.ok);
  const kinds = planned.value.summary.notices.map((notice) => `${notice.file}:${notice.kind}`);
  assert.ok(kinds.includes('src/styles/global.css:mention'));
  assert.ok(kinds.includes('src/pages/broken.astro:unparsed'));
  assert.ok(!planned.value.summary.files.some((file) => file.file === 'src/pages/broken.astro' || file.file === 'src/styles/global.css'));
  const moved = plan(root, 'src/components/Card.astro', 'src/components/forms/Card.astro');
  assert.ok(moved.ok);
  assert.equal(moved.value.summary.files[0]?.file, 'src/components/Card.astro', 'a moved component whose own text changes leads the list');
});

test('a file that mentions the component and cannot be parsed refuses the whole rename, writing nothing', () => {
  const root = project({ 'src/pages/broken.astro': '---\nimport Card from "../components/Card.astro";\nconst = ;\n---\n<Card />\n' });
  const before = snapshot(root);
  const planned = plan(root, 'src/components/Card.astro', 'src/components/ContactCard.astro');
  assert.ok(!planned.ok);
  assert.equal(planned.error.code, 'unsafe-file');
  assert.match(planned.error.message, /src\/pages\/broken\.astro/);
  assert.deepEqual(snapshot(root), before);
});

test('moving to another folder rebases relative imports of the moved file and of its importers', () => {
  const root = project();
  const planned = plan(root, 'src/components/Card.astro', 'src/components/forms/Card.astro');
  assert.ok(planned.ok, planned.ok ? '' : planned.error.message);
  assert.ok(applyComponentRename(planned.value, desktopRenameWriter()).ok);
  assert.match(read(root, 'src/components/forms/Card.astro'), /import helper from "\.\.\/\.\.\/lib\/helper\.ts";/);
  assert.match(
    read(root, 'src/components/Hero.astro'),
    /import Card from "\.\/forms\/Card\.astro";[\s\S]*<Card title="x" \/>/,
    'same name: tags are untouched',
  );
  assert.match(read(root, 'src/pages/index.astro'), /import Card from '@\/components\/forms\/Card\.astro';/);
  assert.match(read(root, 'src/components/index.ts'), /from '\.\/forms\/Card\.astro'/);
});

test('renaming then moving then undoing both restores every byte of every file', () => {
  const root = project();
  const before = snapshot(root);
  const writer = desktopRenameWriter();
  const first = plan(root, 'src/components/Card.astro', 'src/components/ContactCard.astro');
  assert.ok(first.ok && applyComponentRename(first.value, writer).ok);
  const second = plan(root, 'src/components/ContactCard.astro', 'src/components/forms/ContactCard.astro');
  assert.ok(second.ok && applyComponentRename(second.value, writer).ok);
  assert.notDeepEqual(snapshot(root), before);
  assert.ok(revertComponentRename(second.value, writer).ok);
  assert.ok(revertComponentRename(first.value, writer).ok);
  assert.deepEqual(snapshot(root), before);
  assert.ok(applyComponentRename(first.value, writer).ok, 'redo applies the same plan again');
  assert.ok(fs.existsSync(path.join(root, 'src/components/ContactCard.astro')));
});

test('a case-only rename goes through a temporary name', () => {
  const root = project();
  const planned = plan(root, 'src/components/Card.astro', 'src/components/CARD.astro');
  assert.ok(planned.ok, planned.ok ? '' : planned.error.message);
  assert.ok(applyComponentRename(planned.value, desktopRenameWriter()).ok);
  assert.ok(fs.readdirSync(path.join(root, 'src/components')).includes('CARD.astro'));
});

test('a write that fails part way leaves every file as it was', () => {
  const root = project();
  const before = snapshot(root);
  const planned = plan(root, 'src/components/Card.astro', 'src/components/forms/ContactCard.astro');
  assert.ok(planned.ok);
  const total = planned.value.texts.length;
  assert.ok(total > 3, 'the rename touches several files');
  for (const failAt of [1, 2, total]) {
    const real = desktopRenameWriter();
    let writes = 0;
    const failing = {
      ...real,
      write: (entry: Parameters<typeof real.write>[0]) => {
        writes += 1;
        if (writes === failAt) {
          return { ok: false as const, error: { code: 'write', message: 'disk full' } };
        }
        return real.write(entry);
      },
    };
    const result = applyComponentRename(planned.value, failing);
    assert.ok(!result.ok, `write ${failAt} fails the rename`);
    assert.deepEqual(snapshot(root), before, `write ${failAt}: nothing is left half done`);
  }
});

test('refuses outside the component folders, climbing paths, a taken name (any case), the same name and reserved names', () => {
  const root = project({ 'src/components/Taken.astro': '<p />\n', 'src/pages/Other.astro': '<p />\n' });
  const before = snapshot(root);
  const cases: ReadonlyArray<readonly [string, string, string]> = [
    ['src/components/Card.astro', 'src/pages/Card.astro', 'invalid'],
    ['src/pages/Other.astro', 'src/components/Other.astro', 'invalid'],
    ['src/components/Card.astro', 'src/components/taken.astro', 'invalid'],
    ['src/components/Card.astro', 'src/components/Taken.astro', 'exists'],
    ['src/components/Card.astro', 'src/components/Card.astro', 'invalid'],
    ['src/components/Card.astro', 'src/components/Fragment.astro', 'invalid'],
    ['src/components/Missing.astro', 'src/components/Gone.astro', 'missing'],
  ];
  for (const [from, to, code] of cases) {
    const planned = plan(root, from, to);
    assert.ok(!planned.ok, `${from} to ${to} is refused`);
    assert.equal(planned.error.code, code, `${from} to ${to}`);
  }
  assert.deepEqual(snapshot(root), before);
});
