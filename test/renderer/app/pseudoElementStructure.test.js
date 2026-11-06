// Goal: a ::before or ::after is drawn by CSS, so while one is the selection the
// structural actions change nothing: Delete, Backspace, Cut, ⌘C, Copy, ⌘D,
// Duplicate, Wrap and ⌘⇧A (make a component) leave the element it belongs to and
// its rule alone, and a later ⌘V has no clone of the element to paste.
// Its row selects the element, with a pick naming the layer, so the selected id
// alone would act on the element. A blocked key is left to the browser. Keys in a
// text field stay the field's, selected text still copies natively, and an element
// with no pseudo-element picked still deletes, copies, duplicates and wraps.
// Method: the rule (structuralSelection) is checked on its own; handleAppKeyDown
// is driven with event-shaped objects for the Navigator (an element holds focus)
// and for the canvas (the replayed key, targeted at the document); menuCopy is
// called as the Edit menu calls it, with the focus and text selection set; and the
// desktop actions are read for what the element menu is told, which covers Wrap:
// it has no key. navigatorContextMenu.test.js clicks the menu those answers drive.
// A write can only start at removeNode or duplicateNode, a component only at
// setCreateRequest and a clipboard entry only at copyNode, so a call to one is
// what "changed something" means here.
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
// Copy asks whether text is selected, and none is until a check sets some. The
// menu's Copy hands a field or selected text to the browser through nativeCopy.
let selectedText = '';
let nativeCopies = 0;
globalThis.window = {
  getSelection: () => selectedText,
  avb: {
    nativeCopy: async () => {
      nativeCopies++;
      return { ok: true };
    },
  },
};
globalThis.document = { activeElement: undefined };

const { handleAppKeyDown, menuCopy } = load('src/app/model/appKeys.ts');
const { structuralSelection, selectedPseudo } = load('src/app/model/selectionStructure.ts');
const { desktopElementActions } = load('src/app/shell/desktopElementActions.ts');

const PICKS = ['before', 'after'].map((pseudo) => ({ nodeId: 'pricing_wrap', pseudo, serial: 1 }));
const DELETE_KEYS = ['Delete', 'Backspace'];
const PATHS = [
  ['Navigator', () => new FakeElement(false)],
  ['canvas', () => ({})],
];

function press({ key, target, pick, selection = 'pricing_wrap', meta = false, shift = false }) {
  const removed = [];
  const duplicated = [];
  const copied = [];
  let created = 0;
  let prevented = false;
  const event = {
    key,
    metaKey: meta,
    ctrlKey: false,
    shiftKey: shift,
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
    duplicateNode: (id) => duplicated.push(id),
    copyNode: (id) => copied.push(id),
    setLeftTab: () => {},
    setCreateRequest: () => {
      created++;
    },
  });
  assert.equal(selectedIdRef.current, selection, 'the key leaves the selection alone');
  assert.equal(pseudoPickRef.current, pick, 'the key leaves the pick alone');
  return { removed, duplicated, copied, created, prevented };
}

const NOTHING = { removed: [], duplicated: [], copied: [], created: 0, prevented: false };

function copyFromMenu({ pick, selection = 'pricing_wrap' }) {
  const copied = [];
  const nativeBefore = nativeCopies;
  menuCopy({
    selectedIdRef: { current: selection },
    pseudoPickRef: { current: pick },
    pageStateRef: { current: { pageState: { editable: true } } },
    cmsOpenRef: { current: false },
    copyNode: (id) => copied.push(id),
  });
  return { copied, native: nativeCopies - nativeBefore };
}

// The rule.
for (const pick of PICKS) {
  assert.equal(selectedPseudo('pricing_wrap', pick), pick.pseudo);
  assert.equal(structuralSelection('pricing_wrap', pick), undefined, `::${pick.pseudo} cannot be changed`);
  assert.equal(selectedPseudo('other', pick), undefined, 'a pick held for another node is not the selection');
  assert.equal(structuralSelection('other', pick), 'other', 'so that node can be changed');
}
assert.equal(structuralSelection('pricing_wrap', undefined), 'pricing_wrap');
assert.equal(structuralSelection(undefined, undefined), undefined, 'nothing selected');
assert.equal(structuralSelection('', undefined), undefined, 'an empty id names nothing');
assert.equal(structuralSelection('frontmatter', undefined), undefined, 'the frontmatter is not a node');
assert.throws(() => selectedPseudo('pricing_wrap', { nodeId: '', pseudo: 'before', serial: 1 }), /a pseudo-element belongs to a node/);

