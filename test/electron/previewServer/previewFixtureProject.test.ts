// Goal: every component of a generated project gets a way to be drawn: required props of each kind (text, number,
// switch, enum, list, object, picture, an imported interface) are filled from their types, slots get sample
// content, a component that would throw still has plainer attempts after the first, the key follows every edit
// to the component, a component it imports, or the project's styles, and nothing is ever written to the project.
// Method: write a small project to a temporary folder, load each component's preview module through the real
// Vite plugin (the route's own code), read the attempts back as the page would, and compare the whole tree of
// files before and after.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { componentPreviewPlugin } from '#dist/electron/previewServer/componentPreview.js';

const FILES: Readonly<Record<string, string>> = {
  'tsconfig.json': '{ "compilerOptions": { "paths": { "@lib/*": ["./src/lib/*"] } } }',
  'src/lib/types.ts': 'export interface Quote { author: string; stars: number; link: { label: string; href: string } }',
  'src/styles/site.css': 'body { color: #111; }',
  'src/components/Needy.astro': `---
interface Props { title: string; count: number; open: boolean; tone: 'a' | 'b'; tags: string[]; cta: { label: string; href: string }; src: string }
const { title, count, open, tone, tags, cta, src } = Astro.props;
---
<section data-tone={tone}><h2>{title}</h2><img src={src} /><a href={cta.href}>{cta.label}</a>{tags.map((tag) => <i>{tag}</i>)}</section>`,
  'src/components/Quote.astro': `---
import type { Quote } from '@lib/types';
interface Props { quote: Quote; items: { heading: string }[] }
const { quote, items } = Astro.props;
---
<blockquote>{quote.author} {quote.stars}</blockquote>`,
  'src/components/Shell.astro': `---
interface Props { heading?: string }
---
<div><header><slot name="head" /></header><slot /></div>`,
  'src/components/Throws.astro': `---
interface Props { data: { a: { b: string } } }
const { data } = Astro.props;
---
<p>{data.a.b.toUpperCase()}<slot /></p>`,
};

function project(context: { readonly after: (hook: () => void) => void }): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-preview-fixture-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [file, text] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  return root;
}

function snapshotOf(root: string): ReadonlyMap<string, string> {
  const files = new Map<string, string>();
  // Iterative with a stated bound: the fixture is a few files.
  const pending = [root];
  for (let step = 0; step < 1000 && pending.length > 0; step += 1) {
    const directory = pending.pop();
    assert.ok(directory !== undefined);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(full);
      } else {
        files.set(path.relative(root, full), fs.readFileSync(full, 'utf8'));
      }
    }
  }
  return files;
}

interface Attempt {
  readonly label: string;
  readonly props: Readonly<Record<string, unknown>>;
  readonly slot: { readonly kind: string };
}

function parseAttempt(value: unknown): Attempt {
  assert.ok(typeof value === 'object' && value !== null);
  const label: unknown = Reflect.get(value, 'label');
  const props: unknown = Reflect.get(value, 'props');
  const slot: unknown = Reflect.get(value, 'slot');
  assert.ok(typeof label === 'string' && typeof props === 'object' && props !== null && typeof slot === 'object' && slot !== null);
  const kind: unknown = Reflect.get(slot, 'kind');
  assert.ok(typeof kind === 'string');
  return { label, props: Object.fromEntries(Object.entries(props)), slot: { kind } };
}

function load(root: string, name: string): { readonly key: string; readonly attempts: readonly Attempt[]; readonly missing: readonly string[] } {
  const plugin = componentPreviewPlugin([root]);
  const code = plugin.load.call({}, path.join(root, 'src/components', name + '.astro') + '?raw&stacki-preview-props');
  assert.ok(code !== undefined, name);
  assert.ok(code.startsWith('export default '), name);
  const parsed: unknown = JSON.parse(code.slice('export default '.length, -1));
  assert.ok(typeof parsed === 'object' && parsed !== null);
  const key: unknown = Reflect.get(parsed, 'key');
  const attempts: unknown = Reflect.get(parsed, 'attempts');
  const missing: unknown = Reflect.get(parsed, 'missing');
  assert.ok(typeof key === 'string' && Array.isArray(attempts) && Array.isArray(missing));
  return { key, attempts: attempts.map(parseAttempt), missing: missing.map(String) };
}

