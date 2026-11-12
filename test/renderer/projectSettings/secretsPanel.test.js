// Goal: the Settings panel's Secrets tab shows the project's `.env` with every value hidden (the real
// text is in no DOM node until it is revealed), reveals and hides one or all, edits a name and a value
// inline (Enter saves, Escape cancels), deletes behind the app's own confirm, adds with validation
// messages, treats a missing `.env` as the normal empty state with a Create button, warns when `.env`
// is not ignored, refuses a save over an outside change, names real read failures, and tells the person
// to restart when the running app lacks the channels. It never shows a plain-text loading line: a first load
// paints placeholder rows in the real layout, a reopened tab paints its cached names in its first render and
// refreshes behind them, a failed refresh keeps those names, and the cache holds names only and is bounded.
// Method: bundle the real panel with esbuild, mount it in jsdom over a fake `window.avb` that keeps one
// `.env` text in memory and answers like main does (using the real codec), then click and type as a
// person would and read the DOM and the stored text.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');

const output = repoPath('node_modules/.stacki-test/secrets-panel.cjs');
fs.mkdirSync(path.dirname(output), { recursive: true });
esbuild.buildSync({
  stdin: {
    contents: [
      "export { default as ProjectSettingsPanel } from './src/features/projectSettings/ProjectSettingsPanel';",
      "export { default as SecretsTab } from './src/features/projectSettings/SecretsTab';",
      "export { secretsListingCache, prewarmSecretsListing } from './src/features/projectSettings/secretsCache';",
      "export { ConfirmHost } from './src/ui/ConfirmDialog';",
      "export { changeEnvFile, parseEnvFile, serializeEnvFile, envEntries, envInvalidLines } from './shared/properties/envFile';",
    ].join('\n'),
    resolveDir: repoPath('package.json').replace(/package\.json$/, ''),
    loader: 'tsx',
  },
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  jsx: 'automatic',
  loader: { '.css': 'empty', '.svg': 'empty' },
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  logLevel: 'silent',
});

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
require('../../helpers/popupDom').installPopupDOM(dom.window);
global.window = dom.window;
for (const name of ['document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'KeyboardEvent', 'MouseEvent', 'getComputedStyle']) {
  Object.defineProperty(global, name, { value: dom.window[name], configurable: true, writable: true });
}
global.IS_REACT_ACT_ENVIRONMENT = true;

const SECRET = 'hunter2-secret';
const OTHER = 'zzz-other-value';
const panel = require(output);
const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');

// The project as main would answer for it.
let text; // undefined: no .env
let ignore;
let applied;
let ignored;
const digest = (value) =>
  crypto
    .createHash('sha256')
    .update(value ?? '')
    .digest('hex');
const failure = (code) => ({ ok: false, error: { code, message: 'm' } });
function listing() {
  const parsed = panel.parseEnvFile(text ?? '');
  const entries = panel.envEntries(parsed.value).map(({ index, name, duplicate, multiline }) => ({ index, name, duplicate, multiline }));
  return { revision: digest(text), exists: text !== undefined, entries, invalidLines: panel.envInvalidLines(parsed.value), ignore };
}
function installMain() {
  window.avb = {
    listSecrets: async () => ({ ok: true, value: listing() }),
    readSecret: async ({ revision, index }) => {
      if (revision !== digest(text)) {
        return failure('changed');
      }
      const entry = panel.envEntries(panel.parseEnvFile(text ?? '').value)[index];
      return entry === undefined ? failure('not-found') : { ok: true, value: { value: entry.value } };
    },
    applySecretsChange: async ({ revision, change }) => {
      if (revision !== digest(text)) {
        return failure('changed');
      }
      applied.push(change);
      if (change.kind === 'create') {
        text ??= '';
        return { ok: true, value: listing() };
      }
      const next = panel.changeEnvFile(panel.parseEnvFile(text ?? '').value, change);
      if (!next.ok) {
        return failure(next.error);
      }
      text = panel.serializeEnvFile(next.value);
      return { ok: true, value: listing() };
    },
    ignoreSecretsFile: async () => {
      ignored.push(true);
      ignore = 'ignored';
      return { ok: true, value: listing() };
    },
  };
}

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
const settleAll = async () => {
  await settle();
  await settle();
};
const click = async (element) => {
  assert.ok(element, 'the control exists');
  await act(async () => element.click());
  await settleAll();
};
const type = async (element, value) => {
  assert.ok(element, 'the field exists');
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value').set;
  await act(async () => {
    setter.call(element, value);
    element.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
};
const press = async (element, key) => {
  await act(async () => element.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true })));
  await settleAll();
};
const byLabel = (label) => document.querySelector(`[aria-label="${label}"]`);
const button = (label) => [...document.querySelectorAll('button')].find((candidate) => candidate.textContent.trim() === label);
const rowText = () => [...document.querySelectorAll('.secrets-row')].map((row) => row.textContent);

