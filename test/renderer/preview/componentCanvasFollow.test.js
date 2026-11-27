// Goal: selecting another frame on the component canvas changes everything that speaks of the selection in ONE paint.
// The canvas state (the selected frame, its scope, what is picked) used to follow the editor's selection in an effect:
// the editor's outline and the Settings panel moved first and Frame settings a commit later, and the panel's fields,
// keyed by frame and scope, mounted twice. Recorded in the running app, that was the flicker the owner saw. The state
// now follows during render, so a selection change is one commit, and Frame settings keeps its elements and changes
// only their words.
//
// Method: the real hook (useDesktopComponentCanvas.ts useFrameFollowsEditor) and the real Frame settings panel
// (ComponentCanvasPanel.tsx), bundled as the app bundles them, render in jsdom over a canvas page parsed by the app's
// own parser. A harness stands in for the shell: it holds the editor's selection and the canvas state. Each commit
// records what the DOM says (useLayoutEffect, before paint) and a MutationObserver records every element removed, so a
// transient state or a remount between the old frame and the new one is caught. Selections cover an instance, a frame
// box and a group box; the negative space is a selection that names nothing on the canvas.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { ROOT, repoPath } = require('../../helpers/sources.js');
const { installPopupDOM } = require('../../helpers/popupDom.js');
const { parsePage } = require('#dist/electron/parse/astroParser.js');
const { CANVAS_LIMITS: LIMITS } = require('#dist/shared/properties/componentCanvas.js');

const directory = repoPath('node_modules/.stacki-test/component-canvas-follow');
fs.mkdirSync(directory, { recursive: true });
const output = path.join(directory, 'component-canvas-follow.cjs');
buildSync({
  stdin: {
    contents: [
      "export { useFrameFollowsEditor, frameSettingChange, resetChange, valuesChange, rootClassesChange, withSettings, arrangementChange } from './src/app/state/useDesktopComponentCanvas';",
      "export { rootSettings } from './src/app/shell/canvasFrameSettings';",
      "export { ComponentCanvasPanel } from './src/features/preview/componentCanvas/ComponentCanvasPanel';",
      "export { noteComponentCanvas } from './src/features/preview/componentCanvas/componentCanvasSession';",
      "export { buildCanvasLayout } from './src/features/preview/componentCanvas/canvasModel';",
      "export { groupFrames, canvasLevels, layoutTargets } from './src/features/preview/componentCanvas/canvasGroups';",
      "export { sectionScopes } from './src/features/preview/componentCanvas/CanvasScopeControl';",
      "export { resolveFrame, scopeHolds, sharedOverrides } from './shared/properties/componentCanvas';",
      "export { canvasPageSource, canvasTreeOf } from './src/features/preview/componentCanvas/canvasPage';",
      "export { nodeAtPath } from './src/editor/editorTree';",
      "export { parseComponentCanvasSource, serializeComponentCanvas } from './shared/properties/componentCanvas';",
      "export { toEditorPageState } from './src/editor/pageState';",
    ].join('\n'),
    resolveDir: ROOT,
    loader: 'ts',
  },
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  jsx: 'automatic',
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  loader: { '.css': 'empty' },
  logLevel: 'silent',
});

const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
global.window = dom.window;
global.document = dom.window.document;
for (const name of [
  'Node',
  'Element',
  'HTMLElement',
  'HTMLInputElement',
  'MutationObserver',
  'DOMRect',
  'Window',
  'KeyboardEvent',
  'MouseEvent',
  'PointerEvent',
  'FocusEvent',
]) {
  global[name] = dom.window[name];
}
global.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
global.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
global.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
global.IS_REACT_ACT_ENVIRONMENT = true;
global.ResizeObserver = dom.window.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
installPopupDOM(dom.window);
const React = require('react');
const { createRoot } = require('react-dom/client');
const { act } = React;
const canvas = require(output);

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const BUTTON = 'src/components/Button.astro';
// Past the segmented control's hover delay (SegmentedControl.tsx), by which its tip is up.
const TOOLTIP_WAIT_MS = 650;
const component = {
  file: BUTTON,
  name: 'Button',
  schema: [
    { name: 'variant', type: 'enum', optional: true, options: ['main', 'play'], default: 'main' },
    { name: 'emphasis', type: 'enum', optional: true, options: ['primary', 'secondary'], default: 'primary' },
  ],
};

