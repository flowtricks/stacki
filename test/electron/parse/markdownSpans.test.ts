// Goal: span integrity for Markdown and MDX (plan §3.2, §11 step 10), the
// property every Markdown splice stands on. For every node of every Markdown
// fixture, slicing the file at the node's span gives the node as the printer
// writes it at that place — its container's prefix (`> `, an item's
// indentation) on every line after the first, the file's own line breaks —
// so an edit written as the difference between two prints lands on exactly
// the bytes it changes. Every attribute Markdown writes (an image's alt,
// source and title, a fence's language, a list's first number) slices to its
// value; markup inside MDX slices as the .astro parser's spans do. And the
// printer reproduces every fixture whole, byte for byte.
// Method: the real parser, its output through the wire parser (so the
// markdown attribute spans are validated too), then the projection — which
// says how each node is written and in which list it sits — and per node the
// printer run at the node's place. The committed fixtures must hold every
// property; a seeded generated corpus of a few hundred pages holds the
// structural ones everywhere and the print property on every page the printer
// reproduces whole (a lazy continuation line, for one, is read but printed
// with its prefix, so such a page is outside the printer's promise).
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { parseMarkdownPage, printMarkdownItem, printMarkdownNode, serializeMarkdownPage } from '#dist/electron/parse/markdownParser.js';
import { LIMITS } from '#dist/shared/core/limits.js';
import { markdownPrefix } from '#dist/shared/engine/markdownLayout.js';
import { parsePageResult, type PageModel, type PageNode } from '#dist/shared/page/pageNode.js';
import { projectPage, type ProjectedNode } from '#dist/shared/page/sourceProjection.js';
import { encodeUtf8, type ByteString } from '#dist/shared/core/span.js';
import { generatedMarkdown, type MarkdownDocument } from '../../helpers/markdownCorpus.ts';

const DIRECTORIES = ['test/fixtures/round-trip', 'test/fixtures/editor-core', 'test/corpus'];

function fixtures(): readonly MarkdownDocument[] {
  return DIRECTORIES.flatMap((directory) =>
    fs
      .readdirSync(directory)
      .filter((name) => /\.mdx?$/.test(name) && name !== 'README.md')
      .sort()
      .map((name) => ({
        name: `${directory}/${name}`,
        mdx: name.endsWith('.mdx'),
        text: fs.readFileSync(path.join(directory, name), 'utf8'),
      })),
  );
}

interface Located {
  readonly node: PageNode;
  readonly parent: { readonly node: PageNode; readonly projected: ProjectedNode } | undefined;
  readonly index: number;
  readonly projected: ProjectedNode;
}

interface Counts {
  readonly nodes: number;
  readonly printed: number;
  readonly attributes: number;
}

function parsed(document: MarkdownDocument): { model: PageModel; located: readonly Located[] } {
  const raw = parseMarkdownPage(document.text, { mdx: document.mdx });
  assert.ok(raw.editable, `${document.name} parses`);
  const result = parsePageResult(raw);
  assert.ok(result.editable);
  const projection = projectPage(document.text, result);
  assert.equal(projection.tag, 'valid', `${document.name} projects`);
  const byPath = new Map(projection.tag === 'valid' ? projection.nodes.map((node) => [node.path.join('/'), node]) : []);
  const located: Located[] = [];
  type Parent = Located['parent'];
  const walk = (nodes: readonly PageNode[], parent: Parent, prefix: readonly number[]) => {
    const depth = prefix.length;
    assert.ok(depth <= LIMITS.treeDepthMax, `${document.name}: tree depth limit`);
    nodes.forEach((node, index) => {
      const at = [...prefix, index];
      const projected = byPath.get(at.join('/'));
      assert.ok(projected !== undefined, `${document.name}: node ${at.join('/')} is projected`);
      located.push({ node, parent, index, projected });
      walk('children' in node ? (node.children ?? []) : [], { node, projected }, at);
    });
  };
  walk(result.model.nodes, undefined, []);
  assert.equal(located.length, byPath.size, `${document.name}: one projected node per node`);
  return { model: result.model, located };
}

