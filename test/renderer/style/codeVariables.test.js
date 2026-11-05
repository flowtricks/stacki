// The code editors' variables: `--` offers the project's variables, and a
// whole value has the purple bind dot.
//
//   node test/renderer/style/codeVariables.test.js
//
// Goal: every Style panel editor that edits CSS values as code offers the
// variables the Custom value box offers. The clip-path code had neither the
// `--` chooser nor the bind dot, because it is CodeMirror (CssCodeEditor's
// CodeEditor), not the token field the Custom value box wraps; the CSS Code
// rule editor was the same component with the same gap. Both now take their
// variables from CodeVariables.tsx through a required `variables` prop.
// Method: the scope rule (codeVariableScope.ts) is checked on its own, valid
// and invalid places to type a reference alike. Then the real CodeEditor, and
// the real clip-path editor, are bundled with a three-variable project and
// mounted in jsdom; typing is replayed as CodeMirror `input.type`
// transactions, and keys as keydown on the editor's content. Last, a source
// scan holds the shape that keeps a new editor from missing them: CodeMirror
// is mounted for CSS only in CssCodeEditor.tsx, every <CodeEditor> says what
// its text is, and every <textarea> in the panel sits in a VariableConnect.

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { build } = require('esbuild');
const { JSDOM } = require('jsdom');
const { ROOT, repoPath, stubSources } = require('../../helpers/sources.js');

// The project's variables: two sizes and a colour, so a filter by property shows.
const VARIABLES_STUB = {
  'src/features/style/model/webflow.ts': () => ({
    contents: `
      export async function streamProjectVariables(onAdd) {
        onAdd({ name: 'accent', collection: 'Sizes', group: '', value: '2rem', binding: 'var(--accent)', type: 'Size' });
        onAdd({ name: 'brand', collection: 'Sizes', group: '', value: '1rem', binding: 'var(--brand)', type: 'Size' });
        onAdd({ name: 'ink', collection: 'Sizes', group: '', value: '#000', binding: 'var(--ink)', type: 'Color' });
        return [];
      }
    `,
    loader: 'js',
  }),
};

async function bundle(name, contents) {
  const output = repoPath(`node_modules/.stacki-test/${name}.cjs`);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  await build({
    stdin: { contents, resolveDir: ROOT, loader: 'ts' },
    outfile: output,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
    loader: { '.css': 'empty' },
    logLevel: 'silent',
    plugins: [stubSources('stub-variables', VARIABLES_STUB)],
  });
  delete require.cache[output];
  return require(output);
}

let editorModule;
before(async () => {
  editorModule = await bundle(
    'code-variables',
    `
    export { CodeEditor } from './src/features/style/components/CssCodeEditor';
    export { codeTypedVariableAt } from './src/features/style/model/codeVariableScope';
    export { EditorView } from '@codemirror/view';
    export { registerPopupLayer } from './src/ui/popupOwnership';
  `,
  );
});

const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/', pretendToBeVisual: true });
require('../../helpers/popupDom').installPopupDOM(dom.window);
global.window = dom.window;
global.document = dom.window.document;
global.navigator = dom.window.navigator;
for (const name of [
  'Element',
  'HTMLElement',
  'Node',
  'Text',
  'Range',
  'MutationObserver',
  'getComputedStyle',
  'KeyboardEvent',
  'MouseEvent',
  'DOMParser',
  'Window',
]) {
  global[name] = dom.window[name];
}
global.requestAnimationFrame = (callback) => setTimeout(callback, 0);
global.cancelAnimationFrame = clearTimeout;
global.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
dom.window.ResizeObserver = global.ResizeObserver;
global.IS_REACT_ACT_ENVIRONMENT = true;

const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
const press = (element) => {
  element.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  element.dispatchEvent(new dom.window.MouseEvent('mouseup', { bubbles: true }));
  element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
};
const pickerNames = () => [...document.querySelectorAll('.embed-editor_varpicker-item-name')].map((name) => name.textContent);
const viewIn = (EditorView, host) => {
  const element = host.querySelector('.cm-editor');
  assert.ok(element, 'the editor is mounted');
  const view = EditorView.findFromDOM(element);
  assert.ok(view, 'the editor has a view');
  return view;
};
// Typing as CodeMirror records it: an `input.type` transaction at the caret.
const typeInto = async (view, text) => {
  await act(async () => {
    const at = view.state.selection.main.head;
    view.dispatch({ changes: { from: at, insert: text }, selection: { anchor: at + text.length }, userEvent: 'input.type' });
  });
  await settle();
};
const caretAt = async (view, at) => {
  await act(async () => {
    view.dispatch({ selection: { anchor: at }, userEvent: 'select' });
  });
};
const key = async (view, name) => {
  const event = new dom.window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true });
  await act(async () => view.contentDOM.dispatchEvent(event));
  return event;
};

