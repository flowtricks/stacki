// Goal: span integrity (plan §3.2), the property splices stand on. For every
// node and every attribute of every corpus, round-trip, hostile and large
// fixture, slicing the source at the reported span reproduces the reported
// text; children sit inside their parent in order; and the projection's byte
// spans slice the UTF-8 bytes to the same text the UTF-16 spans slice from the
// string. The large fixtures are also rebuilt in memory and must match the
// committed manifest byte for byte (the generator is deterministic).
// Method: the real parser with offsets on, its output passed through the wire
// parser (so the attrSpans contract is exercised too), then checked per kind.
// Each attribute's whole span is re-parsed on its own and must yield exactly
// that attribute — the strongest statement that the span is the attribute.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { parseAttrs, parsePage } from '#dist/electron/parse/astroParser.js';
import { LIMITS } from '#dist/shared/core/limits.js';
import { parsePageResult, type PageNode } from '#dist/shared/page/pageNode.js';
import type { ParserNode } from '#dist/electron/parse/astroParserTypes.js';
import { projectPage } from '#dist/shared/page/sourceProjection.js';
import { generateLargeFixtures, manifestEntry, parserNodeCounter } from '#dist/scripts/reports/largeFixtures.js';

const DIRECTORIES = ['test/corpus', 'test/fixtures/round-trip', 'test/fixtures/editor-core'];
const collapse = (text: string) => text.replace(/\s+/g, ' ').trim();
const counter = parserNodeCounter((text) => parsePage(text));

function corpusFiles(): readonly { name: string; text: string }[] {
  return DIRECTORIES.flatMap((directory) =>
    fs
      .readdirSync(directory)
      .filter((name) => name.endsWith('.astro'))
      .sort()
      .map((name) => ({
        name: `${directory}/${name}`,
        text: fs.readFileSync(path.join(directory, name), 'utf8'),
      })),
  );
}

function largeFixtures() {
  const corpus = new Map(
    fs
      .readdirSync('test/corpus')
      .filter((name) => name.endsWith('.astro'))
      .map((name) => [name, fs.readFileSync(path.join('test/corpus', name), 'utf8')] as const),
  );
  return generateLargeFixtures(LIMITS, corpus, counter);
}

/** Checks one located node against the text its span slices; returns the
 * number of attribute spans checked. */
function checkNode(text: string, node: ParserNode, where: string): number {
  assert.ok(node.start !== undefined, `${where}: ${node.kind} has a start`);
  assert.ok(node.end !== undefined, `${where}: ${node.kind} has an end`);
  assert.ok(node.end <= text.length, `${where}: span inside the file`);
  const slice = text.slice(node.start, node.end);
  switch (node.kind) {
    case 'component':
    case 'element':
      assert.ok(slice.startsWith(node.shorthand === true ? '<>' : `<${node.name}`), `${where}: opens`);
      assert.ok(slice.endsWith('>'), `${where}: closes`);
      break;
    case 'raw':
      assert.ok(slice.startsWith(`<${node.name}`), `${where}: raw opens`);
      assert.ok(slice.includes(node.inner), `${where}: raw inner is verbatim`);
      break;
    case 'text':
      if (node.source === undefined) {
        assert.equal(collapse(slice), collapse(node.value), `${where}: text`);
      } else {
        assert.equal(slice, node.source, `${where}: text source`);
      }
      break;
    case 'expr':
      assert.ok(slice === node.value || `{${slice}}` === node.value, `${where}: expression`);
      break;
    case 'raw-line':
      assert.equal(slice, node.value, `${where}: raw line`);
      break;
    case 'comment':
      assert.ok(slice.includes(node.value), `${where}: comment body`);
      assert.match(slice, node.jsx === true ? /^\{\s*\/\*[\s\S]*\*\/\s*\}$/ : /^<!--[\s\S]*-->$/);
      break;
    case 'map':
    case 'cond':
      if (node.source !== undefined) {
        assert.equal(slice, node.source, `${where}: ${node.kind} source`);
      } else {
        assert.ok(node.kind === 'cond' && slice.startsWith(node.test), `${where}: nested condition`);
      }
      break;
    case 'branch':
    case 'chunk-group':
      break;
  }
  return checkAttributes(text, node, where);
}

function checkAttributes(text: string, node: ParserNode, where: string): number {
  const spans = node.attrSpans ?? [];
  for (const entry of spans) {
    const whole = text.slice(entry.span.start, entry.span.end);
    const reparsed = Object.entries(parseAttrs(whole));
    assert.equal(reparsed.length, 1, `${where}: ${entry.name} span holds one attribute`);
    const [name, attr] = reparsed[0] ?? [];
    assert.equal(name, entry.name, `${where}: ${entry.name} span re-parses to its name`);
    assert.equal(attr?.type, entry.type, `${where}: ${entry.name} keeps its type`);
    if ('nameSpan' in entry) {
      assert.equal(text.slice(entry.nameSpan.start, entry.nameSpan.end), entry.name, `${where}: name span`);
    }
    if ('valueSpan' in entry) {
      const value = attr !== undefined && 'value' in attr ? attr.value : undefined;
      assert.equal(text.slice(entry.valueSpan.start, entry.valueSpan.end), value, `${where}: value span`);
    }
  }
  return spans.length;
}

