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
      "export { useFrameFollowsEditor, frameSettingChange, valuesChange } from './src/app/state/useDesktopComponentCanvas';",
      "export { ComponentCanvasPanel } from './src/features/preview/componentCanvas/ComponentCanvasPanel';",
      "export { noteComponentCanvas } from './src/features/preview/componentCanvas/componentCanvasSession';",
      "export { buildCanvasLayout } from './src/features/preview/componentCanvas/canvasModel';",
      "export { groupFrames } from './src/features/preview/componentCanvas/canvasGroups';",
      "export { canvasPageSource, canvasTreeOf } from './src/features/preview/componentCanvas/canvasPage';",
      "export { nodeAtPath } from './src/editor/editorTree';",
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
for (const name of ['Node', 'Element', 'HTMLElement', 'MutationObserver', 'DOMRect', 'Window', 'KeyboardEvent', 'MouseEvent', 'PointerEvent', 'FocusEvent']) {
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
    scopes: { props: first.key, size: '', background: first.key },
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
        size: state.scopes.size,
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
    assert.equal(commit.size, step.picked === 'group' ? step.scope : '', `${step.name}: sizes stay at all frames unless a group is selected`);
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
  const base = { ...opened, settings, frame: link, scopes: { props: link, size: '', background: link } };
  canvas.noteComponentCanvas(base);
  await draw(base);
  const width = () => host.querySelectorAll('.component-canvas-section')[0].querySelectorAll('.props-field')[0];
  const pressed = () => width().querySelector('[role="radio"][aria-checked="true"]')?.textContent;
  assert.equal(pressed(), 'Hug', 'nothing set at All frames: Hug');
  const fixed = [...width().querySelectorAll('[role="radio"]')].find((button) => button.textContent === 'Fixed');
  await act(async () => fixed.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
  assert.deepEqual(edits, [{ kind: 'field', field: 'width', value: 183 }], 'Fixed starts at the frame’s drawn width, written to All frames');
  // The store answers with the all-frames width; the frame's own Hug still wins on that frame.
  const after = {
    ...base,
    settings: { ...settings, components: { [BUTTON]: { ...settings.components[BUTTON], frames: { '': { width: 183 }, [link]: { width: 'hug' } } } } },
  };
  await draw(after);
  assert.equal(pressed(), undefined, 'one frame hugs and the others are fixed: neither is marked');
  assert.equal(width().querySelector('input') ?? undefined, undefined, 'no one size to show');
  const label = width().querySelector('.prop-label');
  assert.match(label.className, /embed-editor_prop-orange/, 'frames that differ are said in orange');
  assert.match(label.title, /frames here show different values\. A value set here leaves each frame’s own value as it is\./, 'and that own values stay');
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

// The owner's rule (f788a3be): a size set for all frames applies across the variants, and a frame or variant can still
// override it. A wider edit writes only its own scope's value; every narrower value, size, background or prop, survives
// it and still wins on its frames. cc65d733 dropped them on a wider edit; this pins that it never does again.
test('a wider edit writes its own scope only: frames and variants keep their own size, background and props', () => {
  const { state: opened } = openCanvas();
  const [first, second] = opened.layout.frames.map((frame) => frame.key);
  const variant = first.split('&').find((pair) => pair.startsWith('variant='));
  const stored = {
    version: 1,
    components: {
      [BUTTON]: {
        split: ['variant', 'emphasis'],
        frames: { [first]: { width: 200, background: 'red', props: { label: 'Own' } }, [variant]: { height: 90 } },
      },
    },
  };
  const at = (scope) => ({ ...opened, settings: stored, frame: first, scopes: { props: scope, size: scope, background: scope } });
  const wide = canvas.frameSettingChange(at(''), { kind: 'field', field: 'width', value: 400 })(stored);
  assert.equal(wide.components[BUTTON].frames[first].width, 200, 'the frame’s own width survives an all-frames width');
  assert.equal(wide.components[BUTTON].frames[''].width, 400, 'and the all-frames width is written');
  const tall = canvas.frameSettingChange(at(''), { kind: 'field', field: 'height', value: 50 })(stored);
  assert.equal(tall.components[BUTTON].frames[variant].height, 90, 'a variant’s own height survives too');
  const painted = canvas.frameSettingChange(at(variant), { kind: 'background', value: 'blue' })(stored);
  assert.equal(painted.components[BUTTON].frames[first].background, 'red', 'the frame’s own background survives a variant’s');
  assert.equal(painted.components[BUTTON].frames[variant].background, 'blue');
  const labelled = canvas.valuesChange(at(''), '', [{ kind: 'prop', name: 'label', value: 'All' }])(stored);
  assert.deepEqual(labelled.components[BUTTON].frames[first].props, { label: 'Own' }, 'the frame’s own prop survives an all-frames value');
  assert.equal(labelled.components[BUTTON].frames[''].props.label, 'All');
  // The negative space: a frame without values of its own takes the wider value.
  assert.equal(wide.components[BUTTON].frames[second], undefined, 'nothing is written for a frame that had nothing');
});
