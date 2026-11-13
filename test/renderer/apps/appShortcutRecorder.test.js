// Goal: an app command's shortcut is recorded, not picked, in the app's details
// popup (AppCommandSettings.tsx over src/ui/ShortcutRecorder.tsx). Clicking the
// field records; the next key combination in the reserved range is saved; a key
// outside the range leaves it recording with a hint read from the range itself;
// a key another command holds is refused with "Used by <App>" and nothing is
// saved; Escape cancels without reaching the popup; Backspace and Delete clear
// it to no shortcut; the reset button appears only when the key differs from the
// app's own and puts the app's own key back. Each command is one line, its title
// and the field, with no subline; a key an earlier app holds draws an amber dot
// and names the holder in the row's hint; a non-admin reads the key as text.
// Also: the details body puts the sections' gap above its first section, so the
// first heading never sits on the header's line.
// Method: the pure pieces (recorderStep, commandShortcutHint, shortcutHolder,
// rebindFor) are called directly over their branches; then the real section is
// mounted in JSDOM over the real command store and driven with key events,
// reading the DOM and the stored rebinds after each step. JSDOM's navigator names
// no Mac, so Mod is Ctrl here; the Mac branch is covered through recorderStep.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { ROOT, repoPath } = require('../../helpers/sources');

const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
for (const key of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'MouseEvent', 'KeyboardEvent', 'FocusEvent']) {
  global[key] = key === 'window' ? dom.window : dom.window[key];
}
global.IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(global, 'localStorage', { configurable: true, value: dom.window.localStorage });
Object.defineProperty(global, 'navigator', { configurable: true, value: dom.window.navigator });

const directory = repoPath('node_modules/.stacki-test/app-shortcut-recorder');
fs.mkdirSync(directory, { recursive: true });
const outfile = path.join(directory, 'bundle.cjs');
esbuild.buildSync({
  stdin: {
    contents: [
      "export { AppCommandSettings } from './src/features/apps/AppCommandSettings';",
      "export { configureAppCommands, resetAppCommands, bindCommands, commandShortcutHint, shortcutHolder, rebindFor } from './src/features/apps/appCommands';",
      "export { recorderStep, isShortcutRecorderTarget } from './src/ui/ShortcutRecorder';",
      "export { ADMIN_VIEW } from './shared/properties/projectRoles';",
      "export { ENGLISH_TRANSLATE } from './shared/properties/i18n/englishTranslator';",
    ].join('\n'),
    resolveDir: ROOT,
    loader: 'ts',
  },
  outfile,
  bundle: true,
  format: 'cjs',
  platform: 'node',
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  loader: { '.css': 'empty' },
  logLevel: 'silent',
});
const apps = require(outfile);
const React = require('react');
const { act } = require('react');
const { createRoot } = require('react-dom/client');

const PROJECT = '/projects/site';
const STORAGE_KEY = `stacki.apps.commands:${PROJECT}`;

function summary(id, name, installedAt, commands) {
  return {
    manifest: {
      manifestVersion: 1,
      id,
      name,
      version: '1.0.0',
      description: '',
      entry: 'index.html',
      capabilities: [],
      window: { mode: 'popup', widthPx: 300, heightPx: 300 },
      settings: [],
      secretsAllowlist: [],
      commands,
    },
    lock: { id, version: '1.0.0', sha256: 'a'.repeat(64), installedAt, source: { kind: 'file', fileName: `${id}.zip` } },
  };
}

const heatMap = summary('heat-map', 'Heat map', '2026-01-01T00:00:00.000Z', [
  { id: 'toggle', title: 'Toggle heat map', shortcut: 'Mod+Alt+Shift+1', panel: undefined },
]);
const notes = summary('notes', 'Notes', '2026-02-01T00:00:00.000Z', [
  { id: 'open', title: 'Open notes', shortcut: 'Mod+Alt+Shift+2', panel: undefined },
  { id: 'pin', title: 'Pin note', shortcut: undefined, panel: undefined },
]);

