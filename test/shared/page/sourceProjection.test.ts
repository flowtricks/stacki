// Goal: the projection and snapshot contracts (plan §3.1, §3.6, §6). A page
// projects to byte spans with structural paths and a capability per node and
// attribute; invalid source is the `parse-error` variant, not an exception; a
// snapshot's checksum is computed from its own bytes and its projection must
// describe bytes of that length. Capabilities are a closed, exhaustive set.
// Method: project small pages written to hit each capability rule, then build
// snapshots with the real SHA-256 and break each precondition once.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { parsePage } from '#dist/electron/parse/astroParser.js';
import { parseMarkdownPage } from '#dist/electron/parse/markdownParser.js';
import { toDigest, toFilePath } from '#dist/shared/core/brand.js';
import {
  CAPABILITIES,
  capabilityAcceptsNodeRewrite,
  capabilityAcceptsVisualIntent,
  describeCapability,
  parseCapability,
} from '#dist/shared/page/capability.js';
import { LIMITS } from '#dist/shared/core/limits.js';
import { parsePageResult } from '#dist/shared/page/pageNode.js';
import { createSnapshot } from '#dist/shared/page/snapshot.js';
import { projectionAcceptsVisualIntents, projectOpaqueDocument, projectPage, type ProjectedNode } from '#dist/shared/page/sourceProjection.js';
import { encodeUtf8, type ByteString } from '#dist/shared/core/span.js';

const project = (text: string) => projectPage(text, parsePageResult(parsePage(text, { locs: true })));
const sha256 = (bytes: ByteString) => toDigest(createHash('sha256').update(bytes).digest('hex'));

function valid(text: string): readonly ProjectedNode[] {
  const projection = project(text);
  assert.equal(projection.tag, 'valid');
  return projection.tag === 'valid' ? projection.nodes : [];
}

test('capabilities are a closed set with a visual-edit answer and notice for each', () => {
  assert.deepEqual(CAPABILITIES, ['editable', 'read-only-opaque', 'repeated-source-node', 'runtime-aggregate', 'unsupported']);
  assert.deepEqual(CAPABILITIES.filter(capabilityAcceptsVisualIntent), ['editable', 'repeated-source-node']);
  assert.deepEqual(CAPABILITIES.filter(capabilityAcceptsNodeRewrite), ['editable', 'read-only-opaque', 'repeated-source-node']);
  assert.equal(new Set(CAPABILITIES.map(describeCapability)).size, CAPABILITIES.length);
  assert.equal(parseCapability('editable'), 'editable');
  assert.throws(() => parseCapability('writable'), /unknown value/);
});

test('each node is classified by plan §6: loops ' + 'repeat, code is opaque, the rest is editable', () => {
  const nodes = valid(
    [
      '---',
      'const items = [1];',
      '---',
      '<main class="page" {...rest}>',
      '  <p set:html={html}></p>',
      '  {items.map((item) => (<li>{item}</li>))}',
      '  {value}',
      '  <!-- note -->',
      '</main>',
      '<script>let a = 1;</script>',
      '<style>.page { color: red; }</style>',
    ].join('\n'),
  );
  const byPath = new Map(nodes.map((node) => [node.path.join('/'), node]));
  assert.equal(byPath.get('0')?.capability, 'editable');
  assert.deepEqual(
    byPath.get('0')?.attributes.map((attribute) => [attribute.name, attribute.capability]),
    [
      ['class', 'editable'],
      ['...rest', 'read-only-opaque'],
    ],
  );
  assert.equal(byPath.get('0/0')?.capability, 'read-only-opaque', 'set:html writes children at runtime');
  assert.equal(byPath.get('0/1')?.kind, 'map');
  assert.equal(byPath.get('0/1')?.capability, 'editable', 'the loop itself is the source node');
  assert.equal(byPath.get('0/1/0')?.capability, 'repeated-source-node');
  assert.equal(byPath.get('0/1/0/0')?.capability, 'repeated-source-node');
  assert.equal(byPath.get('0/2')?.capability, 'read-only-opaque');
  assert.equal(byPath.get('0/3')?.capability, 'editable');
  assert.equal(byPath.get('1')?.capability, 'read-only-opaque', 'a script is code kept verbatim');
  // Same-file styles (plan §6): the style panel restates a page's own rules.
  assert.equal(byPath.get('2')?.capability, 'editable', "a page's own <style> is editable");
});

test('a Fragment with set:html is markup and exposes the directive as an attribute', () => {
  const [fragment] = valid('<Fragment set:html={content} />\n');
  assert.equal(fragment?.capability, 'editable');
  assert.deepEqual(
    fragment?.attributes.map((attribute) => [attribute.name, attribute.capability]),
    [['set:html', 'editable']],
  );
});

test('spans are bytes: paths are preorder, and attribute parts are exact', () => {
  const text = '---\nconst a = "é";\n---\n<p title="Zoë 🎉" hidden>x</p>\n';
  const projection = project(text);
  assert.equal(projection.tag, 'valid');
  if (projection.tag !== 'valid') {
    return;
  }
  const bytes = Buffer.from(text, 'utf8');
  assert.equal(projection.byteLength, bytes.length);
  assert.deepEqual(projection.frontmatter, { start: 0, end: 24 });
  assert.equal(bytes.subarray(0, 24).toString(), '---\nconst a = "é";\n---\n');
  const [paragraph, child] = projection.nodes;
  assert.deepEqual(paragraph?.path, [0]);
  assert.deepEqual(child?.path, [0, 0]);
  const [title, hidden] = paragraph?.attributes ?? [];
  const slice = (span: { start: number; end: number } | undefined) => (span === undefined ? undefined : bytes.subarray(span.start, span.end).toString());
  assert.equal(slice(title?.valueSpan), 'Zoë 🎉');
  assert.equal(slice(title?.nameSpan), 'title');
  assert.equal(slice(hidden?.span), 'hidden');
  assert.equal(hidden?.valueSpan, undefined, 'a bare attribute has no value span');
});

