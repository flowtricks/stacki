// Goal: the placement model answers every "may this node go here" question the editor can ask,
// the same way for every entry point, and never throws for a place a person can reach.
// Method: one table of places per rule, each with the allowed cases, the refused cases (the
// reason is pinned, so a rule cannot pass by refusing for the wrong cause), and the places where
// the model can only warn. Then the negative space: a doctype or document part in every other
// kind of parent, foreign content, a place at the bounds, and totality over every node kind
// against every frame kind. Evidence that the rules match what the Astro compilers and the
// browser do is in placementEvidence.test.js; this file holds the logic.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  checkPlacement,
  frontmatterRefusal,
  isDoctypeText,
  PLACEMENT_LIMITS,
  PLACEMENT_MESSAGE_KEYS,
  PLACEMENT_REFUSALS,
  PLACEMENT_WARNINGS,
  placementNodeOfName,
  selfDropRefusal,
  type PlacementFrame,
  type PlacementNode,
  type PlacementQuery,
  type PlacementVerdict,
} from '#dist/shared/page/placement.js';

const element = (tag: string): PlacementNode => ({ kind: 'element', tag });
const component = (tag?: string): PlacementNode => ({ kind: 'component', tag });
const doctype: PlacementNode = { kind: 'doctype' };
const text: PlacementNode = { kind: 'text', blank: false };
const blank: PlacementNode = { kind: 'text', blank: true };
const comment: PlacementNode = { kind: 'comment' };
const inElement = (tag: string): PlacementFrame => ({ kind: 'element', tag });
const inComponent = (tag?: string): PlacementFrame => ({ kind: 'component', tag });

interface Place {
  readonly frames?: readonly PlacementFrame[];
  readonly before?: readonly PlacementNode[];
  readonly after?: readonly PlacementNode[];
  readonly document?: PlacementQuery['document'];
}

function verdictFor(node: PlacementNode, place: Place = {}): PlacementVerdict {
  return checkPlacement({ node, frames: place.frames ?? [], before: place.before ?? [], after: place.after ?? [], document: place.document ?? 'unknown' });
}

function refusedWith(node: PlacementNode, place: Place, reason: string): void {
  const verdict = verdictFor(node, place);
  assert.equal(verdict.ok, false, `expected a refusal for ${JSON.stringify(node)} in ${JSON.stringify(place)}`);
  if (!verdict.ok) {
    assert.equal(verdict.reason, reason);
    assert.equal(verdict.messageKey, PLACEMENT_MESSAGE_KEYS[verdict.reason]);
  }
}

function allowed(node: PlacementNode, place: Place = {}): void {
  const verdict = verdictFor(node, place);
  assert.equal(verdict.ok, true, `expected ${JSON.stringify(node)} to be allowed in ${JSON.stringify(place)}: ${JSON.stringify(verdict)}`);
  assert.equal(verdict.ok && verdict.warning, undefined, 'a plain allowance carries no warning');
}

function warnedWith(node: PlacementNode, place: Place, reason: string): void {
  const verdict = verdictFor(node, place);
  assert.equal(verdict.ok, true, 'a warning allows the placement');
  assert.equal(verdict.ok ? verdict.warning?.reason : undefined, reason);
}

test('a doctype is the first thing in a page and nowhere else', () => {
  allowed(doctype);
  allowed(doctype, { before: [comment, blank], after: [element('html')] });
  refusedWith(doctype, { before: [element('div')] }, 'doctype-position');
  refusedWith(doctype, { before: [text] }, 'doctype-position');
  refusedWith(doctype, { frames: [inElement('div')] }, 'doctype-position');
  refusedWith(doctype, { frames: [inComponent('main')] }, 'doctype-position');
  refusedWith(doctype, { frames: [inComponent()] }, 'doctype-position');
  refusedWith(doctype, { frames: [inElement('html')] }, 'doctype-position');
  refusedWith(doctype, { frames: [{ kind: 'fragment' }] }, 'doctype-position');
  refusedWith(doctype, { frames: [{ kind: 'transparent' }] }, 'doctype-position');
  refusedWith(doctype, { frames: [inComponent('main'), inElement('div')] }, 'doctype-position');
  refusedWith(doctype, { after: [doctype] }, 'doctype-duplicate');
  refusedWith(doctype, { before: [doctype] }, 'doctype-duplicate');
});

