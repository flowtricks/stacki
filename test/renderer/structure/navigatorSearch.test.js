// Goal: the Navigator's search keeps exactly the rows a person means (by element or component name,
// tag, class, id and text), each with the rows above it, without ever changing the page tree, and
// stays one linear walk however large the page is. The shared highlight cuts a label where the words land.
// Methodology: run the real modules (src/features/structure/navigatorSearch.ts and src/lib/searchText.ts)
// through the app's bundler on hand-made trees: nested elements, a component, a loop, a condition with
// both branches, accents, no match, an empty query, and the bound on matches. Speed is held as a ratio,
// never as milliseconds: the best of several searches over 20,000 nodes is compared with the same amount
// of work done as repeated searches over a 65-node page, so only a search that stops being linear fails.
// The selector and markup forms (.class, #id, [attr], <tag>, /* comment) each get a test on the same
// trees, plus half-typed and malformed queries, which must fall back to plain words and never throw.
const test = require('node:test');
const assert = require('node:assert/strict');
const load = require('../../helpers/rendererModule');
const search = load('src/features/structure/navigatorSearch.ts');
const text = load('src/lib/searchText.ts');

let counter = 0;
const next = (prefix) => `${prefix}-${(counter += 1)}`;
const element = (name, props, children = []) => ({ id: next(name), kind: 'element', name, props, children });
const word = (value) => ({ id: next('text'), kind: 'text', value });
const klass = (value) => ({ class: { type: 'string', value } });
const ids = (nodes) => nodes.map((node) => node.id);
// Every id in a tree, in page order: an explicit stack, so no recursion needs a depth bound.
function flatten(nodes) {
  const found = [];
  const stack = [...nodes].reverse();
  for (let step = 0; step < 100_000 && stack.length > 0; step += 1) {
    const node = stack.pop();
    found.push(node.id);
    stack.push(...[...(node.children ?? [])].reverse());
  }
  return found;
}
const run = (nodes, query) => search.searchNavigator(nodes, search.buildNavigatorIndex(nodes), query);

function page() {
  const heading = element('h1', klass('hero-title'), [word('Welcome home')]);
  const button = element('button', klass('btn primary'), [word('Éclair')]);
  const card = { id: 'card', kind: 'component', name: 'ProductCard', children: [button] };
  const hero = element('section', klass('hero'), [heading]);
  const footer = element('footer', undefined, [element('p', { id: { type: 'string', value: 'legal' } })]);
  const cond = {
    id: 'cond',
    kind: 'cond',
    op: '?',
    test: 'signedIn',
    children: [
      { id: 'then', kind: 'branch', name: 'then', children: [element('a', klass('profile-link'))] },
      { id: 'else', kind: 'branch', name: 'else', children: [element('b', klass('login-link'))] },
    ],
  };
  return { nodes: [hero, card, footer, cond], heading, button, card, hero, footer, cond };
}

test('a tag, a component name, a class, an id and text all find their row', () => {
  const { nodes, heading, card, hero, footer, button } = page();
  assert.ok(flatten(run(nodes, 'h1').nodes).includes(heading.id));
  assert.ok(flatten(run(nodes, 'productcard').nodes).includes(card.id));
  assert.ok(flatten(run(nodes, 'hero-title').nodes).includes(heading.id));
  assert.ok(flatten(run(nodes, 'legal').nodes).includes(footer.children[0].id));
  assert.ok(flatten(run(nodes, 'welcome home').nodes).includes(heading.children[0].id));
  assert.ok(flatten(run(nodes, 'btn').nodes).includes(button.id));
  assert.ok(flatten(run(nodes, 'hero').nodes).includes(hero.id));
});

test('a match keeps its ancestors and drops what neither matches nor leads to a match', () => {
  const { nodes, heading, hero, card, footer } = page();
  const kept = flatten(run(nodes, 'welcome').nodes);
  assert.deepEqual(kept, [hero.id, heading.id, heading.children[0].id]);
  assert.equal(kept.includes(card.id), false);
  assert.equal(kept.includes(footer.id), false);
});

