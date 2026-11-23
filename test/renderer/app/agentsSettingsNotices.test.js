// Goal: Settings → Agents never appends a paragraph. A failed listing, a failed write, a cut-short listing and a refused form are
// toasts; the form's explanations are (i) tips with their text as the button's description; a refused field takes the error look
// (aria-invalid and a filled background, never a border) and says why once, as a toast, when the form is submitted.
// Negative space: a form that has not been submitted, and a listing that is complete, say nothing.
// Method: bundle the real AgentsSettings with the toast capture injected, mount it in jsdom over a fake `window.avb` that serves
// the listing and answers the write, and read what the capture and the DOM hold after each step.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');
const { toastMessages } = require('../../helpers/toastCapture');

const output = repoPath('node_modules/.stacki-test/agents-settings-notices.cjs');
fs.mkdirSync(path.dirname(output), { recursive: true });
const bundled = esbuild.build({
  entryPoints: [repoPath('src/app/settings/AgentsSettings.tsx')],
  outfile: output,
  inject: [repoPath('test/helpers/toastCaptureEntry.js')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  jsx: 'automatic',
  loader: { '.css': 'empty', '.svg': 'empty' },
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  logLevel: 'silent',
});

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
global.window = dom.window;
for (const name of ['document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event']) {
  global[name] = dom.window[name];
}
global.IS_REACT_ACT_ENVIRONMENT = true;

let listing = { agents: [], paired: [], truncated: false };
let listFails = false;
let writeAnswer = { ok: true, value: { written: [] } };
const saves = [];
window.avb = {
  listAgents: async () => {
    if (listFails) {
      throw new Error('The agents folder could not be read.');
    }
    return listing;
  },
  saveAgent: async (input) => {
    saves.push(input);
    return writeAnswer;
  },
  deleteAgent: async () => writeAnswer,
  onInstructionsChanged: () => () => undefined,
};

const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
let component;
test.before(async () => {
  await bundled;
  component = require(output);
});

// Lets the promises a click starts, and the render they cause, finish: one turn of the event loop after each.
const settle = () => act(async () => new Promise((resolve) => setImmediate(resolve)));
const clearToasts = () => {
  globalThis.stackiCapturedToasts = [];
};
let root;
async function mount() {
  clearToasts();
  root = createRoot(document.getElementById('root'));
  await act(async () => root.render(React.createElement(component.AgentsSettings, { projectPath: '/project' })));
  await settle();
}
async function unmount() {
  await act(async () => root.unmount());
  document.getElementById('root').innerHTML = '';
}
const noInlineNotice = () =>
  assert.equal(document.querySelectorAll('[role="alert"], .agents-note, .agents-problem, .props-empty').length, 0, 'the tab appends no notice paragraph');
const newAgent = () => [...document.querySelectorAll('button')].find((item) => item.textContent.trim() === 'New agent');

test('a failed listing is one toast and the tab stays an empty frame', async () => {
  listFails = true;
  await mount();
  assert.match(toastMessages(), /The agents folder could not be read\./);
  noInlineNotice();
  assert.ok(document.querySelector('.agents-card'), 'the card keeps its place, so nothing below it moves');
  await unmount();
  listFails = false;
});

test('a complete listing says nothing; a cut-short one warns once as a toast', async () => {
  listing = { agents: [], paired: [], truncated: false };
  await mount();
  assert.equal(toastMessages(), '', 'negative space: nothing to warn about');
  await unmount();
  listing = { agents: [], paired: [], truncated: true };
  await mount();
  assert.match(toastMessages(), /more agents than are listed here/);
  noInlineNotice();
  await unmount();
  listing = { agents: [], paired: [], truncated: false };
});

test('the form explains itself in tips, refuses a field with the error look and one toast, and reports a failed write as a toast', async () => {
  await mount();
  await act(async () => newAgent().click());
  await settle();
  const form = document.querySelector('form.agents-form');
  assert.ok(form, 'the form opens');
  const tips = [...document.querySelectorAll('.info-hint-text')].map((item) => item.textContent);
  assert.ok(
    tips.some((text) => /Stacki writes a file for Claude and one for Codex/.test(text)),
    'the intro is the section tip',
  );
  assert.ok(
    tips.some((text) => /Also the name of both files\./.test(text)),
    'a field hint is a tip beside its label',
  );
  assert.equal(form.querySelector('.agents-note') ?? undefined, undefined, 'no hint paragraph in the form');
  assert.equal(toastMessages(), '', 'a form that was not submitted says nothing');
  assert.equal(form.querySelectorAll('[aria-invalid="true"]').length, 0, 'and wears no error look');

  clearToasts();
  await act(async () => form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
  assert.match(toastMessages(), /Fill this in\./, 'the first refusal is one toast');
  assert.equal(saves.length, 0, 'nothing is written');
  const name = form.querySelector('input[type="text"]');
  assert.equal(name.getAttribute('aria-invalid'), 'true', 'the refused field takes the error look');
  noInlineNotice();

  const setValue = async (element, value) => {
    const prototype = element instanceof window.HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    await act(async () => {
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value);
      element.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
  };
  const inputs = [...form.querySelectorAll('input[type="text"]')];
  await setValue(inputs[0], 'reviewer');
  await setValue(inputs[1], 'Reviews a change before it merges.');
  await setValue(form.querySelector('textarea'), 'Read the diff and list the risks.');
  assert.equal(form.querySelectorAll('[aria-invalid="true"]').length, 0, 'a valid form wears no error look');

  writeAnswer = { ok: false, error: { code: 'write-failed', message: 'Disk full' } };
  clearToasts();
  await act(async () => form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
  await settle();
  assert.equal(saves.length, 1, 'a valid form is written');
  assert.match(toastMessages(), /Disk full/, 'a failed write is a toast');
  noInlineNotice();
  writeAnswer = { ok: true, value: { written: [] } };
  await unmount();
});
