// Rows for elements that are on the page but taking no part in it.
//
//   node test/renderer/structure/nodeStates.test.js
//
// Two states worth saying out loud in the navigator, neither readable from the
// markup: `display: none` (there and not drawn) and `pointer-events: none`
// (drawn and takes no clicks). Either can arrive from any rule in any
// stylesheet, so the source can't answer — only the laid-out page can, and it
// reports what it computed.
//
// They are not the same as "renders nothing", which is about a node that put no
// element on the page at all. A hidden element is very much there.

const fs = require('fs');
const path = require('path');
const Module = require('module');
const { repoPath } = require('../../helpers/sources.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) {
    failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  }
};
const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  // --- what the page reports ---------------------------------------------------
  {
    const { JSDOM } = require('jsdom');
    const marked = (nodePath, html) => `<!--avb-s:${nodePath}-->${html}<!--avb-e:${nodePath}-->`;
    const dom = new JSDOM(
      `<!doctype html><head><style>
         .gone { display: none }
         .inert { pointer-events: none }
       </style></head><body>
        ${marked('0', '<section id="plain">visible</section>')}
        ${marked('1', '<div id="gone" class="gone">hidden</div>')}
        ${marked('2', '<img id="inert" class="inert" alt="">')}
        ${marked('3', '<p id="both" class="gone inert">both</p>')}
      </body>`,
      { url: 'http://localhost:4321/#avb-design', pretendToBeVisual: true },
    );
    const { window } = dom;
    const NO_BOX = { x: 0, y: 0, width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0 };
    window.Element.prototype.getBoundingClientRect = function () {
      return { ...NO_BOX, width: 100, height: 20, right: 100, bottom: 20 };
    };
    window.Range.prototype.getBoundingClientRect = () => NO_BOX;

    global.window = window;
    global.document = window.document;
    global.location = window.location;
    global.navigator = window.navigator;
    global.MutationObserver = window.MutationObserver;
    global.requestAnimationFrame = window.requestAnimationFrame.bind(window);

    const sent = [];
    window.parent = { postMessage: (message) => sent.push(message) };
    const electron = {
      contextBridge: { exposeInMainWorld: () => {} },
      ipcRenderer: { on: () => {}, send: () => {}, invoke: async () => {} },
      webUtils: {},
    };
    const realRequire = Module.prototype.require;
    Module.prototype.require = function (id) {
      return id === 'electron' ? electron : realRequire.apply(this, arguments);
    };
    process.isMainFrame = false;
    require(repoPath('dist/electron/preload/preload.js'));
    Module.prototype.require = realRequire;
    await settle(60);

    // Asking for anything makes the frame report what it sees.
    const event = new window.MessageEvent('message', { data: { type: 'avb:track', paths: ['0'] } });
    Object.defineProperty(event, 'source', { value: window.parent });
    window.dispatchEvent(event);
    await settle(20);

    const states = sent.filter((message) => message.type === 'avb:node-states').pop();
    check('the page reports what it computed', !!states, JSON.stringify(sent.map((message) => message.type)));
    check('a display:none element is hidden', (states?.hidden || []).includes('1'), JSON.stringify(states));
    check('a pointer-events:none element is inert', (states?.inert || []).includes('2'), JSON.stringify(states));
    check('an element can be both', (states?.hidden || []).includes('3') && (states?.inert || []).includes('3'), JSON.stringify(states));
    check('and an ordinary one is neither', !(states?.hidden || []).includes('0') && !(states?.inert || []).includes('0'), JSON.stringify(states));

    // Computed, not authored: a rule that arrives later is still seen.
    sent.length = 0;
    const style = document.createElement('style');
    style.textContent = '#plain { pointer-events: none }';
    document.head.appendChild(style);
    window.dispatchEvent(event);
    await settle(20);
    const after = sent.filter((message) => message.type === 'avb:node-states').pop();
    check('a rule added later is picked up', (after?.inert || []).includes('0'), JSON.stringify(after));
  }

  // --- what the navigator draws ------------------------------------------------
  {
    const esbuild = require('esbuild');
    const buildDirectory = repoPath('node_modules/.stacki-test');
    fs.mkdirSync(buildDirectory, { recursive: true });
    const bundlePath = path.join(buildDirectory, 'node-states.bundle.js');
    await esbuild.build({
      entryPoints: [repoPath('src/features/structure/StructurePanel.tsx')],
      outfile: bundlePath,
      bundle: true,
      format: 'cjs',
      platform: 'node',
      jsx: 'automatic',
      external: ['react', 'react-dom', 'react/jsx-runtime'],
      logLevel: 'silent',
    });

    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
    global.window = dom.window;
    global.document = dom.window.document;
    global.navigator = dom.window.navigator;
    global.Element = dom.window.Element;
    global.HTMLElement = dom.window.HTMLElement;
    global.Node = dom.window.Node;
    global.IS_REACT_ACT_ENVIRONMENT = true;
    dom.window.Element.prototype.scrollIntoView = function () {};

    const React = require('react');
    const { createRoot } = require('react-dom/client');
    const { act } = require('react');
    const StructurePanel = require(bundlePath).default;

    const elementNode = (id) => ({ id, kind: 'element', name: 'div', props: {}, children: [] });
    const container = dom.window.document.getElementById('root');
    const root = createRoot(container);
    await act(async () => {
      root.render(
        React.createElement(StructurePanel, {
          pageState: {
            editable: true,
            model: {
              nodes: [elementNode('plain'), elementNode('gone'), elementNode('inert'), elementNode('both')],
              imports: [],
            },
          },
          layouts: [],
          currentLayoutName: '',
          selectedId: undefined,
          emptyNodeIds: new Set(),
          hiddenNodeIds: new Set(['gone', 'both']),
          inertNodeIds: new Set(['inert', 'both']),
          onSelect: () => {},
          onDropComponent: () => {},
          onMoveNode: () => {},
          onRemoveNode: () => {},
          onCopyNode: () => {},
          onDuplicateNode: () => {},
          onPasteNode: () => {},
          onChangeLayout: () => {},
          onCodeChange: () => {},
          onOpenCodePanel: () => {},
          onHoverNode: () => {},
          onOpenComponent: () => {},
          hasClipboard: false,
        }),
      );
      await settle(20);
    });

    const marks = (id) => {
      const row = container.querySelector(`.structure-node[data-node-id="${id}"]`);
      return [...(row?.querySelectorAll('.node-empty [role="img"]') || [])].map((empty) => empty.getAttribute('aria-label'));
    };
    check('an ordinary row is unmarked', marks('plain').length === 0, marks('plain').join(' | '));
    check('a hidden row says display: none', marks('gone').length === 1 && /display: none/.test(marks('gone')[0]), marks('gone').join(' | '));
    check('an inert row says pointer-events: none', marks('inert').length === 1 && /pointer-events: none/.test(marks('inert')[0]), marks('inert').join(' | '));
    check('a row that is both carries both marks', marks('both').length === 2, marks('both').join(' | '));

    // "Renders nothing" is a different thing and keeps its own mark — a node
    // that put no element on the page can't also be reported as hidden.
    await act(async () => {
      root.render(
        React.createElement(StructurePanel, {
          pageState: { editable: true, model: { nodes: [elementNode('plain')], imports: [] } },
          layouts: [],
          currentLayoutName: '',
          selectedId: undefined,
          emptyNodeIds: new Set(['plain']),
          hiddenNodeIds: new Set(['plain']),
          inertNodeIds: new Set(),
          onSelect: () => {},
          onDropComponent: () => {},
          onMoveNode: () => {},
          onRemoveNode: () => {},
          onCopyNode: () => {},
          onDuplicateNode: () => {},
          onPasteNode: () => {},
          onChangeLayout: () => {},
          onCodeChange: () => {},
          onOpenCodePanel: () => {},
          onHoverNode: () => {},
          onOpenComponent: () => {},
          hasClipboard: false,
        }),
      );
      await settle(20);
    });
    check('a node that rendered nothing says that, once', marks('plain').length === 1 && /Renders nothing/.test(marks('plain')[0]), marks('plain').join(' | '));

    const kinds = (id) =>
      [...container.querySelectorAll(`.structure-node[data-node-id="${id}"] .node-empty [data-status]`)].map((mark) => mark.getAttribute('data-status'));
    const render = async (props) => {
      await act(async () => {
        root.render(
          React.createElement(StructurePanel, {
            pageState: { editable: true, model: { nodes: props.nodes, imports: [] } },
            layouts: [],
            currentLayoutName: '',
            selectedId: props.selectedId,
            emptyNodeIds: props.empty ?? new Set(),
            hiddenNodeIds: props.hidden ?? new Set(),
            inertNodeIds: new Set(),
            onSelect: () => {},
            onDropComponent: () => {},
            onMoveNode: () => {},
            onRemoveNode: () => {},
            onCopyNode: () => {},
            onDuplicateNode: () => {},
            onPasteNode: () => {},
            onChangeLayout: () => {},
            onCodeChange: () => {},
            onOpenCodePanel: () => {},
            onHoverNode: () => {},
            onOpenComponent: () => {},
            hasClipboard: false,
          }),
        );
        await settle(20);
      });
    };
    const tag = (id, name) => ({ id, kind: 'element', name, props: {}, children: [] });
    const component = { id: 'section', kind: 'component', name: 'Section', props: {}, children: [] };

    await render({ nodes: [tag('plain', 'div'), component], selectedId: 'plain' });
    check('a visible selected element carries no mark', kinds('plain').length === 0, kinds('plain').join(','));
    await render({ nodes: [tag('plain', 'div'), component], selectedId: 'section' });
    check('a visible selected component carries no mark', kinds('section').length === 0, kinds('section').join(','));
    check('no slashed eye anywhere while nothing is hidden', container.querySelector('[data-status="hidden"]') === null);

    await render({ nodes: [tag('gone', 'div'), tag('other', 'div')], selectedId: 'other', hidden: new Set(['gone']) });
    check('a hidden element shows the hidden state while unselected', kinds('gone').join(',') === 'hidden', kinds('gone').join(','));
    check('the hidden mark is named for the state', /display: none/.test(marks('gone')[0] || ''), marks('gone').join(' | '));
    check('a visible sibling of a hidden one stays unmarked', kinds('other').length === 0, kinds('other').join(','));

    const mark = container.querySelector('.structure-node[data-node-id="gone"] [data-status="hidden"]');
    check('the mark has no native title', mark !== null && !mark.hasAttribute('title'));
    await act(async () => {
      mark.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true }));
      await settle(650);
    });
    const tip = dom.window.document.querySelector('.rail-tooltip[role="tooltip"]');
    check('hovering shows the custom tooltip', tip !== null && /display: none/.test(tip.textContent || ''), tip?.textContent);

    await render({ nodes: [tag('empty', 'div')], selectedId: 'empty', empty: new Set(['empty']) });
    check('a node that renders nothing is not marked hidden', kinds('empty').join(',') === 'empty', kinds('empty').join(','));

    await render({
      nodes: [tag('script', 'script'), tag('style', 'style'), { id: 'raw', kind: 'raw', name: 'script', children: [] }],
      selectedId: 'script',
      empty: new Set(['script', 'style', 'raw']),
      hidden: new Set(['script', 'style', 'raw']),
    });
    check('a script row carries no mark', kinds('script').length === 0, kinds('script').join(','));
    check('a style row carries no mark', kinds('style').length === 0, kinds('style').join(','));
    check('a raw code row carries no mark', kinds('raw').length === 0, kinds('raw').join(','));
  }

  if (failures.length) {
    console.error(`\nnode-states: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`node-states: ${checked} passed`);
  process.exit(0);
})();