const press = (key, code, modifiers = {}) => ({ key, code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...modifiers });
const rules = (conflict = () => undefined) => ({ hint: 'Use the range', accepts: (shortcut) => shortcut.startsWith('Mod+Alt+Shift+'), conflict });

test('recorderStep: cancel, clear, wait, pass, refuse and record', () => {
  assert.deepEqual(apps.recorderStep(press('Escape', 'Escape'), 'other', rules()), { kind: 'cancel' });
  assert.deepEqual(apps.recorderStep(press('Backspace', 'Backspace'), 'other', rules()), { kind: 'clear' });
  assert.deepEqual(apps.recorderStep(press('Delete', 'Delete'), 'mac', rules()), { kind: 'clear' });
  assert.deepEqual(apps.recorderStep(press('Shift', 'ShiftLeft', { shiftKey: true }), 'other', rules()), { kind: 'wait' }, 'a bare modifier waits');
  assert.deepEqual(apps.recorderStep(press('Tab', 'Tab'), 'other', rules()), { kind: 'pass' }, 'Tab moves focus on');
  // A modified Escape or Backspace is a key like any other: here, outside the range.
  assert.deepEqual(apps.recorderStep(press('Escape', 'Escape', { shiftKey: true }), 'other', rules()), { kind: 'refuse', hint: 'Use the range' });
  const inRange = { ctrlKey: true, altKey: true, shiftKey: true };
  assert.deepEqual(apps.recorderStep(press('!', 'Digit3', inRange), 'other', rules()), { kind: 'record', shortcut: 'Mod+Alt+Shift+3' });
  assert.deepEqual(apps.recorderStep(press('K', 'KeyK', { ctrlKey: true }), 'other', rules()), { kind: 'refuse', hint: 'Use the range' });
  assert.deepEqual(apps.recorderStep(press(';', 'Semicolon', inRange), 'other', rules()), { kind: 'refuse', hint: 'Use the range' }, 'punctuation is no key');
  // Mod is ⌘ on a Mac and Ctrl elsewhere; the other modifier cannot be written down.
  assert.deepEqual(apps.recorderStep(press('3', 'Digit3', { metaKey: true, altKey: true, shiftKey: true }), 'mac', rules()), {
    kind: 'record',
    shortcut: 'Mod+Alt+Shift+3',
  });
  assert.equal(apps.recorderStep(press('3', 'Digit3', inRange), 'mac', rules()).kind, 'refuse', 'Ctrl is not Mod on a Mac');
  assert.equal(
    apps.recorderStep(press('3', 'Digit3', { metaKey: true, altKey: true, shiftKey: true }), 'other', rules()).kind,
    'refuse',
    'nor the Windows key elsewhere',
  );
  const held = apps.recorderStep(
    press('3', 'Digit3', inRange),
    'other',
    rules(() => 'Used by Notes'),
  );
  assert.deepEqual(held, { kind: 'refuse', hint: 'Used by Notes' });
  assert.throws(() => apps.recorderStep(press('3', 'Digit3'), 'other', { ...rules(), hint: '' }), /Assertion failed: A recorder has a hint to show/);
});

