// The navigator's rows for a condition.
//
//   node test/renderer/structure/navigator.test.js
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

const { toastMessages, toastNotices } = require('../../helpers/toastCapture');
const fs = require('fs');
const path = require('path');
const { repoPath } = require('../../helpers/sources.js');
const { readAppSource } = require('../../helpers/sourceText.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) {
    failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  }
};
const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

const elementNode = (id, name, children = []) => ({
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
  children: [branch('and-then', 'then', [elementNode('hero-command', 'div')])],
};
// `{user ? (<a/>) : (<b/>)}`
const TERNARY = {
  id: 'if-ternary',
  kind: 'cond',
  op: '?',
  test: 'user',
  children: [branch('t-then', 'then', [elementNode('signed-in', 'a')]), branch('t-else', 'else', [elementNode('signed-out', 'b')])],
};

// `{href ? (<a/>) : (heading)}` — the shape a Lumos card is written in. The
// else renders a value, not markup.
const VALUE_ELSE = {
  id: 'if-value',
  kind: 'cond',
  op: '?',
  test: 'href',
  children: [branch('v-then', 'then', [elementNode('card-link', 'a')]), branch('v-else', 'else', [{ id: 'v-heading', kind: 'expr', value: '{heading}' }])],
};
// An element whose only child is the same kind of value: this one HAS a
// Content field, so the tree leaves it to the panel.
const WORDS = elementNode('words', 'p', [{ id: 'w-text', kind: 'expr', value: '{heading}' }]);

(async () => {
  const esbuild = require('esbuild');
  const buildDirectory = repoPath('node_modules/.stacki-test');
  fs.mkdirSync(buildDirectory, { recursive: true });

  // --- the rule itself --------------------------------------------------------
  const rulePath = path.join(buildDirectory, 'branches.bundle.js');
  await esbuild.build({
    entryPoints: [repoPath('src/editor/branches.ts')],
    outfile: rulePath,
    inject: [repoPath('test/helpers/toastCaptureEntry.js')],
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
    JSON.stringify(rowChildren(TERNARY).map((node) => node.id)),
  );
  check('and the else after it, as a row of its own', rowChildren(TERNARY)[1]?.id === 't-else', JSON.stringify(rowChildren(TERNARY).map((node) => node.id)));
  check('two rows, not three', rowChildren(TERNARY).length === 2, `${rowChildren(TERNARY).length}`);
  check('the else keeps its own children', rowChildren(elseBranch(TERNARY))[0]?.id === 'signed-out');
  check('and there is none to draw without one', elseBranch(AND) === undefined);

  check('a plain element is only ever itself', rowHost(elementNode('x', 'div')).id === 'x');
  check(
    'a condition with nothing in it hides nothing',
    thenBranch({ kind: 'cond', children: [] }) === undefined && rowChildren({ kind: 'cond', children: [] }).length === 0,
  );
  check(
    'and one with only an else keeps that else',
    rowChildren({ kind: 'cond', children: [branch('e', 'else', [elementNode('x', 'i')])] })[0]?.id === 'e',
    JSON.stringify(rowChildren({ kind: 'cond', children: [branch('e', 'else', [elementNode('x', 'i')])] })),
  );

  // --- the rows ---------------------------------------------------------------
  const bundlePath = path.join(buildDirectory, 'structure.bundle.js');
  await esbuild.build({
    entryPoints: [repoPath('src/features/structure/StructurePanel.tsx')],
    outfile: bundlePath,
    inject: [repoPath('test/helpers/toastCaptureEntry.js')],
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
      .filter((row) => !row.classList.contains('frontmatter-node'))
      .map((row) => ({
        label: row.querySelector('.label')?.textContent || '',
        // The indent step is a CSS knob (--navigator-indent), so rows are
        // compared by nesting level, which each row carries as data-depth.
        indent: Number(row.getAttribute('data-depth')),
        node: row.getAttribute('data-node-id'),
      }));
  const rowFor = (id) => container.querySelector(`.structure-node[data-node-id="${id}"]`);
  const at = (id) => rows().find((row) => row.node === id);

  const selected = [];
  const dropped = [];
  const render = (nodes, pageKey) =>
    act(async () => {
      reactRoot.render(
        React.createElement(StructurePanel, {
          key: pageKey,
          pageState: { editable: true, model: { nodes, imports: [] } },
          layouts: [],
          currentLayoutName: '',
          selectedId: undefined,
          onSelect: (id) => selected.push(id),
          onDropComponent: (name, target) => dropped.push({ name, ...target }),
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
  // The header expands the remaining branches beyond the initially open root.
  const expandAll = async () =>
    act(async () => {
      container.querySelector('.panel-header button').click();
      await settle(20);
    });

  const defaultSection = elementNode('default-section', 'section', [elementNode('default-content', 'div')]);
  const defaultLayout = {
    ...elementNode('default-layout', 'BaseLayout', [defaultSection]),
    kind: 'component',
  };
  const defaultSibling = {
    ...elementNode('default-sibling', 'Sidebar', [elementNode('sidebar-content', 'div')]),
    kind: 'component',
  };
  await render([defaultLayout, defaultSibling], '/first.astro');
  check('the first component opens on initial load', !!rowFor('default-section'));
  check('nested branches start collapsed', !rowFor('default-content'));
  check('other root components start collapsed', !rowFor('sidebar-content'));
  await act(async () => rowFor('default-layout').querySelector('.drag-handle').click());
  check('the initial root can be collapsed manually', !rowFor('default-section'));
  await render([{ ...defaultLayout }, defaultSibling], '/first.astro');
  check('editing the current file preserves manual collapse', !rowFor('default-section'));
  await render([defaultLayout, defaultSibling], '/second.astro');
  check('switching pages opens the root even when node ids match', !!rowFor('default-section'));
  await render([defaultLayout, defaultSibling], '/first.astro');
  check('returning to a page restores its opening default', !!rowFor('default-section'));

  await render([elementNode('section', 'section', [AND, TERNARY, VALUE_ELSE, WORDS])]);
  await expandAll();

  const labels = rows().map((row) => row.label);
  check('the condition is a row', !!at('if-and'), labels.join(' | '));
  check('it says what it tests', at('if-and').label === 'if command', at('if-and').label);
  check('what is inside it is a row', !!at('hero-command'), labels.join(' | '));
  check('the branch it holds is not', !at('and-then'), labels.join(' | '));
  check(
    'so what is inside sits one level in, not two',
    at('hero-command').indent - at('if-and').indent === 1,
    `${at('hero-command').indent - at('if-and').indent} levels`,
  );

  // The one with an else draws that else, and nothing for the then: what the
  // test holds for sits in the `if`, and the else is the alternative to it.
  check('a condition with an else names that else', !!at('t-else'), labels.join(' | '));
  check('and still nothing for the then', !at('t-then'), labels.join(' | '));
  check(
    'the markup it renders sits one level into the condition',
    at('signed-in').indent - at('if-ternary').indent === 1,
    `${at('signed-in').indent - at('if-ternary').indent} levels`,
  );
  check('the else sits beside it, at the same level', at('t-else').indent === at('signed-in').indent, `${at('t-else').indent} vs ${at('signed-in').indent}`);
  check('with its own markup under it', at('signed-out').indent - at('t-else').indent === 1);
  check('and no row anywhere says "then"', labels.filter((label) => label === 'then').length === 0, labels.join(' | '));

  // An else that renders a value has to draw it. There is no Content field on a
  // branch — its panel says what the branch is for and nothing else — so hiding
  // `{heading}` there left a row that looked empty and a value reachable from
  // nowhere at all.
  check('an else holding a value is not empty', !!at('v-heading'), labels.join(' | '));
  check(
    'the value sits under the else',
    at('v-heading') && at('v-heading').indent - at('v-else').indent === 1,
    at('v-heading') ? `${at('v-heading').indent - at('v-else').indent} levels` : 'no row for it',
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
      const event = new dom.window.Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
      row.dispatchEvent(event);
    };
    await act(async () => {
      fire('dragover');
      fire('drop');
      await settle(20);
    });
    check('dropping on the condition is allowed', dropped.length === 1, JSON.stringify(dropped));
    check('and lands in the branch, which is where the markup lives', dropped[0]?.parentId === 'and-then', JSON.stringify(dropped[0]));
  }

  // Moving between descendants must not erase the destination between two
  // dragover events. Leaving the panel, hovering blank space, and cancelling
  // a drag must still remove it.
  {
    const source = rowFor('hero-command');
    const gap = rowFor('if-ternary').previousElementSibling;
    const data = new Map();
    const dataTransfer = {
      types: ['avb/node'],
      setData: (type, value) => data.set(type, value),
      getData: (type) => data.get(type) || '',
      setDragImage: () => {},
    };
    const fire = (element, type, relatedTarget = undefined) =>
      act(async () => {
        element.dispatchEvent(Object.assign(new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, relatedTarget }), { dataTransfer }));
      });
    await fire(source, 'dragstart');
    check('dragging keeps the source in its original place', rowFor('hero-command') === source);
    await fire(gap, 'dragover');
    check('a gap shows the insertion marker', !!gap.querySelector('.drop-indicator'));
    await fire(gap, 'dragleave', gap.querySelector('.drop-indicator'));
    check('entering the marker does not erase it', !!gap.querySelector('.drop-indicator'));
    await fire(rowFor('if-and'), 'dragover');
    await fire(gap, 'dragleave', rowFor('if-and').querySelector('.label'));
    check('entering a row preserves the new child destination', rowFor('if-and').style.borderColor !== '');
    await fire(rowFor('if-and'), 'dragleave', document.body);
    check('leaving the panel clears the child destination', rowFor('if-and').style.borderColor === '');
    await fire(gap, 'dragover');
    await fire(container.querySelector('.panel-body'), 'dragover');
    check('blank space clears the previous marker', !container.querySelector('.drop-indicator'));
    await fire(gap, 'dragover');
    await fire(source, 'dragend');
    check('cancelling clears the insertion marker', !container.querySelector('.drop-indicator'));
    await fire(source, 'dragstart');
    await fire(gap, 'dragover');
    await fire(document.body, 'dragend');
    check('an external drag end clears the marker', !container.querySelector('.drop-indicator'));
    await fire(source, 'dragstart');
    await fire(gap, 'dragover');
    await act(async () => {
      window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape' }));
    });
    check('Escape clears the marker', !container.querySelector('.drop-indicator'));
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
            pageState: {
              editable: true,
              model: { nodes: [elementNode('section', 'section', [AND, TERNARY])], imports: [] },
            },
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
            onCodeChange: () => {},
            onOpenCodePanel: () => {},
            onHoverNode: () => {},
            onOpenComponent: () => {},
            hasClipboard: false,
          }),
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
    check('down from a condition with an else reaches its markup, not a branch row', (await press('ArrowDown', 'if-ternary')) === 'signed-in');
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
    // The app shell and the modules it was split into (src/app).
    const app = readAppSource();
    const insert = app.slice(app.indexOf("item.type === 'cond'"), app.indexOf("item.type === 'comment'"));
    check('a new condition is `test && (…)`', /op: '&&'/.test(insert), insert.slice(0, 400));
    check('with one branch in it', (insert.match(/kind: 'branch'/g) || []).length === 1, insert.slice(0, 400));
    check('and no else until one is asked for', !/name: 'else'/.test(insert));
  }

  // --- a folded comment, on whatever row it belongs to --------------------------
  //
  // A note sits inside its node's row, and a component's row is green. A flat
  // grey can't lift with the background under it: #666 read 3.1:1 against the
  // panel and 2.1:1 against a selected component row, which is where it looked
  // muddy. White thinned by alpha composites over each of them instead, so what
  // is checked here is the contrast it ends up with — not the colour it is
  // written as.
  {
    const css = fs.readFileSync(repoPath('src/app/styles.css'), 'utf8');
    const rule = css.slice(css.indexOf('.node-note {'));
    const note = /color:\s*rgba\(([^)]+)\)/.exec(rule.slice(0, rule.indexOf('}')));
    check('the note is written as a colour with alpha', !!note, rule.slice(0, rule.indexOf('}')));
    const [red, green, blue, alpha] = (note?.[1] ?? '0,0,0,1').split(',').map((part) => parseFloat(part));

    const over = (fg, alpha, bg) => fg.map((channel, i) => channel * alpha + bg[i] * (1 - alpha));
    const lum = (color) => {
      const [rl, gl, bl] = color.map((channel) => {
        const normalized = channel / 255;
        return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * rl + 0.7152 * gl + 0.0722 * bl;
    };
    const ratio = (x, y) => {
      const [hi, lo] = [lum(x), lum(y)].sort((left, right) => right - left);
      return (hi + 0.05) / (lo + 0.05);
    };
    // The two rows a note can sit on: the panel, and a selected component row
    // (--component-green-soft over --bg).
    const panel = [25, 25, 25];
    const greenRow = over([121, 224, 156], 0.16, panel);
    const on = (bg) => ratio(over([red, green, blue], alpha, bg), bg);

    check('it reads on the panel', on(panel) > 4, on(panel).toFixed(2));
    check('and on a green component row', on(greenRow) > 3.5, on(greenRow).toFixed(2));
    // …and is still a note: a label at full strength would be ~15:1 here.
    check('while staying quieter than the label beside it', on(panel) < 8, on(panel).toFixed(2));
    // The old grey, for the record: this is the case it failed.
    const grey = (bg) => ratio(over([102, 102, 102], 1, bg), bg);
    check('better on green than the flat grey it replaced', on(greenRow) > grey(greenRow), `${on(greenRow).toFixed(2)} vs ${grey(greenRow).toFixed(2)}`);
  }

  // --- a page that does not parse (plan §3.6, step 8) ----------------------------
  // Not an error to dismiss: the navigator says what the parser stopped on,
  // offers the code panel and Astro's own output, and holds the code editor.
  {
    global.Window = dom.window.Window; // CodeMirror measures through it.
    global.MutationObserver = dom.window.MutationObserver;
    global.getComputedStyle = dom.window.getComputedStyle;
    global.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
    global.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
    dom.window.Range.prototype.getClientRects = () => [];
    dom.window.Range.prototype.getBoundingClientRect = () => ({
      top: 0,
      left: 0,
      bottom: 0,
      right: 0,
      width: 0,
      height: 0,
    });
    const opened = [];
    await act(async () => {
      reactRoot.render(
        React.createElement(StructurePanel, {
          pageState: {
            editable: false,
            source: '<main>\n  <div\n</main>\n',
            reason: 'Unclosed tag',
            bail: { what: 'tag', near: '<div' },
          },
          layouts: [],
          currentLayoutName: '',
          selectedId: undefined,
          onSelect: () => {},
          onDropComponent: () => {},
          onMoveNode: () => {},
          onRemoveNode: () => {},
          onCopyNode: () => {},
          onDuplicateNode: () => {},
          onPasteNode: () => {},
          onChangeLayout: () => {},
          onCodeChange: () => {},
          onOpenCodePanel: () => opened.push('code'),
          // Live, as the app hands it over (src/ui/liveValue.ts).
          devLog: {
            get: () => '[astro] Unable to render index.astro',
            set: () => {},
            subscribe: () => () => {},
          },
          hasClipboard: false,
        }),
      );
      await settle(20);
    });
    const note = toastMessages();
    check('no inline error is appended', !container.querySelector('.code-note'));
    check('with the parser’s diagnostic', /Unclosed tag/.test(note), note);
    check('and where it stopped', /Near <div/.test(note), note);
    check('no tree is drawn', rows().length === 0);
    const output = container.querySelector('.parse-error-output pre')?.textContent;
    check('Astro’s output is not appended', output === undefined);
    const held = container.querySelector('.cm-content')?.textContent ?? '';
    check('the code editor is there, holding the text', /<main>/.test(held), held);
    check('no raw textarea is left', !container.querySelector('textarea'));
    await act(async () => {
      toastNotices()[0]
        .recovery.find((action) => action.label === 'Open code panel')
        .run();
    });
    check('the code panel is one click away', opened.length === 1);
  }

  if (failures.length) {
    console.error(`\nnavigator: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`navigator: ${checked} passed`);
  process.exit(0);
})();
