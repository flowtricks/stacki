// Goal: Settings > Dictation's word list never takes Settings down, with or without a project, whether or not
// the AI panel has been opened. Its project-name suggestions used to come from the AI panel's store, which learns a
// project only when the panel opens; asking it before then asserted ("aiStore: a project is loaded before the panel
// acts in it") and crashed Settings for anyone who had not opened the AI panel yet, and from the welcome screen.
// Method: the real DictationWordsRows, bundled with esbuild, is mounted in jsdom while the AI store holds no project
// (the crash's condition: nothing here opens the panel). The main process is a stub of `window.avb.aiMentions` that
// records each request and answers with a chosen reply. Checked: no project asks nothing and shows nothing; a project
// asks for its own files and suggests its component names the person does not have yet; a failed or thrown read shows
// nothing and crashes nothing; another project replaces the last one's names. A source check pins that the word list
// no longer reaches into the AI store. The add-word and snippet dialogs refuse a field with the error look (aria-invalid) and say why
// once, as a toast, when they are submitted, never as a paragraph in the dialog; a valid submit says nothing.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { ROOT, repoPath } = require('../../helpers/sources.js');
const { waitFor, waitForSteady } = require('../../helpers/waitFor.js');
const { toastMessages } = require('../../helpers/toastCapture');

const directory = repoPath('node_modules/.stacki-test/dictation-words');
fs.mkdirSync(directory, { recursive: true });
esbuild.buildSync({
  stdin: {
    contents: "export { DictationWordsRows } from './src/app/settings/DictationWords.tsx';",
    resolveDir: ROOT,
    loader: 'jsx',
  },
  outfile: path.join(directory, 'words.js'),
  inject: [repoPath('test/helpers/toastCaptureEntry.js')],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
  loader: { '.css': 'empty' },
  logLevel: 'silent',
});

const WORDS = { vocabulary: [{ word: 'Logo' }], snippets: [] };
const FILES = [
  { kind: 'file', path: 'src/components/HeroCard.astro', name: 'HeroCard.astro' },
  { kind: 'file', path: 'src/components/Logo.astro', name: 'Logo.astro' }, // Already in the vocabulary.
  { kind: 'file', path: 'src/components/Abc.astro', name: 'Abc.astro' }, // Too short to be worth suggesting.
  { kind: 'file', path: 'src/pages/index.astro', name: 'index.astro' }, // Not a component name.
];

function installDOM(answer) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const { window } = dom;
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'MutationObserver', 'CustomEvent', 'KeyboardEvent']) {
    global[key] = key === 'window' ? window : window[key];
  }
  global.requestAnimationFrame = (callback) => setTimeout(callback, 0);
  global.cancelAnimationFrame = clearTimeout;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const asked = [];
  window.avb = {
    aiMentions: async (payload) => {
      asked.push(payload);
      return answer(payload);
    },
  };
  return { dom, asked };
}

async function mount(projectPath, answer) {
  const { dom, asked } = installDOM(answer);
  const React = require('react');
  const { act } = React;
  const { createRoot } = require('react-dom/client');
  const { DictationWordsRows } = require(path.join(directory, 'words.js'));
  const root = createRoot(document.getElementById('root'));
  const render = async (nextPath) => {
    await act(async () => {
      root.render(React.createElement(DictationWordsRows, { words: WORDS, projectPath: nextPath, onChange() {} }));
    });
  };
  const suggestions = () => [...document.querySelectorAll('.dictation-words-suggestion')].map((button) => button.textContent.trim());
  await render(projectPath);
  return {
    asked,
    render,
    // The reply lands after the render, so each check waits on the suggestions it reads rather than on a guessed delay.
    suggestionsBecome: (expected) =>
      waitFor({ what: `suggestions ${JSON.stringify(expected)}`, read: suggestions, until: (names) => JSON.stringify(names) === JSON.stringify(expected) }),
    // An empty list is also the state before any reply, so "none" must hold steady, not merely be seen once.
    suggestionsStayEmpty: () => waitForSteady({ what: 'no suggestions', read: suggestions, until: (names) => names.length === 0 }),
    asksBecome: (count) => waitFor({ what: `${count} file request(s)`, read: () => asked.length, until: (length) => length === count }),
    close: async () => {
      await act(async () => root.unmount());
      dom.window.close();
    },
  };
}