// The canvas page as the app writes and parses it, and the canvas state opened on its first frame.
function openCanvas() {
  const layout = canvas.buildCanvasLayout(component, { split: ['variant', 'emphasis'] });
  const items = (list, depth = 0) => {
    assert.ok(depth <= LIMITS.splitPropsMax, 'groups nest no deeper than the split');
    return list.map((item) =>
      item.kind === 'frame'
        ? { kind: 'frame', key: item.key, caption: item.key }
        : { kind: 'group', key: item.key, header: item.key, children: items(item.children, depth + 1) },
    );
  };
  const source = canvas.canvasPageSource({
    id: ID,
    component: BUTTON,
    fallbackText: 'Button',
    theme: 'dark',
    snapshot: {
      catalog: [{ file: BUTTON, name: 'Button', props: ['variant', 'emphasis'], slots: [], slotText: false }],
      config: { version: 1, components: {} },
      missingAssets: [],
    },
    groups: items(canvas.groupFrames(layout.frames)),
    frames: layout.frames.map((frame) => ({ ...frame, label: frame.key, width: 'hug', height: 'hug', background: undefined })),
  });
  const parsed = parsePage(source);
  assert.equal(parsed.editable, true);
  const model = canvas.toEditorPageState({ editable: true, ...parsed, source }).model ?? parsed.model;
  const tree = canvas.canvasTreeOf(model.nodes);
  const first = tree.instances[0];
  const state = {
    kind: 'open',
    id: ID,
    component,
    settings: { version: 1, components: {} },
    layout,
    frame: first.key,
    scopes: { props: first.key, frame: first.key },
    rootScope: '*component',
    scale: 1,
    framePanel: 'shown',
    defaults: {},
    instances: tree.instances,
    boxes: tree.boxes,
    root: tree.root,
    subject: 'frame',
    picked: { kind: 'component' },
    resizing: undefined,
  };
  return { model, tree, state };
}

const noop = () => undefined;
const control = {
  setScope: noop,
  edit: noop,
  hideFramePanel: noop,
  showFramePanel: noop,
  coverRight: noop,
  zoom: noop,
  setSplit: noop,
  setArrangement: noop,
  editValues: noop,
  editRootClasses: noop,
};