/** Walk one file; returns [nodes, attributes] checked. */
function checkFile(name: string, text: string): readonly [number, number] {
  const raw = parsePage(text, { locs: true });
  if (!raw.editable) {
    return [0, 0];
  }
  // The wire parser validates the spans (and attrSpans against props); the
  // per-kind checks read the producer's own nodes, which keep text and
  // condition `source` that the wire model does not carry.
  const parsed = parsePageResult(raw);
  const pending = raw.model.nodes.map((node, index) => ({ node, where: `${name}[${index}]` }));
  let nodes = 0;
  let attributes = 0;
  while (pending.length > 0) {
    const entry = pending.pop();
    assert.ok(entry !== undefined);
    nodes += 1;
    attributes += checkNode(text, entry.node, entry.where);
    const children = entry.node.children ?? [];
    children.forEach((child, index) => pending.push({ node: child, where: `${entry.where}/${index}` }));
  }
  checkBytes(text, parsed);
  return [nodes, attributes];
}

// The projection's byte spans must slice the UTF-8 bytes to exactly what the
// UTF-16 spans slice from the string — the conversion, checked end to end.
function checkBytes(text: string, parsed: ReturnType<typeof parsePageResult>): void {
  const projection = projectPage(text, parsed);
  assert.equal(projection.tag, 'valid');
  if (projection.tag !== 'valid') {
    return;
  }
  const bytes = Buffer.from(text, 'utf8');
  assert.equal(projection.byteLength, bytes.length);
  const located = new Map<string, string>();
  const walk = (nodes: readonly PageNode[], prefix: readonly number[]) => {
    const depth = prefix.length;
    assert.ok(depth <= LIMITS.treeDepthMax, 'walk: tree depth limit');
    nodes.forEach((node, index) => {
      const path = [...prefix, index];
      located.set(path.join('/'), text.slice(node.start, node.end));
      if ('children' in node) {
        walk(node.children ?? [], path);
      }
    });
  };
  walk(parsed.editable ? parsed.model.nodes : [], []);
  for (const node of projection.nodes) {
    const sliced = bytes.subarray(node.span.start, node.span.end).toString('utf8');
    assert.equal(sliced, located.get(node.path.join('/')), `byte span at ${node.path.join('/')}`);
    for (const attribute of node.attributes) {
      const whole = bytes.subarray(attribute.span.start, attribute.span.end).toString('utf8');
      assert.equal(Object.keys(parseAttrs(whole))[0], attribute.name, 'attribute byte span');
    }
  }
}

test('every node and attribute span of every corpus file reproduces its text', () => {
  let nodes = 0;
  let attributes = 0;
  const files = corpusFiles();
  for (const file of files) {
    const [fileNodes, fileAttributes] = checkFile(file.name, file.text);
    nodes += fileNodes;
    attributes += fileAttributes;
  }
  // Floors, so a parser change that silently stopped locating nodes fails here.
  assert.ok(files.length >= 50, `corpus files: ${files.length}`);
  assert.ok(nodes >= 350, `nodes checked: ${nodes}`);
  assert.ok(attributes >= 152, `attribute spans checked: ${attributes}`);
});

test('the large fixtures are deterministic, match the manifest, and keep span integrity', () => {
  const manifest: unknown = JSON.parse(fs.readFileSync('test/fixtures/large/manifest.json', 'utf8'));
  const fixtures = largeFixtures();
  const entries = fixtures.map((fixture) => manifestEntry(fixture, LIMITS, counter));
  assert.deepEqual(entries, manifest, 'regenerate with `npm run fixtures:large` after a corpus change');
  for (const entry of entries) {
    assert.ok(entry.bytes <= LIMITS.sourceBytesMax, `${entry.name} fits the file bound`);
    assert.ok(entry.nodes <= LIMITS.treeNodesMax, `${entry.name} fits the node bound`);
    const measured = entry.axis === 'bytes' ? entry.bytes : entry.nodes;
    assert.ok(measured >= Math.floor(entry.target * 0.97), `${entry.name} is about ${entry.percent} %`);
  }
  for (const fixture of fixtures) {
    const [nodes] = checkFile(fixture.name, fixture.text);
    assert.ok(nodes > 0, `${fixture.name} parses and is located`);
  }
});
