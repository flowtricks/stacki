// Goal: an instance's `class` is always the class field, whatever the
// component types it as. Lumos's Button declares `class?: unknown` and
// forwards it into `class:list`; `unknown` is a type no field can fill in, so
// the instance panel showed a read-only "Set in code / unknown" row where the
// class field belongs, though an instance can always pass class. Unset or set
// to words, it is the class token editor; set to an expression, it is that
// expression, editable, and never the word "unknown".
//
// Method: Button's real frontmatter shape is read by the real prop model
// (readPropModel) and projected to its schema field, as the instance panel
// gets it. That field is rendered with the real PropField in jsdom, unset,
// set to words and set to an expression, and the rows it draws are read.
// Beside it, a prop of another name typed `unknown` keeps the read-only row,
// so the exception is pinned to class alone.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { ROOT, repoPath } = require('../../helpers/sources.js');
const { readPropModel } = require('#dist/electron/parse/propModel/readPropModel.js');
const { schemaFieldsOf } = require('#dist/shared/properties/propModelSchema.js');

const directory = repoPath('node_modules/.stacki-test/instance-class-field');
fs.mkdirSync(directory, { recursive: true });
const output = path.join(directory, 'instance-class-field.cjs');
buildSync({
  stdin: {
    contents: ["export { default as PropField } from './src/features/props/PropField';", "export { codeRowKind } from './src/features/props/propKinds';"].join(
      '\n',
    ),
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

// Button.astro's props as Lumos writes them: a union of tags and kinds, `class?: unknown` beside them.
const BUTTON = `---
import type { HTMLAttributes } from "astro/types";
type Emphasis = "primary" | "secondary";
type Tag =
  | (HTMLAttributes<"button"> & { element?: "button"; type?: "button" | "submit" | "reset"; href?: never })
  | (Omit<HTMLAttributes<"a">, "type"> & { element: "link"; href?: string; type?: never });
type Props = {
  /** Set to \`false\` to omit the component. */
  render?: boolean;

  class?: unknown;
  /** Data the button carries. */
  payload?: unknown;
} & Tag & { variant?: "main" | "link"; emphasis?: Emphasis };
const { render = true, variant = "main", class: className, ...rest } = Astro.props;
---
<button class:list={["button_wrap", variant !== "main" && variant, className]} {...rest}><slot /></button>
`;

const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
global.window = dom.window;
global.document = dom.window.document;
for (const name of ['Node', 'Element', 'HTMLElement', 'MutationObserver', 'DOMRect', 'Window', 'KeyboardEvent', 'MouseEvent', 'PointerEvent']) {
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
const React = require('react');
const { createRoot } = require('react-dom/client');
const { act } = React;
const modules = require(output);

const fields = schemaFieldsOf(readPropModel(BUTTON));
const classField = fields.find((field) => field.name === 'class');
const payloadField = fields.find((field) => field.name === 'payload');

async function draw(field, value) {
  const container = document.getElementById('root');
  const root = createRoot(container);
  await act(async () => root.render(React.createElement(modules.PropField, { field, value, projectClasses: ['button_wrap', 'is-dark'], onChange() {} })));
  return { container, root };
}

test('Button’s class is read as a value no field can fill in', () => {
  assert.ok(classField, 'the model lists class');
  assert.equal(classField.codeKind, 'opaque');
  assert.equal(classField.typeText, 'unknown');
  assert.equal(modules.codeRowKind(classField, undefined), undefined, 'class never takes the read-only row');
  assert.equal(modules.codeRowKind(payloadField, undefined), 'code', 'another `unknown` prop still does');
});

test('unset, an instance’s class is the class field, not "Set in code"', async () => {
  const { container, root } = await draw(classField, undefined);
  assert.equal(container.querySelector('.props-code-row') ?? undefined, undefined, 'no read-only row');
  assert.ok(!container.textContent.includes('Set in code'), 'no "Set in code"');
  assert.ok(!container.textContent.includes('unknown'), 'no type word');
  assert.ok(container.querySelector('.class-input'), 'the class token editor');
  await act(async () => root.unmount());
});

test('set to words, it is the class field with its classes', async () => {
  const { container, root } = await draw(classField, { type: 'string', value: 'is-dark' });
  assert.ok(container.querySelector('.class-input'));
  assert.ok(container.textContent.includes('is-dark'));
  await act(async () => root.unmount());
});

test('set to an expression, it is that expression, editable, and never "unknown"', async () => {
  const { container, root } = await draw(classField, { type: 'expr', value: 'theme.buttonClass' });
  assert.equal(container.querySelector('.props-code-row') ?? undefined, undefined, 'no read-only row');
  assert.ok(!container.textContent.includes('unknown'));
  assert.ok(container.querySelector('.cm-editor, input, textarea, [contenteditable="true"]'), 'an editable field');
  assert.ok(container.textContent.includes('theme') || container.innerHTML.includes('theme.buttonClass'), 'showing the expression');
  await act(async () => root.unmount());
});

test('another prop typed unknown keeps the read-only row while unset', async () => {
  const { container, root } = await draw(payloadField, undefined);
  assert.ok(container.querySelector('.props-code-row'), 'the read-only row');
  assert.ok(container.textContent.includes('Set in code'));
  await act(async () => root.unmount());
});