test('a selection change reaches Frame settings in the same commit, with no element of it replaced', async (context) => {
  const { model, tree, state: opened } = openCanvas();
  const idAt = (path) => canvas.nodeAtPath(model.nodes, path.split('.').map(Number))?.id;
  const pathOf = new Map();
  // Every node's path, by an explicit stack: no recursion needs a depth bound.
  const pending = model.nodes.map((node, index) => ({ node, path: String(index) }));
  for (let step = 0; step < 10_000 && pending.length > 0; step += 1) {
    const { node, path } = pending.pop();
    pathOf.set(node.id, path);
    pending.push(...(node.children ?? []).map((child, index) => ({ node: child, path: `${path}.${index}` })));
  }
  const commits = [];
  let select;
  function Harness() {
    const [selectedId, setSelectedId] = React.useState(idAt(opened.instances[0].path));
    const [state, setState] = React.useState(opened);
    select = setSelectedId;
    canvas.noteComponentCanvas(state);
    canvas.useFrameFollowsEditor(state, { editStack: [{}], pathFor: (id) => pathOf.get(id), selectedId, model, setSelectedId }, setState);
    const panel = React.useRef(null);
    React.useLayoutEffect(() => {
      commits.push({
        selection: pathOf.get(selectedId),
        frame: state.frame,
        picked: state.picked.kind,
        scope: state.scopes.props,
        shared: state.scopes.frame,
        text: panel.current?.textContent ?? '',
      });
    });
    return React.createElement('div', { ref: panel }, React.createElement(canvas.ComponentCanvasPanel, { canvas: control, state }));
  }
  const host = document.getElementById('root');
  const root = createRoot(host);
  context.after(() => act(async () => root.unmount()));
  await act(async () => root.render(React.createElement(Harness)));
  const removed = [];
  const observer = new MutationObserver((records) =>
    records.forEach((record) => record.removedNodes.forEach((node) => node.nodeType === 1 && removed.push(node.className))),
  );
  observer.observe(host, { childList: true, subtree: true });
  const section = host.querySelector('.component-canvas-section');
  const steps = [
    { name: 'another frame’s instance', path: tree.instances[1].path, frame: tree.instances[1].key, picked: 'component', scope: tree.instances[1].key },
    {
      name: 'a frame box',
      path: tree.boxes.find((box) => box.kind === 'frame' && box.key === tree.instances[2].key).path,
      frame: tree.instances[2].key,
      picked: 'box',
      scope: tree.instances[2].key,
    },
    {
      name: 'a group box',
      path: tree.boxes.find((box) => box.kind === 'group' && box.key === 'variant=main').path,
      frame: tree.instances[0].key,
      picked: 'group',
      scope: 'variant=main',
    },
  ];
  for (const step of steps) {
    const before = commits.length;
    await act(async () => select(idAt(step.path)));
    const after = commits.slice(before);
    assert.equal(after.length, 1, `${step.name}: one commit, not the selection first and the canvas a commit later`);
    const [commit] = after;
    assert.equal(commit.selection, step.path);
    assert.equal(commit.frame, step.frame, `${step.name}: the frame follows in that commit`);
    assert.equal(commit.picked, step.picked);
    assert.equal(commit.scope, step.scope);
    assert.equal(commit.shared, step.scope, `${step.name}: Frame settings’ one scope starts at the frame, or the group selected`);
  }
  observer.disconnect();
  assert.equal(host.querySelector('.component-canvas-section'), section, 'Frame settings keeps its section: it changes words, it is not mounted again');
  assert.deepEqual(
    removed.filter((name) => /component-canvas-(section|panel|length|color)|props-field/.test(String(name))),
    [],
    'no field of Frame settings is removed and drawn again',
  );
  // The negative space: a selection the canvas has no box or instance for changes nothing of the canvas's.
  const held = commits.at(-1);
  await act(async () => select(undefined));
  assert.equal(commits.at(-1).frame, held.frame);
  assert.equal(commits.at(-1).scope, held.scope);
  canvas.noteComponentCanvas({ kind: 'idle' });
});

