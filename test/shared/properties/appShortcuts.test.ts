// Goal: the Apps shortcut and override contract (shared/properties/appShortcuts.ts
// and the new methods in appsRpc.ts) admits exactly the shortcuts, commands,
// claims, override answers and custom frames Desktop and Studio agree on, and
// refuses every other shape at the boundary; and the reserved app command range
// stays free of every Stacki, Electron menu, browser and OS shortcut.
// Method: one known-good value per parser, then each known-bad variation; for the
// range, the menu accelerators in electron/main.ts and every digit key handler in
// the renderer, Studio and the canvas preload are read from source and compared
// with APP_RESERVED_SHORTCUTS, so a new Stacki shortcut in the range fails here;
// Desktop's and Studio's canvas frames are read to hold that both forward it.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  APP_FORWARDED_KEYS,
  APP_RESERVED_SHORTCUTS,
  APP_SHORTCUT_LIMITS,
  forwardedShortcutOf,
  parseAppCommands,
  parseCommandShortcut,
  parseShortcut,
  parseShortcutClaims,
  shortcutLabel,
  shortcutOfPress,
} from '#dist/shared/properties/appShortcuts.js';
import { parseAppManifest } from '#dist/shared/properties/apps.js';
import { APP_METHODS, APP_RPC_LIMITS, parseOverrideAnswer } from '#dist/shared/properties/appsRpc.js';
import { appSdkSource } from '#dist/shared/properties/appSdk.js';

const ROOT = process.cwd();
const press = (code: string, key: string, modifiers: { meta?: boolean; ctrl?: boolean; shift?: boolean; alt?: boolean } = {}) => ({
  code,
  key,
  metaKey: modifiers.meta === true,
  ctrlKey: modifiers.ctrl === true,
  shiftKey: modifiers.shift === true,
  altKey: modifiers.alt === true,
});

test('shortcuts parse to one canonical text, in any case and order', () => {
  assert.equal(parseShortcut('shift+mod+k'), 'Mod+Shift+K');
  assert.equal(parseShortcut('Mod+Alt+Shift+1'), 'Mod+Alt+Shift+1');
  assert.equal(parseShortcut('escape'), 'Escape');
  const bad: Array<[unknown, RegExp]> = [
    ['', /1 to 32 characters/],
    ['Mod+', /"" is not a key/],
    ['Cmd+K', /"Cmd" is not a modifier/],
    ['Mod+Shift+!', /"!" is not a key/],
    ['Mod+KK', /"KK" is not a key/],
    ['x'.repeat(APP_SHORTCUT_LIMITS.shortcutCharsMax + 1), /1 to 32 characters/],
    [7, /Expected string/],
    [undefined, /Expected string/],
  ];
  for (const [input, message] of bad) {
    assert.throws(() => parseShortcut(input), message, String(input));
  }
});

test('a press reads by its physical key, so Shift and Option cannot change it', () => {
  assert.equal(shortcutOfPress(press('Digit1', '!', { meta: true, shift: true })), 'Mod+Shift+1');
  assert.equal(shortcutOfPress(press('Digit1', '⁄', { meta: true, alt: true, shift: true })), 'Mod+Alt+Shift+1');
  assert.equal(shortcutOfPress(press('KeyK', '˚', { ctrl: true, alt: true })), 'Mod+Alt+K');
  assert.equal(shortcutOfPress(press('Escape', 'Escape')), 'Escape');
  assert.equal(shortcutOfPress(press('ShiftLeft', 'Shift', { shift: true })), undefined);
  assert.equal(forwardedShortcutOf(press('KeyZ', 'z', { meta: true })), 'undo');
  assert.equal(forwardedShortcutOf(press('KeyZ', 'Z', { ctrl: true, shift: true })), 'redo');
  assert.equal(forwardedShortcutOf(press('KeyY', 'y', { ctrl: true })), 'redo');
  assert.equal(forwardedShortcutOf(press('KeyZ', 'z', { meta: true, alt: true })), undefined, 'Alt never forwards');
  assert.equal(forwardedShortcutOf(press('KeyK', 'k', { meta: true })), undefined, 'outside the allowlist');
});

