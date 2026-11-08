// Goal: a node the renderer sends as a tree reaches the file laid out as Stacki's
// own code is: one element per line, indented where the planner lands it, in the
// file's indent unit. This is the half of an insertion the planner cannot do, since
// it receives the printed text whole.
// Method: real pages through `buildEditIntent`, the draft main builds for a gesture,
// then the shipping planner, pinning the exact file. The page model comes from the
// parser, so a pasted node carries the written attributes and closing tag a copied
// one does; the Prettier-wrapped link is the shape found in a user's page.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildEditIntent } from '#dist/electron/documents/editRequests.js';
import { parsePage } from '#dist/electron/parse/astroParser.js';
import { toFilePath, toIntentId } from '#dist/shared/core/brand.js';
import type { Edit, NodeRef } from '#dist/shared/engine/editRequest.js';
import { toIntent } from '#dist/shared/engine/intent.js';
import { planIntent } from '#dist/shared/engine/planner.js';
import { parsePageResult, type PageNode } from '#dist/shared/page/pageNode.js';
import type { Snapshot } from '#dist/shared/page/snapshot.js';
import { encodeUtf8 } from '#dist/shared/core/span.js';
import { applySplices } from '#dist/shared/engine/splice.js';
import { snapshotOf } from '../../simulator/project.ts';

const PAGE = toFilePath('/project/page.astro');

type Placement = 'before' | 'after' | 'first-child' | 'last-child';

function nodesOf(text: string): readonly PageNode[] {
  const parsed = parsePageResult(parsePage(text, { locs: true }));
  assert.ok(parsed.editable, 'the page parses');
  return parsed.model.nodes;
}

function nodeAt(text: string, at: readonly number[]): PageNode {
  let list = nodesOf(text);
  let node: PageNode | undefined;
  for (const step of at) {
    node = list[step];
    assert.ok(node !== undefined, `a node at ${at.join('/')}`);
    list = 'children' in node && Array.isArray(node.children) ? node.children : [];
  }
  assert.ok(node !== undefined, 'the path names a node');
  return node;
}

function refAt(text: string, at: readonly number[]): NodeRef {
  const node = nodeAt(text, at);
  assert.ok(node.start !== undefined, 'the parse carries a start');
  assert.ok(node.end !== undefined, 'the parse carries an end');
  return { path: at, kind: node.kind, span: { start: node.start, end: node.end } };
}

function applied(text: string, edit: Edit): string {
  const authored: Snapshot = snapshotOf(PAGE, encodeUtf8(text));
  const draft = buildEditIntent(edit, authored);
  assert.ok(draft.ok, 'the draft builds');
  const intent = toIntent({ id: toIntentId('layout'), file: authored.path, authoredChecksum: authored.checksum, ...draft.value });
  const plan = planIntent({ authored, current: authored }, intent);
  assert.ok(plan.ok, `the plan holds: ${JSON.stringify(plan)}`);
  return Buffer.from(applySplices(authored.bytes, plan.value.splices)).toString('utf8');
}

function inserted(text: string, at: readonly number[], placement: Placement, node: PageNode): string {
  return applied(text, { tag: 'insert-node', target: refAt(text, at), placement, content: { tag: 'nodes', nodes: [node] } });
}

const LAYOUT = '<div class="a"><div class="b"><h2>Title</h2><p>Words</p></div></div>';

test('multi-element markup lands one element per line, in a tab file', () => {
  const nodes = nodesOf(LAYOUT);
  const node = nodes[0];
  assert.ok(node !== undefined);
  assert.equal(
    inserted('<main>\n\t<section></section>\n</main>\n', [0, 0], 'last-child', node),
    [
      '<main>',
      '\t<section>',
      '\t\t<div class="a">',
      '\t\t\t<div class="b">',
      '\t\t\t\t<h2>Title</h2>',
      '\t\t\t\t<p>Words</p>',
      '\t\t\t</div>',
      '\t\t</div>',
      '\t</section>',
      '</main>',
      '',
    ].join('\n'),
  );
});

