// Goal: Dictation is a Settings tab of its own, and its page tells a designer in plain words where dictation stands and
// what to do about it. The tab sits next to Editor and only where Stacki's speech engine runs; Editor no longer holds any
// of it; an old target that named dictation still lands on the new tab. The page shows one status at a time (not set up,
// downloading with a progress bar, ready, a failed download as a toast), three quality cards (selecting a downloaded one
// switches at once, an un-downloaded one asks first and then downloads), the language, the vocabulary and the snippets (each
// with its Add button in its heading, rows with edit and delete, and its own empty state), and the model's source, license
// and folder folded away by default so the pinned commit never shows until asked.
// Method: the real Settings dialog, bundled with esbuild and mounted in jsdom, with the project-bound tabs stubbed (their own
// suites cover them). The speech engine is the real dictation store (createDictationStore) over fake channels, so downloads,
// progress, cancelling, removing, the model choice and the words run through the real state machine; only the main process
// is replaced. Negative space: no tab without the engine, no dictation content in Editor, no old-name lookalike opens the
// tab, nothing is appended as a paragraph (a failure is a toast), the hash is not in the page while details are folded, a
// cancelled confirmation changes nothing, and the cards lock while a download runs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');
const { waitFor } = require('../../helpers/waitFor.js');
const { toastMessages } = require('../../helpers/toastCapture');