test('command shortcuts are refused outside the reserved range, with the range named', () => {
  for (const reserved of APP_RESERVED_SHORTCUTS) {
    assert.equal(parseCommandShortcut(reserved.toLowerCase()), reserved);
  }
  assert.throws(() => parseCommandShortcut('Mod+K'), /App command shortcuts are Mod\+Alt\+Shift\+1/);
  assert.throws(() => parseCommandShortcut('Mod+Shift+3'), /"Mod\+Shift\+3" is Stacki's/);
  assert.throws(
    () =>
      parseAppManifest({
        manifestVersion: 1,
        id: 'a',
        name: 'A',
        version: '1.0.0',
        entry: 'index.html',
        commands: [{ id: 'go', title: 'Go', shortcut: 'Mod+Z' }],
      }),
    /App command shortcuts are/,
    'the manifest parser refuses it',
  );
});

test('commands and claims are bounded and unique', () => {
  const commands = parseAppCommands([
    { id: 'open-images', title: 'Images', shortcut: 'mod+alt+shift+1', panel: 'images' },
    { id: 'about', title: 'About' },
  ]);
  assert.deepEqual(commands[0], { id: 'open-images', title: 'Images', shortcut: 'Mod+Alt+Shift+1', panel: 'images' });
  assert.equal(commands[1]?.shortcut, undefined);
  const bad: Array<[unknown, RegExp]> = [
    [[{ id: 'Bad Id', title: 'x' }], /command id is lowercase/],
    [[{ id: 'a', title: '' }], /title is 1 to 80/],
    [[{ id: 'a', title: 'x'.repeat(APP_SHORTCUT_LIMITS.commandTitleCharsMax + 1) }], /title is 1 to 80/],
    [[{ id: 'a', title: 'x', panel: 'has space' }], /command panel is/],
    [
      [
        { id: 'a', title: 'A' },
        { id: 'a', title: 'B' },
      ],
      /ids are unique/,
    ],
    [
      [
        { id: 'a', title: 'A', shortcut: 'Mod+Alt+Shift+1' },
        { id: 'b', title: 'B', shortcut: 'Mod+Alt+Shift+1' },
      ],
      /share a shortcut/,
    ],
    [Array.from({ length: APP_SHORTCUT_LIMITS.commandsMax + 1 }, (_, index) => ({ id: `c${index}`, title: 'C' })), /at most 16 commands/],
    ['not a list', /must be a list/],
  ];
  for (const [input, message] of bad) {
    assert.throws(() => parseAppCommands(input), message, JSON.stringify(input).slice(0, 80));
  }
  assert.deepEqual(parseShortcutClaims(['mod+k', 'Mod+K', 'Escape']), ['Mod+K', 'Escape']);
  assert.throws(() => parseShortcutClaims(Array.from({ length: APP_SHORTCUT_LIMITS.claimsMax + 1 }, () => 'Mod+K')), /at most 32/);
  assert.throws(() => parseShortcutClaims('Mod+K'), /list/);
  const manifest = parseAppManifest({ manifestVersion: 1, id: 'a', name: 'A', version: '1.0.0', entry: 'index.html', shortcutClaims: ['mod+z'] });
  assert.deepEqual(manifest.shortcutClaims, ['Mod+Z']);
  assert.deepEqual(manifest.commands, []);
});

test('labels follow the platform', () => {
  assert.equal(shortcutLabel('Mod+Alt+Shift+1', 'mac'), '⌘⌥⇧1');
  assert.equal(shortcutLabel('Mod+Alt+Shift+1', 'other'), 'Ctrl+Alt+Shift+1');
});

test('override answers, shortcut and frame params refuse every other shape', () => {
  assert.deepEqual(parseOverrideAnswer('assets.pick', { kind: 'picked', url: 'https://cdn.example/a.png', alt: 'A' }).result, {
    kind: 'picked',
    url: 'https://cdn.example/a.png',
    alt: 'A',
  });
  assert.equal(parseOverrideAnswer('assets.pick', { kind: 'picked', url: 'public/images/a.png' }).result.kind, 'picked');
  assert.deepEqual(parseOverrideAnswer('cms.bind', { kind: 'picked', path: 'post.data["campus-name"]' }).result, {
    kind: 'picked',
    path: 'post.data["campus-name"]',
  });
  assert.equal(parseOverrideAnswer('cms.bind', { kind: 'picked', path: 'astro:campus' }).result.kind, 'picked');
  assert.deepEqual(parseOverrideAnswer('cms.bind', { kind: 'cancel' }), { point: 'cms.bind', result: { kind: 'cancel' } });
  const projectPathOnly = /https:\/\/ URL or a project path/;
  const badAnswers: Array<['assets.pick' | 'cms.bind', unknown, RegExp]> = [
    ['assets.pick', { kind: 'picked', url: 'javascript:alert(1)' }, projectPathOnly],
    ['assets.pick', { kind: 'picked', url: 'http://plain.example/a.png' }, projectPathOnly],
    ['assets.pick', { kind: 'picked', url: 'public/../secrets.txt' }, /without \., \.\. or empty segments/],
    ['assets.pick', { kind: 'picked', url: '/etc/passwd' }, projectPathOnly],
    ['assets.pick', { kind: 'picked', url: 'data:image/png;base64,AAAA' }, projectPathOnly],
    ['assets.pick', { kind: 'picked', url: `https://a.example/${'x'.repeat(APP_RPC_LIMITS.assetURLCharsMax)}` }, /url is 1 to 2048/],
    ['assets.pick', { kind: 'picked', url: 'https://a.example/a.png', alt: 'x'.repeat(APP_RPC_LIMITS.altCharsMax + 1) }, /alt exceeds 500/],
    ['assets.pick', { kind: 'picked', path: 'post.title' }, /Expected string/],
    ['cms.bind', { kind: 'picked', path: 'post.title; alert(1)' }, /is not a data path/],
    ['cms.bind', { kind: 'picked', path: '${x}' }, /is not a data path/],
    ['cms.bind', { kind: 'picked', path: 'x'.repeat(APP_RPC_LIMITS.bindingPathCharsMax + 1) }, /path is 1 to 512/],
    ['cms.bind', { kind: 'chosen' }, /picked, default or cancel/],
    ['cms.bind', 'picked', /Expected object/],
  ];
  for (const [point, input, message] of badAnswers) {
    assert.throws(() => parseOverrideAnswer(point, input), message, JSON.stringify(input).slice(0, 80));
  }
  const resolve = APP_METHODS['overrides.resolve'].params;
  assert.equal(resolve({ call: 3, point: 'cms.bind', result: { kind: 'default' } }).call, 3);
  const badResolves: Array<[unknown, RegExp]> = [
    [{ call: 0, point: 'cms.bind', result: { kind: 'default' } }, /call is the positive id/],
    [{ call: 1.5, point: 'cms.bind', result: { kind: 'default' } }, /call is the positive id/],
    [{ call: 1, point: 'nav.open', result: { kind: 'default' } }, /point must be one of/],
  ];
  for (const [input, message] of badResolves) {
    assert.throws(() => resolve(input), message);
  }
  const open = APP_METHODS['ui.openFrame'].params;
  assert.deepEqual(open({ page: 'picker.html', width: 640, height: 480, modal: true }), {
    page: 'picker.html',
    width: 640,
    height: 480,
    modal: true,
    data: undefined,
  });
  const ownPage = /opens one of the app’s own HTML files/;
  const badFrames: Array<[unknown, RegExp]> = [
    [{ page: '../escape.html', width: 640, height: 480 }, ownPage],
    [{ page: 'picker.js', width: 640, height: 480 }, ownPage],
    [{ page: 'picker.html', width: APP_RPC_LIMITS.frameWidthPxMax + 1, height: 480 }, /width must be 240 to 1600/],
    [{ page: 'picker.html', width: 640, height: 10 }, /height must be 160 to 1200/],
    [{ page: 'picker.html', width: 640, height: 480, modal: 'yes' }, /modal must be true or false/],
    [{ page: 'picker.html', width: 640, height: 480, data: 'x'.repeat(APP_RPC_LIMITS.valueCharsMax + 1) }, /data exceeds 4096/],
  ];
  for (const [input, message] of badFrames) {
    assert.throws(() => open(input), message, JSON.stringify(input).slice(0, 80));
  }
  assert.throws(() => APP_METHODS['ui.closeFrame'].params({ frameId: 'frame-0' }), /frameId is an id/);
  assert.throws(() => APP_METHODS['ui.closeFrame'].params({ frameId: '../x' }), /frameId is an id/);
  assert.throws(() => APP_METHODS['shortcuts.run'].params({ shortcut: 'delete-everything' }), /shortcut must be one of/);
  assert.throws(() => APP_METHODS['shortcuts.focus'].params({ editable: 'yes' }), /editable must be true or false/);
  assert.throws(() => APP_METHODS['overrides.register'].params({ point: 'menu.open' }), /point must be one of/);
  assert.throws(() => APP_METHODS['commands.trigger'].params({ shortcut: 'Mod+Z' }), /App command shortcuts/);
});

test('the SDK is generated from the same key tables', () => {
  const sdk = appSdkSource();
  assert.ok(sdk.includes(JSON.stringify(APP_FORWARDED_KEYS)));
  assert.ok(sdk.includes(JSON.stringify(APP_RESERVED_SHORTCUTS)));
  for (const helper of ['register: register', 'openFrame: openFrame', 'claim: claim']) {
    assert.ok(sdk.includes(helper), helper);
  }
});

// The reserved range guard. Electron accelerators are written `Shift+CmdOrCtrl+Z`;
// renderer handlers compare `event.code` or `event.key` with a digit.
const OS_AND_BROWSER = [
  'Mod+Alt+Shift+V',
  'Mod+Alt+Shift+Escape',
  'Mod+Shift+3',
  'Mod+Shift+4',
  'Mod+Shift+5',
  'Mod+Shift+6',
  'Mod+Shift+0',
  'Mod+Shift+Q',
  'Mod+Shift+T',
  'Mod+Shift+N',
  'Mod+Shift+W',
];

// Iterative, with a bound on the files read: the source trees are a few thousand files.
const SOURCE_FILES_MAX = 20_000;
function sourceFiles(root: string): string[] {
  const found: string[] = [];
  const pending = [root];
  for (let visited = 0; pending.length > 0; visited += 1) {
    assert.ok(visited < SOURCE_FILES_MAX, 'source trees are bounded');
    const directory = pending.pop() ?? root;
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      if (name === 'node_modules' || name === 'vendor' || name === 'dist' || name.startsWith('.')) {
        continue;
      }
      if (statSync(path).isDirectory()) {
        pending.push(path);
      } else if (/\.(?:ts|tsx|mts)$/.test(name)) {
        found.push(path);
      }
    }
  }
  return found;
}