let root;
async function mount(projectPath = '/project') {
  root = createRoot(document.getElementById('root'));
  await act(async () =>
    root.render(React.createElement(React.Fragment, {}, React.createElement(panel.SecretsTab, { projectPath }), React.createElement(panel.ConfirmHost))),
  );
  await settleAll();
}
async function unmount() {
  await act(async () => root.unmount());
}
function reset(initial, ignoreState = 'ignored') {
  text = initial;
  ignore = ignoreState;
  applied = [];
  ignored = [];
  installMain();
}

test('hidden values are in no DOM node; the eye reveals and hides one, and Reveal all hides again', async () => {
  reset(`API_KEY=${SECRET}\nOTHER=${OTHER}\n`);
  await mount();
  assert.ok(!document.body.innerHTML.includes(SECRET), 'no real value while hidden');
  assert.ok(!document.body.innerHTML.includes(OTHER));
  assert.deepEqual(
    rowText().map((row) => row.includes('••••••••')),
    [true, true],
    'a fixed mask, never the real length',
  );
  await click(byLabel('Reveal API_KEY'));
  assert.ok(document.body.innerHTML.includes(SECRET));
  assert.ok(!document.body.innerHTML.includes(OTHER), 'only the revealed one');
  await click(byLabel('Hide API_KEY'));
  assert.ok(!document.body.innerHTML.includes(SECRET));
  await click(button('Reveal all'));
  assert.ok(document.body.innerHTML.includes(SECRET) && document.body.innerHTML.includes(OTHER));
  await click(button('Hide all'));
  assert.ok(!document.body.innerHTML.includes(SECRET) && !document.body.innerHTML.includes(OTHER));
  await unmount();
});

test('revealed values are hidden again when the project changes', async () => {
  reset(`API_KEY=${SECRET}\n`);
  await mount('/one');
  await click(byLabel('Reveal API_KEY'));
  assert.ok(document.body.innerHTML.includes(SECRET));
  await act(async () => root.render(React.createElement(panel.SecretsTab, { projectPath: '/two' })));
  await settleAll();
  assert.ok(!document.body.innerHTML.includes(SECRET));
  await unmount();
});

test('editing: Enter saves a new value and name, Escape cancels, and the line is the only change', async () => {
  reset('# keep\nexport API_KEY="old" # why\nOTHER=1\n');
  await mount();
  await click(byLabel('Edit API_KEY'));
  const value = byLabel('Value');
  assert.equal(value.value, 'old', 'the real value is fetched when editing begins');
  await type(value, 'changed');
  await press(value, 'Escape');
  assert.equal(text, '# keep\nexport API_KEY="old" # why\nOTHER=1\n');
  assert.equal(byLabel('Value') ?? undefined, undefined);
  await click(byLabel('Edit API_KEY'));
  await type(byLabel('Value'), 'changed');
  await type(byLabel('Name'), 'RENAMED');
  await press(byLabel('Value'), 'Enter');
  assert.equal(text, '# keep\nexport RENAMED="changed" # why\nOTHER=1\n');
  await unmount();
});

