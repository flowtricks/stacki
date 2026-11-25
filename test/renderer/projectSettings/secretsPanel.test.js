// Goal: the Settings panel's Secrets tab shows one of the project's dev env files, `.env` first, picked in
// a dropdown that lists the four in load order; every message names the picked file, a name a later file
// sets again says which file dev uses, nothing revealed for one file survives a switch, and `.env.development`
// (usually committed on purpose) gets no Git warning. For the picked file it shows every value hidden (the real
// text is in no DOM node until it is revealed), reveals and hides one or all, edits a name and a value
// inline (Enter saves, Escape cancels), deletes behind the app's own confirm, adds with validation
// messages, treats a missing `.env` as the normal empty state where adding a secret creates it, warns when `.env`
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
      "export { requestSettingsSection } from './src/lib/settingsSections';",
      "export { default as ProjectSettingsPanel } from './src/features/projectSettings/ProjectSettingsPanel';",
      "export { default as SecretsTab } from './src/features/projectSettings/SecretsTab';",
      "export { secretsCacheKey, secretsListingCache, prewarmSecretsListing } from './src/features/projectSettings/secretsCache';",
      "export { subscribeErrorToasts } from './src/ui/errorNotices';",
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
// The DOM here has no layout, so it has no `scrollIntoView`; the file dropdown scrolls its highlighted row into view.
dom.window.HTMLElement.prototype.scrollIntoView ??= () => undefined;
global.window = dom.window;
for (const name of ['document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'KeyboardEvent', 'MouseEvent', 'getComputedStyle']) {
  Object.defineProperty(global, name, { value: dom.window[name], configurable: true, writable: true });
}
global.IS_REACT_ACT_ENVIRONMENT = true;

const SECRET = 'hunter2-secret';
const OTHER = 'zzz-other-value';
const panel = require(output);
const React = require('react');
const { installToastLog } = require('../../helpers/toastLog.js');
const { act } = React;
const { createRoot } = require('react-dom/client');

// The project as main would answer for it: `.env` in `text`, the other dev env files in `others`.
const FILES = ['.env', '.env.local', '.env.development', '.env.development.local'];
let text; // undefined: no .env
let others; // file name → text, for the files after .env
let ignore;
let applied;
let ignored;
let asked; // the file each list call named
const digest = (value) =>
  crypto
    .createHash('sha256')
    .update(value ?? '')
    .digest('hex');
const failure = (code) => ({ ok: false, error: { code, message: 'm' } });
const textOf = (file) => (file === '.env' ? text : others.get(file));
const setText = (file, value) => (file === '.env' ? (text = value) : others.set(file, value));
const namesOf = (source) => panel.envEntries(panel.parseEnvFile(source ?? '').value).map((entry) => entry.name);
function listing(file = '.env') {
  const parsed = panel.parseEnvFile(textOf(file) ?? '');
  // As main does: a name a later file sets again is marked with the last such file.
  const later = FILES.slice(FILES.indexOf(file) + 1);
  const overrides = new Map();
  for (const candidate of later) {
    for (const name of namesOf(textOf(candidate))) {
      overrides.set(name, candidate);
    }
  }
  const entries = panel.envEntries(parsed.value).map(({ index, name, duplicate, multiline }) => {
    const overriddenBy = overrides.get(name);
    return overriddenBy === undefined ? { index, name, duplicate, multiline } : { index, name, duplicate, multiline, overriddenBy };
  });
  return { file, revision: digest(textOf(file)), exists: textOf(file) !== undefined, entries, invalidLines: panel.envInvalidLines(parsed.value), ignore };
}
function installMain() {
  window.avb = {
    listSecrets: async ({ file }) => {
      asked.push(file);
      return { ok: true, value: listing(file) };
    },
    readSecret: async ({ file, revision, index }) => {
      if (revision !== digest(textOf(file))) {
        return failure('changed');
      }
      const entry = panel.envEntries(panel.parseEnvFile(textOf(file) ?? '').value)[index];
      return entry === undefined ? failure('not-found') : { ok: true, value: { value: entry.value } };
    },
    applySecretsChange: async ({ file, revision, change }) => {
      if (revision !== digest(textOf(file))) {
        return failure('changed');
      }
      applied.push(file === '.env' ? change : { file, ...change });
      if (change.kind === 'create') {
        setText(file, textOf(file) ?? '');
        return { ok: true, value: listing(file) };
      }
      const next = panel.changeEnvFile(panel.parseEnvFile(textOf(file) ?? '').value, change);
      if (!next.ok) {
        return failure(next.error);
      }
      setText(file, panel.serializeEnvFile(next.value));
      return { ok: true, value: listing(file) };
    },
    ignoreSecretsFile: async ({ file }) => {
      ignored.push(file === '.env' ? true : file);
      ignore = 'ignored';
      return { ok: true, value: listing(file) };
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
let toastLog;
async function mount(projectPath = '/project') {
  toastLog?.uninstall();
  toastLog = installToastLog(panel.subscribeErrorToasts);
  root = createRoot(document.getElementById('root'));
  await act(async () =>
    root.render(React.createElement(React.Fragment, {}, React.createElement(panel.SecretsTab, { projectPath }), React.createElement(panel.ConfirmHost))),
  );
  await settleAll();
}
async function unmount() {
  await act(async () => root.unmount());
  toastLog?.uninstall();
  toastLog = undefined;
}
function reset(initial, ignoreState = 'ignored') {
  text = initial;
  others = new Map();
  ignore = ignoreState;
  applied = [];
  ignored = [];
  asked = [];
  installMain();
}
// The cache key of a project's `.env`, the file the tab opens on.
const envKey = (projectPath) => panel.secretsCacheKey(projectPath, '.env');

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
  assert.match(toastLog.messages().join('\n'), /A secret with this name already exists\./, 'the reason is a toast');
  assert.ok(byLabel('Name').classList.contains('is-invalid'), 'the refused field takes the error tint');
  assert.equal(document.querySelector('.secrets-problem') ?? undefined, undefined, 'no paragraph is added to the row');
  await type(byLabel('Name'), '1bad');
  assert.ok(!byLabel('Name').classList.contains('is-invalid'), 'typing clears the tint');
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

test('no .env is the empty state, not an error, and Add secret is the one way in', async () => {
  reset(undefined);
  await mount();
  assert.match(document.body.textContent, /No secrets yet/);
  assert.match(document.body.textContent, /No \.env file yet\. Adding a secret creates it\./);
  assert.ok(!document.body.textContent.includes('could not be read'));
  assert.ok(![...document.querySelectorAll('button')].some((candidate) => /^Create/.test(candidate.textContent.trim())), 'no button offers an empty file');
  await click(button('Add secret'));
  await type(byLabel('Name'), 'A');
  await type(byLabel('Value'), 'x');
  await click(button('Save'));
  assert.equal(text, 'A=x\n');
  assert.deepEqual(applied, [{ kind: 'add', name: 'A', value: 'x' }]);
  await unmount();
});

test('an existing empty .env says it is empty', async () => {
  reset('');
  await mount();
  assert.match(document.body.textContent, /\.env is empty\./);
  assert.ok(!document.body.textContent.includes('creates'), 'an existing file is never said to be created');
  await unmount();
});

test('an existing file offers the .gitignore flow when it is not ignored', async () => {
  reset('', 'not-ignored');
  await mount();
  // The button alone is shown; the risk is its tooltip and its description, never a sentence beside it.
  const offer = button('Add to .gitignore');
  const why = '.env is not in .gitignore: secrets could be committed';
  assert.equal(offer.getAttribute('aria-description'), why);
  assert.equal(offer.title, '', 'no system tooltip, which waits longer and may not show on a second hover');
  assert.ok(!document.body.textContent.includes('secrets could be committed'));
  // Stacki's own tip: shown after the shared wait, gone when the pointer leaves, and back on every hover.
  const tip = () => document.querySelector('.rail-tooltip')?.textContent;
  for (const hover of ['first', 'second']) {
    await act(async () => offer.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body })));
    assert.equal(tip(), undefined, `the ${hover} hover waits before the tip`);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 600)));
    assert.equal(tip(), why, `the ${hover} hover shows the reason`);
    await act(async () => offer.dispatchEvent(new window.MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body })));
    assert.equal(tip(), undefined, `the tip goes when the pointer leaves after the ${hover} hover`);
  }
  await click(offer);
  assert.match(document.body.textContent, /Add \.env to \.gitignore\?/);
  await click(button('Add line'));
  assert.deepEqual(ignored, [true]);
  assert.equal(button('Add to .gitignore') ?? undefined, undefined);
  await unmount();
});

