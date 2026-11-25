// Goal: navigator moves inside repeated markup use source splices, preserving loop bindings,
// formatting and unrelated writers. Code-owned return roots must still reject sibling placement.
// Method: drive real page IPC on isolated scratch files; compare exact bytes and apply Undo.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { mainHarness } from '../../helpers/mainHarness.ts';
import type { Edit, NodeRef } from '#dist/shared/engine/editRequest.js';
import { parsePageDiskRead, parsePageEditResult } from '#dist/shared/ipc/pageSave.js';
import type { PageDiskRead } from '#dist/shared/ipc/pageSave.js';
import type { PageNode } from '#dist/shared/page/pageNode.js';

function fixture(source: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-repeated-move-'));
  fs.mkdirSync(path.join(root, 'src/pages'), { recursive: true });
  fs.mkdirSync(path.join(root, 'user'));
  fs.writeFileSync(path.join(root, 'package.json'), '{"dependencies":{"astro":"*"}}');
  const file = path.join(root, 'src/pages/index.astro');
  fs.writeFileSync(file, source);
  const harness = mainHarness(path.join(root, 'user'));
  return {
    read: async () => parsePageDiskRead(await harness.invoke('page:read', file)),
    text: () => fs.readFileSync(file, 'utf8'),
    write: (text: string) => fs.writeFileSync(file, text),
    edit: async (checksum: string, edit: Edit) => parsePageEditResult(await harness.invoke('page:edit', { pagePath: file, authoredChecksum: checksum, edit })),
    dispose: () => {
      harness.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function named(page: PageDiskRead, name: string): NodeRef {
  assert.ok(page.editable);
  const pending: { readonly node: PageNode; readonly path: readonly number[] }[] = page.model.nodes.map((node, index) => ({ node, path: [index] }));
  for (let index = 0; index < pending.length; index++) {
    assert.ok(pending.length < 100, 'the synthetic fixture is bounded');
    const entry = pending[index];
    assert.ok(entry !== undefined);
    const node = entry.node;
    if ('name' in node && node.name === name) {
      assert.ok(node.start !== undefined && node.end !== undefined);
      return { path: entry.path, kind: node.kind, span: { start: node.start, end: node.end } };
    }
    if ('children' in node && node.children !== undefined) {
      pending.push(...node.children.map((child, at) => ({ node: child, path: [...entry.path, at] })));
    }
  }
  assert.fail(`Missing ${name}`);
}

const HEADING = '<Heading title={gebiet.title} />';
const IMAGE = '<Image src={gebiet.image} />';
const ICON = "<Icon name={gebiet.icon} data-note='café 😀' />";
const CHILDREN = [HEADING, IMAGE, ICON];
const WRAPPERS = [
  ['{rechtsgebiete.map((gebiet) => (', '))}'],
  ['{rechtsgebiete.map((gebiet) => (<section>{gebiet.visible && (', ')}</section>))}'],
  ['{rechtsgebiete.map((gebiet) => (<section>{gebiet.items.map((item) => (', '))}</section>))}'],
  ['{rechtsgebiete.map((gebiet) => { const label = gebiet.title; return (', '); })}'],
] as const;
const PLACES = [
  { source: 'Icon', destination: 'Heading', placement: 'before', order: [ICON, HEADING, IMAGE] },
  { source: 'Icon', destination: 'Image', placement: 'before', order: [HEADING, ICON, IMAGE] },
  { source: 'Icon', destination: 'Image', placement: 'after', order: CHILDREN },
  { source: 'Icon', destination: 'Card', placement: 'first-child', order: [ICON, HEADING, IMAGE] },
  { source: 'Icon', destination: 'Card', placement: 'last-child', order: CHILDREN },
  { source: 'Heading', destination: 'Icon', placement: 'after', order: [IMAGE, ICON, HEADING] },
  { source: 'Heading', destination: 'Icon', placement: 'before', order: [IMAGE, HEADING, ICON] },
  { source: 'Image', destination: 'Heading', placement: 'before', order: [IMAGE, HEADING, ICON] },
] as const;

for (const [prefix, suffix] of WRAPPERS) {
  for (const place of PLACES) {
    test(`repeated move ${place.placement} ${place.destination} in ${prefix}`, async (context) => {
      const card = (children: readonly string[]) => `<Card>\r\n  ${children.join('\r\n  ')}\r\n</Card>`;
      const source = `${prefix}${card(CHILDREN)}${suffix}\r\n<!-- untouched -->\r\n`;
      const harness = fixture(source);
      context.after(harness.dispose);
      const page = await harness.read();
      const moved = await harness.edit(page.checksum, {
        tag: 'move-node',
        target: named(page, place.source),
        destination: named(page, place.destination),
        placement: place.placement,
      });
      assert.ok(moved.ok, JSON.stringify(moved));
      assert.equal(harness.text(), `${prefix}${card(place.order)}${suffix}\r\n<!-- untouched -->\r\n`);
      const undone = await harness.edit(moved.value.checksum, {
        tag: 'revert',
        hunks: moved.value.inverse,
      });
      assert.ok(undone.ok, JSON.stringify(undone));
      assert.equal(harness.text(), source, 'Undo restores every original byte');
    });
  }
}

test('move out of a nested container retains outer and inner loop bindings', async (context) => {
  const icon = '<Icon title={gebiet.title} name={item.icon} />';
  const prefix = '{rechtsgebiete.map((gebiet) => (<section>{gebiet.items.map((item) => (';
  const suffix = '))}</section>))}';
  const source = `${prefix}<Card><Box>${icon}</Box>${HEADING}</Card>${suffix}`;
  const harness = fixture(source);
  context.after(harness.dispose);
  const page = await harness.read();
  const moved = await harness.edit(page.checksum, {
    tag: 'move-node',
    target: named(page, 'Icon'),
    destination: named(page, 'Heading'),
    placement: 'before',
  });
  assert.ok(moved.ok, JSON.stringify(moved));
  assert.equal(harness.text(), `${prefix}<Card><Box></Box>${icon}${HEADING}</Card>${suffix}`);
  const undone = await harness.edit(moved.value.checksum, {
    tag: 'revert',
    hunks: moved.value.inverse,
  });
  assert.ok(undone.ok);
  assert.equal(harness.text(), source);
});

test('repeated moves and Undo preserve an external change elsewhere', async (context) => {
  const filler = '<p>A paragraph separating the move from other writers and Undo context.</p>';
  const source = `{rechtsgebiete.map((gebiet) => (<Card>${CHILDREN.join('')}</Card>))}` + `${filler}<Footer />`;
  const harness = fixture(source);
  context.after(harness.dispose);
  const page = await harness.read();
  harness.write(source.replace('<Footer />', '<Footer title="theirs" />'));
  const moved = await harness.edit(page.checksum, {
    tag: 'move-node',
    target: named(page, 'Icon'),
    destination: named(page, 'Heading'),
    placement: 'before',
  });
  assert.ok(moved.ok, JSON.stringify(moved));
  assert.equal(harness.text(), source.replace(CHILDREN.join(''), ICON + HEADING + IMAGE).replace('<Footer />', '<Footer title="theirs" />'));
  harness.write(harness.text() + '<!-- another writer -->');
  const undone = await harness.edit(moved.value.checksum, {
    tag: 'revert',
    hunks: moved.value.inverse,
  });
  assert.ok(undone.ok, JSON.stringify(undone));
  assert.equal(harness.text(), source.replace('<Footer />', '<Footer title="theirs" />') + '<!-- another writer -->');
});

test('a repeated move refuses an externally modified source node', async (context) => {
  const source = `{rechtsgebiete.map((gebiet) => (<Card>${CHILDREN.join('')}</Card>))}`;
  const harness = fixture(source);
  context.after(harness.dispose);
  const page = await harness.read();
  const external = source.replace('gebiet.icon', 'gebiet.otherIcon');
  harness.write(external);
  const moved = await harness.edit(page.checksum, {
    tag: 'move-node',
    target: named(page, 'Icon'),
    destination: named(page, 'Heading'),
    placement: 'before',
  });
  assert.equal(moved.ok, false);
  assert.equal(harness.text(), external);
});

for (const [prefix, suffix] of WRAPPERS) {
  for (const placement of ['before', 'after'] as const) {
    test(`refuse ${placement} return root: ${prefix}`, async (context) => {
      const source = `${prefix}<Card>${CHILDREN.join('')}</Card>${suffix}`;
      const harness = fixture(source);
      context.after(harness.dispose);
      const page = await harness.read();
      const moved = await harness.edit(page.checksum, {
        tag: 'move-node',
        target: named(page, 'Icon'),
        destination: named(page, 'Card'),
        placement,
      });
      assert.equal(moved.ok, false);
      assert.equal(!moved.ok && moved.error.code === 'rejected' && moved.error.reason, 'unsupported-operation');
      assert.equal(harness.text(), source);
    });
  }
}

for (const placement of ['before', 'after'] as const) {
  test(`insert ${placement} repeated child`, async (context) => {
    const source = `{rechtsgebiete.map((gebiet) => (<Card>${CHILDREN.join('')}</Card>))}`;
    const harness = fixture(source);
    context.after(harness.dispose);
    const page = await harness.read();
    const inserted = await harness.edit(page.checksum, {
      tag: 'insert-node',
      target: named(page, 'Heading'),
      placement,
      content: { tag: 'copy', source: named(page, 'Icon') },
    });
    assert.ok(inserted.ok, JSON.stringify(inserted));
    const pair = placement === 'before' ? ICON + HEADING : HEADING + ICON;
    assert.equal(harness.text(), source.replace(HEADING, pair));
  });
}

test('taking the only return root out of a loop still refuses the move', async (context) => {
  const source = `{rechtsgebiete.map((gebiet) => (<Card>${HEADING}</Card>))}<Outside />`;
  const harness = fixture(source);
  context.after(harness.dispose);
  const page = await harness.read();
  const moved = await harness.edit(page.checksum, {
    tag: 'move-node',
    target: named(page, 'Card'),
    destination: named(page, 'Outside'),
    placement: 'before',
  });
  assert.equal(moved.ok, false);
  assert.equal(harness.text(), source);
});

for (const placement of ['before', 'after', 'first-child', 'last-child'] as const) {
  test(`callback return tags distinguish ${placement} placement`, async (context) => {
    const source = '{items.map((item) => { if (item.ok) return <Card><Icon /></Card>; ' + 'return <Other />; })}<Outside />';
    const harness = fixture(source);
    context.after(harness.dispose);
    const page = await harness.read();
    const moved = await harness.edit(page.checksum, {
      tag: 'move-node',
      target: named(page, 'Outside'),
      destination: named(page, 'Card'),
      placement,
    });
    // A callback return tag owns markup children, so insertion inside that
    // tag is valid; sibling return roots still cannot receive extra JSX.
    if (placement === 'first-child' || placement === 'last-child') {
      assert.ok(moved.ok, JSON.stringify(moved));
      const children = placement === 'first-child' ? '<Outside /><Icon />' : '<Icon /><Outside />';
      assert.equal(harness.text(), source.replace('<Icon />', children).replace('})}<Outside />', '})}'));
    } else {
      assert.equal(moved.ok, false);
      assert.equal(harness.text(), source);
    }
  });
}