test('html stands once at the top, after the doctype', () => {
  allowed(element('html'));
  allowed(element('html'), { before: [doctype] });
  allowed(element('html'), { before: [comment, doctype, blank] });
  refusedWith(element('html'), { frames: [inElement('div')] }, 'html-position');
  refusedWith(element('html'), { frames: [inComponent('main')] }, 'html-position');
  refusedWith(element('html'), { before: [element('div')] }, 'html-position');
  refusedWith(element('html'), { after: [doctype] }, 'html-position');
  refusedWith(element('html'), { before: [doctype, element('html')] }, 'html-duplicate');
  refusedWith(element('html'), { after: [element('html')] }, 'html-duplicate');
});

test('head and body stand directly in html, head first', () => {
  allowed(element('head'), { frames: [inElement('html')] });
  allowed(element('body'), { frames: [inElement('html')], before: [element('head')] });
  allowed(element('head'));
  allowed(element('body'));
  allowed(element('head'), { frames: [{ kind: 'fragment' }] });
  refusedWith(element('head'), { frames: [inElement('div')] }, 'head-position');
  refusedWith(element('head'), { frames: [inElement('body')] }, 'head-position');
  refusedWith(element('body'), { frames: [inElement('div')] }, 'body-position');
  refusedWith(element('body'), { frames: [inElement('body')] }, 'body-position');
  refusedWith(element('head'), { frames: [inElement('html')], before: [element('head')] }, 'head-duplicate');
  refusedWith(element('head'), { frames: [inElement('html')], after: [element('head')] }, 'head-duplicate');
  refusedWith(element('body'), { frames: [inElement('html')], after: [element('body')] }, 'body-duplicate');
  refusedWith(element('body'), { frames: [inElement('html')], after: [element('head')] }, 'body-order');
  refusedWith(element('head'), { frames: [inElement('html')], before: [element('body')] }, 'body-order');
});

test('head and body inside a component warn: the layout may own the shell', () => {
  warnedWith(element('head'), { frames: [inComponent('main')] }, 'head-in-component');
  warnedWith(element('body'), { frames: [inComponent()] }, 'body-in-component');
});

test('only metadata stands in head, and only blocks and components stand in html', () => {
  for (const tag of ['title', 'meta', 'link', 'base', 'script', 'style', 'noscript', 'template']) {
    allowed(element(tag), { frames: [inElement('head')] });
  }
  allowed(component(), { frames: [inElement('head')] });
  allowed({ kind: 'slot' }, { frames: [inElement('head')] });
  allowed(comment, { frames: [inElement('head')] });
  refusedWith(element('div'), { frames: [inElement('head')] }, 'head-content');
  refusedWith(element('p'), { frames: [inElement('head')] }, 'head-content');
  refusedWith(text, { frames: [inElement('head')] }, 'head-content');
  allowed(blank, { frames: [inElement('head')] });
  allowed(element('body'), { frames: [inElement('html')] });
  allowed(element('script'), { frames: [inElement('html')] });
  refusedWith(element('div'), { frames: [inElement('html')] }, 'html-content');
  refusedWith(text, { frames: [inElement('html')] }, 'html-content');
});

test('title and base belong to head; meta and link outside it warn', () => {
  allowed(element('title'), { frames: [inElement('head')] });
  allowed(element('title'), { frames: [inComponent('main')] });
  allowed(element('title'));
  allowed(element('title'), { frames: [inElement('svg')] });
  refusedWith(element('title'), { frames: [inElement('div')] }, 'metadata-position');
  refusedWith(element('base'), { frames: [inElement('section')] }, 'metadata-position');
  warnedWith(element('meta'), { frames: [inElement('div')] }, 'metadata-in-body');
  warnedWith(element('link'), { frames: [inElement('section')] }, 'metadata-in-body');
  allowed(element('meta'), { frames: [inElement('head')] });
  allowed(element('link'), { frames: [inComponent('main')] });
});