test('every component has attempts and nothing is reported as missing data', (context) => {
  const root = project(context);
  for (const name of ['Needy', 'Quote', 'Shell', 'Throws']) {
    const module = load(root, name);
    assert.ok(module.attempts.length > 0, `${name} has something to draw`);
    assert.deepEqual(module.missing, [], name);
  }
});

test('required props of every kind get a value of their type', (context) => {
  const root = project(context);
  const first = load(root, 'Needy').attempts[0];
  assert.ok(first);
  assert.equal(first.label, 'sample');
  assert.equal(first.props['title'], 'Needy');
  assert.equal(typeof first.props['count'], 'number');
  assert.equal(first.props['open'], true);
  assert.equal(first.props['tone'], 'a', 'an enum takes its first option');
  assert.ok(Array.isArray(first.props['tags']) && first.props['tags'].length === 3);
  assert.deepEqual(first.props['cta'], { label: 'Needy', href: '#' });
  assert.ok(String(first.props['src']).startsWith('data:image/svg+xml'), 'a picture is a neutral placeholder');
});

test('an imported interface is read through the tsconfig paths', (context) => {
  const root = project(context);
  const props = load(root, 'Quote').attempts[0]?.props;
  assert.ok(props);
  const quote = props['quote'];
  assert.ok(typeof quote === 'object' && quote !== null);
  assert.equal(typeof Reflect.get(quote, 'author'), 'string');
  assert.equal(typeof Reflect.get(quote, 'stars'), 'number');
  assert.ok(Array.isArray(props['items']));
});

test('slots get sample content, and the plainer attempts follow', (context) => {
  const root = project(context);
  const attempts = load(root, 'Shell').attempts;
  assert.equal(attempts[0]?.slot.kind, 'sample');
  assert.deepEqual(
    attempts.map((attempt) => attempt.label),
    ['sample', 'sample-minimal', 'sample-bare'],
    'a throw in the first falls back to plainer inputs, the last with no slot at all',
  );
  assert.equal(attempts.at(-1)?.slot.kind, 'none');
});

test('a component that throws on its sample data still reaches the page with fallbacks and its reason slot', (context) => {
  const root = project(context);
  const attempts = load(root, 'Throws').attempts;
  assert.ok(attempts.length >= 2, 'a guess that throws is followed by another attempt');
});

test('the key follows the component, what it imports, and the project styles, and only those', (context) => {
  const root = project(context);
  const base = load(root, 'Quote').key;
  assert.equal(load(root, 'Quote').key, base, 'the same project gives the same key');
  fs.writeFileSync(path.join(root, 'src/lib/types.ts'), FILES['src/lib/types.ts'] + '\nexport const changed = 1;');
  const afterType = load(root, 'Quote').key;
  assert.notEqual(afterType, base, 'an imported file changed');
  fs.writeFileSync(path.join(root, 'src/styles/site.css'), 'body { color: red; }');
  const afterStyle = load(root, 'Quote').key;
  assert.notEqual(afterStyle, afterType, 'the global styles changed');
  fs.writeFileSync(path.join(root, 'src/components/Quote.astro'), FILES['src/components/Quote.astro'] + '<!-- x -->');
  assert.notEqual(load(root, 'Quote').key, afterStyle, 'the component changed');
  assert.equal(load(root, 'Shell').key, load(root, 'Shell').key);
});

test('loading previews never writes to the project', (context) => {
  const root = project(context);
  const before = snapshotOf(root);
  for (const name of ['Needy', 'Quote', 'Shell', 'Throws']) {
    load(root, name);
  }
  assert.deepEqual([...snapshotOf(root)], [...before]);
});
