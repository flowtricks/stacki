// Goal: the Style selectors panel's first-open tab is decided by the counts its badges show (Unused
// when any, else Locked when any, else All), and the tab a person picks is remembered per project,
// bounded to 50 projects, with anything unreadable in storage treated as absent.
// Method: run the real modules (selectorList.ts, selectorTabPreference.ts) through the app's bundler
// over hand-made counts and an in-memory storage, including the negative space: malformed JSON,
// unknown tab names, wrong shapes, oversized and duplicated entries, and storage that throws.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const loadRenderer = require('../../helpers/rendererModule.js');

const { initialFilter, isSelectorFilter } = loadRenderer('src/features/selectors/selectorList.ts');
const tabs = loadRenderer('src/features/selectors/selectorTabPreference.ts');

const counts = (unused, unknown, kept, all) => ({ unused, unknown, kept, all });
function memoryStorage(initial) {
  const values = new Map(initial === undefined ? [] : [[tabs.SELECTOR_TAB_KEY, initial]]);
  return { values, getItem: (key) => values.get(key) ?? undefined, setItem: (key, value) => values.set(key, value) };
}

test('the first-open tab is Unused, else Locked, else All', () => {
  assert.equal(initialFilter(counts(3, 2, 78, 495)), 'unused', 'unused wins over locked');
  assert.equal(initialFilter(counts(1, 0, 0, 5)), 'unused');
  assert.equal(initialFilter(counts(0, 4, 78, 495)), 'kept', 'locked when nothing is unused');
  assert.equal(initialFilter(counts(0, 4, 0, 10)), 'all', "only Can't tell does not open that tab");
  assert.equal(initialFilter(counts(0, 0, 0, 0)), 'all', 'an empty project opens on All');
});

test('only the four tabs are tabs', () => {
  for (const tab of ['all', 'unused', 'unknown', 'kept']) {
    assert.equal(isSelectorFilter(tab), true);
  }
  for (const value of ['', 'locked', 'ALL', undefined, 3, {}, ['all']]) {
    assert.equal(isSelectorFilter(value), false);
  }
});

test('a stored tab wins, per project, and an invalid one is absent', () => {
  const storage = memoryStorage();
  assert.equal(tabs.loadSelectorTab('/one', storage), undefined, 'no stored tab is absent, so the default applies');
  tabs.saveSelectorTab('/one', 'kept', storage);
  tabs.saveSelectorTab('/two', 'unknown', storage);
  assert.equal(tabs.loadSelectorTab('/one', storage), 'kept');
  assert.equal(tabs.loadSelectorTab('/two', storage), 'unknown');
  tabs.saveSelectorTab('/one', 'all', storage);
  assert.equal(tabs.loadSelectorTab('/one', storage), 'all', 'a later pick replaces the earlier one');
  assert.equal(tabs.loadSelectorTab('/two', storage), 'unknown', 'changing one leaves the other');
  assert.equal(tabs.loadSelectorTab('/three', storage), undefined);
  assert.equal(JSON.parse(storage.values.get(tabs.SELECTOR_TAB_KEY))[0][0], '/one', 'the newest pick is first');

  const bad = [
    'not json',
    '{"a":1}',
    '[["/one","locked"]]',
    '[["/one",5]]',
    '[["/one"]]',
    '[["/one","all","extra"]]',
    '[["","all"]]',
    '[[7,"all"]]',
    '[null]',
    `[["${'x'.repeat(5000)}","all"]]`,
  ];
  for (const raw of bad) {
    assert.equal(tabs.loadSelectorTab('/one', memoryStorage(raw)), undefined, raw.slice(0, 40));
  }
  const mixed = memoryStorage('[["/one","bogus"],["/two","kept"],["/two","all"]]');
  assert.equal(tabs.loadSelectorTab('/one', mixed), undefined, 'an unknown tab is absent');
  assert.equal(tabs.loadSelectorTab('/two', mixed), 'kept', 'the first entry of a duplicated project wins');
});

test('only the 50 most recently changed projects are remembered', () => {
  const storage = memoryStorage();
  for (let index = 0; index < tabs.SELECTOR_TAB_PROJECTS_MAX + 10; index += 1) {
    tabs.saveSelectorTab(`/project-${index}`, 'unused', storage);
  }
  assert.equal(tabs.SELECTOR_TAB_PROJECTS_MAX, 50);
  assert.equal(JSON.parse(storage.values.get(tabs.SELECTOR_TAB_KEY)).length, 50);
  assert.equal(tabs.loadSelectorTab('/project-0', storage), undefined, 'the oldest is forgotten');
  assert.equal(tabs.loadSelectorTab('/project-59', storage), 'unused');
  const oversized = JSON.stringify(Array.from({ length: 80 }, (_, index) => [`/p${index}`, 'all']));
  assert.equal(tabs.loadSelectorTab('/p79', memoryStorage(oversized)), undefined, 'a list longer than the bound is cut when read');
  assert.equal(tabs.loadSelectorTab('/p49', memoryStorage(oversized)), 'all');
});

test('missing or blocked storage never throws', () => {
  const blocked = {
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('full');
    },
  };
  assert.equal(tabs.loadSelectorTab('/one', blocked), undefined);
  assert.doesNotThrow(() => tabs.saveSelectorTab('/one', 'all', blocked));
});
