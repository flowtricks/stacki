// A prop that takes an array, typed into.
//
//   node test/renderer/props/codeProp.test.js
//
// `options` on a select takes `SelectOption[]`. Typing the list straight into
// the field wrote it as TEXT — `options="[\"Designer\", \"Developer\"]"` — which
// is a string the component then calls .map on. And because a string is text,
// the panel then showed it in a plain box: no highlighting, no completions, and
// no way to type an array that stayed an array.
//
// Booleans and numbers already knew this — `cols={3}` is written as an
// expression because that is what a number prop is. A prop whose type is a JS
// value is the same case.

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

(async () => {
  const esbuild = require('esbuild');
  const buildDirectory = repoPath('node_modules/.stacki-test');
  fs.mkdirSync(buildDirectory, { recursive: true });
  const entry = path.join(buildDirectory, 'code-prop.entry.jsx');
  fs.writeFileSync(entry, `export { BindField } from ${JSON.stringify(repoPath('src/features/props/PropsPanel.tsx'))};\n`);
  const bundle = path.join(buildDirectory, 'code-prop.bundle.js');
  await esbuild.build({
    entryPoints: [entry],
    outfile: bundle,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client'],
    loader: { '.css': 'empty' },
    logLevel: 'silent',
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
  dom.window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  global.ResizeObserver = dom.window.ResizeObserver;
  dom.window.Range.prototype.getBoundingClientRect = () => ({
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  });
  dom.window.Range.prototype.getClientRects = () => ({
    length: 0,
    // eslint-disable-next-line stacki/no-null -- Stubs DOMRectList.item, which answers null.
    item: () => null,
    [Symbol.iterator]: function* () {},
  });

  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { act } = React;
  const { BindField } = require(bundle);

  const ARRAY = '["Designer", "Developer"]';

  const mount = async (field, value) => {
    const host = document.createElement('div');
    document.getElementById('root').appendChild(host);
    const root = createRoot(host);
    const wrote = [];
    await act(async () => {
      root.render(
        React.createElement(BindField, {
          value,
          field,
          placeholder: '',
          bindContext: { props: [{ name: 'jobs' }] },
          onChange: (value) => wrote.push(value),
        }),
      );
    });
    // The chips field is a contenteditable: typing into it is text in the box
    // and an input event, which is what the field listens to.
    // The chips field, by its own class: CodeMirror's content area is a
    // contenteditable too, so 'is there something to type in' cannot tell them
    // apart.
    const box = () => host.querySelector('.bind-input');
    const type = async (text) => {
      const element = box();
      if (!element) {
        return false;
      }
      await act(async () => {
        element.textContent = text;
        element.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      });
      return true;
    };
    return {
      host,
      wrote,
      box,
      type,
      code: () => host.querySelector('.cm-editor'),
      done: async () => {
        await act(async () => root.unmount());
      },
    };
  };

  // --- the report ---------------------------------------------------------------
  {
    const mounted = await mount({ name: 'options', type: 'code' }, { type: 'expr', value: 'jobs' });
    check('a prop bound to a name shows a field to type in', !!mounted.box(), mounted.host.innerHTML.slice(0, 160));
    const typed = await mounted.type(ARRAY);
    check('the array can be typed', typed);
    const last = mounted.wrote[mounted.wrote.length - 1];
    check('and is written as an expression', last?.type === 'expr', JSON.stringify(last));
    check('with the array itself as the value', last?.value === ARRAY, JSON.stringify(last));
    check('not as a quoted string', !(last?.type === 'string'), 'options="[…]" is a string the component calls .map on');
    await mounted.done();
  }

  // --- and then it reads as code -----------------------------------------------
  //
  // An array is not something a field of chips and text can show, so the value
  // keeps the code editor — which is where the highlighting and the completions
  // are.
  {
    const mounted = await mount({ name: 'options', type: 'code' }, { type: 'expr', value: ARRAY });
    check('an array value gets the code editor', !!mounted.code(), mounted.host.innerHTML.slice(0, 200));
    check('rather than a field of chips and text', !mounted.box(), mounted.host.innerHTML.slice(0, 200));
    await mounted.done();
  }

  // --- what has not changed ------------------------------------------------------
  //
  // A text prop is still text. The same characters typed into a heading are the
  // heading, brackets and all.
  {
    const mounted = await mount({ name: 'heading', type: 'string' }, { type: 'string', value: 'Hi' });
    await mounted.type(ARRAY);
    const last = mounted.wrote[mounted.wrote.length - 1];
    check('a text prop still writes text', last?.type === 'string', JSON.stringify(last));
    check('with what was typed in it', last?.value === ARRAY, JSON.stringify(last));
    await mounted.done();
  }

  // A number prop was always written as an expression; that is the rule this
  // extends, not one it replaces.
  {
    const mounted = await mount({ name: 'cols', type: 'number' }, { type: 'expr', value: '3' });
    await mounted.type('4');
    const last = mounted.wrote[mounted.wrote.length - 1];
    check('a number prop still writes an expression', last?.type === 'expr', JSON.stringify(last));
    await mounted.done();
  }

  // --- the type has to be read before any of this can happen ------------------------
  //
  // All of the above is decided by the prop's TYPE, and a prop only has one if
  // the schema could read its declaration. The reader refused a `;` inside the
  // type — which is how TypeScript writes an object —
  //
  //   items?: { title: string; text: string }[]
  //
  // so that line matched nothing at all. The prop fell through to the
  // destructuring, where there is no type to read, and came back as `other`:
  // no expression, no list control, a page of JSON in a text box.
  {
    const { parsePropSchema } = require(repoPath('dist/electron/parse/astroParser.js'));
    const withType = (decl) => {
      const source = `---\ninterface Props {\n  ${decl}\n}\n` + `const { items } = Astro.props;\n---\n<div/>\n`;
      return (parsePropSchema(source).find((prop) => prop.name === 'items') || {}).type;
    };
    check(
      'an array of objects, written the way TypeScript writes one',
      withType('items?: { title: string; text: string }[];') === 'code',
      withType('items?: { title: string; text: string }[];'),
    );
    check(
      'and with commas, which always worked',
      withType('items?: { title: string, text: string }[];') === 'code',
      withType('items?: { title: string, text: string }[];'),
    );
    check('a named array is still code', withType('items?: Item[];') === 'code', withType('items?: Item[];'));
    check('and so is a plain one', withType('items?: string[];') === 'code', withType('items?: string[];'));
    // The semicolons inside a Record are the same case, and it is still a bag
    // of attributes rather than a list.
    check(
      'a Record with a shape in it is still attributes',
      withType('items?: Record<string, { a: string; b: number }>;') === 'attrs',
      withType('items?: Record<string, { a: string; b: number }>;'),
    );
    // What the semicolon rule must not eat: the ordinary members beside it.
    const many =
      `---\ninterface Props {\n  /** The rows. */\n` +
      `  items?: { title: string; text: string }[];\n  variant?: "stack" | "row";\n` +
      `  count?: number;\n}\nconst { items } = Astro.props;\n---\n<div/>\n`;
    const schema = parsePropSchema(many);
    const type = (name) => (schema.find((prop) => prop.name === name) || {}).type;
    check('the prop after it is still read', type('variant') === 'enum', type('variant'));
    check('and the one after that', type('count') === 'number', type('count'));
    check(
      'and the note above it is still its own',
      /The rows/.test((schema.find((prop) => prop.name === 'items') || {}).doc || ''),
      JSON.stringify((schema.find((prop) => prop.name === 'items') || {}).doc),
    );
  }

  // The same reading happens a second time, for a union of shapes: which props
  // a branch offers. A member it cannot read is a prop that branch does not
  // know it has.
  {
    const { parsePropSchema } = require(repoPath('dist/electron/parse/astroParser.js'));
    const source =
      `---\ntype Props =\n  | { variant: "list"; items: { title: string; text: string }[] }\n` +
      `  | { variant: "plain"; text: string };\nconst { variant } = Astro.props as Props;\n` +
      `---\n<div/>\n`;
    const schema = parsePropSchema(source);
    const union = (schema.find((prop) => prop.unions) || {}).unions || [];
    const names = union[0] ? union[0].names : [];
    check('a branch knows the array member it declares', names.includes('items'), JSON.stringify(names));
    check('beside the ones it always knew', names.includes('variant') && names.includes('text'), JSON.stringify(names));
  }

  // --- the rule, where it lives ---------------------------------------------------
  const panel = fs.readFileSync(repoPath('src/features/props/propBindings.tsx'), 'utf8');
  check('a code prop is written as an expression', /field\?\.type === 'code' \|\|/.test(panel), 'nothing marks an array prop as written-as-code');
  check(
    'and its parts join as code rather than into a template',
    /mode: field\?\.type === 'code' \? 'code' : mode/.test(panel),
    'text beside a chip would be quoted into a template string',
  );

  if (failures.length) {
    console.error(`\ncode-prop: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`code-prop: ${checked} passed  [a prop that takes an array]`);
  process.exit(0);
})();
