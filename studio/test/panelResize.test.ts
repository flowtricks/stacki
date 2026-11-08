// Goal: Studio's side panels resize exactly as Desktop's do, because they use Desktop's
// shared resize hook rather than a copy or a fixed CSS width.
// Methodology: read Studio's shell sources and assert that both panels take their width and
// handle from the vendored `usePanelResize`, that the vendored file is in the shared-source
// inventory, and that no Studio rule pins a competing desktop width. Then drive the shared
// drag arithmetic with valid deltas and with deltas that push past each bound, for both edges.
// The full pointer, keyboard and storage gesture is covered against the same file by the
// Desktop suite `test/renderer/app/resizablePanel.test.js`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PANEL_WIDTH_PX_MAX, PANEL_WIDTH_PX_MIN, dragPanelWidth } from '../vendor/stacki/src/app/shell/ResizablePanel';

const read = (file: string) => readFile(new URL(`../${file}`, import.meta.url), 'utf8');
const SHARED_IMPORT = /import \{ usePanelResize(, usePanelWidths)? \} from '\.\.\/\.\.\/vendor\/stacki\/src\/app\/shell\/ResizablePanel';/;

test('Studio shell takes both panel widths from the shared Desktop resize hook', async () => {
  const sidebar = await read('src/app/EditorSidebar.tsx');
  const editor = await read('src/app/Editor.tsx');
  const inventory = await read('scripts/shared-source.json');
  assert.ok(inventory.includes('"src/app/shell/ResizablePanel.tsx"'), 'Studio vendors the Desktop component');
  for (const [name, source, kind] of [
    ['EditorSidebar', sidebar, "usePanelResize(panel === 'code' ? 'code' : 'left')"],
    ['Editor', editor, "usePanelResize('right')"],
  ] as const) {
    assert.ok(SHARED_IMPORT.test(source), `${name} imports the shared hook`);
    assert.ok(source.includes(kind), `${name} resizes the matching Desktop panel kind`);
    // Collapsed panels float at the same width, so the width the user set survives a collapse.
    assert.ok(source.includes('style={{ width: resize.width }}'), `${name} applies the shared width`);
    assert.ok(source.includes('{!mobile && resize.handle}'), `${name} renders the shared handle`);
  }
  const css = await read('src/app/studio.css');
  assert.ok(css.includes('.studio-left > .panel-resize {\n  right: -4px;'), 'The left handle straddles the edge as on Desktop');
  assert.ok(css.includes('.studio-right > .panel-resize {\n  left: -4px;'), 'The right handle straddles the edge as on Desktop');
  assert.equal(css.includes('clamp(360px, 34vw'), false, 'No fixed code panel width competes with the stored one');
});

test('Studio collapses by the shared Desktop layout rule, not by a window-width query', async () => {
  const layout = await read('src/app/mobileEditor.ts');
  const editor = await read('src/app/Editor.tsx');
  const css = await read('src/app/studio.css');
  const inventory = await read('scripts/shared-source.json');
  assert.ok(inventory.includes('"src/app/shell/editorLayout.ts"'), 'Studio vendors the Desktop layout rule');
  assert.ok(layout.includes("from '../../vendor/stacki/src/app/shell/editorLayout'"), 'The layout store uses the shared rule');
  assert.equal(layout.includes('matchMedia'), false, 'No window-width query decides the layout');
  assert.ok(editor.includes('data-editor-layout={layout}'), 'The shell exposes the layout to its stylesheet');
  assert.ok(css.includes(".studio-app[data-editor-layout='collapsed'] .studio-left {"), 'Collapsed panels float by layout, not by viewport');
  for (const file of ['src/features/cms/CmsWorkspace.tsx', 'src/features/variables/VariablesWorkspace.tsx']) {
    assert.equal((await read(file)).includes("matchMedia('(max-width: 700px)')"), false, `${file} follows the editor layout`);
  }
});

test('Dragging a handle changes the width and stops at each bound', () => {
  assert.deepEqual(PANEL_WIDTH_PX_MIN, { left: 260, code: 360, right: 322 });
  assert.equal(PANEL_WIDTH_PX_MAX, 600);
  // The left edge grows when dragged right.
  assert.equal(dragPanelWidth('left', 260, 150), 410);
  assert.equal(dragPanelWidth('left', 410, -40.4), 370);
  assert.equal(dragPanelWidth('left', 260, 5000), 600);
  assert.equal(dragPanelWidth('left', 300, -5000), 260);
  assert.equal(dragPanelWidth('code', 400, -5000), 360);
  // The right edge grows when dragged left.
  assert.equal(dragPanelWidth('right', 322, -150), 472);
  assert.equal(dragPanelWidth('right', 472, 100), 372);
  assert.equal(dragPanelWidth('right', 322, -5000), 600);
  assert.equal(dragPanelWidth('right', 400, 5000), 322);
  // Non-finite input is a programmer error, not a width.
  assert.throws(() => dragPanelWidth('left', Number.NaN, 10), /Drag start width must be finite/);
  assert.throws(() => dragPanelWidth('right', 322, Number.POSITIVE_INFINITY), /Drag delta must be finite/);
});