// The owner's report: with All frames chosen, pressing Fixed did nothing. The field showed the selected frame's own
// value (a Hug an older This-frame default had stored), which wins on that frame, so the all-frames write never showed.
// The size fields now start Fixed at the frame's drawn size and write it at the scope only: the frame's own Hug survives
// and still wins there (frameSettingChange). Frames in scope that differ (one Hug, the others fixed) are said as they
// are: neither choice marked, the label orange, saying the frame keeps its own value, with a Reset that gives it this one.
// Since the one shared "Apply to", the write also takes the frame's Hug away (below).
test('Fixed at All frames writes from the drawn size, and frames that differ are said to be Mixed', async (context) => {
  const { state: opened } = openCanvas();
  const link = opened.layout.frames[1].key;
  const settings = { version: 1, components: { [BUTTON]: { split: ['variant', 'emphasis'], frames: { [link]: { width: 'hug' } } } } };
  const edits = [];
  const panelControl = { ...control, drawnSize: (key) => (key === link ? { width: 183, height: 96 } : undefined), edit: (edit) => edits.push(edit) };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  context.after(() => act(async () => root.unmount()));
  const draw = (state) => act(async () => root.render(React.createElement(canvas.ComponentCanvasPanel, { canvas: panelControl, state })));
  const base = { ...opened, settings, frame: link, scopes: { props: link, frame: '' } };
  canvas.noteComponentCanvas(base);
  await draw(base);
  const width = () => host.querySelector('section[aria-label="Size"]').querySelectorAll('.props-field')[0];
  const pressed = () => width().querySelector('[role="radio"][aria-checked="true"]')?.textContent;
  assert.equal(pressed(), 'Hug', 'nothing set at All frames: Hug');
  const fixed = [...width().querySelectorAll('[role="radio"]')].find((button) => button.textContent === 'Fixed');
  await act(async () => fixed.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
  assert.deepEqual(edits, [{ kind: 'field', field: 'width', value: 183 }], 'Fixed starts at the frame’s drawn width, written to All frames');
  // A This-frame Hug chosen afterwards wins on that frame.
  const after = {
    ...base,
    settings: { ...settings, components: { [BUTTON]: { ...settings.components[BUTTON], frames: { '': { width: 183 }, [link]: { width: 'hug' } } } } },
  };
  await draw(after);
  assert.equal(pressed(), undefined, 'one frame hugs and the others are fixed: neither is marked');
  assert.equal(width().querySelector('input') ?? undefined, undefined, 'no one size to show');
  const label = width().querySelector('.prop-label');
  assert.match(label.className, /embed-editor_prop-orange/, 'frames that differ are said in orange');
  assert.match(label.title, /frames here show different values\. A value set here gives them all that value\./, 'and what a value set here does');
  assert.match(label.title, /This frame has its own value\. 1 frame here keeps its own value\. Reset to give it this one\./, 'and which, with Reset');
  // Every frame fixed, at different sizes: Fixed, with the pixels left empty and saying Mixed.
  const sized = {
    ...base,
    settings: { ...settings, components: { [BUTTON]: { ...settings.components[BUTTON], frames: { '': { width: 183 }, [link]: { width: 240 } } } } },
  };
  await draw(sized);
  assert.equal(pressed(), 'Fixed');
  assert.equal(width().querySelector('input')?.value, '');
  assert.equal(width().querySelector('input')?.placeholder, 'Mixed');
  // Every frame the same: the value itself.
  const same = { ...base, settings: { ...settings, components: { [BUTTON]: { ...settings.components[BUTTON], frames: { '': { width: 183 } } } } } };
  await draw(same);
  assert.equal(pressed(), 'Fixed');
  assert.equal(width().querySelector('input')?.value, '183');
  canvas.noteComponentCanvas({ kind: 'idle' });
});

// The owner's request: the Layout choices are drawn with the Style panel's direction arrows, not words. Each segment's
// words are still its accessible name and its hover tip, and choosing one sets that arrangement.
test('Layout shows direction icons, named and tipped by their words', async (context) => {
  const { state } = openCanvas();
  const arrangements = [];
  const panelControl = { ...control, setArrangement: (_levels, next) => arrangements.push(next) };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  context.after(() => act(async () => root.unmount()));
  canvas.noteComponentCanvas(state);
  const all = { ...state, scopes: { ...state.scopes, frame: '' } };
  await act(async () => root.render(React.createElement(canvas.ComponentCanvasPanel, { canvas: panelControl, state: all })));
  const group = host.querySelector('.component-canvas-arrangement');
  assert.equal(group.getAttribute('aria-label'), 'Layout');
  const segments = [...group.querySelectorAll('[role="radio"]')];
  assert.deepEqual(
    segments.map((segment) => segment.getAttribute('aria-label')),
    ['Side by side', 'Stacked', 'Wrap'],
  );
  for (const segment of segments) {
    assert.equal(segment.textContent, '', 'no visible words');
    assert.equal(segment.querySelectorAll('svg[aria-hidden="true"]').length, 1, 'one decorative icon');
  }
  assert.deepEqual(
    segments.map((segment) => segment.querySelector('svg').getAttribute('data-central-icon') ?? undefined),
    // The wrap icon is the direction bar's own drawing, which carries no Central name.
    ['arrowRight', 'arrowDown', undefined],
  );
  assert.equal(segments[2].querySelectorAll('svg path[opacity="0.4"]').length, 1, 'the direction bar’s wrap icon');
  assert.equal(segments[0].getAttribute('aria-checked'), 'true', 'side by side is what nobody arranged');
  await act(async () => {
    segments[1].dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, TOOLTIP_WAIT_MS));
  });
  assert.equal(document.querySelector('[role="tooltip"]')?.textContent, 'Stacked', 'the words are the hover tip');
  await act(async () => segments[2].dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
  assert.deepEqual(arrangements, ['wrap']);
  canvas.noteComponentCanvas({ kind: 'idle' });
});

