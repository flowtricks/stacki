// The navigator's rows for a condition.
//
//   node test/navigator.js
//
// `{x ? (…) : (…)}` has two branches and the tree has to say which is which.
// `{x && (…)}` has one, and a branch you cannot leave is not a place: the row
// read "then" under "if command" and indented everything inside it a level for
// saying nothing. So a lone then is not drawn — what is inside the condition is
// drawn inside the condition — and the branch rows come back the moment there
// is an else to tell them apart from.
//
// The model keeps its branch either way: it is still where a drop lands, still
// what the file writes out. This is only which rows the tree draws.

const fs = require('fs');
const path = require('path');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
};
const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

const el = (id, name, children = []) => ({
  id,
  kind: 'element',
  name,
  props: { class: id },
  children,
});
const branch = (id, name, children) => ({ id, kind: 'branch', name, children });

// `{command && (<div class="hero-command"/>)}`
const AND = {
  id: 'if-and',
  kind: 'cond',
  op: '&&',
  test: 'command',
  children: [branch('and-then', 'then', [el('hero-command', 'div')])],
};
// `{user ? (<a/>) : (<b/>)}`
const TERNARY = {
  id: 'if-ternary',
  kind: 'cond',
  op: '?',
  test: 'user',
  children: [
    branch('t-then', 'then', [el('signed-in', 'a')]),
    branch('t-else', 'else', [el('signed-out', 'b')]),
  ],
};

// `{href ? (<a/>) : (heading)}` — the shape a Lumos card is written in. The
// else renders a value, not markup.
const VALUE_ELSE = {
  id: 'if-value',
  kind: 'cond',
  op: '?',
  test: 'href',
  children: [
    branch('v-then', 'then', [el('card-link', 'a')]),
    branch('v-else', 'else', [{ id: 'v-heading', kind: 'expr', value: '{heading}' }]),
  ],
};
// An element whose only child is the same kind of value: this one HAS a
// Content field, so the tree leaves it to the panel.
const WORDS = el('words', 'p', [{ id: 'w-text', kind: 'expr', value: '{heading}' }]);