test('the hint is the reserved range; a holder is named; a rebind back to the default is none', () => {
  assert.equal(apps.commandShortcutHint('mac', apps.ENGLISH_TRANSLATE), 'Use ⌘⌥⇧ with a number from 1 to 9');
  assert.equal(apps.commandShortcutHint('other', apps.ENGLISH_TRANSLATE), 'Use Ctrl+Alt+Shift with a number from 1 to 9');
  const bound = apps.bindCommands([heatMap, notes], new Map(), {});
  assert.equal(apps.shortcutHolder(bound, 'notes', 'open', 'Mod+Alt+Shift+1', apps.ENGLISH_TRANSLATE), 'Used by Heat map', 'another app is named by its app');
  assert.equal(apps.shortcutHolder(bound, 'notes', 'pin', 'Mod+Alt+Shift+2', apps.ENGLISH_TRANSLATE), 'Used by Open notes', 'one of the same app by its title');
  assert.equal(apps.shortcutHolder(bound, 'notes', 'open', 'Mod+Alt+Shift+2', apps.ENGLISH_TRANSLATE), undefined, 'its own key is no conflict');
  assert.equal(apps.shortcutHolder(bound, 'notes', 'open', 'Mod+Alt+Shift+5', apps.ENGLISH_TRANSLATE), undefined, 'a free key');
  const [toggle] = heatMap.manifest.commands;
  assert.equal(apps.rebindFor(toggle, 'Mod+Alt+Shift+1'), undefined);
  assert.equal(apps.rebindFor(toggle, 'Mod+Alt+Shift+4'), 'Mod+Alt+Shift+4');
  assert.equal(apps.rebindFor(toggle, undefined), 'none');
  assert.equal(apps.rebindFor(notes.manifest.commands[1], undefined), undefined, 'no key is the default of a command without one');
});

async function mountSection(app) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(React.createElement(apps.AppCommandSettings, { app, admin: true })));
  return { container, root };
}

const stored = () => JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');

test('the details section records, refuses, cancels, clears and resets a command’s key', async () => {
  localStorage.clear();
  apps.resetAppCommands();
  apps.configureAppCommands(PROJECT, [heatMap, notes], () => apps.ADMIN_VIEW);
  const { container, root } = await mountSection(notes);
  const field = () => container.querySelector('[aria-label="Shortcut for Open notes"]');
  const hint = () => container.querySelector('.shortcut-recorder-hint')?.textContent;
  const reset = () => container.querySelector('[aria-label="Use the app’s own key"]') ?? undefined;
  const key = (key, code, modifiers = {}) => act(async () => field().dispatchEvent(new KeyboardEvent('keydown', { key, code, bubbles: true, ...modifiers })));
  const inRange = { ctrlKey: true, altKey: true, shiftKey: true };
  assert.equal(field().textContent, 'Ctrl+Alt+Shift+2', 'shows the current key');
  assert.equal(reset(), undefined, 'no reset while it is the app’s own key');

  await act(async () => field().click());
  assert.equal(field().textContent, 'Press keys…');
  assert.equal(apps.isShortcutRecorderTarget(field()), true, 'global shortcuts skip a recording field');

  // Outside the range: the hint, and still recording.
  await key('k', 'KeyK', { ctrlKey: true });
  assert.equal(hint(), 'Use Ctrl+Alt+Shift with a number from 1 to 9');
  assert.equal(field().textContent, 'Press keys…');
  assert.deepEqual(stored(), {}, 'nothing saved');

  // Another app's key: refused, named, not saved, still recording.
  await key('1', 'Digit1', inRange);
  assert.equal(hint(), 'Used by Heat map');
  assert.deepEqual(stored(), {});
  assert.equal(field().textContent, 'Press keys…');

  // A free key in the range: saved, and the reset appears.
  await key('5', 'Digit5', inRange);
  assert.equal(field().textContent, 'Ctrl+Alt+Shift+5');
  assert.equal(hint(), undefined);
  assert.deepEqual(stored(), { notes: { open: 'Mod+Alt+Shift+5' } });
  assert.ok(reset(), 'the key differs from the app’s own');

  // Escape cancels and never reaches the popup underneath.
  let escapes = 0;
  const onDocumentKey = (event) => {
    if (event.key === 'Escape') {
      escapes += 1;
    }
  };
  document.addEventListener('keydown', onDocumentKey);
  await act(async () => field().click());
  await key('Escape', 'Escape');
  document.removeEventListener('keydown', onDocumentKey);
  assert.equal(escapes, 0, 'the popup does not close');
  assert.equal(field().textContent, 'Ctrl+Alt+Shift+5', 'cancelled, unchanged');
  assert.deepEqual(stored(), { notes: { open: 'Mod+Alt+Shift+5' } });

  // Backspace clears it to no shortcut.
  await act(async () => field().click());
  await key('Backspace', 'Backspace');
  assert.equal(field().textContent, 'None');
  assert.deepEqual(stored(), { notes: { open: 'none' } });
  // One line per command: the title and the field, no subline under the title.
  const row = [...container.querySelectorAll('.apps-details-item')].find((candidate) => candidate.textContent.includes('Open notes'));
  assert.equal(row.querySelector('.apps-details-item-text').textContent, 'Open notes');
  assert.equal(row.querySelector('.apps-details-row-description') ?? undefined, undefined, 'no subline');
  assert.equal(row.dataset.tone, undefined, 'a free key draws no dot');

  // Reset puts the app's own key back and the button goes.
  await act(async () => reset().click());
  assert.equal(field().textContent, 'Ctrl+Alt+Shift+2');
  assert.deepEqual(stored(), { notes: {} });
  assert.equal(reset(), undefined);

  // Recording the app's own key by hand leaves nothing to reset.
  await act(async () => field().click());
  await key('6', 'Digit6', inRange);
  await act(async () => field().click());
  await key('2', 'Digit2', inRange);
  assert.deepEqual(stored(), { notes: {} });
  assert.equal(reset(), undefined);

  await act(async () => root.unmount());
  apps.resetAppCommands();
});