test('editing validates the name beside the field and sends nothing', async () => {
  reset('A=1\nB=2\n');
  await mount();
  await click(byLabel('Edit A'));
  await type(byLabel('Name'), 'B');
  await press(byLabel('Name'), 'Enter');
  assert.match(document.body.textContent, /A secret with this name already exists\./);
  await type(byLabel('Name'), '1bad');
  await press(byLabel('Name'), 'Enter');
  assert.match(document.body.textContent, /do not start with a number/);
  await type(byLabel('Name'), '');
  await press(byLabel('Name'), 'Enter');
  assert.match(document.body.textContent, /Enter a name\./);
  assert.deepEqual(applied, []);
  await unmount();
});

test('deleting asks in the app’s own dialog; cancel keeps the line, confirm removes only it', async () => {
  reset('# keep\nA=1\nB=2\n');
  await mount();
  await click(byLabel('Delete A'));
  assert.match(document.body.textContent, /Delete A\?/);
  await click(button('Cancel'));
  assert.equal(text, '# keep\nA=1\nB=2\n');
  await click(byLabel('Delete A'));
  await click(button('Delete'));
  assert.equal(text, '# keep\nB=2\n');
  await unmount();
});

test('adding: validation messages, then the new line is appended', async () => {
  reset('A=1\n');
  await mount();
  await click(button('Add secret'));
  await type(byLabel('Name'), '9x');
  await type(byLabel('Value'), 'v');
  await press(byLabel('Value'), 'Enter');
  assert.match(document.body.textContent, /do not start with a number/);
  await type(byLabel('Name'), 'A');
  await press(byLabel('Value'), 'Enter');
  assert.match(document.body.textContent, /already exists/);
  await type(byLabel('Name'), 'NEW_ONE');
  await press(byLabel('Value'), 'Enter');
  assert.equal(text, 'A=1\nNEW_ONE=v\n');
  assert.deepEqual(
    applied.map((change) => change.kind),
    ['add'],
  );
  await unmount();
});

test('no .env is the empty state with a Create button, not an error', async () => {
  reset(undefined);
  await mount();
  assert.match(document.body.textContent, /No secrets yet/);
  assert.match(document.body.textContent, /No \.env file yet/);
  assert.ok(!document.body.textContent.includes('could not be read'));
  await click(button('Create .env file'));
  assert.equal(text, '');
  assert.deepEqual(applied, [{ kind: 'create' }]);
  assert.equal(button('Create .env file') ?? undefined, undefined, 'the button goes once the file exists');
  assert.match(document.body.textContent, /Adding a secret creates \.env/);
  assert.ok(button('Add secret'));
  await unmount();
});

test('a created file offers the .gitignore flow when it is not ignored', async () => {
  reset(undefined, 'not-ignored');
  await mount();
  await click(button('Create .env file'));
  assert.match(document.body.textContent, /\.env is not in \.gitignore: secrets could be committed/);
  await click(button('Add to .gitignore'));
  assert.match(document.body.textContent, /Add \.env to \.gitignore\?/);
  await click(button('Add line'));
  assert.deepEqual(ignored, [true]);
  assert.ok(!document.body.textContent.includes('secrets could be committed'));
  await unmount();
});

test('a tracked .env gets a warning with no button', async () => {
  reset('A=1\n', 'tracked');
  await mount();
  assert.match(document.body.textContent, /tracked by Git/);
  assert.equal(button('Add to .gitignore') ?? undefined, undefined);
  await unmount();
});

test('a save over an outside change is refused, says so, and Reload shows the new file', async () => {
  reset('A=1\n');
  await mount();
  text = 'A=1\nB=2\n';
  await click(byLabel('Delete A'));
  await click(button('Delete'));
  assert.match(document.body.textContent, /changed on disk/);
  assert.equal(text, 'A=1\nB=2\n');
  await click(button('Reload'));
  assert.deepEqual(
    [...document.querySelectorAll('.secrets-name')].map((name) => name.textContent),
    ['A', 'B'],
  );
  await unmount();
});

