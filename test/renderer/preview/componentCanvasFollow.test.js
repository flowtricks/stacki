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
      "export { useFrameFollowsEditor } from './src/app/state/useDesktopComponentCanvas';",
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
    scope: first.key,
    scale: 1,
    framePanel: 'shown',
    defaults: {},
    instances: tree.instances,
    boxes: tree.boxes,
    root: tree.root,
    subject: 'frame',
    picked: { kind: 'component' },
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
        scope: state.scope,
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