test('script and style stand wherever markup does', () => {
  for (const frames of [[], [inElement('div')], [inElement('ul')], [inElement('table')], [inElement('p')], [inComponent('section')]]) {
    allowed(element('script'), { frames });
    allowed(element('style'), { frames });
  }
  // A select keeps only options and scripts: the browser drops a style inside it.
  allowed(element('script'), { frames: [inElement('select')] });
  refusedWith(element('style'), { frames: [inElement('select')] }, 'content-model');
  refusedWith(element('script'), { frames: [inElement('img')] }, 'void-parent');
});

test('a void element holds nothing', () => {
  for (const tag of ['img', 'br', 'hr', 'input', 'meta', 'link', 'source', 'wbr', 'col']) {
    for (const node of [element('span'), text, comment, component('main'), { kind: 'code' } as const, { kind: 'fragment' } as const]) {
      refusedWith(node, { frames: [inElement(tag)] }, 'void-parent');
    }
  }
  allowed(element('span'), { frames: [inComponent('img-wrapper')] });
});

test('list, table, select and media children need their parent', () => {
  allowed(element('li'), { frames: [inElement('ul')] });
  allowed(element('li'), { frames: [inElement('ol')] });
  allowed(element('li'), { frames: [inElement('menu')] });
  allowed(element('li'), { frames: [inElement('ul'), { kind: 'transparent' }] });
  refusedWith(element('li'), { frames: [inElement('div')] }, 'needs-parent');
  refusedWith(element('li'), { frames: [inElement('li')] }, 'needs-parent');
  refusedWith(element('li'), { document: 'page' }, 'needs-parent');
  allowed(element('tr'), { frames: [inElement('table')] });
  allowed(element('tr'), { frames: [inElement('tbody')] });
  allowed(element('td'), { frames: [inElement('tr')] });
  allowed(element('th'), { frames: [inElement('tr')] });
  refusedWith(element('td'), { frames: [inElement('div')] }, 'needs-parent');
  refusedWith(element('td'), { frames: [inElement('table')] }, 'needs-parent');
  refusedWith(element('tr'), { frames: [inElement('div')] }, 'needs-parent');
  refusedWith(element('tr'), { frames: [inElement('tr')] }, 'needs-parent');
  allowed(element('thead'), { frames: [inElement('table')] });
  allowed(element('caption'), { frames: [inElement('table')] });
  allowed(element('colgroup'), { frames: [inElement('table')] });
  allowed(element('col'), { frames: [inElement('colgroup')] });
  refusedWith(element('thead'), { frames: [inElement('div')] }, 'needs-parent');
  refusedWith(element('tbody'), { frames: [inElement('tbody')] }, 'needs-parent');
  refusedWith(element('col'), { frames: [inElement('table')] }, 'needs-parent');
  allowed(element('option'), { frames: [inElement('select')] });
  allowed(element('option'), { frames: [inElement('optgroup')] });
  allowed(element('option'), { frames: [inElement('datalist')] });
  allowed(element('optgroup'), { frames: [inElement('select')] });
  refusedWith(element('option'), { frames: [inElement('div')] }, 'needs-parent');
  refusedWith(element('optgroup'), { frames: [inElement('optgroup')] }, 'needs-parent');
  allowed(element('dt'), { frames: [inElement('dl')] });
  allowed(element('dd'), { frames: [inElement('dl'), inElement('div')] });
  refusedWith(element('dd'), { frames: [inElement('div')] }, 'needs-parent');
  refusedWith(element('dt'), { frames: [inElement('ul')] }, 'needs-parent');
  allowed(element('source'), { frames: [inElement('picture')] });
  allowed(element('source'), { frames: [inElement('video')] });
  allowed(element('track'), { frames: [inElement('audio')] });
  refusedWith(element('source'), { frames: [inElement('div')] }, 'needs-parent');
  refusedWith(element('track'), { frames: [inElement('picture')] }, 'needs-parent');
  allowed(element('figcaption'), { frames: [inElement('figure')] });
  refusedWith(element('figcaption'), { frames: [inElement('div')] }, 'needs-parent');
  allowed(element('rt'), { frames: [inElement('ruby')] });
  refusedWith(element('rp'), { frames: [inElement('span')] }, 'needs-parent');
});