(async () => {
  const esbuild = require('esbuild');
  const buildDir = path.join(__dirname, '..', 'node_modules', '.stacki-test');
  fs.mkdirSync(buildDir, { recursive: true });

  // --- the rule itself --------------------------------------------------------
  const rulePath = path.join(buildDir, 'branches.bundle.js');
  await esbuild.build({
    entryPoints: [path.join(__dirname, '..', 'src', 'branches.js')],
    outfile: rulePath,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    logLevel: 'silent',
  });
  const { thenBranch, elseBranch, rowChildren, rowHost } = require(rulePath);

  check('a then is the condition itself', thenBranch(AND)?.id === 'and-then');
  check('what is in it is what the condition holds', rowChildren(AND)[0]?.id === 'hero-command');
  check('and a drop on the condition lands in the branch', rowHost(AND).id === 'and-then');
  check('so does one with an else beside it', rowHost(TERNARY).id === 't-then');

  // With an else, the then is STILL not a row: what is in it is in the `if`,
  // and the else follows as the one branch that says something the `if` didn't.
  check(
    'a condition with an else shows its then inline',
    rowChildren(TERNARY)[0]?.id === 'signed-in',
    JSON.stringify(rowChildren(TERNARY).map((n) => n.id))
  );
  check(
    'and the else after it, as a row of its own',
    rowChildren(TERNARY)[1]?.id === 't-else',
    JSON.stringify(rowChildren(TERNARY).map((n) => n.id))
  );
  check('two rows, not three', rowChildren(TERNARY).length === 2, `${rowChildren(TERNARY).length}`);
  check('the else keeps its own children', rowChildren(elseBranch(TERNARY))[0]?.id === 'signed-out');
  check('and there is none to draw without one', elseBranch(AND) === null);

  check('a plain element is only ever itself', rowHost(el('x', 'div')).id === 'x');
  check(
    'a condition with nothing in it hides nothing',
    thenBranch({ kind: 'cond', children: [] }) === null &&
      rowChildren({ kind: 'cond', children: [] }).length === 0
  );
  check(
    'and one with only an else keeps that else',
    rowChildren({ kind: 'cond', children: [branch('e', 'else', [el('x', 'i')])] })[0]?.id === 'e',
    JSON.stringify(rowChildren({ kind: 'cond', children: [branch('e', 'else', [el('x', 'i')])] }))
  );

  // --- the rows ---------------------------------------------------------------
  const bundlePath = path.join(buildDir, 'structure.bundle.js');
  await esbuild.build({
    entryPoints: [path.join(__dirname, '..', 'src', 'panels', 'StructurePanel.jsx')],
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
  dom.window.Element.prototype.scrollIntoView = function scrollIntoView() {};

  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { act } = require('react');
  const StructurePanel = require(bundlePath).default;

  const container = dom.window.document.getElementById('root');
  const reactRoot = createRoot(container);
  const rows = () =>
    [...container.querySelectorAll('.structure-node')]
      .filter((r) => !r.classList.contains('frontmatter-node'))
      .map((r) => ({
        label: r.querySelector('.label')?.textContent || '',
        indent: parseInt(r.style.paddingLeft, 10) || 0,
        node: r.getAttribute('data-node-id'),
      }));
  const rowFor = (id) => container.querySelector(`.structure-node[data-node-id="${id}"]`);
  const at = (id) => rows().find((r) => r.node === id);

  const selected = [];
  const dropped = [];
  const render = (nodes) =>
    act(async () => {
      reactRoot.render(
        React.createElement(StructurePanel, {
          pageState: { editable: true, model: { nodes, imports: [] } },
          layouts: [],
          currentLayoutName: '',
          selectedId: null,
          onSelect: (id) => selected.push(id),
          onDropComponent: (name, target) => dropped.push({ name, ...target }),
          onMoveNode: () => {},
          onRemoveNode: () => {},
          onCopyNode: () => {},
          onDuplicateNode: () => {},
          onPasteNode: () => {},
          onChangeLayout: () => {},
          onRawChange: () => {},
          onHoverNode: () => {},
          onOpenComponent: () => {},
          hasClipboard: false,
        })
      );
      await settle(20);
    });
  // Everything starts collapsed; the header button opens it all.
  const expandAll = async () =>
    act(async () => {
      container.querySelector('.panel-header button').click();
      await settle(20);
    });

  await render([el('section', 'section', [AND, TERNARY, VALUE_ELSE, WORDS])]);
  await expandAll();

  const labels = rows().map((r) => r.label);
  check('the condition is a row', !!at('if-and'), labels.join(' | '));
  check('it says what it tests', at('if-and').label === 'if command', at('if-and').label);
  check('what is inside it is a row', !!at('hero-command'), labels.join(' | '));
  check('the branch it holds is not', !at('and-then'), labels.join(' | '));
  check(
    'so what is inside sits one level in, not two',
    at('hero-command').indent - at('if-and').indent === 16,
    `${at('hero-command').indent - at('if-and').indent}px`
  );

  // The one with an else draws that else, and nothing for the then: what the
  // test holds for sits in the `if`, and the else is the alternative to it.
  check('a condition with an else names that else', !!at('t-else'), labels.join(' | '));
  check('and still nothing for the then', !at('t-then'), labels.join(' | '));
  check(
    'the markup it renders sits one level into the condition',
    at('signed-in').indent - at('if-ternary').indent === 16,
    `${at('signed-in').indent - at('if-ternary').indent}px`
  );
  check(
    'the else sits beside it, at the same level',
    at('t-else').indent === at('signed-in').indent,
    `${at('t-else').indent} vs ${at('signed-in').indent}`
  );
  check('with its own markup under it', at('signed-out').indent - at('t-else').indent === 16);
  check(
    'and no row anywhere says "then"',
    labels.filter((l) => l === 'then').length === 0,
    labels.join(' | ')
  );

  // An else that renders a value has to draw it. There is no Content field on a
  // branch — its panel says what the branch is for and nothing else — so hiding
  // `{heading}` there left a row that looked empty and a value reachable from
  // nowhere at all.
  check('an else holding a value is not empty', !!at('v-heading'), labels.join(' | '));
  check(
    'the value sits under the else',
    at('v-heading') && at('v-heading').indent - at('v-else').indent === 16,
    at('v-heading') ? `${at('v-heading').indent - at('v-else').indent}px` : 'no row for it'
  );
  // Where there IS a Content field, the words stay in it: showing them twice is
  // the noise this rule exists to avoid.
  check('an element with words in it still leaves them to the panel', !at('w-text'), labels.join(' | '));

  // --- a drop on the condition ------------------------------------------------
  {
    const row = rowFor('if-and');
    const dataTransfer = {
      types: ['avb/component'],
      getData: (type) => (type === 'avb/component' ? 'Button' : ''),
      dropEffect: 'move',
      effectAllowed: 'move',
    };
    const fire = (type) => {
      const ev = new dom.window.Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'dataTransfer', { value: dataTransfer });
      row.dispatchEvent(ev);
    };
    await act(async () => {
      fire('dragover');
      fire('drop');
      await settle(20);
    });
    check('dropping on the condition is allowed', dropped.length === 1, JSON.stringify(dropped));
    check(
      'and lands in the branch, which is where the markup lives',
      dropped[0]?.parentId === 'and-then',
      JSON.stringify(dropped[0])
    );
  }

  // --- arrow keys -------------------------------------------------------------
  // They walk the tree that is drawn: a row nobody can see is not somewhere the
  // selection can land.
  {
    const press = async (key, from) => {
      selected.length = 0;
      await act(async () => {
        reactRoot.render(
          React.createElement(StructurePanel, {
            pageState: { editable: true, model: { nodes: [el('section', 'section', [AND, TERNARY])], imports: [] } },
            layouts: [],
            currentLayoutName: '',
            selectedId: from,
            onSelect: (id) => selected.push(id),
            onDropComponent: () => {},
            onMoveNode: () => {},
            onRemoveNode: () => {},
            onCopyNode: () => {},
            onDuplicateNode: () => {},
            onPasteNode: () => {},
            onChangeLayout: () => {},
            onRawChange: () => {},
            onHoverNode: () => {},
            onOpenComponent: () => {},
            hasClipboard: false,
          })
        );
        await settle(10);
      });
      // A separate turn: the key listener is an effect, and it only knows what
      // is selected once the render it belongs to has been committed.
      await act(async () => {
        dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true }));
        await settle(10);
      });
      return selected[0];
    };
    check('down from the condition reaches what is inside it', (await press('ArrowDown', 'if-and')) === 'hero-command');
    check('and up from there reaches the condition', (await press('ArrowUp', 'hero-command')) === 'if-and');
    check(
      'down from a condition with an else reaches its markup, not a branch row',
      (await press('ArrowDown', 'if-ternary')) === 'signed-in'
    );
    // ← and → step between siblings, ↑ goes out. The else and the markup the
    // `if` renders are siblings now, so one press moves between them.
    const leftOfElse = await press('ArrowLeft', 't-else');
    check('left from the else reaches the markup beside it', leftOfElse === 'signed-in', String(leftOfElse));
    const outOfElse = await press('ArrowUp', 't-else');
    check('and up from it goes out to the condition', outOfElse === 'if-ternary', String(outOfElse));
  }

  // A condition dropped from the palette starts as the one thing it is: a
  // test and what it shows. The else is a switch in the props panel.
  {
    const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'App.jsx'), 'utf8');
    const insert = app.slice(app.indexOf("item.type === 'cond'"), app.indexOf("item.type === 'comment'"));
    check("a new condition is `test && (…)`", /op: '&&'/.test(insert), insert.slice(0, 400));
    check('with one branch in it', (insert.match(/kind: 'branch'/g) || []).length === 1, insert.slice(0, 400));
    check('and no else until one is asked for', !/name: 'else'/.test(insert));
  }

  if (failures.length) {
    console.error(`\nnavigator: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`navigator: ${checked} passed`);
  process.exit(0);
})();
