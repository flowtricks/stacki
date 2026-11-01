// Goal: Markdown and MDX pages take visual edits as splices (plan §11 step
// 10). Each gesture the app makes on a Markdown page — text typed into a
// paragraph, a heading's level, an image's source or alt, a fence's language,
// a list item or a block added, removed or moved, the YAML frontmatter edited
// or created, a component's prop in MDX — reaches the file as the change it
// is, and nothing else: every expected file below is the input with exactly
// that change, written by hand. What Markdown cannot write (a class on a
// paragraph) is refused with the file untouched, not saved some other way.
// The reply's inverse restores the file; an edit authored before an outside
// change elsewhere is mapped through it.
// Method: the real main-process handlers in the windowless harness, on
// temporary files; requests are built from the renderer's own parse (the
// page:read reply), as the app builds them.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import type { Edit, NodeRef } from '#dist/shared/engine/editRequest.js';
import { parsePageNode, type PageModel, type PageNode } from '#dist/shared/page/pageNode.js';
import { parsePageDiskRead, parsePageEditResult, type PageDiskRead } from '#dist/shared/ipc/pageSave.js';
import { mainHarness } from '../../helpers/mainHarness.ts';

const sha256 = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
const GESTURE_ID = `g${'1'.repeat(32)}`;

const POST = [
  '---',
  'title: Post',
  '---',
  '# Title',
  '',
  'Some *text* here.',
  'Second line.',
  '',
  '- one',
  '- two',
  '',
  '> quote line',
  '> more',
  '',
  '```ts',
  'const x = 1;',
  '```',
  '',
  '![Alt](a.png)',
  '',
].join('\n');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-markdown-edit-'));
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

type Harness = ReturnType<typeof fixture>;

async function open(harness: Harness, name: string, text: string) {
  const file = path.join(harness.root, 'src/pages', name);
  fs.writeFileSync(file, text);
  const page = parsePageDiskRead(await harness.invoke('page:read', file));
  assert.ok(page.editable, `${name} opens in the visual editor`);
  return { file, page };
}

function nodeAt(read: PageDiskRead, at: readonly number[]): PageNode {
  assert.ok(read.editable, 'the page parses');
  let list: readonly PageNode[] = read.model.nodes;
  let node: PageNode | undefined;
  for (const step of at) {
    node = list[step];
    assert.ok(node !== undefined, `a node at ${at.join('/')}`);
    list = 'children' in node && Array.isArray(node.children) ? node.children : [];
  }
  assert.ok(node !== undefined, 'the path names a node');
  return node;
}

function refAt(read: PageDiskRead, at: readonly number[]): NodeRef {
  const node = nodeAt(read, at);
  assert.ok(node.start !== undefined && node.end !== undefined, 'the parse carries ranges');
  return { path: at, kind: node.kind, span: { start: node.start, end: node.end } };
}

async function send(harness: Harness, file: string, checksum: string, request: Edit) {
  return parsePageEditResult(
    await harness.invoke('page:edit', {
      pagePath: file,
      authoredChecksum: checksum,
      edit: request,
    }),
  );
}

/** Send `request` and require the file to become `expected`, exactly. */
async function applies(harness: Harness, opened: { readonly file: string; readonly page: PageDiskRead }, request: Edit, expected: string): Promise<void> {
  const reply = await send(harness, opened.file, opened.page.checksum, request);
  assert.ok(reply.ok, `${request.tag} applies: ${reply.ok ? '' : JSON.stringify(reply.error)}`);
  assert.equal(fs.readFileSync(opened.file, 'utf8'), expected, `${request.tag} writes its change`);
  assert.equal(reply.value.checksum, sha256(expected));
}

async function refused(harness: Harness, opened: { readonly file: string; readonly page: PageDiskRead }, request: Edit): Promise<string> {
  const before = fs.readFileSync(opened.file, 'utf8');
  const reply = await send(harness, opened.file, opened.page.checksum, request);
  assert.equal(fs.readFileSync(opened.file, 'utf8'), before, 'a refusal leaves the file');
  assert.ok(!reply.ok, `${request.tag} is refused`);
  return reply.error.code === 'rejected' ? reply.error.reason : reply.error.code;
}

// New nodes as the renderer sends them, through the wire parser.
function paragraph(value: string): PageNode {
  const text = { id: GESTURE_ID, kind: 'text', value };
  return parsePageNode({ id: GESTURE_ID, kind: 'element', name: 'p', children: [text] });
}