test('a bare list item at the root of a component, or in a component, warns instead of refusing', () => {
  warnedWith(element('li'), { frames: [inComponent()] }, 'unknown-component-parent');
  warnedWith(element('td'), { frames: [inComponent()] }, 'unknown-component-parent');
  warnedWith(element('li'), { document: 'component' }, 'unknown-component-parent');
  warnedWith(element('li'), { document: 'unknown' }, 'unknown-component-parent');
  refusedWith(element('li'), { document: 'page' }, 'needs-parent');
  // A component that renders a known tag is judged by it.
  allowed(element('li'), { frames: [inComponent('ul')] });
  refusedWith(element('li'), { frames: [inComponent('div')] }, 'needs-parent');
  warnedWith(element('li'), { frames: [{ kind: 'fragment' }] }, 'unknown-component-parent');
  refusedWith(element('li'), { frames: [{ kind: 'fragment' }], document: 'page' }, 'needs-parent');
});

test('a fixed-content parent refuses everything else, and warns about what it cannot read', () => {
  refusedWith(element('div'), { frames: [inElement('ul')] }, 'content-model');
  refusedWith(element('span'), { frames: [inElement('ol')] }, 'content-model');
  refusedWith(element('div'), { frames: [inElement('table')] }, 'content-model');
  refusedWith(element('div'), { frames: [inElement('tr')] }, 'content-model');
  refusedWith(element('div'), { frames: [inElement('select')] }, 'content-model');
  refusedWith(element('li'), { frames: [inElement('dl')] }, 'needs-parent');
  refusedWith(element('div'), { frames: [inElement('picture')] }, 'content-model');
  allowed(element('div'), { frames: [inElement('dl')] });
  allowed(element('hr'), { frames: [inElement('select')] });
  allowed(component('li'), { frames: [inElement('ul')] });
  refusedWith(component('section'), { frames: [inElement('ul')] }, 'content-model');
  warnedWith(component(), { frames: [inElement('ul')] }, 'unknown-component-child');
  allowed({ kind: 'slot' }, { frames: [inElement('ul')] });
  allowed({ kind: 'code' }, { frames: [inElement('ul')] });
  allowed({ kind: 'fragment' }, { frames: [inElement('ul')] });
  allowed(comment, { frames: [inElement('table')] });
  allowed(blank, { frames: [inElement('table')] });
  refusedWith(text, { frames: [inElement('table')] }, 'text-position');
  refusedWith(text, { frames: [inElement('select')] }, 'text-position');
  warnedWith(text, { frames: [inElement('ul')] }, 'text-in-list');
});

test('phrasing parents refuse blocks', () => {
  for (const parent of ['p', 'h1', 'h6', 'span', 'strong', 'em', 'label']) {
    refusedWith(element('div'), { frames: [inElement(parent)] }, 'content-model');
    refusedWith(element('p'), { frames: [inElement(parent)] }, 'content-model');
    refusedWith(element('ul'), { frames: [inElement(parent)] }, 'content-model');
    allowed(element('span'), { frames: [inElement(parent)] });
    allowed(element('a'), { frames: [inElement(parent)] });
    allowed(text, { frames: [inElement(parent)] });
    allowed({ kind: 'slot' }, { frames: [inElement(parent)] });
    allowed(component(), { frames: [inElement(parent)] });
  }
  refusedWith(component('section'), { frames: [inElement('p')] }, 'content-model');
  allowed(element('div'), { frames: [inElement('div')] });
  allowed(element('p'), { frames: [inElement('section')] });
  allowed(element('ul'), { frames: [inElement('li')] });
});