test('a byte-order mark is inside the frontmatter span; its absence means no frontmatter', () => {
  const projection = project('﻿---\r\nconst a = 1;\r\n---\r\n<p>x</p>\r\n');
  assert.equal(projection.tag, 'valid');
  if (projection.tag === 'valid') {
    assert.deepEqual(projection.frontmatter, { start: 3, end: 27 });
  }
  const bare = project('<p>x</p>\n');
  assert.equal(bare.tag === 'valid' ? bare.frontmatter : 'missing', undefined);
});

test('invalid source is a parse-error projection that visual intents cannot target', () => {
  const projection = project('<div>\n  <span>unclosed\n</div>\n');
  assert.equal(projection.tag, 'parse-error');
  assert.equal(projectionAcceptsVisualIntents(projection), false);
  if (projection.tag === 'parse-error') {
    assert.equal(projection.diagnostics.length, 1);
    assert.match(projection.diagnostics[0]?.message ?? '', /unclosed <span>/);
  }
  assert.equal(projectionAcceptsVisualIntents(project('<p>x</p>')), true);
});

test('a Markdown page projects its blocks, items and text, and its JSX as markup', () => {
  const text = '---\ntitle: x\n---\n# Hi\n\n- one\n- two\n\n<Card title="a" />\n\n![alt](a.png)\n';
  const projection = projectPage(text, parsePageResult(parseMarkdownPage(text, { mdx: true })));
  assert.equal(projection.tag, 'valid');
  if (projection.tag !== 'valid') {
    return;
  }
  assert.deepEqual(projection.frontmatter, { start: 0, end: 17 });
  const shape = projection.nodes.map((node) => [node.path.join('/'), node.syntax, node.list]);
  assert.deepEqual(shape, [
    ['0', 'markdown', 'blocks'],
    ['0/0', 'markdown', 'inline'],
    ['1', 'markdown', 'blocks'],
    ['1/0', 'markdown', 'items'],
    ['1/0/0', 'markdown', 'blocks'],
    ['1/0/0/0', 'markdown', 'inline'],
    ['1/1', 'markdown', 'items'],
    ['1/1/0', 'markdown', 'blocks'],
    ['1/1/0/0', 'markdown', 'inline'],
    ['2', 'markup', 'blocks'],
    ['3', 'markdown', 'blocks'],
  ]);
  const attributes = (path: string) =>
    projection.nodes.find((node) => node.path.join('/') === path)?.attributes.map((attribute) => [attribute.name, attribute.type]);
  assert.deepEqual(attributes('2'), [['title', 'string']]);
  assert.deepEqual(attributes('3'), [
    ['alt', 'markdown'],
    ['src', 'markdown'],
  ]);
  assert.ok(projection.nodes.every((node) => node.capability === 'editable'));
});

test('an .astro page is markup throughout; a stylesheet is an opaque document', () => {
  assert.ok(valid('<ul><li>x</li></ul>').every((node) => node.syntax === 'markup'));
  assert.ok(valid('<ul><li>x</li></ul>').every((node) => node.list === 'markup'));
  const unlocated = parsePageResult(parsePage('<p>x</p>'));
  assert.throws(() => projectPage('<p>x</p>', unlocated), /recorded source offsets/);
  const css = projectOpaqueDocument('.card { color: red; }\n');
  const opaque = { tag: 'valid', byteLength: 22, utf16Length: 22, frontmatter: undefined };
  assert.deepEqual(css, { ...opaque, nodes: [] });
});

// Inside the byte bound but past the UTF-16 bound: 10 MB of ASCII. The parser
// refuses it, and the projection must too — as a parse error, not the offset
// converter's assertion (a crash before step 4 found it). One unit less passes.
test('a page past the UTF-16 bound projects as a parse error, not a crash', () => {
  const over = 'x'.repeat(LIMITS.ipcFieldCharsMax + 1);
  assert.ok(Buffer.byteLength(over) <= LIMITS.sourceBytesMax, 'The file fits the byte bound');
  const page = projectPage(over, parsePageResult(parsePage(over, { locs: true })));
  assert.equal(page.tag, 'parse-error');
  assert.equal(page.byteLength, LIMITS.ipcFieldCharsMax + 1);
  assert.match(page.tag === 'parse-error' ? (page.diagnostics[0]?.message ?? '') : '', /UTF-16/);
  assert.equal(projectOpaqueDocument(over).tag, 'parse-error');
  const at = over.slice(1);
  assert.equal(projectOpaqueDocument(at).tag, 'valid', 'Exactly at the bound is valid');
});

test('a snapshot computes its checksum from its bytes and matches its projection', () => {
  const text = '<p title="é">x</p>\n';
  const bytes = encodeUtf8(text);
  const path = toFilePath('/site/src/pages/index.astro');
  const snapshot = createSnapshot({ path, bytes, projection: project(text) }, sha256);
  assert.equal(snapshot.checksum, createHash('sha256').update(text, 'utf8').digest('hex'));
  assert.equal(snapshot.bytes, bytes);
  assert.deepEqual(Object.keys(snapshot).sort(), ['bytes', 'checksum', 'path', 'projection'], 'no version field');
  assert.throws(() => createSnapshot({ path, bytes: encodeUtf8(`${text} `), projection: project(text) }, sha256), /derived from bytes of this length/);
});