function item(value: string): PageNode {
  const inner = { id: GESTURE_ID, kind: 'element', name: 'p', children: [] };
  const node = parsePageNode({ id: GESTURE_ID, kind: 'element', name: 'li', children: [inner] });
  assert.ok(node.kind === 'element');
  return { ...node, children: [paragraph(value)] };
}

function withValue(node: PageNode, value: string): PageNode {
  assert.ok(node.kind === 'text', 'a text node');
  return { ...node, value };
}

test('typed text and a heading level change their own bytes', async (context) => {
  const harness = fixture();
  context.after(harness.dispose);
  const opened = await open(harness, 'post.md', POST);
  const typed = withValue(nodeAt(opened.page, [1, 0]), 'Some *text* there.\nSecond line.');
  const target = refAt(opened.page, [1, 0]);
  const expected = POST.replace('here.', 'there.');
  await applies(harness, opened, { tag: 'replace-node', target, node: typed }, expected);
  const again = await open(harness, 'post.md', POST);
  const level: Edit = { tag: 'rename-tag', target: refAt(again.page, [0]), to: 'h2' };
  await applies(harness, again, level, POST.replace('# Title', '## Title'));
  const para = await open(harness, 'post.md', POST);
  const heading: Edit = { tag: 'rename-tag', target: refAt(para.page, [1]), to: 'h3' };
  await applies(harness, para, heading, POST.replace('Some *text*', '### Some *text*'));
});

test('a line typed in a quote keeps the quote; an item gets its marker', async (context) => {
  const harness = fixture();
  context.after(harness.dispose);
  const opened = await open(harness, 'post.md', POST);
  const quoted = withValue(nodeAt(opened.page, [3, 0, 0]), 'quote line\nmore\nand more');
  const expected = POST.replace('> more\n', '> more\n> and more\n');
  const target = refAt(opened.page, [3, 0, 0]);
  await applies(harness, opened, { tag: 'replace-node', target, node: quoted }, expected);
  const list = await open(harness, 'post.md', POST);
  const added: Edit = {
    tag: 'insert-node',
    target: refAt(list.page, [2, 0]),
    placement: 'after',
    content: { tag: 'nodes', nodes: [item('one and a half')] },
  };
  await applies(harness, list, added, POST.replace('- one\n', '- one\n- one and a half\n'));
});

test('an image, a fence and a list write their attributes in Markdown', async (context) => {
  const harness = fixture();
  context.after(harness.dispose);
  const set = (target: NodeRef, name: string, value: string): Edit => ({
    tag: 'set-attribute',
    target,
    name,
    value: { type: 'string', value },
  });
  const cases: readonly (readonly [readonly number[], string, string, string])[] = [
    [[5], 'src', 'b.png', POST.replace('(a.png)', '(b.png)')],
    [[5], 'alt', 'New alt', POST.replace('![Alt]', '![New alt]')],
    [[5], 'title', 'T', POST.replace('(a.png)', '(a.png "T")')],
    [[4], 'lang', 'js', POST.replace('```ts', '```js')],
  ];
  for (const [at, name, value, expected] of cases) {
    const page = await open(harness, 'post.md', POST);
    await applies(harness, page, set(refAt(page.page, at), name, value), expected);
  }
  const ordered = '1. one\n2. two\n';
  let opened = await open(harness, 'list.md', ordered);
  await applies(harness, opened, set(refAt(opened.page, [0]), 'start', '4'), '4. one\n5. two\n');
  opened = await open(harness, 'post.md', POST);
  const reason = await refused(harness, opened, set(refAt(opened.page, [1]), 'class', 'lead'));
  assert.equal(reason, 'unsupported-operation', 'a paragraph has no class Markdown can write');
  const style: Edit = {
    tag: 'set-inline-style',
    target: refAt(opened.page, [1]),
    property: 'color',
    declaration: { tag: 'set', value: 'red' },
  };
  assert.equal(await refused(harness, opened, style), 'unsupported-operation');
});