// The owner's report: "this dropdown isn't working, it just keeps switching only the selected frame". An edit was
// written at the chosen key alone, so a narrower setting, or one of another axis that merges later (`variant=main` over
// `emphasis=primary`), still won on its frames. Now every frame the choice names takes the value, and no other frame
// changes (componentCanvas.ts withSharedEdit). A frame can be given its own again afterwards. Preview values keep their
// own rule: narrower ones survive a wider edit.
const STORED = (opened) => {
  const keys = opened.layout.frames.map((frame) => frame.key);
  return {
    version: 1,
    components: {
      [BUTTON]: {
        split: ['variant', 'emphasis'],
        frames: {
          'variant=main': { width: 'hug', background: 'green', props: { label: 'Main' } },
          [keys[2]]: { width: 200, height: 90, background: 'red', props: { label: 'Own' } },
        },
      },
    },
  };
};

test('every scope offered reaches the frames it counts, and each of them takes a size, Hug and a background', () => {
  const { state: opened } = openCanvas();
  const stored = STORED(opened);
  const frames = opened.layout.frames.map((frame) => frame.key);
  const shownBy = (file, key, setting) => canvas.resolveFrame(file.components[BUTTON], key)[setting];
  let weighed = 0;
  for (const frame of frames) {
    const selected = { ...opened, settings: stored, frame };
    for (const scope of canvas.sectionScopes({ ...selected, scopes: { props: frame, frame } }, 'frame', (key, values) => `${key} ${values?.count ?? ''}`)) {
      const state = { ...selected, scopes: { props: frame, frame: scope.value } };
      assert.equal(scope.hint, `componentCanvas.panel.frames ${scope.frames.length}`, 'the count is the frames it reaches');
      const edits = [
        { kind: 'field', field: 'width', value: 321 },
        { kind: 'field', field: 'height', value: 123 },
        { kind: 'field', field: 'width', value: scope.value === '' ? undefined : 'hug' },
        { kind: 'background', value: 'blue' },
      ];
      for (const edit of edits) {
        const setting = edit.kind === 'field' ? edit.field : 'background';
        const next = canvas.frameSettingChange(state, edit)(stored);
        const wanted = edit.value ?? 'hug';
        for (const key of frames) {
          const expected = scope.frames.includes(key) ? wanted : shownBy(stored, key, setting);
          assert.equal(shownBy(next, key, setting), expected, `${scope.value || 'all'} ${setting} on ${key}`);
          assert.deepEqual(canvas.resolveFrame(next.components[BUTTON], key).props, canvas.resolveFrame(stored.components[BUTTON], key).props);
        }
        assert.equal(canvas.parseComponentCanvasSource(canvas.serializeComponentCanvas(next)).ok, true);
        weighed += 1;
      }
    }
  }
  assert.ok(weighed > frames.length * 4, 'wider scopes than This frame were weighed');
});