// The keys, from each place they can arrive.
for (const [path, target] of PATHS) {
  for (const key of DELETE_KEYS) {
    for (const pick of PICKS) {
      assert.deepEqual(press({ key, target: target(), pick }), NOTHING, `${key} on ::${pick.pseudo} from the ${path}`);
    }
    assert.deepEqual(
      press({ key, target: target(), pick: undefined }),
      { ...NOTHING, removed: ['pricing_wrap'], prevented: true },
      `${key} on an element from the ${path}`,
    );
    assert.deepEqual(
      press({ key, target: target(), pick: PICKS[0], selection: 'other' }),
      { ...NOTHING, removed: ['other'], prevented: true },
      `${key} from the ${path} ignores a pick left on another node`,
    );
  }

  for (const pick of PICKS) {
    assert.deepEqual(press({ key: 'd', meta: true, target: target(), pick }), NOTHING, `⌘D on ::${pick.pseudo} from the ${path}`);
    assert.deepEqual(press({ key: 'a', meta: true, shift: true, target: target(), pick }), NOTHING, `⌘⇧A on ::${pick.pseudo} from the ${path}`);
    assert.deepEqual(press({ key: 'c', meta: true, target: target(), pick }), NOTHING, `⌘C on ::${pick.pseudo} from the ${path}`);
  }
  assert.deepEqual(
    press({ key: 'c', meta: true, target: target(), pick: undefined }),
    { ...NOTHING, copied: ['pricing_wrap'], prevented: true },
    `⌘C on an element from the ${path}`,
  );
  assert.deepEqual(
    press({ key: 'c', meta: true, target: target(), pick: PICKS[0], selection: 'other' }),
    { ...NOTHING, copied: ['other'], prevented: true },
    `⌘C from the ${path} ignores a pick left on another node`,
  );
  assert.deepEqual(
    press({ key: 'd', meta: true, target: target(), pick: undefined }),
    { ...NOTHING, duplicated: ['pricing_wrap'], prevented: true },
    `⌘D on an element from the ${path}`,
  );
  assert.deepEqual(
    press({ key: 'd', meta: true, target: target(), pick: PICKS[0], selection: 'other' }),
    { ...NOTHING, duplicated: ['other'], prevented: true },
    `⌘D from the ${path} ignores a pick left on another node`,
  );
  assert.deepEqual(
    press({ key: 'a', meta: true, shift: true, target: target(), pick: undefined }),
    { ...NOTHING, created: 1, prevented: true },
    `⌘⇧A on an element from the ${path}`,
  );
}

// A text field keeps its own Delete, with a pseudo-element selected or not.
for (const key of DELETE_KEYS) {
  for (const pick of [...PICKS, undefined]) {
    assert.deepEqual(press({ key, target: new FakeElement(true), pick }), NOTHING, `${key} in a field`);
  }
}
for (const pick of [...PICKS, undefined]) {
  assert.deepEqual(press({ key: 'd', meta: true, target: new FakeElement(true), pick }), NOTHING, '⌘D in a field');
  assert.deepEqual(press({ key: 'c', meta: true, target: new FakeElement(true), pick }), NOTHING, '⌘C in a field is left to the field');
}

// Selected text keeps the browser's copy: the key is neither taken nor prevented.
selectedText = 'Pricing';
for (const pick of [...PICKS, undefined]) {
  assert.deepEqual(press({ key: 'c', meta: true, target: {}, pick }), NOTHING, '⌘C over selected text');
}
selectedText = '';

// The frontmatter is no node to duplicate or copy.
assert.deepEqual(press({ key: 'd', meta: true, target: {}, pick: undefined, selection: 'frontmatter' }), NOTHING, '⌘D on the frontmatter');
assert.deepEqual(press({ key: 'c', meta: true, target: {}, pick: undefined, selection: 'frontmatter' }), NOTHING, '⌘C on the frontmatter');

// The Edit menu's Copy, which is what ⌘C reaches on macOS: the menu takes the key first.
for (const pick of PICKS) {
  assert.deepEqual(copyFromMenu({ pick }), { copied: [], native: 0 }, `the menu's Copy on ::${pick.pseudo}`);
}
assert.deepEqual(copyFromMenu({ pick: undefined }), { copied: ['pricing_wrap'], native: 0 }, "the menu's Copy on an element");
assert.deepEqual(copyFromMenu({ pick: PICKS[0], selection: 'other' }), { copied: ['other'], native: 0 }, "the menu's Copy ignores a pick left on another node");
assert.deepEqual(copyFromMenu({ pick: undefined, selection: 'frontmatter' }), { copied: [], native: 0 }, "the menu's Copy on the frontmatter");

// A focused field and selected text get the native copy, with a pseudo-element selected or not.
const textField = Object.assign(new FakeElement(true), { tagName: 'INPUT' });
for (const pick of [...PICKS, undefined]) {
  globalThis.document.activeElement = textField;
  assert.deepEqual(copyFromMenu({ pick }), { copied: [], native: 1 }, "the menu's Copy in a field");
  globalThis.document.activeElement = undefined;
  selectedText = 'Pricing';
  assert.deepEqual(copyFromMenu({ pick }), { copied: [], native: 1 }, "the menu's Copy over selected text");
  selectedText = '';
}

// The element menu, which is asked about the node it opened on.
const menuFor = (selectedId, pseudoPick) => desktopElementActions({ defaultsCanvas: { rootId: undefined, state: { kind: 'busy' } }, selectedId, pseudoPick });
for (const pick of PICKS) {
  assert.equal(menuFor('pricing_wrap', pick).canChangeStructure('pricing_wrap'), false, `the menu changes nothing on ::${pick.pseudo}`);
}
assert.equal(menuFor('pricing_wrap', undefined).canChangeStructure('pricing_wrap'), true, 'the menu changes an element');

console.log('pseudo-element-structure: all checks passed');
