// Goal: the main-process edit handler refuses a structural edit that would break the page: a
// doctype moved or inserted inside a component, a list item moved out of its list, a block put
// in a paragraph. The refusal is a typed Result (`rejected`, reason `invalid-placement`), never a
// crash, and the file's bytes on disk are exactly what they were. The same edits in a valid place
// still apply, so the guard is not a blanket refusal.
// Method: a generated page in a temporary project, read and edited through the real `page:read`
// and `page:edit` handlers in the windowless harness (as the renderer sends them); the bytes on
// disk are read back after each refused edit and compared with the bytes before.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { mainHarness } from '../../helpers/mainHarness.ts';
import type { NodeRef } from '#dist/shared/engine/editRequest.js';
import { parsePageDiskRead, parsePageEditResult, type PageDiskRead } from '#dist/shared/ipc/pageSave.js';
import type { PageNode } from '#dist/shared/page/pageNode.js';
import { LIMITS } from '#dist/shared/core/limits.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-invalid-placement-'));
fs.mkdirSync(path.join(root, 'src/pages'), { recursive: true });
fs.mkdirSync(path.join(root, 'user'));
fs.writeFileSync(path.join(root, 'package.json'), '{"dependencies":{"astro":"*"}}');
const harness = mainHarness(path.join(root, 'user'));
test.after(() => {
  harness.dispose();
  fs.rmSync(root, { recursive: true, force: true });
});

const PAGE = ['<!doctype html>', '<Layout>', '  <main>', '    <p>Hello</p>', '    <ul><li>one</li></ul>', '  </main>', '</Layout>', ''].join('\n');
let pages = 0;

function page(text: string): string {
  pages += 1;
  const file = path.join(root, `src/pages/page${pages}.astro`);
  fs.writeFileSync(file, text);
  return file;
}

async function read(file: string): Promise<PageDiskRead> {
  return parsePageDiskRead(await harness.invoke('page:read', file));
}

function nodeAt(opened: PageDiskRead, at: readonly number[]): PageNode {
  assert.ok(opened.editable, 'the page parses');
  let list: readonly PageNode[] = opened.model.nodes;
  let node: PageNode | undefined;
  for (const step of at) {
    node = list[step];
    assert.ok(node !== undefined, `a node at ${at.join('/')}`);
    list = 'children' in node && Array.isArray(node.children) ? node.children : [];
  }
  assert.ok(node !== undefined, 'the path names a node');
  return node;
}

function refAt(opened: PageDiskRead, at: readonly number[]): NodeRef {
  const node = nodeAt(opened, at);
  assert.ok(node.start !== undefined && node.end !== undefined, 'the parse carries spans');
  return { path: at, kind: node.kind, span: { start: node.start, end: node.end } };
}

async function send(file: string, edit: Record<string, unknown>) {
  const opened = await read(file);
  assert.ok(opened.editable, 'the page parses');
  return parsePageEditResult(await harness.invoke('page:edit', { pagePath: file, authoredChecksum: opened.checksum, edit }));
}

// The page's nodes: [0] doctype, [1] Layout, [1,0] main, [1,0,0] p, [1,0,1] ul, [1,0,1,0] li (children counted without blank text).
async function locate(file: string) {
  const opened = await read(file);
  assert.ok(opened.editable);
  const find = (needle: string): readonly number[] => {
    const walk = (list: readonly PageNode[], prefix: readonly number[], depth: number): readonly number[] | undefined => {
      assert.ok(depth <= LIMITS.treeDepthMax, 'a fixture is shallow');
      for (const [index, node] of list.entries()) {
        const at = [...prefix, index];
        const text = PAGE.slice(node.start ?? 0, node.end ?? 0);
        if (text.startsWith(needle)) {
          return at;
        }
        const children = 'children' in node && Array.isArray(node.children) ? node.children : [];
        const inner = walk(children, at, depth + 1);
        if (inner !== undefined) {
          return inner;
        }
      }
      return undefined;
    };
    const found = walk(opened.model.nodes, [], 0);
    assert.ok(found !== undefined, `the fixture has ${needle}`);
    return found;
  };
  return { opened, find };
}

function assertRefused(result: ReturnType<typeof parsePageEditResult>): void {
  assert.equal(result.ok, false, 'the edit is refused');
  if (!result.ok) {
    assert.equal(result.error.code, 'rejected');
    assert.equal(result.error.code === 'rejected' && result.error.reason, 'invalid-placement');
  }
}

test('moving the doctype into a component is refused with a typed error and the file is untouched', async () => {
  const file = page(PAGE);
  const { opened, find } = await locate(file);
  const result = await send(file, {
    tag: 'move-node',
    target: refAt(opened, find('<!doctype')),
    destination: refAt(opened, find('<main')),
    placement: 'last-child',
  });
  assertRefused(result);
  assert.equal(fs.readFileSync(file, 'utf8'), PAGE, 'not one byte changed');
  const into = await send(file, {
    tag: 'move-node',
    target: refAt(opened, find('<!doctype')),
    destination: refAt(opened, find('<Layout')),
    placement: 'first-child',
  });
  assertRefused(into);
  assert.equal(fs.readFileSync(file, 'utf8'), PAGE);
});

test('moving a list item out of its list, or a block into a paragraph, is refused', async () => {
  const file = page(PAGE);
  const { opened, find } = await locate(file);
  assertRefused(await send(file, { tag: 'move-node', target: refAt(opened, find('<li')), destination: refAt(opened, find('<main')), placement: 'last-child' }));
  assertRefused(await send(file, { tag: 'move-node', target: refAt(opened, find('<ul')), destination: refAt(opened, find('<p>')), placement: 'last-child' }));
  assert.equal(fs.readFileSync(file, 'utf8'), PAGE);
});

test('inserting a doctype or a stray list item is refused; a valid insert still applies', async () => {
  const file = page(PAGE);
  const { opened, find } = await locate(file);
  const doctypeSource = page('<!doctype html>\n');
  const doctype = nodeAt(await read(doctypeSource), [0]);
  assertRefused(
    await send(file, { tag: 'insert-node', target: refAt(opened, find('<main')), placement: 'last-child', content: { tag: 'nodes', nodes: [doctype] } }),
  );
  const itemSource = page('<li>stray</li>\n');
  const item = nodeAt(await read(itemSource), [0]);
  assertRefused(
    await send(file, { tag: 'insert-node', target: refAt(opened, find('<main')), placement: 'last-child', content: { tag: 'nodes', nodes: [item] } }),
  );
  assert.equal(fs.readFileSync(file, 'utf8'), PAGE, 'nothing was written');
  const paragraphSource = page('<p>New</p>\n');
  const paragraph = nodeAt(await read(paragraphSource), [0]);
  const applied = await send(file, {
    tag: 'insert-node',
    target: refAt(opened, find('<main')),
    placement: 'last-child',
    content: { tag: 'nodes', nodes: [paragraph] },
  });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.match(fs.readFileSync(file, 'utf8'), /<p>New<\/p>/);
});

test('wrapping a list item in a div is refused', async () => {
  const file = page(PAGE);
  const { opened, find } = await locate(file);
  const item = refAt(opened, find('<li'));
  assertRefused(await send(file, { tag: 'wrap-nodes', target: item, last: item, name: 'div' }));
  assert.equal(fs.readFileSync(file, 'utf8'), PAGE);
});
