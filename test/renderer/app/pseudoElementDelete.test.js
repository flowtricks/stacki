// Goal: a ::before or ::after is drawn by CSS, so while one is the selection
// Delete, Backspace and Cut remove nothing: not the element it belongs to, not
// its rule. Its row selects the element, with a pick naming the layer, so the
// selected id alone would delete the element. Delete in a text field stays the
// field's, and an element with no pseudo-element picked still deletes.
// Method: the rule (deletableSelection) is checked on its own; handleAppKeyDown
// is driven with event-shaped objects for the Navigator (an element holds focus)
// and for the canvas (the replayed key, targeted at the document); and the
// desktop actions are read for what the element menu is told. A write can only
// start at removeNode, so a call to it is what "changed something" means here.
const assert = require('node:assert/strict');
const load = require('../../helpers/rendererModule');

class FakeElement {
  constructor(field) {
    this.field = field;
    this.isContentEditable = false;
  }
  closest(selector) {
    return this.field && selector.includes('input') ? this : undefined;
  }
}
globalThis.HTMLElement = FakeElement;

const { handleAppKeyDown } = load('src/app/model/appKeys.ts');
const { deletableSelection, selectedPseudo } = load('src/app/model/selectionDeletion.ts');
const { desktopElementActions } = load('src/app/shell/desktopElementActions.ts');

const PICKS = ['before', 'after'].map((pseudo) => ({ nodeId: 'pricing_wrap', pseudo, serial: 1 }));
const DELETE_KEYS = ['Delete', 'Backspace'];
const PATHS = [
  ['Navigator', () => new FakeElement(false)],
  ['canvas', () => ({})],
];

function press({ key, target, pick, selection = 'pricing_wrap' }) {
  const removed = [];
  let prevented = false;
  const event = {
    key,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    defaultPrevented: false,
    target,
    preventDefault: () => {
      prevented = true;
    },
  };
  const selectedIdRef = { current: selection };
  const pseudoPickRef = { current: pick };
  handleAppKeyDown(event, {
    cmsOpenRef: { current: false },
    pageStateRef: { current: { pageState: { editable: true } } },
    selectedIdRef,
    pseudoPickRef,
    removeNode: (id) => removed.push(id),
  });
  assert.equal(selectedIdRef.current, selection, 'the key leaves the selection alone');
  assert.equal(pseudoPickRef.current, pick, 'the key leaves the pick alone');
  return { removed, prevented };
}

// The rule.
for (const pick of PICKS) {
  assert.equal(selectedPseudo('pricing_wrap', pick), pick.pseudo);
  assert.equal(deletableSelection('pricing_wrap', pick), undefined, `::${pick.pseudo} cannot be deleted`);
  assert.equal(selectedPseudo('other', pick), undefined, 'a pick held for another node is not the selection');
  assert.equal(deletableSelection('other', pick), 'other', 'so that node can be deleted');
}
assert.equal(deletableSelection('pricing_wrap', undefined), 'pricing_wrap');
assert.equal(deletableSelection(undefined, undefined), undefined, 'nothing selected');
assert.equal(deletableSelection('', undefined), undefined, 'an empty id names nothing');
assert.equal(deletableSelection('frontmatter', undefined), undefined, 'the frontmatter is not a node');
assert.throws(() => selectedPseudo('pricing_wrap', { nodeId: '', pseudo: 'before', serial: 1 }), /a pseudo-element belongs to a node/);

// The keys, from each place they can arrive.
for (const [path, target] of PATHS) {
  for (const key of DELETE_KEYS) {
    for (const pick of PICKS) {
      assert.deepEqual(press({ key, target: target(), pick }), { removed: [], prevented: false }, `${key} on ::${pick.pseudo} from the ${path}`);
    }
    assert.deepEqual(
      press({ key, target: target(), pick: undefined }),
      { removed: ['pricing_wrap'], prevented: true },
      `${key} on an element from the ${path}`,
    );
    assert.deepEqual(
      press({ key, target: target(), pick: PICKS[0], selection: 'other' }),
      { removed: ['other'], prevented: true },
      `${key} from the ${path} ignores a pick left on another node`,
    );
  }
}

// A text field keeps its own Delete, with a pseudo-element selected or not.
for (const key of DELETE_KEYS) {
  for (const pick of [...PICKS, undefined]) {
    assert.deepEqual(press({ key, target: new FakeElement(true), pick }), { removed: [], prevented: false }, `${key} in a field`);
  }
}

// The element menu, which is asked about the node it opened on.
const menuFor = (selectedId, pseudoPick) => desktopElementActions({ defaultsCanvas: { rootId: undefined, state: { kind: 'busy' } }, selectedId, pseudoPick });
for (const pick of PICKS) {
  assert.equal(menuFor('pricing_wrap', pick).canDeleteNode('pricing_wrap'), false, `the menu offers no Delete on ::${pick.pseudo}`);
}
assert.equal(menuFor('pricing_wrap', undefined).canDeleteNode('pricing_wrap'), true, 'the menu deletes an element');

console.log('pseudo-element-delete: all checks passed');