test('the word list reads project files through the main process, not through the AI panel’s store', () => {
  const source = fs.readFileSync(repoPath('src/app/settings/DictationWords.tsx'), 'utf8');
  assert.doesNotMatch(source, /features\/ai\/aiStore/, 'Settings never depends on the AI panel having opened');
  assert.match(source, /aiMentions\(\{ projectPath, query: '', kinds: \['file'\] \}\)/);
  const settings = fs.readFileSync(repoPath('src/app/settings/Settings.tsx'), 'utf8');
  assert.match(settings, /<DictationSetting projectPath=\{props\.projectPath\} \/>/, 'Settings passes its own open project');
});

test('with no project open (the welcome screen), the list renders, asks nothing and suggests nothing', async (context) => {
  const view = await mount(undefined, () => ({ ok: true, value: FILES }));
  context.after(view.close);
  await view.suggestionsStayEmpty();
  assert.deepEqual(view.asked, []);
});

test('with a project open and the AI panel never opened, the list suggests that project’s new component names', async (context) => {
  const view = await mount('/work/site', () => ({ ok: true, value: FILES }));
  context.after(view.close);
  await view.suggestionsBecome(['HeroCard']);
  assert.equal(view.asked.length, 1);
  assert.equal(view.asked[0].projectPath, '/work/site');
  assert.equal(view.asked[0].query, '');
  assert.deepEqual([...view.asked[0].kinds], ['file']);
});

test('a failed or thrown read leaves no suggestions and no crash', async (context) => {
  const failed = await mount('/work/site', () => ({ ok: false, error: { code: 'agent-failed', message: 'the project could not be read' } }));
  context.after(failed.close);
  await failed.asksBecome(1);
  await failed.suggestionsStayEmpty();
  const thrown = await mount('/work/site', () => {
    throw new Error('main went away');
  });
  context.after(thrown.close);
  await thrown.asksBecome(1);
  await thrown.suggestionsStayEmpty();
});

test('another project replaces the last one’s names, and closing the project clears them', async (context) => {
  const view = await mount('/work/site', ({ projectPath }) => ({
    ok: true,
    value: projectPath === '/work/site' ? FILES : [{ kind: 'file', path: 'src/components/PriceTable.astro', name: 'PriceTable.astro' }],
  }));
  context.after(view.close);
  await view.suggestionsBecome(['HeroCard']);
  await view.render('/work/shop');
  await view.suggestionsBecome(['PriceTable']);
  assert.equal(view.asked.at(-1).projectPath, '/work/shop');
  await view.render(undefined);
  await view.suggestionsStayEmpty();
  assert.equal(view.asked.length, 2, 'closing the project asks nothing more');
});

test('the word and snippet dialogs wear the error look and say why once as a toast; a valid entry says nothing', async (context) => {
  const view = await mount('/work/site', () => ({ ok: true, value: [] }));
  context.after(view.close);
  const { act } = require('react');
  window.HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute('open', '');
  };
  window.HTMLDialogElement.prototype.close = function close() {
    this.removeAttribute('open');
  };
  const submit = async () => {
    globalThis.stackiCapturedToasts = [];
    await act(async () =>
      document.querySelector('.dictation-words-dialog form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })),
    );
  };
  const type = async (input, text) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, text);
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
  const noParagraph = () =>
    assert.equal(
      document.querySelectorAll('.dictation-words-dialog p, .dictation-words-dialog [role="alert"], .ai-compose-problem').length,
      0,
      'the dialog appends no paragraph',
    );

  const add = [...document.querySelectorAll('button')].find((button) => button.textContent.includes('Add a new word'));
  await act(async () => add.click());
  const word = document.querySelector('.dictation-words-dialog input');
  assert.equal(word.getAttribute('aria-invalid') ?? undefined, undefined, 'an untouched dialog wears no error look');
  await submit();
  assert.match(toastMessages(), /Fill this in\./);
  assert.equal(word.getAttribute('aria-invalid'), 'true', 'the refused word takes the error look');
  noParagraph();
  await type(word, 'Logo');
  assert.equal(word.getAttribute('aria-invalid') ?? undefined, undefined, 'editing clears the look');
  await submit();
  assert.match(toastMessages(), /This is already in the list\./, 'a duplicate is refused');
  await type(word, 'Stacki');
  await submit();
  assert.equal(toastMessages(), '', 'a valid word says nothing');
});