async function mountEditor(variables, value) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const changes = [];
  await act(async () => {
    root.render(React.createElement(editorModule.CodeEditor, { value, ariaLabel: 'CSS', variables, onChange: (next) => changes.push(next) }));
  });
  await settle();
  const view = viewIn(editorModule.EditorView, host);
  const done = async () => {
    await act(async () => root.unmount());
    host.remove();
  };
  return { host, view, changes, done };
}

test('a reference is typed anywhere in a value, and only in a declaration value in a rule', () => {
  const { codeTypedVariableAt } = editorModule;
  const value = { kind: 'value', prop: 'clip-path' };
  const declarations = { kind: 'declarations' };
  const typedIn = (text, scope) => codeTypedVariableAt(text, text.length, scope);
  assert.deepEqual(typedIn('inset(var(--ac', value), { typed: { start: 6, end: 14, query: 'ac' }, prop: 'clip-path' });
  assert.equal(typedIn('inset(1rem', value), undefined, 'plain typing is not a reference');
  assert.equal(typedIn('a--', value), undefined, 'a name with -- in it is not a reference');
  assert.equal(typedIn('.a {\n  width: --', declarations)?.prop, 'width', 'a declaration value offers what fits its property');
  assert.equal(typedIn('.a { color: red; padding: calc(1rem + var(--', declarations)?.prop, 'padding');
  const custom = typedIn('.a {\n  --gap: --', declarations);
  assert.ok(custom, 'a custom property’s value is a value too');
  assert.equal(custom.prop, undefined, 'and it may hold a variable of any type');
  assert.equal(typedIn('.a {\n  --', declarations), undefined, 'a new custom property’s name is not a reference');
  assert.equal(typedIn('.a { width: 1rem; --', declarations), undefined, 'nor is one after a finished declaration');
  const selectorText = '.a:hover --';
  assert.equal(codeTypedVariableAt(`${selectorText} {}`, selectorText.length, declarations), undefined, 'a selector is not a declaration');
  assert.throws(() => codeTypedVariableAt('x', -1, value), /the caret is not before the text/);
  assert.throws(() => codeTypedVariableAt('x', 0.5, value), /the caret is a whole offset/);
});

test('typing -- in a value editor opens the chooser, filtered to the property, and Enter completes it', async () => {
  const { view, changes, done } = await mountEditor({ kind: 'value', prop: 'clip-path' }, 'inset(');
  await caretAt(view, view.state.doc.length);
  await typeInto(view, 'var(--');
  const picker = document.querySelector('.embed-editor_varpicker');
  assert.ok(picker, 'typing var(-- opens the chooser');
  assert.ok(!picker.querySelector('.embed-editor_varpicker-search'), 'it follows the typing, with no search box of its own');
  assert.deepEqual(pickerNames(), ['accent', 'brand'], 'sizes fit clip-path; the colour does not');
  await typeInto(view, 'br');
  assert.deepEqual(pickerNames(), ['brand'], 'the list follows the typed name');
  const enter = await key(view, 'Enter');
  await settle();
  assert.ok(enter.defaultPrevented, 'the chooser takes Enter from the editor');
  assert.equal(view.state.doc.toString(), 'inset(var(--brand)', 'Enter completes the reference in place');
  assert.equal(changes.at(-1), 'inset(var(--brand)', 'and the change reaches the owner like typing');
  assert.ok(!document.querySelector('.embed-editor_varpicker'), 'the chooser closes');
  await done();
});

test('arrows move through the typed chooser, Escape puts it away, and a moved caret alone opens nothing', async () => {
  const { view, done } = await mountEditor({ kind: 'value', prop: 'clip-path' }, '');
  await typeInto(view, '--');
  const active = () => document.querySelector('.embed-editor_varpicker-item.is-active')?.textContent ?? '';
  assert.match(active(), /accent/, 'the first match is marked');
  await key(view, 'ArrowDown');
  assert.match(active(), /brand/, '↓ moves the mark');
  assert.equal(view.state.doc.toString(), '--', 'and leaves the text alone');
  const escape = await key(view, 'Escape');
  await settle();
  assert.ok(escape.defaultPrevented, 'Escape is the chooser’s');
  assert.ok(!document.querySelector('.embed-editor_varpicker'), 'Escape closes the chooser');
  assert.equal(view.state.doc.toString(), '--', 'and picks nothing');
  await caretAt(view, 0);
  await caretAt(view, 2);
  await settle();
  assert.ok(!document.querySelector('.embed-editor_varpicker'), 'moving the caret back to a reference does not reopen it');
  await done();
});

