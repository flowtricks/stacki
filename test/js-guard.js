// A statement goes into the file when you leave the field, and only if it parses.
//
//   node test/js-guard.js
//
// The frontmatter editor splices what you type into the .astro file the site is
// compiled from. It used to do that on every keystroke — so the half-finished
// shape of a statement, `const x = ` on its way to `const x = 1`, was compiled,
// failed, and replaced the preview with a build error you then had to sit
// through. Every statement passes through that shape; the error was unavoidable
// rather than unlucky.
//
// Two rules, and both matter:
//
//   Nothing is written while typing. The write waits for the field to be left.
//   Nothing broken is written at all. A statement that doesn't parse is kept in
//   the field, marked, and explained — the file keeps the last thing that did.
//
// The parser half is checked on its own below, because the case that would
// quietly ruin this is TypeScript: Astro frontmatter is TS, and a checker that
// only knows JavaScript would reject `const x: string = ''` — correct code,
// refused, with no way to save it.

const fs = require('fs');
const path = require('path');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
};

(async () => {
  const esbuild = require('esbuild');
  const buildDir = path.join(__dirname, '..', 'node_modules', '.stacki-test');
  fs.mkdirSync(buildDir, { recursive: true });

  // --- The checker -----------------------------------------------------------
  {
    const out = path.join(buildDir, 'js-check.bundle.js');
    await esbuild.build({
      entryPoints: [path.join(__dirname, '..', 'src', 'jsCheck.js')],
      outfile: out, bundle: true, format: 'cjs', platform: 'node', logLevel: 'silent',
    });
    const { checkStatement } = require(out);

    const ok = (code) => checkStatement(code).ok;
    check('a plain declaration passes', ok('const media = "x";'));
    check('a ternary passes', ok('const media = a === "card" ? ["card"] : [a];'));
    check('a template literal passes', ok('const media = `--_o: ${o}`;'));
    check('top-level await passes', ok('const rows = await load();'), JSON.stringify(checkStatement('const rows = await load();')));
    // The one that would make this feature worse than useless: Astro frontmatter
    // is TypeScript, and refusing correct TS would mean it could not be saved.
    check('an annotated declaration passes', ok('const media: string = "x";'), JSON.stringify(checkStatement('const media: string = "x";')));
    check('a generic passes', ok('const rows: Array<string> = [];'), JSON.stringify(checkStatement('const rows: Array<string> = [];')));
    check('an interface-typed const passes', ok('const p: Props["media"] = undefined;'), JSON.stringify(checkStatement('const p: Props["media"] = undefined;')));
    // Emptiness is allowed — clearing a field is a thing to be able to do.
    check('an empty statement passes', ok(''));

    check('a stray token fails', !ok('const media = "x" ;; ='));
    check('an unfinished statement fails', !ok('const media = '));
    check('an unclosed brace fails', !ok('const media = {'));
    check('an unclosed string fails', !ok('const media = "x'), JSON.stringify(checkStatement('const media = "x')));

    // The message has to name something you can go and look at.
    const stray = checkStatement('const media = "x" ;; =');
    check('a stray token is named', stray.message.includes('='), stray.message);
    const short = checkStatement('const media = ');
    check('an unfinished statement says so', /unfinished|stops early/i.test(short.message), short.message);
    const line = checkStatement('const a = 1;\nconst b = ;; =');
    check('and a multi-line mistake says which line', /line 2/.test(line.message), line.message);
  }

  // --- The editor ------------------------------------------------------------
  const entry = path.join(buildDir, 'js-guard.entry.jsx');
  fs.writeFileSync(
    entry,
    `export { BindField } from ${JSON.stringify(path.join(__dirname, '..', 'src', 'panels', 'PropsPanel.jsx'))};\n` +
      // CodeMirror's own way in from a DOM node — the editor here is a real one.
      `export { EditorView } from '@codemirror/view';\n`
  );
  const bundle = path.join(buildDir, 'js-guard.bundle.js');
  await esbuild.build({
    entryPoints: [entry], outfile: bundle, bundle: true, format: 'cjs', platform: 'node',
    jsx: 'automatic', external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client'],
    loader: { '.css': 'empty' }, logLevel: 'silent',
  });

  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  global.window = dom.window;
  global.document = dom.window.document;
  global.navigator = dom.window.navigator;
  global.MutationObserver = dom.window.MutationObserver;
  global.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  global.DOMRect = dom.window.DOMRect;
  global.Window = dom.window.Window;
  global.Element = dom.window.Element;
  global.HTMLElement = dom.window.HTMLElement;
  global.Node = dom.window.Node;
  global.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  global.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
  global.IS_REACT_ACT_ENVIRONMENT = true;
  dom.window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  global.ResizeObserver = dom.window.ResizeObserver;
  dom.window.Range.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 });
  dom.window.Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} });

  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { act } = React;
  const { BindField, EditorView } = require(bundle);

  const START = 'const media = "start";';
  const host = document.createElement('div');
  document.getElementById('root').appendChild(host);
  const root = createRoot(host);
  // Every write the editor makes to the file, in order.
  const writes = [];
  await act(async () => {
    root.render(
      React.createElement(BindField, {
        value: { type: 'expr', value: '`${media}`' },
        placeholder: '',
        bindCtx: {},
        dataCtx: {
          frontmatter: `${START}\n`,
          imports: '',
          onSetFrontmatter: (code) => writes.push(code),
        },
        onChange: () => {},
      })
    );
  });

  // Open the source editor through the chip's menu, the way a person does.
  const chip = host.querySelector('.expr-chip');
  check('the binding drew a chip', !!chip, host.innerHTML.slice(0, 160));
  await act(async () => { chip.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true })) });
  const editRow = [...document.querySelectorAll('.bind-menu .dp-foot')].find((r) => r.textContent.includes('Edit media'));
  check('the menu offers to edit it', !!editRow, [...document.querySelectorAll('.bind-menu .dp-foot')].map((r) => r.textContent).join(' | '));
  await act(async () => { editRow.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) });
  const box = document.querySelector('.var-src');
  check('the source editor opens', !!box);

  const cm = () => box.querySelector('.expr-input');
  // CodeMirror is real here, so typing goes through its own transaction.
  const view = () => { const el = cm(); return el ? EditorView.findFromDOM(el) : null };
  const type = async (text) => {
    const v = view();
    if (!v) return false;
    await act(async () => {
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } });
    });
    return true;
  };
  const leaveField = async () => {
    await act(async () => {
      // What a press outside the popup does.
      document.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true }));
    });
  };
  const isRed = () => !!cm()?.classList.contains('invalid');
  const message = () => box?.querySelector('.var-src-error')?.textContent?.trim() ?? '';

  check('typing is possible at all', await type('const media = "half'), 'no CodeMirror view to type into');

  // Rule one: nothing goes to the file while typing.
  check('typing writes nothing to the file', writes.length === 0, JSON.stringify(writes));
  check('and nothing is marked yet', !isRed(), 'red before it was ever committed');

  // Rule two: leaving with a broken statement writes nothing, and says why.
  await leaveField();
  check('leaving a broken statement writes nothing', writes.length === 0, JSON.stringify(writes));
  check('the field goes red', isRed(), cm()?.className);
  check('and says what to fix', message().length > 0, JSON.stringify(message()));
  check('the editor stays open to be fixed', !!document.querySelector('.var-src'), 'it closed, taking the message with it');

  // Fixing it clears the mark as you type — now that there is a mistake to watch.
  await type('const media = "half";');
  check('fixing it clears the mark', !isRed(), cm()?.className);
  check('and the message goes', message() === '', JSON.stringify(message()));
  check('but still nothing is written until the field is left', writes.length === 0, JSON.stringify(writes));

  await leaveField();
  check('leaving a good statement writes it', writes.length === 1, JSON.stringify(writes));
  check('with the statement in it', writes[0]?.includes('const media = "half";'), JSON.stringify(writes[0]));
  check('and the editor closes', !document.querySelector('.var-src'), 'still open after a clean commit');

  await act(async () => { root.unmount() });
  host.remove();

  if (failures.length) {
    console.error(`js-guard: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`js-guard: ${checked} passed  [commit on leave, refuse broken, TS-safe]`);
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
