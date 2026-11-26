// Goal: Design mode stays removable and its fence stays shut. (1) Nothing outside its own folders reaches it but the
// integration points docs/design-mode/REMOVE.md lists, each with the number of lines it names. (2) The fence's list
// of channels that may run on the sandbox names only real channels, and none of those that act outside a copy of
// the project: git, publishing, the terminal, the AI agent, Stacki apps, secrets, settings, recents, MCP writes,
// remote content writes. (3) Its renderer code calls no preload method but its own channel. (4) The AI panel's mode
// buttons, which it shares with comment pins, and comment pins themselves know nothing of it.
//
// Method: a bounded scan of the source trees' text, and the built IPC payload table for the channel names. Each rule
// also checks a known-bad line, so a pattern that matches nothing cannot pass vacuously.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { IPC_PAYLOADS } from '#dist/shared/ipc/ipcPayloads.js';
import { DESIGN_CHANNELS } from '#dist/electron/lib/designMode/designFence.js';

// Tests run from the repository root (scripts/gate/runTests.ts).
const ROOT = process.cwd();
const FEATURE_PATHS = [
  'src/app/designMode/',
  'electron/handlers/designMode/',
  'electron/lib/designMode/',
  'electron/preload/designMode/',
  'shared/ipc/designSession.ts',
  'shared/ipc/designSnapshot.ts',
];
const SCANNED = ['src', 'electron', 'shared', 'scripts', 'studio/src', 'studio/scripts'];
const FILES_MAX = 20_000;

/** The integration points REMOVE.md lists: file, and how many of its lines reach Design mode. */
const INTEGRATION_POINTS: Readonly<Record<string, number>> = {
  'src/app/shell/AppShell.tsx': 2,
  'electron/main.ts': 5,
  'electron/preload/preload.ts': 3,
  'electron/lib/ipcRegistrar.ts': 3,
  'electron/preload/preloadBridge.ts': 1,
  'shared/ipc/ipcPayloads.ts': 2,
  'shared/ipc/ipcResults.ts': 3,
  'shared/ipc/preloadApi.ts': 1,
  'src/features/style/embed/useInlineTarget.ts': 5,
  'src/features/style/model/inlineDefault.ts': 5,
  'src/features/ai/AiPanel.tsx': 2,
  'src/features/ai/aiHold.ts': 1,
};

function sourceFiles(): readonly string[] {
  const files: string[] = [];
  const pending = SCANNED.map((folder) => path.join(ROOT, folder)).filter((folder) => fs.existsSync(folder));
  while (pending.length > 0 && files.length < FILES_MAX) {
    const directory = pending.pop() ?? ROOT;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== 'vendor' && entry.name !== 'dist') {
          pending.push(full);
        }
      } else if (/\.(ts|tsx|mts|js|mjs|css)$/.test(entry.name)) {
        files.push(path.relative(ROOT, full).split(path.sep).join('/'));
      }
    }
  }
  assert.ok(files.length < FILES_MAX, 'the scan stays within its bound');
  return files;
}

function inFeature(file: string): boolean {
  return FEATURE_PATHS.some((feature) => file === feature || file.startsWith(feature));
}