test('a value editor binds its whole value from the purple dot', async () => {
  const { host, view, changes, done } = await mountEditor({ kind: 'value', prop: 'clip-path' }, 'inset(0.5rem round 2rem)');
  const dot = host.querySelector('.embed-editor_varconnect.code-editor_frame > .embed-editor_varconnect-dot');
  assert.ok(dot, 'the dot sits in the editor’s frame, which shows it on hover');
  assert.equal(dot.getAttribute('aria-label'), 'Connect clip-path to a variable');
  await act(async () => press(dot));
  await settle();
  assert.ok(document.querySelector('.embed-editor_varpicker-search'), 'the dot opens the chooser with its search box');
  assert.deepEqual(pickerNames(), ['accent', 'brand'], 'filtered to the property');
  const brand = [...document.querySelectorAll('.embed-editor_varpicker-item')].find((item) => item.textContent.includes('brand'));
  await act(async () => press(brand));
  await settle();
  assert.equal(view.state.doc.toString(), 'var(--brand)', 'the whole value becomes the variable');
  assert.equal(changes.at(-1), 'var(--brand)');
  // Opened again, the dot marks the variable the value now is.
  await act(async () => press(dot));
  await settle();
  assert.match(document.querySelector('.embed-editor_varpicker-item.is-selected')?.textContent ?? '', /brand/);
  await act(async () => press(dot));
  await settle();
  await done();
});

test('a rule editor offers variables in declaration values and has no bind dot', async () => {
  const { host, view, changes, done } = await mountEditor({ kind: 'declarations' }, '.a {\n  width: ');
  assert.ok(!host.querySelector('.embed-editor_varconnect-dot'), 'a whole rule has no one property to bind');
  await caretAt(view, view.state.doc.length);
  await typeInto(view, '--');
  assert.deepEqual(pickerNames(), ['accent', 'brand'], 'width takes sizes');
  await key(view, 'Tab');
  await settle();
  assert.equal(changes.at(-1), '.a {\n  width: var(--accent)', 'Tab takes the marked variable');
  await typeInto(view, ';\n  color: --');
  assert.deepEqual(pickerNames(), ['ink'], 'color takes colours');
  await key(view, 'Escape');
  await typeInto(view, ';\n  --');
  await settle();
  assert.ok(!document.querySelector('.embed-editor_varpicker'), 'a new custom property’s name opens nothing');
  await done();
});

test('a read-only editor offers nothing', async () => {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(React.createElement(editorModule.CodeEditor, { value: '', ariaLabel: 'CSS', readOnly: true, variables: { kind: 'value', prop: 'width' } }));
  });
  await settle();
  assert.ok(!host.querySelector('.embed-editor_varconnect-dot'), 'no dot on a value that cannot change');
  const view = viewIn(editorModule.EditorView, host);
  await typeInto(view, '--');
  assert.ok(!document.querySelector('.embed-editor_varpicker'), 'and no chooser');
  await act(async () => root.unmount());
  host.remove();
});

test('the clip-path editor’s code has the dot and the chooser, and binding writes the whole clip-path', async () => {
  const clipModule = await bundle(
    'code-variables-clip-path',
    `
      export { default as ClipPath } from './src/features/style/clipPath/ClipPath';
      export { EditorView } from '@codemirror/view';
    `,
  );
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const writes = [];
  await act(async () => {
    root.render(
      React.createElement(clipModule.ClipPath, {
        onApply: (value) => writes.push(value),
        onClear: () => writes.push('clear'),
        hideClassPicker: true,
        initialValue: 'inset(0.5rem round 2rem)',
      }),
    );
  });
  // Past the editor's write throttle and its selection read.
  await act(async () => new Promise((resolve) => setTimeout(resolve, 300)));
  const code = host.querySelector('#clip-path_css-output');
  assert.ok(code, 'the code field is mounted');
  const frame = code.parentElement;
  assert.ok(frame?.classList.contains('code-editor_frame'), 'the code sits in the variables frame');
  const dot = frame.querySelector(':scope > .embed-editor_varconnect-dot');
  assert.ok(dot, 'the code has the bind dot');
  // The dot's corner is the visible box's corner only if they share the anchor:
  // the frame wears VariableConnect's positioned class, and the box it holds is
  // the editor itself, with nothing between them (see the CSS test below).
  assert.ok(frame.classList.contains('embed-editor_varconnect'), 'the frame is anchored as the Custom value field is');
  assert.equal(code.parentElement, dot.parentElement, 'the dot and the editor sit in the same positioned frame');
  assert.ok(code.classList.contains('code-editor'), 'the frame’s editor child is the padded `.code-editor` the frame resets');
  assert.ok(code.querySelector(':scope > .cm-editor'), 'and the visible box is its direct child');
  const view = viewIn(clipModule.EditorView, host);
  await caretAt(view, view.state.doc.length);
  await typeInto(view, ' var(--');
  assert.deepEqual(pickerNames(), ['accent', 'brand'], 'typing -- in the code opens the chooser');
  await key(view, 'Escape');
  await act(async () => press(dot));
  await settle();
  const accent = [...document.querySelectorAll('.embed-editor_varpicker-item')].find((item) => item.textContent.includes('accent'));
  await act(async () => press(accent));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 300)));
  assert.equal(view.state.doc.toString(), 'var(--accent)', 'the code is the variable');
  assert.equal(writes.at(-1), 'var(--accent)', 'and the whole clip-path is written as it');
  await act(async () => root.unmount());
  host.remove();
});