test('summary and legend lead their parent', () => {
  allowed(element('summary'), { frames: [inElement('details')] });
  allowed(element('summary'), { frames: [inElement('details')], before: [comment] });
  allowed(element('legend'), { frames: [inElement('fieldset')] });
  refusedWith(element('summary'), { frames: [inElement('details')], before: [element('p')] }, 'first-child');
  refusedWith(element('summary'), { frames: [inElement('details')], after: [element('summary')] }, 'first-child');
  refusedWith(element('legend'), { frames: [inElement('fieldset')], before: [element('input')] }, 'first-child');
  refusedWith(element('p'), { frames: [inElement('details')], after: [element('summary')] }, 'first-child');
  refusedWith(element('div'), { frames: [inElement('fieldset')], after: [element('legend')] }, 'first-child');
  allowed(element('p'), { frames: [inElement('details')], before: [element('summary')] });
  allowed(element('p'), { frames: [inElement('details')] });
  allowed(comment, { frames: [inElement('details')], after: [element('summary')] });
});

test('a link or button never nests in another, nor a form in a form, however deep', () => {
  refusedWith(element('a'), { frames: [inElement('a')] }, 'nested-interactive');
  refusedWith(element('a'), { frames: [inElement('a'), inElement('div'), inElement('span')] }, 'nested-interactive');
  refusedWith(element('button'), { frames: [inElement('a')] }, 'nested-interactive');
  refusedWith(element('a'), { frames: [inElement('button')] }, 'nested-interactive');
  refusedWith(element('button'), { frames: [inElement('button'), inElement('div')] }, 'nested-interactive');
  refusedWith(element('form'), { frames: [inElement('form'), inElement('div')] }, 'nested-form');
  refusedWith({ kind: 'element', tag: 'div', descendants: ['a'] }, { frames: [inElement('a')] }, 'nested-interactive');
  refusedWith({ kind: 'element', tag: 'section', descendants: ['span', 'a'] }, { frames: [inElement('button')] }, 'nested-interactive');
  refusedWith({ kind: 'component', tag: undefined, descendants: ['a'] }, { frames: [inElement('a')] }, 'nested-interactive');
  refusedWith({ kind: 'element', tag: 'span', descendants: ['form'] }, { frames: [inElement('form'), inElement('div')] }, 'nested-form');
  allowed(element('a'), { frames: [inElement('div')] });
  allowed(element('button'), { frames: [inElement('form')] });
  allowed({ kind: 'element', tag: 'div', descendants: ['a', 'span'] }, { frames: [inElement('section')] });
  allowed(element('span'), { frames: [inElement('a')] });
  allowed(element('form'), { frames: [inElement('div')] });
});

test('a slot is for components and layouts, not pages', () => {
  const slot: PlacementNode = { kind: 'slot' };
  allowed(slot, { document: 'component' });
  allowed(slot, { document: 'unknown', frames: [inElement('div')] });
  refusedWith(slot, { document: 'page' }, 'slot-in-page');
  refusedWith(slot, { document: 'page', frames: [inElement('div')] }, 'slot-in-page');
});

test('fragments, comments, expressions and components stand anywhere markup does', () => {
  for (const node of [{ kind: 'fragment' } as const, comment, { kind: 'code' } as const, component(), component('main')]) {
    allowed(node);
    allowed(node, { frames: [inElement('div')] });
    allowed(node, { frames: [inComponent('section'), inElement('div')] });
    allowed(node, { frames: [{ kind: 'transparent' }] });
  }
});

test('the frontmatter is not a place for markup', () => {
  for (const node of [doctype, element('div'), text, comment, component(), { kind: 'code' } as const]) {
    refusedWith(node, { frames: [{ kind: 'frontmatter' }] }, 'frontmatter');
  }
  assert.equal(frontmatterRefusal().ok, false);
  assert.equal(selfDropRefusal().ok, false);
  const selfDrop = selfDropRefusal();
  assert.equal(selfDrop.ok, false);
  if (!selfDrop.ok) {
    assert.equal(selfDrop.reason, 'self-drop');
  }
});

test('foreign content skips the HTML content model', () => {
  allowed(element('title'), { frames: [inElement('svg')] });
  allowed(element('div'), { frames: [inElement('svg'), inElement('g')] });
  allowed(element('a'), { frames: [inElement('a'), inElement('svg')] });
  refusedWith(doctype, { frames: [inElement('svg')] }, 'doctype-position');
});

