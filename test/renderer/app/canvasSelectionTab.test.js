// Goal: a canvas selection must not close the Apps panel (a running app needs the
// selection while it stays visible) or the Code panel, and must still send every
// other left panel to the Navigator so the selected row is visible.
// Method: leftTabAfterCanvasSelection is the updater selectCanvasPath hands to
// setLeftTab; it is checked for every left tab, then driven through a React-style
// setter so a tab held in state ends where the user would see it.
const assert = require('node:assert/strict');
const load = require('../../helpers/rendererModule');

const { leftTabAfterCanvasSelection } = load('src/app/model/canvasSelectionTab.ts');

const KEPT = ['apps', 'code'];
const MOVED = ['pages', 'navigator', 'properties', 'components', 'assets', 'cms', 'variables', 'selectors', 'history'];

for (const tab of KEPT) {
  assert.equal(leftTabAfterCanvasSelection(tab), tab, `${tab} stays open`);
}
for (const tab of MOVED) {
  assert.equal(leftTabAfterCanvasSelection(tab), 'navigator', `${tab} gives way to the navigator`);
}

let held = 'apps';
const setLeftTab = (update) => {
  held = update(held);
};
setLeftTab(leftTabAfterCanvasSelection);
assert.equal(held, 'apps', 'a selection with Apps active leaves Apps');
held = 'pages';
setLeftTab(leftTabAfterCanvasSelection);
assert.equal(held, 'navigator', 'a selection with Pages active still opens the Navigator');
console.log('canvasSelectionTab ok');
