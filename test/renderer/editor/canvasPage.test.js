// Goal: while a component is open, the Style panel is told the page the canvas
// shows it on, never the component itself. Opening a component makes it the
// current page, and handing that path on as the page made the panel skip the
// page's `<style>`: a button turned into a component showed no selector chips,
// though a page rule written `:global(.button)` styled it on the canvas.
// Method: edit stacks as the app builds them (the page, then each component
// opened from it), checked through canvasPageOf; then the negative space: a
// page alone, an empty stack, a stack that starts at a component, and the
// assertion that a component is never its own page.
const assert = require('node:assert/strict');
const load = require('../../helpers/rendererModule');
const { canvasPageOf } = load('src/editor/pageState.ts');

const page = { kind: 'page', path: '/site/src/pages/index.astro', name: 'index' };
const button = { kind: 'component', path: '/site/src/components/Button.astro', name: 'Button', hostKey: '0.1' };
const icon = { kind: 'component', path: '/site/src/components/Icon.astro', name: 'Icon', hostKey: '0.0' };

assert.equal(canvasPageOf([page, button]), page.path, 'a component open on a page names that page, not itself');
assert.equal(canvasPageOf([page, button, icon]), page.path, 'a nested component still names the page the canvas shows');

assert.equal(canvasPageOf([page]), undefined, 'a page open on its own has no other page');
assert.equal(canvasPageOf([]), undefined, 'nothing open names nothing');
assert.equal(canvasPageOf([button]), undefined, 'a component opened on its own names no page');
assert.equal(canvasPageOf([button, icon]), undefined, 'nor does a stack that starts at a component');

assert.throws(
  () => canvasPageOf([{ ...page, path: button.path }, button]),
  /canvasPageOf: a component is not the page it is shown on/,
  'a component is never the page it is shown on',
);

console.log('canvas-page: 7 passed');