test('every reason has a message key, params and a documented class', () => {
  const keys = new Set<string>(Object.values(PLACEMENT_MESSAGE_KEYS));
  assert.equal(keys.size, PLACEMENT_REFUSALS.length + PLACEMENT_WARNINGS.length, 'one message per reason');
  for (const key of keys) {
    assert.match(key, /^structure\.placement\.[a-zA-Z]+$/);
  }
  const overlap = PLACEMENT_REFUSALS.filter((reason) => new Set<string>(PLACEMENT_WARNINGS).has(reason));
  assert.deepEqual(overlap, [], 'a reason is a refusal or a warning, never both');
});

test('a refusal names the child and the parent for its message', () => {
  const verdict = verdictFor(element('li'), { frames: [inElement('div')] });
  assert.equal(verdict.ok, false);
  if (!verdict.ok) {
    assert.deepEqual(verdict.params, { child: 'li', parent: 'ul / ol / menu' });
  }
  const content = verdictFor(element('div'), { frames: [inElement('p')] });
  assert.equal(content.ok, false);
  if (!content.ok) {
    assert.deepEqual(content.params, { child: 'div', parent: 'p' });
  }
});

test('tag comparison ignores case', () => {
  refusedWith(element('LI'), { frames: [inElement('DIV')] }, 'needs-parent');
  allowed(element('LI'), { frames: [inElement('UL')] });
  refusedWith(element('HTML'), { frames: [inElement('div')] }, 'html-position');
});

test('totality: every node kind in every frame kind has a verdict', () => {
  const nodes: readonly PlacementNode[] = [
    doctype,
    text,
    blank,
    comment,
    { kind: 'code' },
    { kind: 'fragment' },
    { kind: 'slot' },
    element('div'),
    element('li'),
    element('html'),
    component(),
    component('ul'),
  ];
  const frames: readonly PlacementFrame[] = [
    inElement('div'),
    inElement('ul'),
    inElement('p'),
    inElement('img'),
    inElement('table'),
    inComponent(),
    inComponent('main'),
    { kind: 'fragment' },
    { kind: 'transparent' },
    { kind: 'frontmatter' },
  ];
  for (const node of nodes) {
    for (const frame of frames) {
      for (const document of ['page', 'component', 'unknown'] as const) {
        const verdict = verdictFor(node, { frames: [frame], document });
        assert.equal(typeof verdict.ok, 'boolean');
      }
    }
    assert.equal(typeof verdictFor(node).ok, 'boolean');
  }
});

test('a place past the bounds is a programmer error, not a verdict', () => {
  const tooDeep = Array.from({ length: PLACEMENT_LIMITS.framesMax + 1 }, () => inElement('div'));
  assert.throws(() => verdictFor(element('div'), { frames: tooDeep }), /no deeper than the page tree/);
  const tooWide = Array.from({ length: PLACEMENT_LIMITS.siblingsMax + 1 }, () => comment);
  assert.throws(() => verdictFor(element('div'), { before: tooWide }), /bounded number of siblings/);
});

test('names map to the nodes they stand for', () => {
  assert.deepEqual(placementNodeOfName('Fragment', 'component', undefined), { kind: 'fragment' });
  assert.deepEqual(placementNodeOfName('', 'element', undefined), { kind: 'fragment' });
  assert.deepEqual(placementNodeOfName('slot', 'element', undefined), { kind: 'slot' });
  assert.deepEqual(placementNodeOfName('div', 'element', undefined), { kind: 'element', tag: 'div' });
  assert.deepEqual(placementNodeOfName('Card', 'component', 'section'), { kind: 'component', tag: 'section' });
  assert.deepEqual(placementNodeOfName('Card', 'component', undefined), { kind: 'component', tag: undefined });
  assert.throws(() => placementNodeOfName('x'.repeat(129), 'element', undefined), /tag-name bound/);
});

test('the doctype is recognised in any spelling, and only that', () => {
  for (const spelling of ['<!doctype html>', '<!DOCTYPE html>', '  <!Doctype   html >\n', '<!doctype html PUBLIC "x">']) {
    assert.equal(isDoctypeText(spelling), true, spelling);
  }
  for (const other of ['<!-- doctype -->', '<doctype>', '<!doctypehtml>', 'x <!doctype html>', '<!doctype html> y', '']) {
    assert.equal(isDoctypeText(other), false, other);
  }
});