test('real read failures still show their reason, with Reload', async () => {
  reset('A=1\n');
  window.avb.listSecrets = async () => failure('denied');
  await mount();
  assert.match(document.body.textContent, /Cannot read \.env/);
  assert.ok(button('Reload'));
  assert.ok(!document.body.textContent.includes('No secrets yet'));
  await unmount();
});

test('an app without the channels says to restart, for a missing method and for an unregistered handler', async () => {
  reset('A=1\n');
  delete window.avb.listSecrets;
  await mount();
  assert.match(document.body.textContent, /Restart Stacki/);
  assert.equal(button('Reload') ?? undefined, undefined);
  await unmount();
  reset('A=1\n');
  window.avb.listSecrets = async () => {
    throw new Error("Error invoking remote method 'secrets:list': Error: No handler registered for 'secrets:list'");
  };
  await mount();
  assert.match(document.body.textContent, /Restart Stacki/);
  await unmount();
});

test('the Settings panel lists its tabs and opens Secrets', async () => {
  reset('A=1\n');
  root = createRoot(document.getElementById('root'));
  await act(async () => root.render(React.createElement(panel.ProjectSettingsPanel, { projectPath: '/project' })));
  await settleAll();
  assert.equal(document.querySelector('.panel-header h2').textContent, 'Settings');
  const tabs = [...document.querySelectorAll('.project-settings-tab')];
  assert.deepEqual(
    tabs.map((tab) => tab.textContent.trim()),
    ['Secrets', 'MCP'],
  );
  assert.equal(tabs[0].getAttribute('aria-current'), 'page');
  assert.ok(document.querySelector('.secrets'));
  await unmount();
});

// A listing the test releases by hand, so the in-between state can be read.
function deferListing() {
  let release;
  const pending = new Promise((resolve) => {
    release = () => resolve({ ok: true, value: listing() });
  });
  window.avb.listSecrets = () => pending;
  return release;
}
const renderOnly = (projectPath) =>
  act(async () => {
    root = createRoot(document.getElementById('root'));
    root.render(React.createElement(panel.SecretsTab, { projectPath }));
  });

test('a first load paints the tab chrome and placeholder rows, never a Reading or Loading line', async () => {
  reset(`API_KEY=${SECRET}\nOTHER=${OTHER}\n`);
  const release = deferListing();
  await renderOnly('/first-load');
  assert.match(document.querySelector('.secrets-heading h3').textContent, /Secrets/, 'the heading is there at once');
  assert.ok(button('Add secret').disabled, 'the add button holds its place but waits for a revision');
  const group = document.querySelector('.ui-skeleton-rows');
  assert.equal(group.getAttribute('aria-busy'), 'true');
  assert.equal(group.querySelectorAll('.secrets-row-skeleton').length, 4);
  assert.equal(document.querySelectorAll('.secrets-row-skeleton .secrets-row-actions').length, 4, 'the placeholder rows carry the action slots');
  assert.doesNotMatch(document.body.textContent, /Reading|Loading…|Please wait/);
  assert.ok(!document.body.innerHTML.includes(SECRET));
  await act(async () => release());
  await settleAll();
  assert.equal(document.querySelector('.ui-skeleton-rows') ?? undefined, undefined, 'placeholders go once the names arrive');
  assert.deepEqual(
    [...document.querySelectorAll('.secrets-name')].map((name) => name.textContent),
    ['API_KEY', 'OTHER'],
  );
  await unmount();
});

test('reopening a project paints the cached names in the first render, then refreshes in the background', async () => {
  reset('A=1\nB=2\n');
  await mount('/reopen');
  await unmount();
  text = 'A=1\nB=2\nC=3\n';
  const release = deferListing();
  await renderOnly('/reopen');
  assert.equal(document.querySelector('.ui-skeleton-rows') ?? undefined, undefined, 'no placeholder on a reopen');
  assert.deepEqual(
    [...document.querySelectorAll('.secrets-name')].map((name) => name.textContent),
    ['A', 'B'],
    'the previous names, before the read has answered',
  );
  await act(async () => release());
  await settleAll();
  assert.deepEqual(
    [...document.querySelectorAll('.secrets-name')].map((name) => name.textContent),
    ['A', 'B', 'C'],
    'the refresh lands in place',
  );
  await unmount();
});