test('multi-element markup takes a spaced file’s own unit', () => {
  const node = nodesOf(LAYOUT)[0];
  assert.ok(node !== undefined);
  assert.equal(
    inserted('<main>\n  <header>\n    <h1>a</h1>\n  </header>\n  <section></section>\n</main>\n', [0, 1], 'last-child', node),
    [
      '<main>',
      '  <header>',
      '    <h1>a</h1>',
      '  </header>',
      '  <section>',
      '    <div class="a">',
      '      <div class="b">',
      '        <h2>Title</h2>',
      '        <p>Words</p>',
      '      </div>',
      '    </div>',
      '  </section>',
      '</main>',
      '',
    ].join('\n'),
  );
});

test('beside a child on its parent’s line, a printed block’s later lines match its first', () => {
  const node = nodesOf('<div><p>x</p></div>')[0];
  assert.ok(node !== undefined);
  assert.equal(inserted('<main><h2>a</h2></main>\n', [0, 0], 'after', node), '<main><h2>a</h2>\n\t<div>\n\t\t<p>x</p>\n\t</div>\n</main>\n');
});

// The page this fix came from: Prettier wrapped the link in the user's own HTML, and
// a paste prints the wrapper from the source it was read with, so `\n>` is the file's.
test('a pasted wrapper keeps its link as written, on lines of its own', () => {
  const copied = [
    '<main>',
    '            <div class="button-wrapper">',
    '              <a href="#" class="button secondary"',
    '                >Send your first pigeon <span>→</span></a',
    '              >',
    '            </div>',
    '</main>',
    '',
  ].join('\n');
  const wrapper = nodeAt(copied, [0, 0]);
  assert.equal(
    inserted('<body>\n  <section class="dev">\n    <p>Typed.</p>\n  </section>\n</body>\n', [0, 0, 0], 'after', wrapper),
    [
      '<body>',
      '  <section class="dev">',
      '    <p>Typed.</p>',
      '    <div class="button-wrapper">',
      '      <a href="#" class="button secondary"',
      '        >Send your first pigeon <span>→</span></a',
      '      >',
      '    </div>',
      '  </section>',
      '</body>',
      '',
    ].join('\n'),
  );
});

test('lines inside a printed <pre> keep their own start', () => {
  const node = nodesOf('<section>\n\t<pre>one\n  two</pre>\n\t<p>x</p>\n</section>')[0];
  assert.ok(node !== undefined);
  assert.equal(
    inserted('<main>\n\t<aside></aside>\n</main>\n', [0, 0], 'last-child', node),
    '<main>\n\t<aside>\n\t\t<section>\n\t\t\t<pre>one\n  two</pre>\n\t\t\t<p>x</p>\n\t\t</section>\n\t</aside>\n</main>\n',
  );
});

test('a duplicate is the node’s own bytes, whatever its layout', () => {
  const text = '<main>\n\t<div class="a"><p>x</p>\n\t\t\t<p>y</p></div>\n</main>\n';
  const target = refAt(text, [0, 0]);
  assert.equal(
    applied(text, { tag: 'insert-node', target, placement: 'after', content: { tag: 'copy', source: target } }),
    '<main>\n\t<div class="a"><p>x</p>\n\t\t\t<p>y</p></div>\n\t<div class="a"><p>x</p>\n\t\t\t<p>y</p></div>\n</main>\n',
  );
});

test('a wrapper stands on its own lines only where those lines cannot show', () => {
  const wrap = (text: string, at: readonly number[], name: string): string => {
    const target = refAt(text, at);
    return applied(text, { tag: 'wrap-nodes', target, last: target, name });
  };
  assert.equal(wrap('<main>\n\t<p>x</p>\n</main>\n', [0, 0], 'div'), '<main>\n\t<div>\n\t<p>x</p>\n\t</div>\n</main>\n');
  assert.equal(wrap('<main>\n\t<p>x</p>\n</main>\n', [0, 0], 'a'), '<main>\n\t<a>\n\t<p>x</p>\n\t</a>\n</main>\n');
  assert.equal(wrap('<p>one <b>x</b> two</p>\n', [0, 1], 'a'), '<p>one <a><b>x</b></a> two</p>\n');
  assert.equal(wrap('<pre><b>x</b></pre>\n', [0, 0], 'div'), '<pre><div><b>x</b></div></pre>\n');
});