test('a later This-frame value wins, the shared field says so, and Reset gives the whole scope one value again', () => {
  const { state: opened } = openCanvas();
  const frames = opened.layout.frames.map((frame) => frame.key);
  const scope = 'emphasis=primary';
  const primary = frames.filter((key) => canvas.scopeHolds(scope, key));
  const at = (settings, chosen, frame = primary[0]) => ({ ...opened, settings, frame, scopes: { props: frame, frame: chosen } });
  const stored = STORED(opened);
  const wide = canvas.frameSettingChange(at(stored, scope), { kind: 'field', field: 'width', value: 300 })(stored);
  assert.deepEqual(canvas.sharedOverrides(wide.components[BUTTON], frames, scope, 'width'), []);
  const own = canvas.frameSettingChange(at(wide, primary[0]), { kind: 'field', field: 'width', value: 111 })(wide);
  assert.deepEqual(canvas.sharedOverrides(own.components[BUTTON], frames, scope, 'width'), [primary[0]]);
  const reset = canvas.resetChange(at(own, scope), 'frame', 'width')(own);
  assert.ok(primary.every((key) => canvas.resolveFrame(reset.components[BUTTON], key).width === 300));
  // With nothing of its own at the scope, Reset takes what narrower entries say.
  const bare = canvas.resetChange(at(stored, ''), 'frame', 'height')(stored);
  assert.ok(frames.every((key) => canvas.resolveFrame(bare.components[BUTTON], key).height === 'hug'));
  assert.equal(bare.components[BUTTON].frames[frames[2]].width, 200, 'and only of that setting');
  // Preview values are the other choice’s: a wider value leaves a frame’s own.
  const labelled = canvas.valuesChange(at(stored, ''), '', [{ kind: 'prop', name: 'label', value: 'All' }])(stored);
  assert.deepEqual(labelled.components[BUTTON].frames[frames[2]].props, { label: 'Own' });
});

