// An `{expression}` that is a pure data binding is a purple chip in the Expression panel, and plain text in the Navigator.
//
//   node test/renderer/structure/expressionBinding.test.js
//
// Two places draw the node. The Navigator row for `{aiCallout1.cta.label}` shows NO chip (text never wears a purple
// chip in the Navigator): the path as plain text WITHOUT braces and the data-binding icon; complex code (a call, a
// ternary, a template literal, an operator) keeps its braces and the code icon. Other chip kinds (the Content field,
// the prop fields, the Expression panel) are untouched. The Expression panel shows the chip for a pure binding with a `{}` toggle to the raw code editor, and a click
// on the chip opens the data picker. The checks run on jsdom with rendered React, on generated nodes only.

const fs = require('fs');
const path = require('path');
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
  const esbuild = require('esbuild');
  const buildDirectory = repoPath('node_modules/.stacki-test');
  fs.mkdirSync(buildDirectory, { recursive: true });
  const bundle = async (entry, name) => {
    const outfile = path.join(buildDirectory, name);
    await esbuild.build({
      entryPoints: [repoPath(entry)],
      outfile,
      bundle: true,
      format: 'cjs',
      platform: 'node',
      jsx: 'automatic',
      external: ['react', 'react-dom', 'react/jsx-runtime'],
      loader: { '.css': 'empty' },
      logLevel: 'silent',
    });
    return outfile;
  };
  const panelBundle = await bundle('src/features/structure/StructurePanel.tsx', 'expression-binding-structure.bundle.js');
  const sourceBundle = await bundle('src/features/props/SourcePanels.tsx', 'expression-binding-source.bundle.js');
  const modelBundle = await bundle('src/editor/bindingPath.ts', 'expression-binding-model.bundle.js');

  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  global.window = dom.window;
  global.document = dom.window.document;
  global.navigator = dom.window.navigator;
  global.Element = dom.window.Element;
  global.HTMLElement = dom.window.HTMLElement;
  global.Node = dom.window.Node;
  // The raw code editor is CodeMirror, which needs these from the page it lives in.
  global.MutationObserver = dom.window.MutationObserver;
  global.Window = dom.window.Window;
  global.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  global.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  global.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
  const NO_RECT = { x: 0, y: 0, width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0 };
  dom.window.Range.prototype.getClientRects = () => [];
  dom.window.Range.prototype.getBoundingClientRect = () => NO_RECT;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  dom.window.Element.prototype.scrollIntoView = function () {};

  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { act } = require('react');
  const StructurePanel = require(panelBundle).default;
  const { ExprPanel } = require(sourceBundle);
  const { pureBindingPath } = require(modelBundle);

  // --- which expressions are bindings ------------------------------------------
  for (const [source, expected] of [
    ['{aiCallout1.cta.label}', 'aiCallout1.cta.label'],
    ['{ card.title }', 'card.title'],
    ['{items[0].name}', 'items[0].name'],
    ['{props.x}', 'props.x'],
    ['{fn(a)}', undefined],
    ['{a ? b : c}', undefined],
    ['{`hi ${name}`}', undefined],
    ['{a + b}', undefined],
    ['{<b>x</b>}', undefined],
    ['{a?.b}', undefined],
    ['{true}', undefined],
    ['{}', undefined],
  ]) {
    check(`pureBindingPath(${source})`, pureBindingPath(source) === expected, String(pureBindingPath(source)));
  }

  const container = dom.window.document.getElementById('root');
  const root = createRoot(container);

  // --- the Navigator row -------------------------------------------------------
  const exprNode = (id, value) => ({ id, kind: 'expr', value });
  const LONG = 'someVeryLongCollection.entries.firstItem.nested.heading.label';
  const nodes = [
    exprNode('plain', '{aiCallout1.cta.label}'),
    exprNode('long', `{${LONG}}`),
    exprNode('call', '{format(date)}'),
    exprNode('ternary', '{ok ? a : b}'),
    exprNode('template', '{`x ${y}`}'),
  ];
  await act(async () => {
    root.render(
      React.createElement(StructurePanel, {
        pageState: { editable: true, model: { nodes, imports: [] } },
        layouts: [],
        currentLayoutName: '',
        selectedId: 'plain',
        emptyNodeIds: new Set(),
        hiddenNodeIds: new Set(),
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
  const row = (id) => container.querySelector(`.structure-node[data-node-id="${id}"]`);

  const labelText = (id) => row(id)?.querySelector('.label')?.textContent;
  check('a pure binding row has no chip', row('plain')?.querySelector('.expr-chip, .data-chip') === null);
  check('the row reads as the plain path without braces', labelText('plain') === 'aiCallout1.cta.label', labelText('plain'));
  check('a long path has no chip either', row('long')?.querySelector('.expr-chip, .data-chip') === null);
  check('a long path shows in full as text', labelText('long') === LONG, labelText('long'));

  for (const id of ['call', 'ternary', 'template']) {
    check(`complex code has no chip: ${id}`, row(id)?.querySelector('.expr-chip') === null);
    check(
      `complex code keeps its braces: ${id}`,
      /[{}]/.test(row(id)?.querySelector('.label')?.textContent || ''),
      row(id)?.querySelector('.label')?.textContent,
    );
  }
  const iconOf = (id) => row(id)?.querySelector('.icon')?.innerHTML;
  check('a binding row has a different icon from code', iconOf('plain') !== iconOf('call'));

  // Hover and click still reach the row.
  const selected = [];
  await act(async () => {
    root.render(
      React.createElement(StructurePanel, {
        pageState: { editable: true, model: { nodes, imports: [] } },
        layouts: [],
        currentLayoutName: '',
        selectedId: undefined,
        emptyNodeIds: new Set(),
        hiddenNodeIds: new Set(),
        inertNodeIds: new Set(),
        onSelect: (id) => selected.push(id),
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
  await act(async () => {
    row('plain')
      .querySelector('.label')
      .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await settle(5);
  });
  check('clicking the label in the Navigator selects the row', selected.includes('plain'), selected.join(','));

  // --- the Expression panel ----------------------------------------------------
  const committed = [];
  const renderPanel = async (value) => {
    await act(async () => {
      root.render(
        React.createElement(ExprPanel, {
          node: { id: 'e1', kind: 'expr', value },
          bindContext: { frontmatter: '', imports: '' },
          loopContext: undefined,
          onSetText: (next) => committed.push(next),
        }),
      );
      await settle(20);
    });
  };
  await renderPanel('{aiCallout1.cta.label}');
  const panelChip = () => container.querySelector('.text-connection .expr-chip');
  check('the panel shows the binding as a chip', panelChip()?.textContent === 'aiCallout1.cta.label', panelChip()?.textContent);
  check('the panel shows no code box for a binding', container.querySelector('.expr-input') === null);
  const toggle = () => container.querySelector('.prop-expr-toggle');
  check('the {} toggle exists and is not pressed', toggle()?.getAttribute('aria-pressed') === 'false', String(toggle()?.getAttribute('aria-pressed')));

  await act(async () => {
    toggle().dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await settle(10);
  });
  check(
    'the {} toggle switches to raw code',
    toggle()?.getAttribute('aria-pressed') === 'true' && container.querySelector('.text-connection .expr-chip') === null,
  );
  await act(async () => {
    toggle().dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await settle(10);
  });
  check('and back to the chip', container.querySelector('.text-connection .expr-chip') !== null);

  await act(async () => {
    panelChip().dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await settle(30);
  });
  check('clicking the chip opens the data picker', container.querySelector('.bind-menu') !== null || dom.window.document.querySelector('.bind-menu') !== null);

  // A complex expression keeps the code editor and no chip.
  await renderPanel('{format(date)}');
  check(
    'a call keeps the code editor',
    container.querySelector('.text-connection .expr-chip') === null && container.querySelector('.prop-expr-toggle') === null,
  );

  if (failures.length) {
    console.error(`\nexpression-binding: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`expression-binding: ${checked} passed`);
  process.exit(0);
})();