test('a tracked .env gets a warning with no button', async () => {
  reset('A=1\n', 'tracked');
  await mount();
  assert.match(document.body.textContent, /\.env is committed to Git/);
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

test('the Settings panel opens on a root of links and a link opens its view; back and Escape return to the root', async () => {
  reset('A=1\n');
  root = createRoot(document.getElementById('root'));
  const views = ['secrets', 'mcp', 'instructions'];
  await act(async () =>
    root.render(React.createElement(panel.ProjectSettingsPanel, { projectPath: '/project', views, renderInstructions: () => 'instructions view' })),
  );
  await settleAll();
  assert.equal(document.querySelector('.panel-header h2').textContent, 'Settings');
  assert.deepEqual(
    [...document.querySelectorAll('.settings-link')].map((link) => link.textContent.trim()),
    ['Secrets', 'MCP', 'Instructions'],
  );
  assert.equal(document.querySelector('.secrets') ?? undefined, undefined, 'the root draws no view');
  assert.equal(document.querySelector('input[type="text"]') ?? undefined, undefined, 'and no search box');
  await act(async () => document.querySelectorAll('.settings-link')[0].click());
  await settleAll();
  assert.equal(document.querySelector('.panel-header h2').textContent, 'Secrets');
  assert.ok(document.querySelector('.secrets'));
  await act(async () => document.querySelector('.settings-panel .panel-header button').click());
  await settleAll();
  assert.equal(document.querySelectorAll('.settings-link').length, 3, 'back returns to the root');
  await act(async () => document.querySelectorAll('.settings-link')[2].click());
  assert.equal(document.querySelector('.settings-detail, .settings-body').textContent.includes('instructions view'), true);
  await act(async () => document.querySelector('.settings-panel').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  assert.equal(document.querySelectorAll('.settings-link').length, 3, 'Escape returns to the root');
  await unmount();
});

test('the Agents row sits after Instructions and opens the Agents view the host draws', async () => {
  reset('A=1\n');
  root = createRoot(document.getElementById('root'));
  await act(async () =>
    root.render(
      React.createElement(panel.ProjectSettingsPanel, {
        projectPath: '/project',
        views: ['secrets', 'mcp', 'instructions', 'agents'],
        renderInstructions: () => 'instructions view',
        renderAgents: () => 'agents view',
      }),
    ),
  );
  await settleAll();
  assert.deepEqual(
    [...document.querySelectorAll('.settings-link')].map((link) => link.textContent.trim()),
    ['Secrets', 'MCP', 'Instructions', 'Agents'],
  );
  await act(async () => document.querySelectorAll('.settings-link')[3].click());
  await settleAll();
  assert.equal(document.querySelector('.panel-header h2').textContent, 'Agents');
  assert.equal(document.querySelector('.settings-detail, .settings-body').textContent.includes('agents view'), true);
  await unmount();
});

test('a role sees only the links it may open', async () => {
  reset('A=1\n');
  root = createRoot(document.getElementById('root'));
  await act(async () =>
    root.render(React.createElement(panel.ProjectSettingsPanel, { projectPath: '/project', views: ['instructions'], renderInstructions: () => 'x' })),
  );
  await settleAll();
  assert.deepEqual(
    [...document.querySelectorAll('.settings-link')].map((link) => link.textContent.trim()),
    ['Instructions'],
  );
  await unmount();
});

test('a request for Instructions opens that view at once, and a request made before the panel exists waits for it', async () => {
  reset('A=1\n');
  panel.requestSettingsSection('instructions');
  root = createRoot(document.getElementById('root'));
  await act(async () =>
    root.render(
      React.createElement(panel.ProjectSettingsPanel, {
        projectPath: '/project',
        views: ['secrets', 'instructions'],
        renderInstructions: () => 'instructions view',
      }),
    ),
  );
  await settleAll();
  assert.equal(document.querySelector('.panel-header h2').textContent, 'Instructions');
  // Asked again from another view of the open panel: it moves there.
  await act(async () => document.querySelector('.settings-panel .panel-header button').click());
  await settleAll();
  await act(async () => panel.requestSettingsSection('instructions'));
  await settleAll();
  assert.equal(document.querySelector('.panel-header h2').textContent, 'Instructions');
  // A role without the view takes the request and ignores it.
  await unmount();
  panel.requestSettingsSection('mcp');
  root = createRoot(document.getElementById('root'));
  await act(async () =>
    root.render(React.createElement(panel.ProjectSettingsPanel, { projectPath: '/project', views: ['instructions'], renderInstructions: () => 'x' })),
  );
  await settleAll();
  assert.equal(document.querySelector('.panel-header h2').textContent, 'Settings');
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
  assert.match(toastLog.messages().join('\n'), /Cannot read \.env/, 'the failure is a toast');
  assert.equal(document.querySelector('.secrets-failure') ?? undefined, undefined, 'no notice paragraph is added to the panel');
  assert.ok(button('Reload'), 'the toast carries Reload');
  assert.equal(document.querySelector('.ui-skeleton-rows') ?? undefined, undefined);
  window.avb.listSecrets = async () => ({ ok: true, value: listing() });
  await click(button('Reload'));
  assert.deepEqual(toastLog.messages(), [], 'a good read withdraws the toast');
  await unmount();
});

test('the cache holds names only: a revealed or edited value is never in it', async () => {
  reset(`API_KEY=${SECRET}\nOTHER=${OTHER}\n`);
  await mount('/names-only');
  await click(byLabel('Reveal API_KEY'));
  await click(byLabel('Edit OTHER'));
  assert.ok(document.body.innerHTML.includes(SECRET));
  const cached = panel.secretsListingCache.get(envKey('/names-only'));
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
  assert.equal(panel.secretsListingCache.get(envKey('/bound-0')) ?? undefined, undefined, 'the oldest is dropped');
  assert.equal(panel.secretsListingCache.get(envKey('/bound-3')) ?? undefined, undefined);
  assert.equal(panel.secretsListingCache.get(envKey('/bound-11')).kind, 'ready', 'the newest is kept');
  assert.equal(panel.secretsListingCache.get(envKey('/bound-4')).kind, 'ready', 'the eighth most recent is kept');
});

test('a prefetch fills the cache so the first open has no placeholder; an app without the channels fills nothing', async () => {
  reset('A=1\n');
  await panel.prewarmSecretsListing('/prefetched');
  assert.equal(panel.secretsListingCache.get(envKey('/prefetched')).kind, 'ready');
  assert.deepEqual(asked, ['.env'], 'the prefetch reads the file the tab opens on, and only that one');
  delete window.avb.listSecrets;
  await panel.prewarmSecretsListing('/no-channels');
  assert.equal(panel.secretsListingCache.get(envKey('/no-channels')) ?? undefined, undefined);
  window.avb.listSecrets = async () => failure('denied');
  await panel.prewarmSecretsListing('/denied');
  assert.equal(panel.secretsListingCache.get(envKey('/denied')) ?? undefined, undefined, 'a failure is never cached as an empty list');
});

// The labels of the open dropdown's options, in the order they are listed.
const optionLabels = () => [...document.querySelectorAll('.dd-option .dd-option-label')].map((label) => label.textContent.trim());

// Picks a file in the tab's dropdown, as a person would: open the menu, click the option.
async function pick(file) {
  await click(byLabel('Env file'));
  const option = [...document.querySelectorAll('.dd-option')].find((candidate) => candidate.querySelector('.dd-option-label')?.textContent.trim() === file);
  await click(option);
}

test('the dropdown lists the four dev files in load order, and opens on .env', async () => {
  reset('A=1\n');
  await mount('/files');
  assert.equal(byLabel('Env file').textContent.trim(), '.env');
  await click(byLabel('Env file'));
  assert.deepEqual(optionLabels(), FILES);
  await click(byLabel('Env file'));
  await unmount();
});

test('another file is listed, created and changed on its own, and every message names it', async () => {
  reset('A=1\n');
  await mount('/other-file');
  await pick('.env.local');
  assert.equal(asked.at(-1), '.env.local');
  assert.equal(byLabel('Env file').textContent.trim(), '.env.local');
  assert.match(document.body.textContent, /No \.env\.local file yet/);
  await click(button('Add secret'));
  await type(byLabel('Name'), 'B');
  await type(byLabel('Value'), SECRET);
  await click(button('Save'));
  assert.equal(others.get('.env.local'), `B=${SECRET}\n`);
  assert.equal(text, 'A=1\n', '.env is left as it was');
  assert.deepEqual(applied, [{ file: '.env.local', kind: 'add', name: 'B', value: SECRET }]);
  await click(byLabel('Delete B'));
  assert.match(document.body.textContent, /Removes the line from \.env\.local/);
  await click(button('Cancel'));
  await unmount();
});

test('a value revealed in one file is gone when another file is picked', async () => {
  reset(`API_KEY=${SECRET}\n`);
  await mount('/switch');
  await click(byLabel('Reveal API_KEY'));
  assert.ok(document.body.innerHTML.includes(SECRET));
  await pick('.env.local');
  assert.ok(!document.body.innerHTML.includes(SECRET), 'nothing revealed for .env is shown beside .env.local');
  await pick('.env');
  assert.ok(!document.body.innerHTML.includes(SECRET), 'coming back starts hidden');
  await unmount();
});

test('a name a later file sets again says which file dev uses', async () => {
  reset('A=1\nB=2\n');
  others.set('.env.local', 'A=local\n');
  others.set('.env.development', 'A=dev\n');
  await mount('/overridden');
  const rows = rowText();
  const names = [...document.querySelectorAll('.secrets-name')];
  assert.match(names[0].title, /Dev uses the value in \.env\.development/);
  assert.equal(names[1].title, '', 'a name set only here has no note');
  assert.ok(!rows.join('').includes('Dev uses'), 'the note is a tooltip, not a paragraph in the row');
  assert.ok(!document.body.textContent.includes('local'), 'only the last overriding file is named');
  await unmount();
});

test('.env.development is not offered for .gitignore, and its Git state is no warning', async () => {
  reset('A=1\n', 'not-ignored');
  others.set('.env.development', 'PUBLIC_URL=x\n');
  await mount('/development');
  assert.ok(button('Add to .gitignore'), '.env still warns');
  await pick('.env.development');
  assert.equal(button('Add to .gitignore') ?? undefined, undefined);
  ignore = 'tracked';
  await pick('.env.local');
  const reported = toastLog.messages().length;
  assert.match(toastLog.messages().join('\n'), /\.env\.local is committed to Git/, 'a tracked file is a warning toast');
  await pick('.env.development');
  assert.equal(toastLog.messages().length, reported, 'a development file reports nothing');
  assert.ok(!document.getElementById('root').textContent.includes('committed to Git'), 'and the panel holds no warning paragraph');
  await unmount();
});