// Layout under the shared choice: every group of several whose frames are all in the set; This frame has none, so no
// control; the canvas itself is arranged only while it is selected.
test('Layout arranges every group the chosen set holds, and is not offered where it holds none', async (context) => {
  const { state: opened } = openCanvas();
  const tree = canvas.groupFrames(opened.layout.frames);
  const reached = (scope) => new Set(opened.layout.frames.map((frame) => frame.key).filter((key) => canvas.scopeHolds(scope, key)));
  assert.deepEqual(canvas.layoutTargets(tree, reached('')), ['variant=main', 'variant=play']);
  assert.deepEqual(canvas.layoutTargets(tree, reached('variant=play')), ['variant=play']);
  assert.deepEqual(canvas.layoutTargets(tree, reached('emphasis=primary')), [], 'no group is all primary');
  assert.deepEqual(canvas.layoutTargets(tree, reached(opened.layout.frames[0].key)), []);
  const both = canvas.arrangementChange(opened, ['variant=main', 'variant=play'], 'column')(opened.settings);
  assert.deepEqual(both.components[BUTTON].layouts, { 'variant=main': 'column', 'variant=play': 'column' });
  const calls = [];
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  context.after(() => act(async () => root.unmount()));
  const draw = (state) =>
    act(async () =>
      root.render(React.createElement(canvas.ComponentCanvasPanel, { canvas: { ...control, setArrangement: (...call) => calls.push(call) }, state })),
    );
  const dropdowns = () => host.querySelectorAll('button.dd-trigger').length;
  await draw(opened);
  assert.equal(dropdowns(), 1, 'one Apply to');
  assert.equal(host.querySelector('section[aria-label="Layout"]') ?? undefined, undefined, 'This frame has nothing to arrange');
  const mixed = { version: 1, components: { [BUTTON]: { layouts: { 'variant=main': 'column' } } } };
  await draw({ ...opened, settings: mixed, scopes: { ...opened.scopes, frame: '' } });
  assert.equal(dropdowns(), 1);
  const section = host.querySelector('section[aria-label="Layout"]');
  assert.equal(section.querySelector('[role="radio"][aria-checked="true"]') ?? undefined, undefined, 'groups arranged differently show no choice');
  assert.match(section.querySelector('.prop-label').className, /embed-editor_prop-orange/);
  await act(async () => section.querySelectorAll('[role="radio"]')[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
  assert.deepEqual(calls, [[['variant=main', 'variant=play'], 'row']]);
});

// The canvas root's settings always start at this component; every component's is only ever the person's own pick,
// which holds while the canvas is open.
test('the canvas root’s settings start at This component, and a picked All components holds', async (context) => {
  const { model, tree, state: opened } = openCanvas();
  const rootPath = tree.root;
  const rootId = canvas.nodeAtPath(model.nodes, rootPath.split('.').map(Number)).id;
  const frameId = canvas.nodeAtPath(model.nodes, tree.instances[1].path.split('.').map(Number)).id;
  const held = {};
  function Harness({ initial }) {
    const [selectedId, setSelectedId] = React.useState(undefined);
    const [state, setState] = React.useState(initial);
    Object.assign(held, { state, setState, select: setSelectedId });
    canvas.noteComponentCanvas(state);
    const pathFor = (id) => (id === rootId ? rootPath : id === frameId ? tree.instances[1].path : undefined);
    canvas.useFrameFollowsEditor(state, { editStack: [{}], pathFor, selectedId, model, setSelectedId }, setState);
    return false;
  }
  const open = async (settings) => {
    const root = createRoot(document.createElement('div'));
    context.after(() => act(async () => root.unmount()));
    await act(async () => root.render(React.createElement(Harness, { initial: { ...opened, settings } })));
    await act(async () => held.select(rootId));
    assert.equal(held.state.subject, 'root', 'the canvas root is the subject');
  };
  const project = { version: 1, classes: ['theme-dark'], components: {} };
  const own = { ...project, components: { [BUTTON]: { root: { classes: ['theme-invert'] } } } };
  for (const settings of [project, own, { version: 1, components: {} }]) {
    await open(settings);
    assert.equal(held.state.scopes.frame, '*component');
  }
  // Picked by the person, All components comes back after a frame was selected in between.
  await act(async () => held.setState((state) => ({ ...state, rootScope: '*project', scopes: { ...state.scopes, frame: '*project' } })));
  await act(async () => held.select(frameId));
  assert.notEqual(held.state.scopes.frame, '*project');
  await act(async () => held.select(rootId));
  assert.equal(held.state.scopes.frame, '*project');
  canvas.noteComponentCanvas({ kind: 'idle' });
});

// The class field's writer, the change it makes and the open canvas over the new settings, as the app chains them.
function rootField(opened) {
  let state = opened;
  const field = () => {
    const control = {
      editRootClasses: (classes) => {
        state = canvas.withSettings(state, canvas.rootClassesChange(state, classes)(state.settings));
      },
    };
    return canvas.rootSettings(control, state, (key) => key);
  };
  return {
    // Orange is `inherited`; blue is a value with Reset; plain is neither.
    shown: () => {
      const { value } = field();
      const extra = field().extras('class');
      const label = extra?.provenance?.tone === 'inherited' ? 'orange' : extra?.reset !== undefined ? 'blue' : 'plain';
      return { value, label, scope: state.scopes.frame };
    },
    remove: () => field().onSetProp('class', undefined),
    type: (text) => field().onSetProp('class', { type: 'string', value: text }),
    reset: () => field().extras('class').reset(),
    settings: () => state.settings,
  };
}

const atRoot = (settings, scope = '*component') => {
  const { state } = openCanvas();
  return { ...state, settings, subject: 'root', rootScope: scope, scopes: { ...state.scopes, frame: scope } };
};

// The owner's reports: a theme-dark on screen that would not come off, under an orange label nobody expected.
test('at This component every removal shows, stays, and Reset gives back the shared class', () => {
  const settings = { version: 1, classes: ['theme-dark'], components: { [BUTTON]: { root: { classes: ['theme-invert'] } } } };
  const field = rootField(atRoot(settings));
  assert.deepEqual(field.shown(), { value: 'theme-invert', label: 'blue', scope: '*component' });
  field.remove();
  assert.deepEqual(field.shown(), { value: '', label: 'blue', scope: '*component' }, 'removed: no class here, and still this component');
  field.reset();
  assert.deepEqual(field.shown(), { value: 'theme-dark', label: 'orange', scope: '*component' }, 'Reset brings the shared one back');
  field.remove();
  assert.deepEqual(field.shown(), { value: '', label: 'blue', scope: '*component' }, 'a borrowed class comes off, never a no-op');
  assert.deepEqual(field.settings().classes, ['theme-dark'], 'All components is never changed from here');
  const saved = canvas.parseComponentCanvasSource(canvas.serializeComponentCanvas(field.settings()));
  assert.deepEqual(saved.value.components[BUTTON].root.classes, [], 'and it stays removed in the saved file');
  field.type('u-wide');
  assert.deepEqual(field.shown(), { value: 'u-wide', label: 'blue', scope: '*component' });
  field.reset();
  assert.equal(field.settings().components[BUTTON], undefined, 'nothing of its own is left behind');
});

test('with nothing shared a class is blue or nothing is plain; All components edits keep a component’s own', () => {
  const field = rootField(atRoot({ version: 1, components: {} }));
  assert.deepEqual(field.shown(), { value: undefined, label: 'plain', scope: '*component' });
  field.type('theme-brand');
  assert.deepEqual(field.shown(), { value: 'theme-brand', label: 'blue', scope: '*component' });
  field.remove();
  assert.deepEqual(field.shown(), { value: undefined, label: 'plain', scope: '*component' });
  assert.equal(field.settings().components[BUTTON], undefined);
  const own = { version: 1, classes: ['theme-dark'], components: { [BUTTON]: { root: { classes: ['theme-invert'] } } } };
  const wide = rootField(atRoot(own, '*project'));
  assert.deepEqual(wide.shown(), { value: 'theme-dark', label: 'blue', scope: '*project' });
  wide.remove();
  assert.equal(wide.settings().classes, undefined);
  assert.deepEqual(wide.settings().components[BUTTON].root.classes, ['theme-invert'], 'a wider edit drops nothing narrower');
});

test('a Layout choice is this component’s own, at its level only, whatever the root scope', () => {
  const state = atRoot({ version: 1, components: {} }, '*project');
  const [group] = state.boxes.filter((box) => box.kind === 'group').map((box) => box.key);
  const next = canvas.arrangementChange(state, ['*canvas'], 'row')(state.settings);
  assert.deepEqual(next.components[BUTTON].layouts, { '*canvas': 'row' });
  const both = canvas.arrangementChange({ ...state, settings: next }, [group], 'column')(next);
  assert.deepEqual(both.components[BUTTON].layouts, { '*canvas': 'row', [group]: 'column' });
  assert.deepEqual(canvas.arrangementChange({ ...state, settings: both }, ['*canvas'], undefined)(both).components[BUTTON].layouts, { [group]: 'column' });
});

// A borrowed background is only the empty field's placeholder: Backspace there must remove it here, never do nothing.
test('Backspace on a borrowed background removes it for this component, and only there', async (context) => {
  const borrowed = { version: 1, background: '#123456', components: {} };
  const edits = [];
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  context.after(() => act(async () => root.unmount()));
  const render = (state) =>
    act(async () => root.render(React.createElement(canvas.ComponentCanvasPanel, { canvas: { ...control, edit: (edit) => edits.push(edit) }, state })));
  const press = async () => {
    const input = host.querySelector('.component-canvas-color input');
    await act(async () => input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true })));
  };
  await render(atRoot(borrowed, '*project'));
  await press();
  assert.deepEqual(edits, [], 'at All components the field shows its own value: nothing borrowed to remove');
  await render(atRoot(borrowed));
  assert.equal(host.querySelector('.component-canvas-inherited').getAttribute('title'), 'All components', 'orange says whose value it is');
  await press();
  assert.deepEqual(edits, [{ kind: 'background', value: 'transparent' }]);
});
