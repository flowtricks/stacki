// Goal: the fixes planned beyond one element are made only where they are safe:
// per-instance ids only in components, with every reference in the file
// rewritten and none left behind in an expression; the h1 promotion picks the
// most prominent heading component and keeps how its level is written; a link
// fix points the href at the chosen route.
// Method: parse real .astro sources with the editor's parser and pin each
// plan's edits, then each case where no fix may be made.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePage } from '#dist/electron/parse/astroParser.js';
import { parsePageResult } from '#dist/shared/page/pageNode.js';
import { INSTANCE_KEY_CODE, headingPromotionFix, instanceIdFix, linkFix } from '#dist/shared/page/auditRepairs.js';

function input(source: string, kind: 'page' | 'component' = 'component') {
  const parsed = parsePageResult(parsePage(source, { locs: true }));
  assert.ok(parsed.editable);
  return { file: 'src/components/Icon.astro', kind, nodes: parsed.model.nodes, imports: parsed.model.imports, frontmatter: '', source, route: undefined };
}

test('an svg id in a component becomes unique per instance, references included', () => {
  const fix = instanceIdFix(input('<svg><mask id="m1"></mask><g mask="url(#m1)"></g><use href="#m1" /></svg>'), [0, 0]);
  assert.ok(fix !== undefined);
  assert.deepEqual(fix.edits[0], { tag: 'frontmatter-append', code: INSTANCE_KEY_CODE });
  assert.deepEqual(
    fix.edits.slice(1).map((edit) => (edit.tag === 'attributes' ? [edit.path, edit.expect, Object.keys(edit.patch)] : [])),
    [
      [[0, 0], 'mask', ['id']],
      [[0, 1], 'g', ['mask']],
      [[0, 2], 'use', ['href']],
    ],
  );
  assert.match(fix.after, /mask id=\{`m1-\$\{instanceKey\}`\}/);
});

test('no per-instance fix on a page, for a dynamic id, or when an expression refers to it', () => {
  assert.equal(instanceIdFix(input('<svg><mask id="m1"></mask></svg>', 'page'), [0, 0]), undefined);
  assert.equal(instanceIdFix(input('<svg><mask id={id}></mask></svg>'), [0, 0]), undefined);
  assert.equal(instanceIdFix(input('<svg><mask id="m1"></mask><g mask={`url(#m1)`}></g></svg>'), [0, 0]), undefined);
  assert.equal(instanceIdFix(input('<svg><mask id="m1"></mask></svg>'), [0, 5]), undefined, 'a path that names nothing');
  assert.throws(() => instanceIdFix(input('<svg></svg>'), []), /names an element/);
});

test('the most prominent heading component becomes the h1, its level written as before', () => {
  const page = input('<Heading Tag="h3">A</Heading><Heading Tag="h2">B</Heading><Title level="2">C</Title>', 'page');
  const fix = headingPromotionFix(page, new Map([['Heading', 'Tag']]));
  assert.equal(fix?.after, '<Heading Tag="h1">');
  assert.deepEqual(fix?.edits[0]?.tag === 'attributes' ? fix.edits[0].path : [], [1]);
  const numbered = headingPromotionFix(page, new Map([['Title', 'level']]));
  assert.equal(numbered?.after, '<Title level="1">');
  assert.equal(headingPromotionFix(input('<Heading Tag={tag}>A</Heading>', 'page'), new Map([['Heading', 'Tag']])), undefined);
  assert.equal(headingPromotionFix(input('<h2>A</h2>', 'page'), new Map([['Heading', 'Tag']])), undefined);
  assert.throws(() => headingPromotionFix(input('<h2>A</h2>'), new Map()), /a page is promoted/);
});

test('a link fix points the href at the chosen route', () => {
  const fix = linkFix({ file: 'src/pages/a.astro', path: [0, 1], href: '/missing' }, '/about');
  assert.deepEqual(fix.edits, [{ tag: 'attributes', path: [0, 1], expect: 'a', patch: { href: { type: 'string', value: '/about' } } }]);
  assert.equal(fix.after, '<a href="/about">');
  assert.throws(() => linkFix({ file: 'f', path: [0], href: '' }, 'about'), /site-relative/);
});