/** Lines that reach Design mode: its folders, its channel, its fence, the Inline styles default it sets. */
const REACHES =
  /designMode\/|designSession|DesignSession|DesignModeHost|designFenceState|DESIGN_SESSION|checkDesignFence|inlineDefault|InlineDefault|Design mode \(experimental/;

test('only the listed integration points reach Design mode from outside its folders', () => {
  assert.ok(REACHES.test("import { DesignModeHost } from '../designMode/DesignModeHost';"), 'the pattern sees an import');
  assert.ok(!REACHES.test("import { holdWindow } from '../../ui/busyLock';"), 'the pattern skips other imports');
  const found = new Map<string, number>();
  for (const file of sourceFiles().filter((candidate) => !inFeature(candidate))) {
    const lines = fs
      .readFileSync(path.join(ROOT, file), 'utf8')
      .split('\n')
      .filter((line) => REACHES.test(line));
    if (lines.length > 0) {
      found.set(file, lines.length);
    }
  }
  assert.deepEqual(Object.fromEntries(found), INTEGRATION_POINTS);
});

/** Channel families that act outside a copy of the project: never on the fence's list. */
const NEVER = [
  /^git:/,
  /^github:/,
  /^publish:(?!state$|availability$)/,
  /^terminal:/,
  /^apps:(?!list$|folders$|checkUpdates$|storageWatch$)/,
  /^secrets:(?!list$)/,
  /^preview:(atCommit|stop)$/,
  /^studio:(?!status$)/,
  /^emdash:install/,
  /^ai:(prompt|steer|setup|prewarm|compact|installAgent|trust|remember|review|permission|diff)$/,
  /^settings:set$/,
  /^recents:(add|remove|refreshThumb)$/,
  /^mcp:(apply|applyCodex|saveText|reveal|revealCodex)$/,
  /^cmsRemote:(create|delete|move|write|act|restore|upload)$/,
  /^cmsConnections:(save|remove|sanityLogin)$/,
  /^mediaHosting:(?!connections$|list$)/,
  /^content:remoteEdit$/,
  /^project:(setEnv|openDialog|openSiteDialog|parentDialog|pickFolder|createAstro|createAstroCopy|createStarter)$/,
  /^dev:setNetwork$/,
  /^update:act$/,
];

test("the fence's channels are real channels, and none of them acts outside the copy", () => {
  const real = new Set(Object.keys(IPC_PAYLOADS));
  assert.ok(real.has('git:commit') && real.has('page:edit'), 'the payload table is read');
  assert.ok(
    NEVER.some((pattern) => pattern.test('git:push')),
    'the deny patterns see git',
  );
  for (const channel of DESIGN_CHANNELS) {
    assert.ok(real.has(channel), `${channel} is a channel`);
    for (const pattern of NEVER) {
      assert.ok(!pattern.test(channel), `${channel} may not run in Design mode`);
    }
  }
  // Every channel the app has is either let through or refused: a new one is refused until it is listed here.
  const refused = [...real].filter((channel) => !DESIGN_CHANNELS.has(channel));
  assert.ok(refused.length > 100, 'most of what reaches past the project is refused');
});

test("Design mode's renderer calls no preload method but its own channel", () => {
  const files = sourceFiles().filter((file) => file.startsWith('src/app/designMode/'));
  assert.ok(files.length > 8, 'the feature is read');
  const avb = /window\.avb\.(\w+)/g;
  assert.deepEqual(
    [...'window.avb.pageEdit('.matchAll(avb)].map((match) => match[1]),
    ['pageEdit'],
    'the pattern sees a preload call',
  );
  for (const file of files) {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    for (const match of text.matchAll(avb)) {
      assert.equal(match[1], 'designSession', `${file} calls window.avb.${match[1] ?? ''}`);
    }
    assert.doesNotMatch(text, /\bfetch\(|XMLHttpRequest|ipcRenderer/, `${file} reaches a channel of its own`);
  }
});

/** The mode buttons and comment pins: what Design mode shares the header with, and must be able to leave behind. */
const SHARED_WITH = ['src/features/ai/panelModes.ts', 'src/features/ai/sessions/ModeButtons.tsx', 'src/app/shell/DesktopPins.tsx'];

test('the mode buttons and comment pins know nothing of Design mode', () => {
  const names = /design ?mode|designMode/i;
  assert.ok(names.test('Design mode') && !names.test('registerPanelMode(PINS)'), 'the pattern sees the name');
  const files = [...SHARED_WITH, ...sourceFiles().filter((file) => file.startsWith('src/features/ai/pins/'))];
  assert.ok(files.length > SHARED_WITH.length, 'the pins folder is read');
  for (const file of files) {
    assert.doesNotMatch(fs.readFileSync(path.join(ROOT, file), 'utf8'), names, `${file} names Design mode`);
  }
});