test('blocks and items are added, removed and moved ' + 'as Markdown separates them', async (context) => {
  const harness = fixture();
  context.after(harness.dispose);
  let opened = await open(harness, 'post.md', POST);
  const intro: Edit = {
    tag: 'insert-node',
    target: refAt(opened.page, [0]),
    placement: 'after',
    content: { tag: 'nodes', nodes: [paragraph('Intro.')] },
  };
  await applies(harness, opened, intro, POST.replace('# Title\n', '# Title\n\nIntro.\n'));
  opened = await open(harness, 'post.md', POST);
  const remove = (read: PageDiskRead, at: readonly number[]): Edit => ({
    tag: 'remove-node',
    target: refAt(read, at),
  });
  await applies(harness, opened, remove(opened.page, [2, 1]), POST.replace('- two\n', ''));
  opened = await open(harness, 'post.md', POST);
  const withoutParagraph = POST.replace('Some *text* here.\nSecond line.\n\n', '');
  await applies(harness, opened, remove(opened.page, [1]), withoutParagraph);
  opened = await open(harness, 'post.md', POST);
  const swap: Edit = {
    tag: 'move-node',
    target: refAt(opened.page, [2, 1]),
    destination: refAt(opened.page, [2, 0]),
    placement: 'before',
  };
  await applies(harness, opened, swap, POST.replace('- one\n- two\n', '- two\n- one\n'));
  opened = await open(harness, 'post.md', POST);
  const quote: Edit = {
    tag: 'move-node',
    target: refAt(opened.page, [1]),
    destination: refAt(opened.page, [3]),
    placement: 'last-child',
  };
  const moved = POST.replace('Some *text* here.\nSecond line.\n\n', '').replace('> more\n', '> more\n>\n> Some *text* here.\n> Second line.\n');
  await applies(harness, opened, quote, moved);
  opened = await open(harness, 'only.md', '# A\n\n- only\n\nEnd.\n');
  await applies(harness, opened, remove(opened.page, [1, 0]), '# A\n\nEnd.\n');
});

test('the YAML frontmatter changes its slot, or is created at the top', async (context) => {
  const harness = fixture();
  context.after(harness.dispose);
  let opened = await open(harness, 'post.md', POST);
  const model = (read: PageDiskRead, yaml: string): PageModel => {
    assert.ok(read.editable);
    return { ...read.model, extraFrontmatter: yaml, nodes: [] };
  };
  const yaml = 'title: Post 2\nlayout: ../L.astro';
  const retitle: Edit = { tag: 'set-frontmatter', model: model(opened.page, yaml) };
  await applies(harness, opened, retitle, POST.replace('title: Post\n', `${yaml}\n`));
  opened = await open(harness, 'bare.md', '﻿# Bare\r\n');
  const create: Edit = { tag: 'set-frontmatter', model: model(opened.page, 'layout: ../L.astro') };
  await applies(harness, opened, create, '﻿---\r\nlayout: ../L.astro\r\n---\r\n# Bare\r\n');
});

test('a CRLF page stays CRLF; MDX props are markup; the inverse undoes', async (context) => {
  const harness = fixture();
  context.after(harness.dispose);
  const crlf = POST.replace(/\n/g, '\r\n');
  let opened = await open(harness, 'crlf.md', crlf);
  const typed = withValue(nodeAt(opened.page, [1, 0]), 'Some *text* here.\nSecond line.\nThird.');
  const reply = await send(harness, opened.file, opened.page.checksum, {
    tag: 'replace-node',
    target: refAt(opened.page, [1, 0]),
    node: typed,
  });
  assert.ok(reply.ok);
  const third = crlf.replace('Second line.\r\n', 'Second line.\r\nThird.\r\n');
  assert.equal(fs.readFileSync(opened.file, 'utf8'), third);
  const undone = await send(harness, opened.file, reply.value.checksum, {
    tag: 'revert',
    hunks: reply.value.inverse,
  });
  assert.ok(undone.ok, 'the inverse applies');
  assert.equal(fs.readFileSync(opened.file, 'utf8'), crlf, 'and restores every byte');
  const mdx = '# Hi\n\n<Callout type="info">\n  Body.\n</Callout>\n';
  opened = await open(harness, 'page.mdx', mdx);
  const prop: Edit = {
    tag: 'set-attribute',
    target: refAt(opened.page, [1]),
    name: 'type',
    value: { type: 'string', value: 'warning' },
  };
  await applies(harness, opened, prop, mdx.replace('"info"', '"warning"'));
});

test('an edit authored before an outside change elsewhere is mapped', async (context) => {
  const harness = fixture();
  context.after(harness.dispose);
  const opened = await open(harness, 'post.md', POST);
  const outside = POST.replace('const x = 1;', 'const x = 2;');
  fs.writeFileSync(opened.file, outside);
  const typed = withValue(nodeAt(opened.page, [1, 0]), 'Some *text* there.\nSecond line.');
  const reply = await send(harness, opened.file, opened.page.checksum, {
    tag: 'replace-node',
    target: refAt(opened.page, [1, 0]),
    node: typed,
  });
  assert.ok(reply.ok, 'mapped through the outside change');
  assert.equal(fs.readFileSync(opened.file, 'utf8'), outside.replace('here.', 'there.'));
});
