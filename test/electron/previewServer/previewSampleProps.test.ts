// Goal: required props of every declared kind get a value their type allows, and an imported type is
// resolved through the project's tsconfig paths so its shape can be sampled.
// Method: real prop models read from source text (readPropModel), sampled, then checked per kind (string,
// number, boolean, enum, list, object, image, unknown named type); the prelude is driven with a fake file map.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as path from 'node:path';
import { readPropModel } from '#dist/electron/parse/propModel/readPropModel.js';
import { sampleInputs, SAMPLE_IMAGE_URL } from '#dist/electron/previewServer/previewSampleProps.js';
import { previewTypePrelude, readPathAliases } from '#dist/electron/previewServer/previewTypePrelude.js';

const component = (props: string, body = '') => `---\ninterface Props {\n${props}\n}\nconst p = Astro.props;\n---\n<div>${body}</div>`;

test('required props of each kind receive a value of that kind', () => {
  const source = component(
    [
      '  title: string;',
      '  count: number;',
      '  open: boolean;',
      "  tone: 'a' | 'b';",
      '  tags: string[];',
      '  cta: { label: string; href: string };',
      '  items: { heading: string; n: number }[];',
      '  href: string;',
      '  src: string;',
      '  note?: string;',
    ].join('\n'),
  );
  const { props } = sampleInputs(readPropModel(source), 'Demo', 'required');
  assert.equal(props['title'], 'Demo');
  assert.equal(typeof props['count'], 'number');
  assert.equal(props['open'], true);
  assert.equal(props['tone'], 'a');
  assert.ok(Array.isArray(props['tags']));
  assert.equal(props['tags'].length, 3);
  assert.deepEqual(props['cta'], { label: 'Demo', href: '#' });
  assert.ok(Array.isArray(props['items']));
  assert.equal(props['items'].length, 3);
  assert.equal(props['href'], '#');
  assert.equal(props['src'], SAMPLE_IMAGE_URL);
  assert.equal('note' in props, false, 'an optional prop is left out of the required scope');
});

test('an author default stands and is not sampled', () => {
  const source = `---\ninterface Props { label?: string; size: number }\nconst { label = 'Go', size = 4 } = Astro.props;\n---\n<i />`;
  const { props } = sampleInputs(readPropModel(source), 'Demo', 'illustrative');
  assert.equal('label' in props, false);
  assert.equal('size' in props, false);
});

test('an unreadable named type falls back to a generic bag, a plural to a list of them', () => {
  const source = component('  card: Mystery;\n  cards: Mystery[];');
  const { props } = sampleInputs(readPropModel(source), 'Demo', 'required');
  assert.equal(typeof props['card'], 'object');
  assert.equal(Array.isArray(props['cards']), true);
});

test('an imported interface is resolved through tsconfig paths and sampled', () => {
  const root = path.resolve('/project');
  const files = new Map<string, string>([
    [path.join(root, 'tsconfig.json'), '{ // comment\n "compilerOptions": { "paths": { "@lib/*": ["./src/lib/*"], }, }, }'],
    [path.join(root, 'src/lib/cms/index.ts'), "export { type Quote } from './quote';"],
    [path.join(root, 'src/lib/cms/quote.ts'), 'export interface Quote { author: string; stars: number; link: { label: string; href: string } }'],
  ]);
  const io = { read: (file: string) => files.get(file) };
  const aliases = readPathAliases(root, io);
  assert.ok(aliases);
  const source = `---\nimport type { Quote } from '@lib/cms';\ninterface Props { quote: Quote }\nconst { quote } = Astro.props;\n---\n<p>{quote.author}</p>`;
  const prelude = previewTypePrelude(path.join(root, 'src/components/Q.astro'), source, aliases, io);
  assert.match(prelude, /interface Quote/);
  const { props } = sampleInputs(readPropModel(source, prelude), 'Q', 'required');
  const quote = props['quote'];
  assert.ok(typeof quote === 'object' && quote !== null);
  assert.equal(typeof Reflect.get(quote, 'author'), 'string');
  assert.equal(typeof Reflect.get(quote, 'stars'), 'number');
  assert.deepEqual(Reflect.get(quote, 'link'), { label: 'Q', href: '#' });
});

test('a missing file, a package and bad tsconfig are skipped, not thrown', () => {
  const io = { read: () => undefined };
  assert.equal(readPathAliases('/p', io), undefined);
  assert.equal(previewTypePrelude('/p/a.astro', "---\nimport type { X } from 'pkg';\nimport { Y } from './nope';\n---\n", undefined, io), '');
  assert.equal(readPathAliases('/p', { read: () => '{ nope' }), undefined);
});

test('a member of a picture group is a picture, and the same word elsewhere is a link', () => {
  const source = component('  image: { url: string; alt: string };\n  link: { url: string };');
  const { props } = sampleInputs(readPropModel(source), 'Demo', 'required');
  assert.deepEqual(props['image'], { url: SAMPLE_IMAGE_URL, alt: 'Sample image' });
  assert.deepEqual(props['link'], { url: '#' });
});