test('the search is case and accent blind in the tree and in the query', () => {
  const { nodes, button } = page();
  assert.ok(flatten(run(nodes, 'ECLAIR').nodes).includes(button.children[0].id));
  assert.ok(flatten(run(nodes, 'éclair').nodes).includes(button.children[0].id));
});

test('every word must be somewhere in one row', () => {
  const { nodes, button } = page();
  assert.ok(flatten(run(nodes, 'btn primary').nodes).includes(button.id));
  assert.equal(run(nodes, 'btn hero-title').nodes.length, 0);
});

test('a condition keeps the branch that leads to a match and the condition above it', () => {
  const { nodes } = page();
  const kept = run(nodes, 'login-link').nodes;
  assert.deepEqual(ids(kept), ['cond']);
  assert.deepEqual(ids(kept[0].children), ['else']);
});

test('an empty query, a query of spaces and a query with no match keep nothing', () => {
  const { nodes } = page();
  assert.equal(run(nodes, '').nodes.length, 0);
  assert.equal(run(nodes, '   ').nodes.length, 0);
  assert.equal(run(nodes, 'zzzzz').nodes.length, 0);
  assert.equal(run(nodes, 'zzzzz').matchCount, 0);
});

test('the page tree itself is never changed', () => {
  const { nodes, hero } = page();
  const before = JSON.stringify(nodes);
  const result = run(nodes, 'welcome');
  assert.equal(JSON.stringify(nodes), before);
  assert.notEqual(result.nodes[0], hero, 'the result is a copy');
  assert.equal(hero.children.length, 1);
});

test('matches are bounded, and the bound is reported', () => {
  const many = Array.from({ length: search.NAVIGATOR_MATCHES_MAX + 50 }, () => element('li', klass('item')));
  const result = run(many, 'item');
  assert.equal(result.matchCount, search.NAVIGATOR_MATCHES_MAX);
  assert.equal(result.capped, true);
  assert.equal(result.nodes.length, search.NAVIGATOR_MATCHES_MAX);
  const few = run(many.slice(0, 3), 'item');
  assert.equal(few.capped, false);
  assert.equal(few.matchCount, 3);
});

function big(count) {
  return Array.from({ length: Math.ceil(count / 4) }, (_, index) =>
    element('div', klass(`row-${index}`), [element('span', klass('label')), element('a', klass(`link-${index}`)), word(`word ${index}`)]),
  );
}

function bestOf(runs, work) {
  let best = Infinity;
  for (let attempt = 0; attempt < runs; attempt += 1) {
    const started = process.hrtime.bigint();
    work();
    best = Math.min(best, Number(process.hrtime.bigint() - started));
  }
  return best;
}

test('20,000 nodes cost no more than the same work over 65', () => {
  const large = big(20_000);
  const small = big(65);
  const largeIndex = search.buildNavigatorIndex(large);
  const smallIndex = search.buildNavigatorIndex(small);
  const passes = Math.ceil(20_000 / 65);
  // A query almost nothing matches: the cost is the walk, not the rows kept.
  const largeTime = bestOf(7, () => search.searchNavigator(large, largeIndex, 'qq-none'));
  const smallTime = bestOf(7, () => {
    for (let pass = 0; pass < passes; pass += 1) {
      search.searchNavigator(small, smallIndex, 'qq-none');
    }
  });
  assert.ok(largeTime <= smallTime * 6, `${largeTime} ns over 20,000 nodes vs ${smallTime} ns over ${passes} walks of 65`);
  assert.equal(largeIndex.size, flatten(large).length);
});

test('highlight cuts a label where the words land, whatever the case or accents', () => {
  const runs = (label, query) =>
    text.highlightSegments(label, text.queryWords(query)).map((segment) => `${segment.hit ? '[' : ''}${segment.text}${segment.hit ? ']' : ''}`);
  assert.deepEqual(runs('hero-title', 'title'), ['hero-', '[title]']);
  assert.deepEqual(runs('Éclair au café', 'ecl cafe'), ['[Écl]', 'air au ', '[café]']);
  assert.deepEqual(runs('aaa', 'a'), ['[aaa]']);
  assert.deepEqual(runs('hero', 'zzz'), ['hero']);
  assert.deepEqual(runs('hero', ''), ['hero']);
  assert.deepEqual(runs('', 'a'), []);
});

