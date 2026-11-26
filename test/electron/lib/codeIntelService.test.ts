// Goal: code intelligence answers for any Astro project, whatever its shape, and runs none of it.
// Method: scratch projects written per test (no tsconfig, aliases through `extends`, JavaScript only, generated content
// types, framework components, a workspace opened at its root, no installed dependencies), with the real Astro types
// Studio installs linked in. Each question marks its cursor `‸`, and every answer passes the contract's parser. The
// last test fills a project with files that write a marker when run and checks no question runs any of them.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, type TestContext } from 'node:test';
import { createCodeIntelService } from '#dist/electron/lib/codeIntel/service.js';
import { shippedLibraryFiles, type LibraryFiles } from '#dist/electron/lib/codeIntel/typeFiles.js';
import { parseCodeIntelReply, type CodeCompletion, type CodeIntelQuery, type CodeIntelReply } from '#dist/shared/ipc/codeIntel.js';
import { toExplorerPath } from '#dist/shared/ipc/fileExplorer.js';

const repositoryPath = (relative: string): string => fileURLToPath(new URL(`../../../${relative}`, import.meta.url));
const ASTRO = repositoryPath('studio/node_modules/astro');

interface Site {
  readonly root: string;
  readonly write: (file: string, text: string) => void;
  readonly ask: (file: string, marked: string, kind: 'complete' | 'hover' | 'signature' | 'diagnostics') => CodeIntelReply;
  readonly items: (file: string, marked: string) => readonly CodeCompletion[];
  readonly labels: (file: string, marked: string) => readonly string[];
  readonly errors: (file: string, text: string) => readonly string[];
}

