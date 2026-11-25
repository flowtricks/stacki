// Goal: the keys that open the insert palette and toggle the preview do what
// their tooltips and the menu say. ⌘F, ⌘E and ⌘K all open the palette; a rich
// text field that claims ⌘K (link) or ⌘E (code) first keeps it; the code editor
// keeps its own find. ⌥P is Option and P alone, matched on the physical key.
// Method: handleCommandKey and isPreviewKey are driven with plain event-shaped
// objects, counting palette opens, across the positive and negative space.
const assert = require('node:assert/strict');
const load = require('../../helpers/rendererModule');

globalThis.HTMLElement = globalThis.HTMLElement ?? class HTMLElement {};
const { handleCommandKey, INSERT_PALETTE_KEYS } = load('src/app/model/appKeys.ts');
const { isPreviewKey } = load('src/app/state/appShortcuts.ts');

function run({ key, meta = true, defaultPrevented = false, editable = true }) {
  let opened = 0;
  let prevented = false;
  const event = {
    key,
    metaKey: meta,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    defaultPrevented,
    target: undefined,
    preventDefault: () => {
      prevented = true;
    },
  };
  const keys = {
    pageStateRef: { current: { pageState: { editable } } },
    setInsertOpen: (open) => {
      assert.equal(open, true);
      opened++;
    },
  };
  const handled = handleCommandKey(event, keys);
  return { handled, opened, prevented };
}

assert.deepEqual([...INSERT_PALETTE_KEYS].sort(), ['e', 'f', 'k']);
for (const key of ['f', 'e', 'k', 'K']) {
  assert.deepEqual(run({ key }), { handled: true, opened: 1, prevented: true }, `⌘${key} opens the insert palette`);
}
assert.deepEqual(run({ key: 'k', defaultPrevented: true }), { handled: true, opened: 0, prevented: false }, 'a field that took ⌘K keeps it');
assert.deepEqual(run({ key: 'k', editable: false }), { handled: true, opened: 0, prevented: false }, 'a page that cannot be edited opens nothing');
assert.equal(run({ key: 'k', meta: false }).opened, 0, 'K alone is not the palette');
assert.equal(run({ key: 'j' }).opened, 0, '⌘J is not the palette');

const press = (fields) => ({ altKey: false, metaKey: false, ctrlKey: false, shiftKey: false, code: 'KeyP', ...fields });
assert.equal(isPreviewKey(press({ altKey: true })), true, '⌥P toggles the preview');
assert.equal(isPreviewKey(press({})), false, 'P alone does not');
assert.equal(isPreviewKey(press({ altKey: true, metaKey: true })), false, '⌥⌘P does not');
assert.equal(isPreviewKey(press({ altKey: true, shiftKey: true })), false, '⌥⇧P does not');
assert.equal(isPreviewKey(press({ altKey: true, ctrlKey: true })), false, '⌃⌥P does not');
assert.equal(isPreviewKey(press({ altKey: true, code: 'KeyO' })), false, '⌥O does not');

console.log('app-command-keys: 16 passed');