test('a key an earlier app holds marks the row and names the holder; a non-admin reads the key as text', async () => {
  localStorage.clear();
  apps.resetAppCommands();
  // Installed later and asking for Heat map's key: Heat map keeps it.
  const late = summary('late', 'Late', '2026-03-01T00:00:00.000Z', [{ id: 'go', title: 'Go late', shortcut: 'Mod+Alt+Shift+1', panel: undefined }]);
  apps.configureAppCommands(PROJECT, [heatMap, late], () => apps.ADMIN_VIEW);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(React.createElement(apps.AppCommandSettings, { app: late, admin: true })));
  const row = container.querySelector('.apps-details-item');
  assert.equal(row.dataset.tone, 'warning', 'the amber dot');
  assert.ok(row.querySelector('.apps-details-dot'));
  assert.equal(row.querySelector('[aria-label="Shortcut for Go late"]').textContent, 'Ctrl+Alt+Shift+1', 'the field shows the key it asks for');
  const hint = row.querySelector('button[aria-label="About Go late"]');
  assert.equal(document.getElementById(hint.getAttribute('aria-describedby')).textContent, 'Ctrl+Alt+Shift+1 is in use by Heat map, installed first.');
  // Anyone else sees the key, not a field.
  await act(async () => root.render(React.createElement(apps.AppCommandSettings, { app: heatMap, admin: false })));
  assert.equal(container.querySelector('[aria-label="Shortcut for Toggle heat map"]') ?? undefined, undefined, 'no recorder');
  assert.equal(container.querySelector('.apps-details-shortcut').textContent, 'Ctrl+Alt+Shift+1');
  await act(async () => root.unmount());
  container.remove();
  apps.resetAppCommands();
});

test('the details body puts the sections’ gap above its first section', () => {
  const css = fs.readFileSync(repoPath('src/features/apps/appDetails.css'), 'utf8');
  const body = /\.apps-details-popup \.apps-details-body \{([^}]*)\}/.exec(css)?.[1] ?? '';
  assert.match(body, /--apps-details-section-gap: 20px;/);
  assert.match(body, /\n\s*gap: var\(--apps-details-section-gap\);/, 'sections are a gap apart');
  assert.match(body, /\n\s*padding: var\(--apps-details-section-gap\) 16px;/, 'the first section is the same gap below the header');
});