test('the cached names render synchronously: the first commit already has them', async () => {
  reset('A=1\n');
  await mount('/sync');
  await unmount();
  window.avb.listSecrets = () => new Promise(() => {});
  const container = document.getElementById('root');
  const { flushSync } = require('react-dom');
  root = createRoot(container);
  flushSync(() => root.render(React.createElement(panel.SecretsTab, { projectPath: '/sync' })));
  assert.deepEqual(
    [...container.querySelectorAll('.secrets-name')].map((name) => name.textContent),
    ['A'],
  );
  await unmount();
});

test('a refresh that fails keeps the cached names and shows the error notice with Reload', async () => {
  reset('A=1\nB=2\n');
  await mount('/refresh-fails');
  await unmount();
  window.avb.listSecrets = async () => failure('denied');
  await mount('/refresh-fails');
  assert.deepEqual(
    [...document.querySelectorAll('.secrets-name')].map((name) => name.textContent),
    ['A', 'B'],
    'the names stay',
  );
  assert.match(document.querySelector('.secrets-failure').textContent, /Cannot read \.env/);
  assert.ok(button('Reload'));
  assert.equal(document.querySelector('.ui-skeleton-rows') ?? undefined, undefined);
  window.avb.listSecrets = async () => ({ ok: true, value: listing() });
  await click(button('Reload'));
  assert.equal(document.querySelector('.secrets-failure') ?? undefined, undefined, 'a good read clears the notice');
  await unmount();
});

test('the cache holds names only: a revealed or edited value is never in it', async () => {
  reset(`API_KEY=${SECRET}\nOTHER=${OTHER}\n`);
  await mount('/names-only');
  await click(byLabel('Reveal API_KEY'));
  await click(byLabel('Edit OTHER'));
  assert.ok(document.body.innerHTML.includes(SECRET));
  const cached = panel.secretsListingCache.get('/names-only');
  assert.equal(cached.kind, 'ready');
  const serialized = JSON.stringify(cached);
  assert.ok(!serialized.includes(SECRET) && !serialized.includes(OTHER), 'no value in the cache');
  assert.ok(serialized.includes('API_KEY'), 'the names are');
  await unmount();
  await mount('/names-only');
  assert.ok(!document.body.innerHTML.includes(SECRET), 'a reopened tab starts hidden');
  await unmount();
});

test('the cache is bounded to the most recent projects', async () => {
  reset('A=1\n');
  for (let project = 0; project < 12; project += 1) {
    await mount(`/bound-${project}`);
    await unmount();
  }
  assert.equal(panel.secretsListingCache.get('/bound-0') ?? undefined, undefined, 'the oldest is dropped');
  assert.equal(panel.secretsListingCache.get('/bound-3') ?? undefined, undefined);
  assert.equal(panel.secretsListingCache.get('/bound-11').kind, 'ready', 'the newest is kept');
  assert.equal(panel.secretsListingCache.get('/bound-4').kind, 'ready', 'the eighth most recent is kept');
});

test('a prefetch fills the cache so the first open has no placeholder; an app without the channels fills nothing', async () => {
  reset('A=1\n');
  await panel.prewarmSecretsListing('/prefetched');
  assert.equal(panel.secretsListingCache.get('/prefetched').kind, 'ready');
  delete window.avb.listSecrets;
  await panel.prewarmSecretsListing('/no-channels');
  assert.equal(panel.secretsListingCache.get('/no-channels') ?? undefined, undefined);
  window.avb.listSecrets = async () => failure('denied');
  await panel.prewarmSecretsListing('/denied');
  assert.equal(panel.secretsListingCache.get('/denied') ?? undefined, undefined, 'a failure is never cached as an empty list');
});