// ---- Selector and markup queries ------------------------------------------------------------------

const comment = (value) => ({ id: next('comment'), kind: 'comment', value });
const attrs = (props) =>
  Object.fromEntries(Object.entries(props).map(([name, value]) => [name, value === true ? { type: 'bare' } : { type: 'string', value }]));
function markup() {
  const note = comment(' Hero banner ');
  const banner = element('section', { ...klass('banner wide'), ...attrs({ 'data-Theme': 'Dark-Mode', id: 'top', hidden: true }) });
  const button = { id: 'button', kind: 'component', name: 'Button', props: attrs({ 'data-kind': 'primary action' }), children: [] };
  const plain = element('p', klass('lede'));
  const loose = comment(' trailing text ');
  return { nodes: [note, banner, button, plain, loose], note, banner, button, plain, loose };
}
const found = (nodes, query) => flatten(run(nodes, query).nodes);

test('.class matches a class token, and a prefix while it is typed', () => {
  const { nodes, banner, plain } = markup();
  assert.deepEqual(found(nodes, '.banner'), [banner.id]);
  assert.deepEqual(found(nodes, '.wid'), [banner.id]);
  assert.deepEqual(found(nodes, '.LEDE'), [plain.id]);
  assert.deepEqual(found(nodes, '.nothing'), []);
  assert.deepEqual(found(nodes, '.ledes'), [], 'a longer token than any class finds nothing');
});

test('#id matches ids', () => {
  const { nodes, banner } = markup();
  assert.deepEqual(found(nodes, '#top'), [banner.id]);
  assert.deepEqual(found(nodes, '#to'), [banner.id]);
  assert.deepEqual(found(nodes, '#bottom'), []);
});

test('attribute selectors: exists, =, quoted, ^=, $=, *=, ~=, case-blind names', () => {
  const { nodes, banner, button } = markup();
  assert.deepEqual(found(nodes, '[data-theme]'), [banner.id]);
  assert.deepEqual(found(nodes, '[DATA-THEME]'), [banner.id]);
  assert.deepEqual(found(nodes, '[hidden]'), [banner.id]);
  assert.deepEqual(found(nodes, '[data-theme=dark-mode]'), [banner.id]);
  assert.deepEqual(found(nodes, '[data-theme="dark-mode"]'), [banner.id]);
  assert.deepEqual(found(nodes, "[data-theme='Dark-Mode']"), [banner.id]);
  assert.deepEqual(found(nodes, '[data-theme=dark]'), []);
  assert.deepEqual(found(nodes, '[data-theme^=dark]'), [banner.id]);
  assert.deepEqual(found(nodes, '[data-theme$=mode]'), [banner.id]);
  assert.deepEqual(found(nodes, '[data-theme*=k-m]'), [banner.id]);
  assert.deepEqual(found(nodes, '[data-kind~=action]'), [button.id]);
  assert.deepEqual(found(nodes, '[data-kind~=act]'), []);
  assert.deepEqual(found(nodes, '[data-kind="primary action"]'), [button.id]);
});

test('<tag>, <tag, </tag> and component names match by name', () => {
  const { nodes, banner, button, plain } = markup();
  assert.deepEqual(found(nodes, '<section>'), [banner.id]);
  assert.deepEqual(found(nodes, '</section>'), [banner.id]);
  assert.deepEqual(found(nodes, '<Button>'), [button.id]);
  assert.deepEqual(found(nodes, '<butt'), [button.id], 'unclosed is a prefix');
  assert.deepEqual(found(nodes, '<p>'), [plain.id]);
  assert.deepEqual(found(nodes, '<sect>'), [], 'closed is exact');
});

