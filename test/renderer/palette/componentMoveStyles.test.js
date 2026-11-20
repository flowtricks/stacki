// Goal: "Move styles" in Create component moves exactly the chosen classes' rules: what the component's new tag
// carries is what leaves the page's <style> tags and the stylesheets, by one rule, so no rule is lost or written
// twice; a rule that also needs a class not chosen stays; an at-rule left empty goes; keyframes stay. Copy first,
// delete last: the sheets give up the rules only after the page uses the component, and get them back before it stops,
// so at no write is a rule missing. Undo and redo are all or nothing: a sheet edited by someone refuses the whole step
// before anything is written, and a sheet changed under a write is never overwritten. The page's tags change in the
// same gesture, or not at all when they changed since. The toast names the moved styles.
// Method: the real modules through the renderer loader, on hand-written CSS and page nodes; the sheets' writes run
// against an in-memory disk that refuses a write unless the file holds the expected text, as main's actor does, and
// which the test edits in between, as a person would. Undo and redo run through stepWithFiles, the history's own path,
// with the invariants checked after every write.
const test = require('node:test');
const assert = require('node:assert/strict');
const load = require('../../helpers/rendererModule');
const { planStyleMove, pageStyleNodes } = load('src/editor/componentStyles.ts');
const { withoutCarried } = load('src/editor/pasteStyles.ts');
const { movedStyleFiles, sequencedFiles, stepWithFiles } = load('src/app/model/componentCreation.ts');
const { movedStylesEdit, createdComponentMessage } = load('src/app/model/pageGestures.ts');

const element = (id, classes, children = []) => ({ id, kind: 'element', name: 'div', props: { class: { type: 'string', value: classes } }, children });
const styleTag = (id, inner) => ({ id, kind: 'raw', name: 'style', props: { 'is:global': { type: 'bare' } }, inner });
const card = element('card', 'card', [element('title', 'card_title u-gap')]);
const sheet = (rel, css) => ({ path: `/site/${rel}`, rel, css });
const squash = (css) => css.replace(/\s+/g, ' ').trim();

test('the chosen classes’ rules leave the sheet and are what the new tag carries', () => {
  const base = sheet(
    'src/styles/base.css',
    '.card { padding: 1rem; }\n.footer { margin: 0; }\n.card .card_title { font-weight: 700; }\n@media (width > 40em) { .card { padding: 2rem; } }\n',
  );
  const plan = planStyleMove(card, new Set(['card', 'card_title']), [], [base]);
  assert.equal(plan.sheets.length, 1);
  assert.equal(squash(plan.sheets[0].after), '.footer { margin: 0; }', 'only .footer stays, and the emptied @media goes');
  assert.deepEqual(plan.carried.rules.map(squash), [
    '.card { padding: 1rem; }',
    '.card .card_title { font-weight: 700; }',
    '@media (width > 40em) { .card { padding: 2rem; } }',
  ]);
});