// The node printed at its place: an item after its list's marker, every other
// Markdown node as the printer writes it, each with the prefix its first
// line's containers give it.
function printedAt(bytes: ByteString, model: PageModel, entry: Located): string {
  const eol = model.mdEol ?? '\n';
  const { node, parent, projected } = entry;
  if (projected.list === 'items') {
    assert.ok(parent !== undefined, 'An item has its list');
    const list = parent.node;
    assert.ok(list.kind === 'element', 'A list is an element');
    const ordered = list.name === 'ol';
    const first = attributeValue(list, 'start');
    const start = first === undefined ? 1 : Number(first);
    const number = ordered ? (list.mdNumbers?.[entry.index] ?? start + entry.index) : undefined;
    const marker = list.mdMarker ?? (ordered ? '.' : '-');
    // An item's lines after its first are its list's: the list's first line
    // gives their prefix, and the item adds its own indentation.
    const prefix = markdownPrefix(bytes, parent.projected.span.start);
    assert.ok(prefix !== undefined, 'A list starts after container syntax alone');
    const indent = list.mdIndent ?? '';
    return printMarkdownItem(node, { marker, number, indent }, { prefix, eol });
  }
  // Inline text shares its block's lines (a heading's text starts after `# `).
  const lineStart = projected.list === 'inline' ? parent?.projected.span.start : projected.span.start;
  assert.ok(lineStart !== undefined, 'Inline text has its block');
  const prefix = markdownPrefix(bytes, lineStart);
  assert.ok(prefix !== undefined, 'A Markdown block starts after container syntax alone');
  return printMarkdownNode(node, { prefix, eol });
}

function attributeValue(node: PageNode, name: string): string | undefined {
  const attr = 'props' in node ? node.props?.[name] : undefined;
  return attr !== undefined && 'value' in attr ? attr.value : undefined;
}

// Markup inside MDX: tags open with their name and close with `>`, text holds
// its words. Its lines after the first carry the prefix of the Markdown
// container the block stands in, which the markup parser never saw.
function checkMarkup(slice: string, node: PageNode, where: string, prefix: string): void {
  const collapse = (text: string) =>
    text
      .split(/\r?\n/)
      .map((line, index) => (index > 0 ? unprefixed(line, prefix) : line))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  switch (node.kind) {
    case 'element':
    case 'component':
      assert.ok(slice.startsWith(`<${node.name}`), `${where}: opens`);
      assert.ok(slice.endsWith('>'), `${where}: closes`);
      return;
    case 'text':
      assert.equal(collapse(slice), collapse(node.value), `${where}: text`);
      return;
    case 'expr':
      assert.ok(slice === node.value || `{${slice}}` === node.value, `${where}: expression`);
      return;
    case 'comment':
      assert.ok(slice.includes(node.value), `${where}: comment`);
      return;
    case 'map':
    case 'raw':
    case 'raw-line':
    case 'cond':
    case 'branch':
    case 'chunk-group':
      assert.ok(slice.length > 0, `${where}: covers its bytes`);
      return;
    default: {
      const exhaustive: never = node;
      throw new Error(`Unknown node ${JSON.stringify(exhaustive)}`);
    }
  }
}

function unprefixed(line: string, prefix: string): string {
  if (line.startsWith(prefix)) {
    return line.slice(prefix.length);
  }
  const blank = prefix.trimEnd();
  return line.startsWith(blank) ? line.slice(blank.length) : line;
}

// How much of a document is checked: every node's slice and its printed place, or only the
// slices when the printer does not reproduce the page byte for byte.
type CheckScope = 'printed' | 'slices';

function addCounts(total: Counts, more: Counts): Counts {
  return {
    nodes: total.nodes + more.nodes,
    printed: total.printed + more.printed,
    attributes: total.attributes + more.attributes,
  };
}

