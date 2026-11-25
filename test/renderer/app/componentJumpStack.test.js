// Goal: opening components from a list that names their files (an audit finding, the Components panel, a usage list)
// never stacks them. The bug: each audit finding in another component pushed one more level, so after opening Choice,
// Select, Footer, Nav, Dropdown, Modal and Slider the green back arrow took seven presses to reach the page.
// Method: the real stackAfterJump, stackWith and componentEntry from src/app/model, fed the stacks the app holds. A jump
// keeps the page-level origin and replaces the components above it; a drill (from an instance) still nests; the back
// arrow, Escape and the title bar all pop one entry (closeComponent), so "back" here is dropping the top entry. The
// call sites are checked as source, because they are React modules the node runner does not mount.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const load = require('../../helpers/rendererModule');
const { repoPath } = require('../../helpers/sources.js');

const { stackAfterJump, stackWith } = load('src/app/model/appKeys.ts');
const { componentEntry } = load('src/app/model/pageGestures.ts');

const page = { kind: 'page', name: 'index.astro', path: '/p/src/pages/index.astro', route: '/' };
const NAMES = ['Choice', 'Select', 'Footer', 'Nav', 'Dropdown', 'Modal', 'Slider'];
const component = (name) => ({ name, path: `/p/src/components/${name}.astro` });
// What openComponent builds for a jump: no host instance, focus worked out against the page alone.
const jumped = (stack, name) => componentEntry(stack.slice(0, 1), [], component(name), { path: undefined, occurrence: 0 });
const jump = (stack, name) => stackAfterJump(jumped(stack, name))(stack);
const back = (stack) => stack.slice(0, -1);

test('a jump from another jumped component replaces it: the page and one component', () => {
  const first = jump([page], 'Choice');
  assert.deepEqual(
    first.map((entry) => entry.name),
    ['index.astro', 'Choice'],
  );
  const second = jump(first, 'Select');
  assert.deepEqual(
    second.map((entry) => entry.name),
    ['index.astro', 'Select'],
  );
  assert.equal(second[0], page, 'the origin is the same entry, recorded once');
});

test('after seven audit jumps one back returns to the page', () => {
  let stack = [page];
  for (const name of NAMES) {
    stack = jump(stack, name);
    assert.equal(stack.length, 2, `${name} replaces the component before it`);
  }
  assert.equal(stack.at(-1).name, 'Slider');
  assert.deepEqual(back(stack), [page]);
});

test('re-clicking a finding in the open component changes nothing', () => {
  const open = jump([page], 'Modal');
  const again = jump(open, 'Modal');
  assert.deepEqual(again, open);
  assert.equal(again.length, 2, 'no duplicate entry');
  assert.equal(again[1], open[1], 'the open entry is kept, not rebuilt');
});

test('a drill from an instance still nests, and back steps out one level at a time', () => {
  const card = componentEntry([page], [], component('Card'), { path: '0.2', occurrence: 0 });
  const nested = stackWith(card)([page]);
  const button = componentEntry(nested, [], component('Button'), { path: '0.1', occurrence: 1 });
  const deeper = stackWith(button)(nested);
  assert.deepEqual(
    deeper.map((entry) => entry.name),
    ['index.astro', 'Card', 'Button'],
  );
  assert.equal(back(deeper).at(-1), card);
  assert.deepEqual(back(back(deeper)), [page]);
});

test('a jump out of a drilled component returns to the page in one back', () => {
  const card = componentEntry([page], [], component('Card'), { path: '0.2', occurrence: 0 });
  const nested = stackWith(componentEntry([page, card], [], component('Button'), { path: '0.1', occurrence: 0 }))([page, card]);
  const after = jump(nested, 'Footer');
  assert.deepEqual(
    after.map((entry) => entry.name),
    ['index.astro', 'Footer'],
  );
  assert.equal(after[1].focusPath, undefined, 'the jumped entry does not inherit the drilled instance as its focus');
});

test('a jump to a component already open lower down steps back to that entry', () => {
  const card = componentEntry([page], [], component('Card'), { path: '0.2', occurrence: 0 });
  const nested = stackWith(componentEntry([page, card], [], component('Button'), { path: '0.1', occurrence: 0 }))([page, card]);
  const after = jump(nested, 'Card');
  assert.deepEqual(after, [page, card]);
  assert.equal(after[1].focusPath, '0.2', 'the entry the user drilled into keeps its instance');
});

test('a stack rooted in a component has no page to return to: the jump replaces it', () => {
  const rooted = [{ kind: 'component', ...component('Nav') }];
  assert.deepEqual(
    jump(rooted, 'Footer').map((entry) => entry.name),
    ['Footer'],
  );
  assert.deepEqual(
    jump([], 'Footer').map((entry) => entry.name),
    ['Footer'],
  );
});

test('a jump opens a component, never a page', () => {
  assert.throws(() => stackAfterJump(page), /Assertion failed: A jump opens a component/);
});

test('every sibling-jump entry point opens as a jump; instance opens stay drills', () => {
  const read = (file) => fs.readFileSync(repoPath(file), 'utf8');
  assert.match(read('src/app/shell/DesktopAudits.tsx'), /openComponent\(name, undefined, 0, toFilePath\(path\), 'jump'\)/);
  assert.match(read('src/app/shell/AppShell.tsx'), /openComponent\(name, undefined, 0, entry\.path, 'jump'\)/);
  assert.match(read('src/app/shell/desktopAppHost.ts'), /openComponent\(component\.name, undefined, 0, component\.path, 'jump'\)/);
  assert.match(read('src/app/shell/PageSettingsDesktop.tsx'), /openComponent\(file\.name, undefined, 0, file\.path, 'jump'\)/);
  const management = read('src/app/shell/useComponentManagement.ts');
  assert.match(management, /openComponent\(component\.name, undefined, 0, component\.path, 'jump'\)/);
  assert.match(management, /openComponent\(target\.name, undefined, 0, target\.path, 'jump'\)/);
  // Opening from an instance names the instance, and stays a drill.
  assert.match(read('src/app/shell/AppPanes.tsx'), /openComponent\(node\.name, path, occurrence\)/);
  assert.match(read('src/app/shell/desktopElementActions.ts'), /openComponent\(name, app\.pathFor\(id\)\)/);
});