function canonicalOrRaw(shortcut: string): string {
  try {
    return parseShortcut(shortcut);
  } catch {
    return shortcut;
  }
}

test('no Stacki, menu, browser or OS shortcut is in the reserved app range', () => {
  const main = readFileSync(join(ROOT, 'electron/main.ts'), 'utf8');
  // Punctuation (`CmdOrCtrl+,`) is no shortcut text an app can write, so it is compared as written.
  const accelerators = [...main.matchAll(/accelerator:\s*'([^']+)'/g)].map((match) => canonicalOrRaw((match[1] ?? '').replace('CmdOrCtrl', 'Mod')));
  assert.ok(accelerators.includes('Mod+Z'), 'the menu accelerators were read');
  for (const shortcut of [...accelerators, ...OS_AND_BROWSER, ...Object.keys(APP_FORWARDED_KEYS)]) {
    assert.ok(!APP_RESERVED_SHORTCUTS.some((reserved) => reserved === shortcut), `${shortcut} is in the app range`);
  }
  // A digit key handler anywhere in the editor would be a Stacki shortcut on a digit: only the canvas's app-command forward may read one.
  const files = [...sourceFiles(join(ROOT, 'src')), ...sourceFiles(join(ROOT, 'studio/src')), ...sourceFiles(join(ROOT, 'electron/preload'))];
  const digitHandlers = files.filter((file) => /(?:code\s*===\s*'Digit\d|key\s*===\s*'\d'|\/\^Digit)/.test(readFileSync(file, 'utf8')));
  assert.deepEqual(
    digitHandlers.map((file) => file.slice(ROOT.length + 1)).sort(),
    ['electron/preload/frameDesign.ts', 'src/ui/richTextCommands.ts'],
    'a new digit shortcut is checked against the range here first',
  );
  const forward = /\/\^Digit\(\[([\d-]+)\]\)\$\//.exec(readFileSync(join(ROOT, 'electron/preload/frameDesign.ts'), 'utf8'));
  assert.deepEqual(
    Array.from({ length: 9 }, (_, index) => String(index + 1))
      .filter((digit) => new RegExp(`^[${forward?.[1] ?? ''}]$`).test(digit))
      .map((digit) => `Mod+Alt+Shift+${digit}`),
    [...APP_RESERVED_SHORTCUTS],
    'the canvas forwards exactly the reserved range',
  );
  // Studio's canvas frame forwards the same range by the shared table, as Desktop's message, and
  // the editor runs it: without both, an app command dies while Studio's canvas has focus.
  const studioKeys = readFileSync(join(ROOT, 'studio/src/features/preview/previewKeys.ts'), 'utf8');
  assert.match(
    studioKeys,
    /isReservedShortcut\(shortcut\)\)\s*\{\s*event\.preventDefault\(\);\s*post\(\{ type: 'avb:shortcut', name: 'appCommand', shortcut \}\)/,
  );
  const studioPreview = readFileSync(join(ROOT, 'studio/src/features/preview/usePreview.ts'), 'utf8');
  assert.match(studioPreview, /shortcut\?\.name === 'appCommand'\)\s*\{\s*runShortcutCommand\(shortcut\.shortcut\)/);
});