function site(
  context: TestContext,
  files: Readonly<Record<string, string>>,
  options: { readonly libraries?: LibraryFiles; readonly bare?: 'bare' } = {},
): Site {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-intel-')));
  const service = createCodeIntelService(options.libraries === undefined ? {} : { libraries: options.libraries });
  context.after(() => {
    service.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const write = (file: string, text: string): void => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  };
  for (const [file, text] of Object.entries({ 'package.json': '{"dependencies":{"astro":"*"}}', ...files })) {
    write(file, text);
  }
  if (options.bare === undefined) {
    fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
    fs.symlinkSync(ASTRO, path.join(root, 'node_modules', 'astro'), 'junction');
  }
  const question = (file: string, text: string, query: CodeIntelQuery): CodeIntelReply =>
    parseCodeIntelReply(structuredClone(service.handle({ projectPath: root, path: toExplorerPath(file), text, query })));
  const ask: Site['ask'] = (file, marked, kind) => {
    const position = marked.indexOf('‸');
    assert.ok(kind === 'diagnostics' || position >= 0, 'the question marks its cursor');
    const text = marked.replace('‸', '');
    const query: CodeIntelQuery = kind === 'diagnostics' ? { kind } : kind === 'complete' ? { kind, position, explicit: false } : { kind, position };
    return question(file, text, query);
  };
  const items: Site['items'] = (file, marked) => {
    const reply = ask(file, marked, 'complete');
    assert.ok(reply.kind === 'completions');
    return reply.completions.items;
  };
  return {
    root,
    write,
    ask,
    items,
    labels: (file, marked) => items(file, marked).map((entry) => entry.label),
    errors: (file, text) => {
      const reply = ask(file, text, 'diagnostics');
      assert.ok(reply.kind === 'diagnostics');
      return reply.diagnostics.map((entry) => `${text.slice(entry.from, entry.to)}: ${entry.message}`);
    },
  };
}

const PAGE = 'src/pages/index.astro';
const page = (frontmatter: string, body: string): string => `---\n${frontmatter}\n---\n${body}\n`;
const CARD = [
  '---',
  'interface Props {',
  '  /** The heading. */',
  '  title: string;',
  '  tone?: "calm" | "loud";',
  '}',
  'const { title } = Astro.props;',
  '---',
  '<h2>{title}</h2>',
].join('\n');

test('components: suggested with their import, then their props and values', (context) => {
  const project = site(context, { 'src/components/Card.astro': CARD, [PAGE]: '' });
  const [card] = project.items(PAGE, '<main><Car‸</main>\n');
  assert.equal(card?.label, 'Card');
  assert.equal(card.edits[0]?.insert, "---\nimport Card from '../components/Card.astro';\n---\n\n");
  const imported = 'import Card from "../components/Card.astro";';
  const props = project.items(PAGE, page(imported, '<Card ‸/>'));
  assert.deepEqual(
    props.slice(0, 2).map((entry) => [entry.label, entry.required, entry.insert]),
    [
      ['title', true, 'title=""'],
      ['tone', false, 'tone=""'],
    ],
  );
  assert.equal(props[0]?.documentation, 'The heading.');
  assert.deepEqual([...project.labels(PAGE, page(imported, '<Card tone="‸" />'))].sort(), ['calm', 'loud']);
  // An import the file has is reused under its own name.
  const [reused] = project.items(PAGE, page('import Panel from "../components/Card.astro";', '<Pan‸'));
  assert.deepEqual([reused?.label, reused?.edits.length], ['Panel', 0]);
  // A name already taken gets its folder's.
  const [renamed] = project.items(PAGE, page('const Card = 1;', '<Car‸'));
  assert.equal(renamed?.label, 'ComponentsCard');
});

test('errors, hover and signature help read the unsaved text', (context) => {
  const project = site(context, { 'src/components/Card.astro': CARD, [PAGE]: '---\n---\n' });
  const text = page(
    'import Card from "../components/Card.astro";\nconst count: number = "one";\nif (!count) { return Astro.redirect("/"); }\nawait Promise.resolve();',
    '<Card title="a" tone="shout" />\n<script>\n  const width: string = window.innerWidth;\n  console.log(width);\n</script>',
  );
  const errors = project.errors(PAGE, text);
  assert.equal(errors.length, 3, errors.join('\n'));
  assert.match(errors[0] ?? '', /^count: Type 'string' is not assignable to type 'number'/);
  assert.match(errors[1] ?? '', /^tone: /);
  assert.match(errors[2] ?? '', /^width: /);
  const hover = project.ask(PAGE, page('import Card from "../components/Card.astro";', '<Card tit‸le="a" />'), 'hover');
  assert.ok(hover.kind === 'hover');
  assert.equal(hover.hover?.signature, '(property) Props.title: string');
  const help = project.ask(PAGE, page('function add(left: number, right = 2) { return left + right; }\nadd(1, ‸)', ''), 'signature');
  assert.ok(help.kind === 'signature');
  const signature = help.help?.signatures[0];
  assert.equal(signature?.label.slice(signature.activeFrom, signature.activeTo), 'right?: number');
});

test('aliases through extends, index files, imported and union props', (context) => {
  const project = site(context, {
    'tsconfig.base.json': '{"compilerOptions":{"strict":true,"baseUrl":".","paths":{"@ui/*":["lib/widgets/*"],"~/*":["source/*"]}}}',
    'tsconfig.json': '{"extends":"./tsconfig.base.json"}',
    'lib/widgets/card/index.astro': '---\ntype Props = { heading: string } & ({ kind: "link"; href: string } | { kind: "panel" });\n---\n<div />\n',
    'source/types.ts':
      'export interface Media { source: string }\n/** Formats cents. */\nexport function formatPrice(cents: number): string { return String(cents); }\n',
    'source/parts/Figure.astro': '---\nimport type { Media } from "~/types";\ntype Props = Media & { wide?: boolean };\n---\n<figure />\n',
    'lib/widgets/List.astro':
      '---\ninterface Props<Item extends { id: string }> { items: Item[] }\nconst { items } = Astro.props;\n---\n<ul>{items.map((item) => <li>{item.id}</li>)}</ul>\n',
    [PAGE]: '',
  });
  const [card] = project.items(PAGE, '<Car‸');
  assert.match(card?.edits[0]?.insert ?? '', /import Card from '@ui\/card\/index\.astro';/);
  const imported = 'import Card from "@ui/card/index.astro";\nimport Figure from "~/parts/Figure.astro";';
  assert.ok(project.labels(PAGE, page(imported, '<Card kind="link" ‸/>')).includes('href'));
  assert.deepEqual([...project.labels(PAGE, page(imported, '<Card kind="‸" />'))].sort(), ['link', 'panel']);
  assert.deepEqual(project.labels(PAGE, page(imported, '<Figure ‸/>')).slice(0, 2), ['source', 'wide']);
  assert.deepEqual(project.errors('lib/widgets/List.astro', fs.readFileSync(path.join(project.root, 'lib/widgets/List.astro'), 'utf8')), []);
  // An export not yet imported is offered with the module it comes from.
  const [price] = project.items(PAGE, page('const total = formatPr‸', ''));
  assert.deepEqual([price?.label, price?.entry?.source], ['formatPrice', '~/types']);
  assert.deepEqual(project.labels(PAGE, page('import x from "@ui/‸"', '')), ['card/', 'List.astro']);
});

test('JavaScript only, with no tsconfig', (context) => {
  const project = site(context, {
    'src/lib/format.js': '/**\n * @param {number} value\n * @returns {string}\n */\nexport function asPercent(value) { return value + "%"; }\n',
    [PAGE]: '',
  });
  const errors = project.errors(PAGE, page('import { asPercent } from "../lib/format.js";\nasPercent("a");', ''));
  assert.equal(errors.length, 1, errors.join('\n'));
  assert.deepEqual(project.errors('src/lib/format.js', 'export const half = (value) => value.half;\n'), []);
  assert.equal(project.errors('src/lib/format.js', 'const = 1;\n').length > 0, true);
  assert.ok(project.labels(PAGE, page('import { asPer‸ } from "../lib/format.js";', '')).includes('asPercent'));
});

test('content collections are typed from what Astro generated', (context) => {
  const project = site(context, {
    '.astro/types.d.ts': '/// <reference types="astro/client" />\n/// <reference path="content.d.ts" />\n',
    '.astro/content.d.ts':
      "declare module 'astro:content' {\n  export function getCollection(name: 'articles'): Promise<{ data: { headline: string; rating?: number } }[]>;\n}\n",
    [PAGE]: '',
  });
  const frontmatter = 'import { getCollection } from "astro:content";\nconst posts = await getCollection("articles");';
  assert.deepEqual(project.labels(PAGE, page(frontmatter, '<p>{posts.map((post) => post.data.‸)}</p>')), ['headline', 'rating']);
  assert.deepEqual(project.errors(PAGE, page(frontmatter, '<p>{posts.length}</p>')), []);
});

test('framework components from any folder, and TSX files', (context) => {
  const project = site(context, {
    'tsconfig.json': '{"compilerOptions":{"jsx":"preserve","strict":true}}',
    'src/islands/Counter.tsx':
      'declare namespace JSX { interface Element {} interface IntrinsicElements { b: { className?: string } } }\nexport default function Counter(props: { start: number; mode?: "up" | "down" }) { return <b>{props.start}</b>; }\n',
    'src/islands/Badge.jsx': 'export function Badge({ text }) { return text; }\n',
    'src/islands/Toggle.vue': '<template><b/></template>\n<style scoped>.toggle { color: red }</style>\n',
    'src/styles/site.css': '.lead { font-weight: 600 }\n',
    [PAGE]: '',
  });
  assert.match(project.items(PAGE, '<Cou‸')[0]?.edits[0]?.insert ?? '', /import Counter from '\.\.\/islands\/Counter';/);
  assert.match(project.items(PAGE, '<Badg‸')[0]?.edits[0]?.insert ?? '', /import \{ Badge \} from '\.\.\/islands\/Badge';/);
  assert.match(project.items(PAGE, '<Togg‸')[0]?.edits[0]?.insert ?? '', /import Toggle from '\.\.\/islands\/Toggle\.vue';/);
  const props = project.labels(PAGE, page('import Counter from "../islands/Counter";', '<Counter ‸ />'));
  assert.deepEqual(props.slice(0, 2), ['start', 'mode']);
  assert.deepEqual(project.errors(PAGE, page('import Toggle from "../islands/Toggle.vue";', '<Toggle client:load on />')), []);
  assert.deepEqual(project.labels('src/islands/Other.tsx', 'export const a = <b className="‸" />;'), ['lead']);
});

test('a workspace opened at its root: references, linked packages and their tokens', (context) => {
  const project = site(context, {
    'package.json': '{"private":true}',
    'apps/site/package.json': '{"dependencies":{"astro":"*","@acme/ui":"*"}}',
    'apps/site/tsconfig.json': '{"files":[],"references":[{"path":"./tsconfig.app.json"}]}',
    'apps/site/tsconfig.app.json': '{"compilerOptions":{"strict":true,"paths":{"@/*":["./src/*"]}},"include":["src/**/*"]}',
    'apps/site/src/layouts/Base.astro': '<slot />\n',
    'apps/site/public/robots.txt': '',
    'packages/ui/package.json': '{"name":"@acme/ui","exports":{".":"./index.ts","./tokens.css":"./tokens.css","./Chip.astro":"./Chip.astro"}}',
    'packages/ui/index.ts': '/** Makes a slug. */\nexport const slugify = (value: string): string => value;\n',
    'packages/ui/tokens.css': ':root { --acme-blue: #00f }\n',
    'packages/ui/Chip.astro': '---\ninterface Props { label: string }\n---\n<span />\n',
  });
  fs.mkdirSync(path.join(project.root, 'node_modules/@acme'), { recursive: true });
  fs.symlinkSync(path.join(project.root, 'packages/ui'), path.join(project.root, 'node_modules/@acme/ui'), 'junction');
  const file = 'apps/site/src/pages/post.astro';
  assert.match(project.items(file, '<Bas‸')[0]?.edits[0]?.insert ?? '', /'@\/layouts\/Base\.astro'/);
  assert.match(project.items(file, '<Chi‸')[0]?.edits[0]?.insert ?? '', /import Chip from '@acme\/ui\/Chip\.astro';/);
  assert.equal(project.labels(file, page('import Chip from "@acme/ui/Chip.astro";', '<Chip ‸/>'))[0], 'label');
  const hover = project.ask(file, page('import { slugify } from "@acme/ui";\nslu‸gify("a");', ''), 'hover');
  assert.ok(hover.kind === 'hover');
  assert.equal(hover.hover?.documentation, 'Makes a slug.');
  assert.deepEqual(project.labels(file, '---\nimport "@acme/ui/tokens.css";\n---\n<p style="color: var(--‸)" />'), ['--acme-blue']);
  assert.deepEqual(project.labels(file, '<a href="/‸" />'), ['robots.txt']);
});

test('without installed dependencies it degrades quietly', (context) => {
  const project = site(context, { 'src/components/Card.astro': CARD, 'src/styles/site.css': ':root{--accent:tomato}.lead{}\n' }, { bare: 'bare' });
  assert.deepEqual(project.errors(PAGE, page('import { z } from "zod";\nconst a: number = z.string();', '<div />')), []);
  assert.equal(project.errors(PAGE, page('const a = ;', '<div />')).length > 0, true);
  assert.equal(project.labels(PAGE, '<Car‸')[0], 'Card');
  assert.equal(project.labels(PAGE, page('import Card from "../components/Card.astro";', '<Card ‸/>'))[0], 'title');
  assert.deepEqual(project.labels(PAGE, '<p style="color: var(--‸)" />'), ['--accent']);
});

test('classes and variables follow what would apply', (context) => {
  const project = site(context, {
    'src/styles/global.css': ':root { --brand: #f50 }\n@theme { --color-ink: #111 }\n.container {}\n',
    'src/styles/card.module.css': '.title-bar {}\n',
    'src/components/Other.astro': '<style>.theirs { --theirs: 1 }</style>\n<style is:global>.everywhere {}</style>\n',
  });
  const own = '<style define:vars={{ accent: "red" }}>.mine { --mine: 2px }</style>';
  assert.deepEqual([...project.labels(PAGE, `<p class="‸" />\n${own}`)].sort(), ['container', 'everywhere', 'mine']);
  assert.deepEqual([...project.labels(PAGE, `<p style="color: var(--‸)" />\n${own}`)].sort(), ['--accent', '--brand', '--color-ink', '--mine']);
  const [brand] = project.items('src/styles/other.css', '.a { color: var(--br‸) }');
  assert.deepEqual([brand?.color, brand?.detail], ['#f50', '#f50  ·  src/styles/global.css']);
  const module = project.labels(PAGE, page('import styles from "../styles/card.module.css";\nstyles.‸', ''));
  assert.deepEqual(module, ['title-bar']);
  assert.deepEqual(project.labels('src/styles/other.css', '@import "./‸";'), ['card.module.css', 'global.css']);
});

test('MDX: components with their import among the document, and import paths', (context) => {
  const project = site(context, { 'src/components/Card.astro': CARD });
  const [card] = project.items('src/content/post.mdx', '---\ntitle: A\n---\n\n# Hello\n\n<Car‸\n');
  assert.equal(card?.edits[0]?.insert, "\nimport Card from '../components/Card.astro';\n\n");
  assert.deepEqual(project.labels('src/content/post.mdx', 'import Card from "../components/‸"\n'), ['Card.astro']);
  assert.deepEqual(project.errors('src/content/post.mdx', '# <Nope />\n'), []);
});

test('served and imported paths', (context) => {
  const project = site(context, { 'public/images/logo.svg': '', 'public/favicon.ico': '', 'src/assets/hero.png': '', [PAGE]: '' });
  assert.deepEqual(project.labels(PAGE, '<img src="/‸" />'), ['images/', 'favicon.ico']);
  assert.deepEqual(project.labels(PAGE, '<img src="/images/‸" />'), ['logo.svg']);
  assert.deepEqual(project.labels(PAGE, page('import hero from "../assets/‸"', '')), ['hero.png']);
  assert.deepEqual(project.labels(PAGE, '<style>.a { background: url("../assets/‸") }</style>'), ['hero.png']);
  // A relative src is not processed by Astro, so nothing is offered for one.
  assert.deepEqual(project.labels(PAGE, '<img src="../‸" />'), []);
});

test('a changed or added file is read again', async (context) => {
  const project = site(context, { 'src/lib/a.ts': 'export function use(value: number): number { return value; }\n', [PAGE]: '' });
  const text = page('import { use } from "../lib/a";\nuse(1);', '');
  assert.deepEqual(project.errors(PAGE, text), []);
  project.write('src/lib/a.ts', 'export function use(value: string): string { return value; }\n');
  project.write('src/components/Late.astro', '<p />\n');
  // The watch reports in its own time, within a bounded wait.
  let errors: readonly string[] = [];
  for (let attempt = 0; attempt < 100 && errors.length === 0; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    errors = project.errors(PAGE, text);
  }
  assert.equal(errors.length, 1);
  assert.equal(project.labels(PAGE, '<Lat‸')[0], 'Late');
});

test("the packaged app's copy of TypeScript's libraries is enough", (context) => {
  const shipped = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-intel-libraries-'));
  context.after(() => fs.rmSync(shipped, { recursive: true, force: true }));
  const installed = repositoryPath('node_modules/typescript/lib');
  for (const name of fs.readdirSync(installed).filter((entry) => /^lib(\..+)?\.d\.ts$/.test(entry))) {
    fs.copyFileSync(path.join(installed, name), path.join(shipped, `${name}.txt`));
  }
  const project = site(context, { [PAGE]: '' }, { libraries: shippedLibraryFiles(shipped) });
  assert.ok(project.labels(PAGE, '<script>\n  document.querySel‸\n</script>').includes('querySelector'));
  assert.ok(project.labels(PAGE, page('[1].ma‸', '')).includes('map'));
});

test('no question runs any of the project', (context) => {
  const marker = path.join(os.tmpdir(), `stacki-intel-ran-${process.pid}`);
  context.after(() => fs.rmSync(marker, { force: true }));
  const runs = `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");\nmodule.exports = () => ({});\n`;
  const project = site(context, {
    'astro.config.cjs': runs,
    'astro.config.mjs': `import fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(marker)}, "ran");\nexport default {};\n`,
    'tsconfig.json': '{"compilerOptions":{"plugins":[{"name":"evil-plugin"}]}}',
    '.prettierrc.js': runs,
    'tailwind.config.js': runs,
    'src/content.config.ts': `import fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(marker)}, "ran");\nexport const collections = {};\n`,
    'node_modules/evil-plugin/package.json': '{"name":"evil-plugin","main":"index.js"}',
    'node_modules/evil-plugin/index.js': runs,
    'node_modules/typescript/package.json': '{"name":"typescript","main":"lib/typescript.js"}',
    'node_modules/typescript/lib/typescript.js': runs,
    'node_modules/typescript/lib/tsserverlibrary.js': runs,
    'node_modules/@astrojs/compiler/package.json': '{"name":"@astrojs/compiler","main":"index.js"}',
    'node_modules/@astrojs/compiler/index.js': runs,
    'src/lib/side.ts': `import fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(marker)}, "ran");\nexport const side = 1;\n`,
    [PAGE]: '',
  });
  const text = page('import { side } from "../lib/side";\nconst total = side;', '<p>{total}</p>\n<Pa‸');
  for (const kind of ['complete', 'hover', 'signature', 'diagnostics'] as const) {
    project.ask(PAGE, text, kind);
  }
  project.items(PAGE, '<style>.a { color: var(--‸) }</style>');
  assert.equal(fs.existsSync(marker), false, 'the project ran');
});
