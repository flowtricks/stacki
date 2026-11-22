// Goal: each Style selectors tab that lists nothing shows its own empty-state card: Unused, Locked and
// All say why they are empty (Unused and Locked offer "Show all styles"), a search that finds nothing
// says "No matches" on any tab, and a project with no selectors at all says so with no action.
// Method: render the real selectorEmptyState (and the shared EmptyState it builds on) to static markup
// over a fake translator that returns each key, so the test pins which message each case chooses
// without depending on wording, and check the Show all action calls back.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { renderToStaticMarkup } = require('react-dom/server');
const loadRenderer = require('../../helpers/rendererModule.js');

const { selectorEmptyState } = loadRenderer('src/features/selectors/selectorEmptyState.tsx');

const translate = (key) => key;
const withEntries = { entries: [{ id: 'one' }] };
const noEntries = { entries: [] };

function render(report, filter, search, onShowAll = () => undefined) {
  return renderToStaticMarkup(selectorEmptyState(report, filter, search, translate, onShowAll));
}

test('Unused, empty: the all-in-use title, the existing sentence, and Show all', () => {
  const html = render(withEntries, 'unused', '');
  assert.match(html, /selectors\.empty\.unusedTitle/);
  assert.match(html, /selectors\.empty\.noUnused/);
  assert.match(html, /selectors\.empty\.showAll/);
  assert.match(html, /ui-empty-state-icon/);
});

test('Locked, empty: the no-locked title, its sentence, and Show all', () => {
  const html = render(withEntries, 'kept', '');
  assert.match(html, /selectors\.empty\.lockedTitle/);
  assert.match(html, /selectors\.empty\.noLocked/);
  assert.match(html, /selectors\.empty\.showAll/);
});

test('All, empty: the no-styles title, and no action since there is nothing else to show', () => {
  for (const report of [noEntries, withEntries]) {
    const html = render(report, 'all', '');
    assert.match(html, /selectors\.empty\.allTitle/);
    assert.match(html, /selectors\.empty\.noSelectors/);
    assert.doesNotMatch(html, /showAll/);
  }
});

test('a project with no selectors says so on every tab, with no action', () => {
  for (const filter of ['all', 'unused', 'unknown', 'kept']) {
    const html = render(noEntries, filter, '');
    assert.match(html, /selectors\.empty\.allTitle/, filter);
    assert.doesNotMatch(html, /showAll/, filter);
  }
});

test('a search with no results is No matches on any tab, even when the tab is empty too', () => {
  for (const filter of ['all', 'unused', 'unknown', 'kept']) {
    const html = render(withEntries, filter, 'zzz');
    assert.match(html, /selectors\.empty\.searchTitle/, filter);
    assert.match(html, /selectors\.empty\.noMatch/, filter);
    assert.doesNotMatch(html, /showAll/, filter);
  }
  assert.doesNotMatch(render(withEntries, 'unused', '   '), /searchTitle/, 'blank search text is not a search');
});

test('Can’t tell, empty: the nothing-uncertain card with Show all', () => {
  const html = render(withEntries, 'unknown', '');
  assert.match(html, /selectors\.empty\.certainTitle/);
  assert.match(html, /selectors\.empty\.showAll/);
});

test('the Show all button calls back', () => {
  let called = 0;
  const element = selectorEmptyState(withEntries, 'unused', '', translate, () => (called += 1));
  const button = element.props.action;
  assert.equal(button.type, 'button');
  button.props.onClick();
  assert.equal(called, 1);
});

test('every variant sits at the top by default, and the card can opt into the middle', () => {
  for (const filter of ['all', 'unused', 'unknown', 'kept']) {
    assert.match(render(withEntries, filter, ''), /ui-empty-state ui-empty-state-start/, filter);
  }
  assert.match(render(withEntries, 'all', 'zzz'), /ui-empty-state-start/, 'search variant too');
  const { EmptyState } = loadRenderer('src/ui/EmptyState.tsx');
  const html = renderToStaticMarkup(EmptyState({ icon: undefined, title: 't', align: 'center' }));
  assert.match(html, /ui-empty-state-center/);
});

test('the icon is neutral for every variant: dim text on a neutral fill, never the accent', () => {
  const fs = require('node:fs');
  const { repoPath } = require('../../helpers/sources.js');
  const css = fs.readFileSync(repoPath('src/ui/emptyState.css'), 'utf8');
  const icon = css.slice(css.indexOf('.ui-empty-state-icon {'), css.indexOf('}', css.indexOf('.ui-empty-state-icon {')));
  assert.match(icon, /color: var\(--text-dim\)/);
  assert.match(icon, /background: var\(--bg-active\)/);
  assert.doesNotMatch(icon, /accent/);
  const panelCss = fs.readFileSync(repoPath('src/features/selectors/selectors.css'), 'utf8');
  assert.doesNotMatch(panelCss, /selectors-body:has/, 'the panel no longer turns its body into a centring column');
  assert.match(panelCss, /\.selectors-body > \.ui-empty-state \{[^}]*margin-block-start: 4px/);
});
