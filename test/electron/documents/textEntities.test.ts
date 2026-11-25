// Goal: a text run that spells characters as entities (`&copy; {year}`) can be
// edited. The Content field restates the text node by its characters ("© "),
// the file spells them its own way (`&copy; `), and the edit must land on the
// file's bytes without rewriting the entities it did not touch. Before this, any
// footer line that started with a copyright sign refused the edit as an editor
// error (found by sweeping real Astro sites through the page handlers).
// Method: the pure placement (`entityTextHunks`) is checked on known-good runs,
// each one applied and read back through the parser's own text rule, and on the
// shapes it must decline (no entity, a value that is not the run's characters,
// a stray ampersand, no change); then the real `page:edit` handler is driven on
// pages written to a temporary project, with the bytes compared exactly.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { mainHarness } from '../../helpers/mainHarness.ts';
import { entityTextHunks } from '#dist/electron/documents/textEntities.js';
import { textValue } from '#dist/shared/page/htmlText.js';
import { parsePageDiskRead, parsePageEditResult } from '#dist/shared/ipc/pageSave.js';
import type { PageNode } from '#dist/shared/page/pageNode.js';
import { LIMITS } from '#dist/shared/core/limits.js';

/** The bytes after the hunks are applied to the run, largest offset first so earlier ones stay valid. */
function applied(raw: string, hunks: readonly { readonly span: { readonly start: number; readonly end: number }; readonly text: string }[]): string {
  const bytes = Buffer.from(raw, 'utf8');
  let out = bytes;
  for (const hunk of [...hunks].sort((left, right) => right.span.start - left.span.start)) {
    out = Buffer.concat([out.subarray(0, hunk.span.start), Buffer.from(hunk.text, 'utf8'), out.subarray(hunk.span.end)]);
  }
  return out.toString('utf8');
}

function placed(raw: string, previous: string, next: string): string {
  assert.equal(textValue(raw), previous, 'the case states the run as the parser reads it');
  const result = entityTextHunks(raw, previous, next);
  assert.ok(result !== undefined, `the run is placed: ${JSON.stringify(raw)}`);
  assert.ok(result.ok, 'the change has a place');
  const written = applied(raw, result.value);
  assert.equal(textValue(written), next, 'the written run reads back as the characters typed');
  return written;
}

test('typing after an entity leaves the entity as the file spells it', () => {
  assert.equal(placed('&copy; ', '© ', '© Blog'), '&copy; Blog');
  assert.equal(placed('&copy; 2024 Foo', '© 2024 Foo', '© 2025 Foo'), '&copy; 2025 Foo');
  assert.equal(placed('Tom &amp; Jerry', 'Tom & Jerry', 'Tom & Jerry and friends'), 'Tom &amp; Jerry and friends');
});

test('an entity the edit does not touch keeps its spelling, however many there are', () => {
  assert.equal(placed('&nbsp;a&amp;b', ' a&b', ' a&b!'), '&nbsp;a&amp;b!');
  assert.equal(placed('&middot; one &middot; two', '· one · two', '· one · three'), '&middot; one &middot; three');
});

test('an edit that reaches into an entity writes the characters it needs and keeps the rest', () => {
  assert.equal(placed('&copy; x', '© x', 'c x'), 'c x');
  assert.equal(placed('a&mdash;b', 'a—b', 'a—bc'), 'a&mdash;bc');
  assert.equal(placed('Tom &amp; Jerry', 'Tom & Jerry', 'Tom + Jerry'), 'Tom + Jerry');
});

test('the whitespace the parser squeezes is one unit, so a line break and indent are never cut', () => {
  assert.equal(placed('\n    &copy; ', ' © ', ' © Blog'), '\n    &copy; Blog');
  assert.equal(placed('&copy;\n    2024', '© 2024', '© 2025'), '&copy;\n    2025');
});

test('typed characters that are markup are written as entities', () => {
  assert.equal(placed('&copy; a', '© a', '© a < b & {c}'), '&copy; a &lt; b &amp; &#123;c&#125;');
});