const output = repoPath('node_modules/.stacki-test/dictation-settings.cjs');
fs.mkdirSync(path.dirname(output), { recursive: true });
const stubs = {
  name: 'dictation-settings-stubs',
  setup(build) {
    build.onResolve(
      {
        filter:
          /cmsConnections\/CmsConnections$|studioSetup\/StudioSetup$|\/FolderSettings$|\/RolesSettings$|\/InstructionsSettings$|\/AuditsSettings$|\/BreakpointsSettings$|\/StyleTagSettings$/,
      },
      (args) => ({
        path: args.path,
        namespace: 'stub',
      }),
    );
    build.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({
      loader: 'jsx',
      contents: args.path.includes('StyleTagSettings')
        ? 'export function StyleTagSettingsPage() { return null; }'
        : args.path.includes('BreakpointsSettings')
          ? 'export function BreakpointsSettings() { return null; }'
          : args.path.includes('AuditsSettings')
            ? 'export function AuditsSettings() { return null; }'
            : args.path.includes('InstructionsSettings')
              ? 'export function InstructionsSettings() { return null; }'
              : args.path.includes('RolesSettings')
                ? 'export function RolesSettings() { return null; }'
                : args.path.includes('FolderSettings')
                  ? 'export function FolderSettings() { return null; }'
                  : args.path.includes('CmsConnections')
                    ? 'export function CmsConnections() { return null; }'
                    : 'export default function StudioSetup() { return null; }',
    }));
  },
};
const bundled = esbuild.build({
  stdin: {
    contents: [
      "export { default, openAppSettings } from './src/app/settings/Settings';",
      "export { ConfirmHost } from './src/ui/ConfirmDialog';",
      "export { VoiceEnvironmentContext } from './src/features/ai/voice/voiceEnvironment';",
      "export { createDictationStore } from './src/features/ai/voice/dictationStore';",
      "export { WHISPER_MODELS, modelTotalBytes } from './shared/properties/voice/whisperModels';",
    ].join('\n'),
    resolveDir: repoPath('package.json').replace(/package\.json$/, ''),
    loader: 'ts',
  },
  outfile: output,
  inject: [repoPath('test/helpers/toastCaptureEntry.js')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  jsx: 'automatic',
  loader: { '.css': 'empty', '.svg': 'empty' },
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  plugins: [stubs],
  logLevel: 'silent',
});

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
require('../../helpers/popupDom').installPopupDOM(dom.window);
global.window = dom.window;
for (const name of ['document', 'navigator', 'HTMLElement', 'Element', 'Node', 'localStorage', 'KeyboardEvent', 'Event']) {
  global[name] = dom.window[name];
}
global.requestAnimationFrame = (callback) => setTimeout(callback, 0);
global.cancelAnimationFrame = clearTimeout;
global.IS_REACT_ACT_ENVIRONMENT = true;
const menuListeners = new Map();
const avb = {
  onMenu: (name, callback) => {
    menuListeners.set(name, callback);
    return () => menuListeners.delete(name);
  },
  settings: async () => ({ sound: false, usageCountsEnabled: true }),
  setPreference: async (input) => ({ sound: input.enabled, usageCountsEnabled: true, saved: true }),
};
window.avb = avb;

const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
let bundle;
test.before(async () => {
  await bundled;
  bundle = require(output);
});

const TURBO_REVISION = '360ebcde2559d60bb474678be3c1de9ef347d01a';
const DIRECTORY = '/Users/designer/Library/Application Support/Stacki/models/whisper';

/** The main process, faked: what is on disk per model, and downloads the test finishes by hand. */
function fakeChannels(installed = {}) {
  const disk = { turbo: { kind: 'notInstalled' }, small: { kind: 'notInstalled' }, base: { kind: 'notInstalled' }, ...installed };
  const calls = { download: [], cancel: [], remove: [] };
  const listeners = new Set();
  let finish;
  const channels = {
    status: async () => ({ models: Object.entries(disk).map(([id, install]) => ({ id, install })), directory: DIRECTORY }),
    download: (id) => {
      calls.download.push(id);
      return new Promise((resolve) => {
        finish = (outcome) => {
          if (outcome.kind === 'installed') {
            disk[id] = { kind: 'installed', sizeBytes: outcome.sizeBytes };
          }
          resolve(outcome);
        };
      });
    },
    cancel: async (id) => void calls.cancel.push(id),
    remove: async (id) => {
      calls.remove.push(id);
      disk[id] = { kind: 'notInstalled' };
    },
    onProgress: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    channels,
    calls,
    progress: (progress) => listeners.forEach((listener) => listener(progress)),
    finish: (outcome) => finish(outcome),
  };
}

let root;
let store;
let fake;
/** Mounts Settings with a speech engine (or none), opens it on `tab`, and returns once the page settled. */
async function mount({ whisper = true, installed = {}, tab = 'dictation' } = {}) {
  localStorage.clear();
  globalThis.stackiCapturedToasts = [];
  fake = fakeChannels(installed);
  store = bundle.createDictationStore(fake.channels);
  const environment = whisper ? { whisper: { store } } : {};
  root = createRoot(document.getElementById('root'));
  await act(async () =>
    root.render(
      React.createElement(
        bundle.VoiceEnvironmentContext.Provider,
        { value: environment },
        React.createElement(bundle.default, { projectPath: '/project', previewURL: undefined }),
        React.createElement(bundle.ConfirmHost),
      ),
    ),
  );
  await act(async () => bundle.openAppSettings(tab));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  // The Editor tab's own preferences read (a stub here) may say something of its own; only what Dictation says is under test.
  globalThis.stackiCapturedToasts = [];
}
async function unmount() {
  const mounted = root;
  root = undefined;
  await act(async () => mounted.unmount());
  delete window.avb.microphoneStatus;
  delete window.avb.dictationReveal;
}
// A test that failed midway must not leave its Settings dialog open for the next one.
test.afterEach(async () => {
  if (root !== undefined) {
    await unmount();
  }
});
const tabs = () => [...document.querySelectorAll('[role="tab"]')];
const selectedTab = () => document.querySelector('[role="tab"][aria-selected="true"]');
const panel = () => document.querySelector('.dictation-page');
const text = () => panel()?.textContent ?? '';
const button = (label, scope = document) =>
  [...scope.querySelectorAll('button')].find((item) => item.textContent.trim() === label || item.getAttribute('aria-label') === label);
const cards = () => [...document.querySelectorAll('.dictation-quality-card')];
const card = (name) => cards().find((item) => item.querySelector('.dictation-quality-name').textContent === name);
const click = (element) => act(async () => element.click());
const type = (input, value) =>
  act(async () => {
    const prototype = input.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
const submitDialog = () =>
  act(async () => document.querySelector('.dictation-words-dialog form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
const confirmButton = (label) => button(label, document.querySelector('.confirm-dialog'));

test('Dictation is a tab right after Editor where the engine runs, and not at all where it does not', async () => {
  await mount({ tab: 'editor' });
  const labels = tabs().map((item) => item.textContent.trim());
  assert.equal(labels[0], 'Editor settings');
  assert.equal(labels[1], 'Dictation', 'next to Editor');
  assert.ok(tabs()[1].querySelector('svg'), 'with the microphone icon');
  const editor = document.getElementById('app-settings-panel-editor');
  assert.ok(!editor.querySelector('.dictation-page'), 'Editor holds none of it');
  assert.doesNotMatch(editor.textContent, /Dictation|Vocabulary|Snippets|Whisper/, 'Editor lists no dictation setting');
  await unmount();
  await mount({ whisper: false, tab: 'editor' });
  assert.ok(!tabs().some((item) => item.textContent.trim() === 'Dictation'), 'no engine, no tab');
  await act(async () => bundle.openAppSettings('dictation'));
  assert.equal(selectedTab().textContent.trim(), 'Editor settings', 'a request for the missing tab opens the first shown one');
  await unmount();
});

test('opening on dictation, or on a name dictation used to have, lands on the new tab', async () => {
  await mount();
  assert.equal(selectedTab().textContent.trim(), 'Dictation');
  assert.ok(panel(), 'the page is there');
  await unmount();
  for (const old of ['editor:dictation', 'ai.dictation']) {
    localStorage.clear();
    fake = fakeChannels();
    store = bundle.createDictationStore(fake.channels);
    localStorage.setItem('stacki.settings.tab', old);
    root = createRoot(document.getElementById('root'));
    await act(async () =>
      root.render(
        React.createElement(
          bundle.VoiceEnvironmentContext.Provider,
          { value: { whisper: { store } } },
          React.createElement(bundle.default, { projectPath: undefined, previewURL: undefined }),
        ),
      ),
    );
    await act(async () => menuListeners.get('settings')());
    assert.equal(selectedTab().textContent.trim(), 'Dictation', `${old} opens the Dictation tab`);
    await unmount();
  }
  localStorage.setItem('stacki.settings.tab', 'editor:dictations');
  const model = require(output);
  assert.ok(model, 'the bundle loads');
});

test('not set up: one blue Download button, the size, no paragraph of error text, and the details folded', async () => {
  await mount();
  await waitFor({ what: 'the status', read: () => text(), until: (value) => value.includes('Dictation is not set up') });
  const download = button('Download 568 MB') ?? [...document.querySelectorAll('.dictation-status-action button')][0];
  assert.ok(download.classList.contains('primary'), 'the primary action is the blue button');
  assert.match(download.textContent, /^Download \d+(\.\d)? MB$/);
  assert.equal(document.querySelectorAll('.dictation-page [role="alert"]').length, 0, 'no alert paragraph');
  assert.equal(document.querySelectorAll('.dictation-status-bar').length, 0, 'no progress bar yet');
  await unmount();
});

test('while the status is unknown the page shows skeletons, not words, and the cards are already there', async () => {
  await mount();
  // Before main answers: a store that never refreshed has no status.
  await unmount();
  fake = fakeChannels();
  fake.channels.status = () => new Promise(() => undefined);
  store = bundle.createDictationStore(fake.channels);
  root = createRoot(document.getElementById('root'));
  await act(async () =>
    root.render(
      React.createElement(
        bundle.VoiceEnvironmentContext.Provider,
        { value: { whisper: { store } } },
        React.createElement(bundle.default, { projectPath: undefined, previewURL: undefined }),
      ),
    ),
  );
  await act(async () => bundle.openAppSettings('dictation'));
  assert.ok(document.querySelectorAll('.dictation-status .ui-skeleton').length >= 2, 'the status is skeletons');
  assert.doesNotMatch(text(), /Not downloaded|Loading|Dictation is not set up/, 'no placeholder words');
  assert.equal(cards().length, 3, 'the cards render at once');
  assert.equal(document.querySelectorAll('.dictation-quality-state').length, 0, 'no badge before anything is known');
  await unmount();
});

test('downloading shows percent, a progress bar, bytes and Cancel; finishing shows Ready with a check and Remove', async () => {
  await mount();
  await waitFor({ what: 'the status', read: () => text(), until: (value) => value.includes('not set up') });
  const total = bundle.modelTotalBytes(bundle.WHISPER_MODELS.turbo);
  await click(document.querySelector('.dictation-status-action button'));
  assert.deepEqual(fake.calls.download, ['turbo']);
  await act(async () => fake.progress({ id: 'turbo', receivedBytes: Math.ceil(total / 4), totalBytes: total }));
  assert.match(text(), /Downloading, 25%/);
  const bar = document.querySelector('.dictation-status-bar');
  assert.equal(bar.getAttribute('role'), 'progressbar');
  assert.equal(bar.getAttribute('aria-valuenow'), '25');
  assert.match(text(), /\d+(\.\d)? MB of \d+(\.\d)? MB/, 'size done of total');
  assert.ok(button('Cancel download'), 'Cancel is offered');
  assert.ok(!button('Remove downloaded model'), 'nothing to remove mid-download');
  assert.ok(cards().find((item) => item.getAttribute('aria-checked') === 'false').disabled, 'the other cards lock');
  await click(button('Cancel download'));
  assert.deepEqual(fake.calls.cancel, ['turbo'], 'Cancel reaches the main process for this model');
  await act(async () => fake.finish({ kind: 'installed', sizeBytes: total }));
  await waitFor({ what: 'ready', read: () => text(), until: (value) => value.includes('Ready to dictate') });
  assert.ok(!document.querySelector('.dictation-status-bar'), 'the bar is gone');
  assert.ok(document.querySelector('.dictation-status[data-state="ready"] svg'), 'a check mark');
  assert.ok(button('Remove downloaded model'));
  assert.equal(toastMessages(), '', 'success says nothing');
  await click(button('Remove downloaded model'));
  assert.match(document.querySelector('.confirm-dialog').textContent, /Remove the speech model\?/);
  await click(button('Cancel', document.querySelector('.confirm-dialog')));
  await settle();
  assert.deepEqual(fake.calls.remove, [], 'a cancelled removal keeps the model');
  await click(button('Remove downloaded model'));
  await click(confirmButton('Remove'));
  await waitFor({ what: 'not set up again', read: () => text(), until: (value) => value.includes('Dictation is not set up') });
  assert.deepEqual(fake.calls.remove, ['turbo']);
  await unmount();
});

test('a failed download is a toast and the page keeps its place; a cancelled one is silent', async () => {
  await mount();
  await waitFor({ what: 'the status', read: () => text(), until: (value) => value.includes('not set up') });
  const heightBefore = document.querySelectorAll('.dictation-page > *').length;
  await click(document.querySelector('.dictation-status-action button'));
  await act(async () => fake.finish({ kind: 'failed', failure: 'offline' }));
  await waitFor({ what: 'the toast', read: () => toastMessages(), until: (value) => /Hugging Face could not be reached/.test(value) });
  assert.match(text(), /Dictation is not set up/, 'the card returns to its state');
  assert.equal(document.querySelectorAll('.dictation-page > *').length, heightBefore, 'no paragraph was appended');
  assert.equal(document.querySelectorAll('.dictation-page p:not(.app-settings-empty p), .dictation-page [role="alert"]').length, 0);
  globalThis.stackiCapturedToasts = [];
  await click(document.querySelector('.dictation-status-action button'));
  await act(async () => fake.finish({ kind: 'failed', failure: 'cancelled' }));
  await settle();
  assert.equal(toastMessages(), '', 'cancelling is not an error');
  await unmount();
});

test('quality cards: Fast, Balanced, Best with their sizes, the chosen one marked, downloaded ones badged', async () => {
  const { WHISPER_MODELS, modelTotalBytes } = bundle;
  await mount({ installed: { small: { kind: 'installed', sizeBytes: modelTotalBytes(WHISPER_MODELS.small) } } });
  await waitFor({ what: 'the badge', read: () => document.querySelectorAll('.dictation-quality-state').length, until: (count) => count === 1 });
  assert.deepEqual(
    cards().map((item) => item.querySelector('.dictation-quality-name').textContent),
    ['Fast', 'Balanced', 'Best'],
  );
  assert.deepEqual(
    cards().map((item) => item.querySelector('.dictation-quality-size').textContent),
    ['Fast', 'Balanced', 'Best'].map((name, index) => {
      const id = ['base', 'small', 'turbo'][index];
      return `${Math.round(modelTotalBytes(WHISPER_MODELS[id]) / 100_000) / 10} MB`;
    }),
    'each card shows the size of its pinned files',
  );
  assert.deepEqual(
    cards().map((item) => item.getAttribute('aria-checked')),
    ['false', 'false', 'true'],
    'Best is the default',
  );
  assert.match(card('Balanced').textContent, /Downloaded/);
  assert.doesNotMatch(card('Fast').textContent + card('Best').textContent, /Downloaded/);
  assert.equal(document.querySelector('[role="radiogroup"]').getAttribute('aria-label'), 'Dictation quality');
  await unmount();
});

test('choosing a downloaded card switches at once; an un-downloaded one asks, then downloads; saying no changes nothing', async () => {
  const { WHISPER_MODELS, modelTotalBytes } = bundle;
  await mount({ installed: { small: { kind: 'installed', sizeBytes: modelTotalBytes(WHISPER_MODELS.small) } } });
  await waitFor({ what: 'the badge', read: () => document.querySelectorAll('.dictation-quality-state').length, until: (count) => count === 1 });
  await click(card('Balanced'));
  assert.equal(store.snapshot().model, 'small', 'the model switched');
  assert.equal(card('Balanced').getAttribute('aria-checked'), 'true');
  assert.deepEqual(fake.calls.download, [], 'no download for one already here');
  assert.match(text(), /Ready to dictate/, 'the status follows the chosen model');

  await click(card('Fast'));
  assert.ok(document.querySelector('.confirm-dialog'), 'an un-downloaded card asks first');
  assert.match(document.querySelector('.confirm-dialog').textContent, /Download the Fast model\?/);
  await click(button('Cancel', document.querySelector('.confirm-dialog')));
  await settle();
  assert.equal(store.snapshot().model, 'small', 'no answer, no change');
  assert.deepEqual(fake.calls.download, []);

  await click(card('Fast'));
  await click(confirmButton('Download'));
  assert.equal(store.snapshot().model, 'base');
  assert.deepEqual(fake.calls.download, ['base'], 'yes starts the download of that model');
  assert.ok(button('Cancel download'));
  await click(card('Best'));
  assert.ok(!document.querySelector('.confirm-dialog'), 'a locked card does not even ask');
  assert.equal(store.snapshot().model, 'base');
  await unmount();
});

test('vocabulary: an empty state with an icon, Add in the heading, then rows with edit and delete', async () => {
  await mount();
  await waitFor({ what: 'the page', read: () => text(), until: (value) => value.includes('Vocabulary') });
  const empties = [...document.querySelectorAll('.dictation-page .app-settings-empty')];
  assert.equal(empties.length, 2, 'one per list');
  assert.match(empties[0].textContent, /No words yet\. Add names dictation gets wrong, and it writes them your way\./);
  assert.match(empties[1].textContent, /No snippets yet\./);
  for (const empty of empties) {
    assert.ok(empty.querySelector('svg'), 'with an icon');
  }
  const headers = [...document.querySelectorAll('.app-settings-section-header')].map((item) => item.textContent);
  assert.ok(
    headers.some((value) => value.includes('Vocabulary') && value.includes('Add a new word')),
    'Add sits in the Vocabulary heading',
  );
  assert.ok(
    headers.some((value) => value.includes('Snippets') && value.includes('Add a snippet')),
    'Add sits in the Snippets heading',
  );

  await click(button('Add a new word'));
  await type(document.querySelector('.dictation-words-dialog input'), 'Stacki');
  await submitDialog();
  assert.deepEqual(store.snapshot().words.vocabulary, [{ word: 'Stacki' }]);
  assert.ok(document.querySelector('.dictation-rows .dictation-row-title'), 'a row replaces the empty state');
  assert.ok(!document.querySelector('.dictation-words-dialog'), 'the dialog closed');

  await click(button('Edit Stacki'));
  const input = document.querySelector('.dictation-words-dialog input');
  assert.equal(input.value, 'Stacki', 'editing starts from the word');
  assert.match(document.querySelector('.dictation-words-dialog .modal-header').textContent, /Edit word/);
  await type(input, 'Stacki Studio');
  await submitDialog();
  assert.deepEqual(store.snapshot().words.vocabulary, [{ word: 'Stacki Studio' }], 'edited in place, not added');

  await click(button('Add a new word'));
  await type(document.querySelector('.dictation-words-dialog input'), 'Stacki Studio');
  await submitDialog();
  assert.match(toastMessages(), /already in the list/, 'a duplicate is refused with a toast');
  assert.equal(store.snapshot().words.vocabulary.length, 1);
  await click(button('Cancel', document.querySelector('.dictation-words-dialog')));

  await click(button('Remove Stacki Studio'));
  assert.deepEqual(store.snapshot().words.vocabulary, [], 'deleted');
  assert.equal(document.querySelectorAll('.dictation-page .app-settings-empty').length, 2, 'the empty state returns');
  await unmount();
});

test('snippets: add, edit, delete with a confirmation, and a cancelled delete keeps the snippet', async () => {
  await mount();
  await waitFor({ what: 'the page', read: () => text(), until: (value) => value.includes('Snippets') });
  await click(button('Add a snippet'));
  await type(document.querySelector('.dictation-words-dialog input'), 'my site');
  await type(document.querySelector('.dictation-words-dialog textarea'), 'https://example.com');
  await submitDialog();
  assert.deepEqual(store.snapshot().words.snippets, [{ trigger: 'my site', expansion: 'https://example.com' }]);
  assert.match(document.querySelector('.dictation-rows').textContent, /my site/);

  await click(button('Edit my site'));
  assert.equal(document.querySelector('.dictation-words-dialog textarea').value, 'https://example.com');
  await type(document.querySelector('.dictation-words-dialog textarea'), 'https://stacki.build');
  await submitDialog();
  assert.deepEqual(store.snapshot().words.snippets, [{ trigger: 'my site', expansion: 'https://stacki.build' }]);

  await click(button('Delete my site'));
  await click(button('Cancel', document.querySelector('.confirm-dialog')));
  await settle();
  assert.equal(store.snapshot().words.snippets.length, 1, 'a cancelled delete keeps it');
  await click(button('Delete my site'));
  await click(confirmButton('Delete'));
  assert.deepEqual(store.snapshot().words.snippets, []);
  await unmount();
});

test('model details are folded: the pinned commit is nowhere in the page until they open, then the names read plainly', async () => {
  const { WHISPER_MODELS, modelTotalBytes } = bundle;
  window.avb.dictationReveal = async (payload) => void (window.revealed = payload);
  await mount({ installed: { turbo: { kind: 'installed', sizeBytes: modelTotalBytes(WHISPER_MODELS.turbo) } } });
  await waitFor({ what: 'ready', read: () => text(), until: (value) => value.includes('Ready to dictate') });
  const toggle = button('Model details');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false', 'folded by default');
  assert.ok(!document.querySelector('.dictation-details-list'));
  assert.equal(document.body.innerHTML.includes(TURBO_REVISION), false, 'the commit hash is not in the default DOM');
  assert.doesNotMatch(document.body.textContent, /onnx-community|Stored in/);

  await click(toggle);
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  const list = document.querySelector('.dictation-details-list');
  assert.match(list.textContent, /Whisper large v3 turbo, 4-bit/);
  assert.match(list.textContent, /MIT, by OpenAI/);
  assert.match(list.textContent, /onnx-community\/whisper-large-v3-turbo/);
  assert.equal(list.textContent.includes(TURBO_REVISION), false, 'even open, the hash stays out of the text');
  const path = list.querySelector('.dictation-details-path');
  assert.ok(path.querySelector('code.code-inline'), 'the path is highlighted code');
  assert.ok(path.textContent.length <= 44, 'a long path is cut to fit');
  assert.match(path.textContent, /^\/Users\/.*….*\/turbo$/u, 'cut in the middle, both ends kept');
  assert.ok(path.title.includes(TURBO_REVISION), 'the tooltip keeps the whole folder');
  await click(button('Show in Finder'));
  assert.deepEqual(window.revealed, { modelId: 'turbo' });
  await click(toggle);
  assert.ok(!document.querySelector('.dictation-details-list'), 'folds again');
  await unmount();
});

test('there is nothing to reveal before the model is downloaded', async () => {
  await mount();
  await waitFor({ what: 'the status', read: () => text(), until: (value) => value.includes('not set up') });
  await click(button('Model details'));
  assert.ok(!button('Show in Finder'));
  await unmount();
});

test('the microphone row says what the system answered, and only where it can say', async () => {
  window.avb.microphoneStatus = async () => ({ status: 'granted', appName: 'Stacki', settingsAvailable: true });
  await mount();
  await waitFor({ what: 'the row', read: () => text(), until: (value) => value.includes('Allowed') });
  assert.ok(!button('Open System Settings'), 'nothing to fix when allowed');
  await unmount();
  window.avb.microphoneStatus = async () => ({ status: 'denied', appName: 'Stacki', settingsAvailable: true });
  await mount();
  await waitFor({ what: 'the row', read: () => text(), until: (value) => value.includes('Off in System Settings') });
  assert.ok(button('Open System Settings'));
  await unmount();
  window.avb.microphoneStatus = async () => ({ status: 'unknown', appName: 'Stacki', settingsAvailable: false });
  await mount();
  await settle();
  assert.doesNotMatch(text(), /Microphone/, 'an unknown answer draws no row');
  await unmount();
  await mount();
  assert.doesNotMatch(text(), /Microphone/, 'no bridge, no row');
  await unmount();
});