function checkDocument(document: MarkdownDocument, scope: CheckScope): Counts {
  const exact = scope === 'printed';
  let nodes = 0;
  let printed = 0;
  let attributes = 0;
  const { model, located } = parsed(document);
  const bytes = encodeUtf8(document.text);
  for (const entry of located) {
    const { node, projected } = entry;
    const where = `${document.name} ${projected.path.join('/')} (${node.kind})`;
    const slice = Buffer.from(bytes.subarray(projected.span.start, projected.span.end)).toString();
    const located16 = document.text.slice(node.start, node.end);
    assert.equal(slice, located16, `${where}: byte and UTF-16 spans`);
    nodes += 1;
    if (projected.syntax === 'markdown') {
      if (exact) {
        assert.equal(printedAt(bytes, model, entry), slice, `${where}: printed at its place`);
        printed += 1;
      }
    } else if (exact) {
      checkMarkup(slice, node, where, markupPrefix(bytes, located, entry));
    }
    for (const attribute of projected.attributes) {
      const value = Buffer.from(bytes.subarray(attribute.valueSpan?.start ?? 0, attribute.valueSpan?.end ?? 0)).toString();
      if (attribute.type === 'markdown') {
        assert.equal(value, attributeValue(node, attribute.name), `${where}: ${attribute.name}`);
        attributes += 1;
      }
    }
  }
  return { nodes, printed, attributes };
}

// The prefix of the Markdown container a markup node's block stands in: read
// at the block, the outermost markup ancestor.
function markupPrefix(bytes: ByteString, located: readonly Located[], entry: Located): string {
  const path = entry.projected.path;
  const root = located.find(
    (candidate) => candidate.projected.syntax === 'markup' && candidate.projected.list !== 'markup' && startsWithPath(path, candidate.projected.path),
  );
  assert.ok(root !== undefined, 'Markup in Markdown stands in a block');
  return markdownPrefix(bytes, root.projected.span.start) ?? '';
}

function startsWithPath(path: readonly number[], prefix: readonly number[]): boolean {
  return prefix.every((step, index) => path[index] === step);
}

function printedWhole(document: MarkdownDocument): boolean {
  const raw = parseMarkdownPage(document.text, { mdx: document.mdx });
  assert.ok(raw.editable);
  return serializeMarkdownPage(raw.model) === document.text.replace(/^﻿/, '');
}

test('every Markdown fixture prints back byte for byte', () => {
  const files = fixtures();
  assert.ok(files.length >= 7, `Markdown fixtures: ${files.length}`);
  for (const document of files) {
    assert.ok(printedWhole(document), `${document.name} round-trips`);
  }
});

test('every node of every Markdown fixture slices to itself as printed at its place', () => {
  let counts: Counts = { nodes: 0, printed: 0, attributes: 0 };
  for (const document of fixtures()) {
    counts = addCounts(counts, checkDocument(document, 'printed'));
  }
  // Floors, so a parser change that silently stopped locating nodes fails here.
  assert.ok(counts.nodes >= 230, `nodes checked: ${counts.nodes}`);
  assert.ok(counts.printed >= 220, `printed checks: ${counts.printed}`);
  assert.ok(counts.attributes >= 15, `Markdown attributes checked: ${counts.attributes}`);
});

test('a seeded corpus keeps span integrity wherever the printer reproduces the page', () => {
  let counts: Counts = { nodes: 0, printed: 0, attributes: 0 };
  let exact = 0;
  const documents = generatedMarkdown(10, 600);
  for (const document of documents) {
    const whole = printedWhole(document);
    exact += whole ? 1 : 0;
    counts = addCounts(counts, checkDocument(document, whole ? 'printed' : 'slices'));
  }
  assert.ok(exact >= 300, `pages printed exactly: ${exact} of ${documents.length}`);
  assert.ok(counts.printed >= 1_700, `printed checks: ${counts.printed}`);
  assert.ok(counts.attributes >= 200, `Markdown attributes checked: ${counts.attributes}`);
});