test('the placement declines what is not its to place', () => {
  assert.equal(entityTextHunks('plain words', 'plain words', 'plain words!'), undefined, 'no ampersand at all');
  assert.equal(entityTextHunks('a & b', 'a & b', 'a & bc'), undefined, 'a stray ampersand is not an entity');
  assert.equal(entityTextHunks('&unknownname; x', '&unknownname; x', '&unknownname; xy'), undefined, 'a name the decoder does not know is plain text');
  assert.equal(entityTextHunks('&copy; x', 'not the characters', 'other'), undefined, 'the node is not what the bytes say');
  const unchanged = entityTextHunks('&copy; x', '© x', '© x');
  assert.ok(unchanged !== undefined && !unchanged.ok, 'a gesture with no change has nothing to write');
});

// --- Through the real handlers ---------------------------------------------------------

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-text-entities-'));
  fs.mkdirSync(path.join(root, 'src/pages'), { recursive: true });
  fs.mkdirSync(path.join(root, 'user'));
  fs.writeFileSync(path.join(root, 'package.json'), '{"dependencies":{"astro":"*"}}');
  const harness = mainHarness(path.join(root, 'user'));
  return {
    root,
    ...harness,
    dispose: () => {
      harness.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

const harness = fixture();
test.after(() => harness.dispose());

/** The first text node whose words mention `needle`, with its path. */
function findText(nodes: readonly PageNode[], needle: string): { readonly path: readonly number[]; readonly node: PageNode } | undefined {
  const pending: { readonly path: readonly number[]; readonly node: PageNode }[] = nodes.map((node, index) => ({ path: [index], node }));
  for (let visited = 0; visited < pending.length; visited++) {
    assert.ok(visited < LIMITS.treeNodesMax, 'the search stays inside the tree bound');
    const entry = pending[visited];
    assert.ok(entry !== undefined, 'the search visits an existing node');
    if (entry.node.kind === 'text' && entry.node.value.includes(needle)) {
      return entry;
    }
    if ('children' in entry.node && Array.isArray(entry.node.children)) {
      pending.push(...entry.node.children.map((node: PageNode, index: number) => ({ path: [...entry.path, index], node })));
    }
  }
  return undefined;
}

let pageCount = 0;

/** Restates the text node holding `needle` with `value`, as the Content field does, and returns the page's bytes. */
async function retype(text: string, needle: string, value: (current: string) => string): Promise<string> {
  pageCount += 1;
  const file = path.join(harness.root, `src/pages/page${pageCount}.astro`);
  fs.writeFileSync(file, text);
  const before = parsePageDiskRead(await harness.invoke('page:read', file));
  assert.ok(before.editable, 'the page parses');
  const found = findText(before.model.nodes, needle);
  assert.ok(found !== undefined && found.node.kind === 'text', 'the page has the text');
  assert.ok(found.node.start !== undefined && found.node.end !== undefined, 'the parse carries source ranges');
  const result = parsePageEditResult(
    await harness.invoke('page:edit', {
      pagePath: file,
      authoredChecksum: before.checksum,
      edit: {
        tag: 'replace-node',
        target: { path: found.path, kind: 'text', span: { start: found.node.start, end: found.node.end } },
        node: { ...found.node, value: value(found.node.value) },
      },
    }),
  );
  assert.ok(result.ok, `the edit applies: ${JSON.stringify(result)}`);
  return fs.readFileSync(file, 'utf8');
}

test('the Content field edits a footer line that starts with a copyright entity', async () => {
  const page = '<footer>\n  <span>\n    &copy; {new Date().getFullYear()} Your Blog.\n  </span>\n</footer>\n';
  const written = await retype(page, '©', (current) => `${current}Acme `);
  assert.equal(written, '<footer>\n  <span>\n    &copy; Acme {new Date().getFullYear()} Your Blog.\n  </span>\n</footer>\n');
});

test('an entity run on one line takes the typed words and nothing else changes', async () => {
  const page = '<p>{a} &middot; {b}</p>\n';
  const written = await retype(page, '·', () => ' · and ');
  assert.equal(written, '<p>{a} &middot; and {b}</p>\n');
});