test('a selector list loses only its chosen member; a rule needing an unchosen class stays; keyframes stay', () => {
  const css = '.card, .footer { color: red; }\n.card .u-gap { gap: 1rem; }\n@keyframes spin { to { rotate: 1turn; } }\n.card { animation: spin 1s; }\n';
  const plan = planStyleMove(card, new Set(['card']), [], [sheet('src/styles/base.css', css)]);
  const after = squash(plan.sheets[0].after);
  assert.match(after, /^\.footer \{ color: red; \}/, '.footer keeps its rule');
  assert.match(after, /\.card \.u-gap \{ gap: 1rem; \}/, 'u-gap is not chosen, so the rule stays');
  assert.match(after, /@keyframes spin/, 'keyframes stay for whoever else names them');
  assert.doesNotMatch(after, /animation/);
  assert.ok(plan.carried.rules.some((rule) => /^\.card \{\s*color: red;/.test(rule)));
  assert.ok(
    plan.carried.rules.some((rule) => /@keyframes spin/.test(rule)),
    'the animation the moved rule names comes along',
  );
});

test('nothing chosen, an untouched sheet, and CSS that does not parse change nothing', () => {
  const css = '.footer { margin: 0; }';
  assert.deepEqual(planStyleMove(card, new Set(), [], [sheet('a.css', '.card { color: red; }')]).sheets, []);
  assert.deepEqual(planStyleMove(card, new Set(['card']), [], [sheet('a.css', css)]).sheets, []);
  const broken = '.card { color: red;';
  assert.equal(withoutCarried(broken, { classes: new Set(['card']), ids: new Set() }), broken, 'CSS that does not parse is returned as it was');
});

test('the page’s own tags change too, but not a tag inside the markup, which moves with it', () => {
  const inside = styleTag('inside', '.card_title { color: blue; }');
  const page = [
    element('wrap', 'wrap', [{ ...card, children: [...card.children, inside] }]),
    styleTag('pageStyle', '.card { color: red; }\n.wrap { gap: 0; }'),
  ];
  const tags = pageStyleNodes(page, 'card');
  assert.deepEqual(
    tags.map((tag) => tag.id),
    ['pageStyle'],
  );
  const plan = planStyleMove(card, new Set(['card']), tags, []);
  assert.deepEqual(
    plan.pageStyles.map((edit) => [edit.id, squash(edit.inner)]),
    [['pageStyle', '.wrap { gap: 0; }']],
  );
});

test('the page gesture rewrites each tag, removes one left empty, and refuses a tag changed since', () => {
  const model = { imports: [], extraFrontmatter: '', nodes: [card, styleTag('a', '.card { x: 1 }\n.y { z: 2 }'), styleTag('b', '.card { x: 1 }')] };
  const edits = [
    { id: 'a', before: '.card { x: 1 }\n.y { z: 2 }', inner: '\n.y { z: 2 }' },
    { id: 'b', before: '.card { x: 1 }', inner: '\n' },
  ];
  const ready = movedStylesEdit(model, edits);
  assert.equal(ready.kind, 'ready');
  const after = ready.gesture.apply(model);
  assert.deepEqual(
    after.nodes.filter((node) => node.kind === 'raw').map((node) => [node.id, node.inner]),
    [['a', '\n.y { z: 2 }']],
    'b held only moved rules and is gone',
  );
  assert.deepEqual(movedStylesEdit(model, []), { kind: 'none' });
  assert.deepEqual(movedStylesEdit(model, [{ ...edits[0], before: 'something else' }]), { kind: 'changed' });
  assert.deepEqual(movedStylesEdit(model, [{ ...edits[0], id: 'missing' }]), { kind: 'changed' });
});

// An in-memory disk whose writes are refused unless the file holds the expected text, as main's actor does.
function casDisk(entries) {
  const disk = new Map(entries);
  const writes = [];
  const calls = {
    read: async (path) => disk.get(path),
    write: async (path, css, expected) => {
      if (disk.get(path) !== expected) {
        throw new Error(`${path} changed`);
      }
      writes.push(path);
      disk.set(path, css);
    },
    changed: (rels) => `changed: ${rels.join(', ')}`,
  };
  return { disk, writes, calls };
}
const SHEETS = [
  { path: '/site/a.css', rel: 'a.css', before: 'before-a', after: 'after-a' },
  { path: '/site/b.css', rel: 'b.css', before: 'before-b', after: 'after-b' },
];

test('the sheets are cleaned after the page and put back before it, each write refused unless the sheet is unchanged', async () => {
  const { disk, writes, calls } = casDisk([
    ['/site/a.css', 'before-a'],
    ['/site/b.css', 'before-b'],
  ]);
  const files = movedStyleFiles(SHEETS, calls);
  assert.equal(await files.check('redo'), undefined);
  await files.redoAfterPage();
  assert.deepEqual([...disk.values()], ['after-a', 'after-b']);
  await files.redoAfterPage();
  assert.equal(writes.length, 2, 'run again after a partial step, it writes nothing twice');
  assert.equal(await files.check('undo'), undefined);
  await files.undoBeforePage();
  assert.deepEqual([...disk.values()], ['before-a', 'before-b']);
  await files.undo();
  await files.redo();
  assert.equal(writes.length, 4, 'undo and redo themselves leave the sheets to the hooks around the page');
});

test('a sheet edited by someone refuses the whole step, naming it, and a sheet changed under a write is not overwritten', async () => {
  const { disk, calls } = casDisk([
    ['/site/a.css', 'after-a'],
    ['/site/b.css', 'edited by hand'],
  ]);
  const files = movedStyleFiles(SHEETS, calls);
  assert.equal(await files.check('undo'), 'changed: b.css');
  assert.equal(await files.check('redo'), 'changed: b.css');
  disk.set('/site/b.css', 'after-b');
  const racing = {
    ...calls,
    write: async (path, css, expected) => (path === '/site/b.css' ? disk.set(path, 'edited meanwhile') : undefined, calls.write(path, css, expected)),
  };
  await assert.rejects(movedStyleFiles(SHEETS, racing).undoBeforePage(), /b\.css changed/);
  assert.equal(disk.get('/site/b.css'), 'edited meanwhile', 'main refuses the write, the edit stays');
});

// Plays one undo or redo of a move through stepWithFiles, the history's own path, and checks after every write that no
// rule is ever missing: while the page uses the component it exists, and the rules are always in the sheets or in it.
async function stepped(direction, start, checkAnswer = undefined) {
  const state = { ...start };
  const order = [];
  const holds = () => {
    assert.ok(!state.pageUsesComponent || state.component, `${order.join(' > ')}: the page never uses a missing component`);
    assert.ok(state.rulesInSheets || state.component, `${order.join(' > ')}: the rules are always somewhere`);
  };
  const log = (step, change) => async () => {
    order.push(step);
    Object.assign(state, change);
    holds();
  };
  const component = {
    check: async () => checkAnswer,
    undoBeforePage: async () => undefined,
    undo: log('component deleted', { component: false }),
    redo: log('component created', { component: true }),
    redoAfterPage: async () => undefined,
  };
  const sheets = {
    check: async () => undefined,
    undoBeforePage: log('rules back in sheets', { rulesInSheets: true }),
    undo: async () => undefined,
    redo: async () => undefined,
    redoAfterPage: log('rules out of sheets', { rulesInSheets: false }),
  };
  const outcome = await stepWithFiles(direction, sequencedFiles(component, sheets), async () => {
    order.push(direction === 'undo' ? 'page reverted' : 'page replayed');
    state.pageUsesComponent = direction === 'redo';
    holds();
    return 'whole';
  });
  return { outcome, order, state };
}

test('undo: rules back in the sheets, then the page, then the component goes; redo the mirror; never a rule missing', async () => {
  const moved = { component: true, pageUsesComponent: true, rulesInSheets: false };
  const undone = await stepped('undo', moved);
  assert.equal(undone.outcome.tag, 'stepped');
  assert.deepEqual(undone.order, ['rules back in sheets', 'page reverted', 'component deleted']);
  assert.deepEqual(undone.state, { component: false, pageUsesComponent: false, rulesInSheets: true }, 'exactly as before the move');
  const redone = await stepped('redo', undone.state);
  assert.deepEqual(redone.order, ['component created', 'page replayed', 'rules out of sheets']);
  assert.deepEqual(redone.state, moved);
});

test('a refused check stops the step before anything is written', async () => {
  const moved = { component: true, pageUsesComponent: true, rulesInSheets: false };
  const refused = await stepped('undo', moved, 'changed: base.css');
  assert.deepEqual(refused.outcome, { tag: 'refused', message: 'changed: base.css' });
  assert.deepEqual(refused.order, [], 'not even the page moved');
  assert.deepEqual(refused.state, moved);
});

test('the toast names the moved styles, alone or with values and props', () => {
  const translate = (key, params = {}) => `${key}${JSON.stringify(params)}`;
  assert.match(
    createdComponentMessage('src/components/Card.astro', { props: 0, moved: 0, styles: 2 }, { stranded: false }, translate),
    /createdWithOne.*movedStyles/,
  );
  assert.match(createdComponentMessage('src/components/Card.astro', { props: 1, moved: 1, styles: 2 }, { stranded: false }, translate), /createdWithThree/);
  assert.match(
    createdComponentMessage('src/components/Card.astro', { props: 0, moved: 0, styles: 0 }, { stranded: false }, translate),
    /^shell\.component\.created\{/,
  );
});