test('comments match by text in /* */, /*, /*text, and <!-- forms; a comment labelling a row brings the row', () => {
  const { nodes, note, banner, loose } = markup();
  assert.deepEqual(found(nodes, '/* hero banner */'), [note.id, banner.id], 'the row the comment labels is kept with it');
  assert.deepEqual(found(nodes, '/* hero'), [note.id, banner.id]);
  assert.deepEqual(found(nodes, '/*hero'), [note.id, banner.id]);
  assert.deepEqual(found(nodes, '<!-- hero banner -->'), [note.id, banner.id]);
  assert.deepEqual(found(nodes, '/* trailing'), [loose.id], 'a comment labelling nothing is a row of its own');
  assert.equal(found(nodes, '/*').length > 0, true, 'a bare opener finds every comment');
  assert.deepEqual(found(nodes, '/* nothing here'), []);
});

test('terms are joined by AND on one row, and plain words keep working beside them', () => {
  const { nodes, banner } = markup();
  assert.deepEqual(found(nodes, '<section> .banner [hidden]'), [banner.id]);
  assert.deepEqual(found(nodes, '<section> .lede'), []);
  assert.deepEqual(found(nodes, 'section banner'), [banner.id]);
});

test('partial and malformed input falls back to plain words and never throws', () => {
  const { nodes } = markup();
  for (const query of [
    '[',
    '[data-theme',
    '[data-theme=',
    '[=x]',
    '[]',
    '[a b]',
    '.',
    '#',
    '<',
    '</',
    '<>',
    '/',
    '{/*',
    '[data-theme^]',
    '[[[[',
    '....',
    '<<<<',
  ]) {
    assert.doesNotThrow(() => run(nodes, query), query);
    assert.ok(Array.isArray(run(nodes, query).nodes));
  }
  assert.deepEqual(
    search.parseNavigatorQuery('.').map((term) => term.kind),
    ['word'],
  );
  assert.deepEqual(
    search.parseNavigatorQuery('[data-x').map((term) => term.kind),
    ['word'],
  );
});

test('the parser is bounded: a long query is cut and the number of terms is capped', () => {
  const long = search.parseNavigatorQuery('a'.repeat(5_000));
  assert.equal(long.length, 1);
  assert.ok(long[0].word.length <= search.NAVIGATOR_QUERY_LENGTH_MAX);
  assert.ok(search.parseNavigatorQuery('.a '.repeat(100)).length <= search.NAVIGATOR_TERMS_MAX);
  const started = Date.now();
  search.parseNavigatorQuery('['.repeat(5_000) + '"'.repeat(5_000));
  assert.ok(Date.now() - started < 1_000, 'adversarial input is read in a pass');
});

test('each kind of term gives the words the panel marks', () => {
  assert.deepEqual(search.navigatorHighlightWords('.btn'), ['btn']);
  assert.deepEqual(search.navigatorHighlightWords('#top'), ['top']);
  assert.deepEqual(search.navigatorHighlightWords('<Button>'), ['button']);
  assert.deepEqual(search.navigatorHighlightWords('[data-x="Dark Mode"]'), ['dark mode']);
  assert.deepEqual(search.navigatorHighlightWords('[hidden]'), ['hidden']);
  assert.deepEqual(search.navigatorHighlightWords('/* Hero banner'), ['hero', 'banner']);
  assert.deepEqual(search.navigatorHighlightWords('plain Words'), ['plain', 'words']);
});

test('5,000 nodes searched with selector queries cost no more than the same work over 65', () => {
  const large = big(5_000);
  const small = big(65);
  const largeIndex = search.buildNavigatorIndex(large);
  const smallIndex = search.buildNavigatorIndex(small);
  const passes = Math.ceil(5_000 / 65);
  for (const query of ['.qq-none', '[data-qq=none]', '<qqnone>', '/* qq none']) {
    const largeTime = bestOf(7, () => search.searchNavigator(large, largeIndex, query));
    const smallTime = bestOf(7, () => {
      for (let pass = 0; pass < passes; pass += 1) {
        search.searchNavigator(small, smallIndex, query);
      }
    });
    assert.ok(largeTime <= smallTime * 6, `${query}: ${largeTime} ns over 5,000 nodes vs ${smallTime} ns over ${passes} walks of 65`);
  }
});