// The declarations of the one rule whose selector list is exactly `selector`.
function ruleBody(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = [...css.matchAll(new RegExp(`(?:^|\\}|\\*\\/)\\s*${escaped}\\s*\\{([^}]*)\\}`, 'g'))];
  assert.equal(matches.length, 1, `exactly one \`${selector}\` rule`);
  return matches[0][1];
}

// The DOM here (jsdom) has no layout, so the dot's place is held by the rules that set it: the
// frame and the Custom value wrapper share one positioned class and one dot
// rule, and nothing pads the editor box away from the frame's corner. The
// app-wide `.code-editor` fallback pads by 10px, which is what left the
// clip-path dot floating up and to the left of the field.
test('the code editor’s dot sits on the visible box’s corner, as on Custom value', () => {
  const embedCss = fs.readFileSync(repoPath('src/features/style/embedEditor.css'), 'utf8');
  const editorCss = fs.readFileSync(repoPath('src/features/style/components/CssCodeEditor.css'), 'utf8');
  const clipCss = fs.readFileSync(repoPath('src/features/style/clipPath/ClipPath.css'), 'utf8');
  const appCss = fs.readFileSync(repoPath('src/app/styles.css'), 'utf8');
  assert.match(ruleBody(embedCss, '.embed-editor_varconnect'), /position:\s*relative;/, 'the shared wrapper is the dot’s anchor');
  assert.match(ruleBody(embedCss, '.embed-editor_varconnect-dot'), /position:\s*absolute;/, 'the dot is placed from that anchor');
  assert.match(ruleBody(appCss, '.code-editor'), /padding:\s*10px;/, 'the fallback padding this guards against still exists');
  assert.match(ruleBody(editorCss, '.code-editor_frame > .code-editor'), /padding:\s*0;/, 'the frame drops it, so the box starts at its corner');
  const frame = ruleBody(editorCss, '.embed-editor_varconnect.code-editor_frame');
  assert.doesNotMatch(frame, /padding|margin|position/, 'the frame adds no space and keeps the shared anchor');
  assert.doesNotMatch(ruleBody(clipCss, '.clip-path_code'), /padding|margin/, 'the clip-path code adds none either');
  assert.doesNotMatch(ruleBody(editorCss, '.code-editor .cm-editor'), /margin/, 'nor does the visible box');
});

// The files under a folder, recursively, bounded so a runaway tree fails loudly.
function sourceFiles(folder) {
  const found = [];
  const pending = [repoPath(folder)];
  for (let step = 0; pending.length > 0; step++) {
    assert.ok(step < 10_000, 'sourceFiles: the tree is bounded');
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(full);
      } else if (/\.tsx?$/.test(entry.name)) {
        found.push(full);
      }
    }
  }
  return found;
}

test('no CSS value editor in the Style panel is made without its variables', () => {
  const editorFile = repoPath('src/features/style/components/CssCodeEditor.tsx');
  const files = sourceFiles('src/features/style');
  assert.ok(files.includes(editorFile), 'the scan sees the shared editor');
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    const name = path.relative(ROOT, file);
    if (file !== editorFile) {
      assert.doesNotMatch(
        source,
        /@uiw\/react-codemirror|new EditorView\(/,
        `${name} mounts CodeMirror itself; use CssCodeEditor's CodeEditor, which carries the variables`,
      );
    }
    for (const match of source.matchAll(/<CodeEditor\b[^>]*?\/>/gs)) {
      assert.match(match[0], /\bvariables=\{\{\s*kind:\s*'(value|declarations)'/, `${name}: a <CodeEditor> says what its text is`);
    }
    if (/<textarea\b/.test(source)) {
      assert.match(source, /VariableConnect|connectField/, `${name} edits a value in a <textarea> outside VariableConnect`);
    }
  }
  const clipView = fs.readFileSync(repoPath('src/features/style/clipPath/ClipPathView.tsx'), 'utf8');
  assert.match(clipView, /variables=\{\{ kind: 'value', prop: 'clip-path' \}\}/, 'the clip-path code binds the whole clip-path');
  const queryForms = fs.readFileSync(repoPath('src/features/style/embed/QueryForms.tsx'), 'utf8');
  assert.match(queryForms, /variables=\{\{ kind: 'declarations' \}\}/, 'the CSS Code editor offers variables in declaration values');
});
