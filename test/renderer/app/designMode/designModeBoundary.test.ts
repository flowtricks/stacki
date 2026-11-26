// Goal: Design mode stays removable and can never write. (1) Nothing outside its folders reaches it except the
// integration points docs/design-mode/REMOVE.md lists, each exactly where it says. (2) Its renderer modules import
// only what a sandbox needs: shared contracts, the UI kit, the canvas's read-only request channel, the AI panel's
// draft and screenshot, and nothing of the editor's edit queue, gestures, saves or IPC writes. (3) It calls no preload
// method but the menu listener and no `fetch`; the frame's relay fetches only the two read-only routes. (4) What the
// app hands it is the read-only view REMOVE.md names. (5) The AI panel's Modes menu, which Design mode shares with
// comment pins, and comment pins themselves know nothing of Design mode, so taking it out leaves them as they are.
// (6) The insert palette's letters Design mode keeps from the editor are the editor's own.
//
// Method: a bounded scan of the source trees' text. Each rule also checks a known-bad line, so a pattern that
// matches nothing cannot pass vacuously.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Tests run from the repository root (scripts/gate/runTests.ts).
const ROOT = process.cwd();
const FEATURE_FOLDERS = ['src/app/designMode', 'electron/preload/designMode', 'electron/previewServer/designMode', 'shared/designMode'];
const SCANNED = ['src', 'electron', 'shared', 'scripts', 'studio/src', 'studio/scripts'];
const FILES_MAX = 20_000;

/** The integration points REMOVE.md lists: file, and the exact lines that name Design mode. */
const INTEGRATION_POINTS: Readonly<Record<string, number>> = {
  'src/app/shell/AppShell.tsx': 2,
  'electron/preload/preload.ts': 3,
  'electron/preview/markerConfig.ts': 2,
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
  return FEATURE_FOLDERS.some((folder) => file.startsWith(folder + '/'));
}

/** Lines that reach Design mode's code: an import or require of a designMode path, or a path string naming its files. */
const REACHES = /designMode\/|DesignModeHost|designModeRenderPlugin|listenForDesignModeRequests|isDesignModeSandbox/;

test('only the listed integration points reach Design mode from outside its folders', () => {
  assert.ok(REACHES.test("import { DesignModeHost } from '../designMode/DesignModeHost';"), 'the pattern sees an import');
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

/** Modules outside the feature its renderer code may import, by path from src/ or shared/. */
const RENDERER_IMPORTS_ALLOWED = new Set([
  'react',
  'shared/designMode/designModeContract',
  'shared/designMode/designIds',
  'shared/core/i18n/locales',
  'shared/ipc/aiChat',
  'shared/page/pageNode',
  'shared/properties/ai/aiLimits',
  'src/app/App',
  'src/editor/canvasQuery',
  'src/editor/pageView',
  'src/features/ai/aiBridge',
  'src/features/ai/aiStore',
  'src/features/ai/screenshot/draftAttachments',
  'src/features/style/components/ColorSwatch',
  'src/features/ai/panelModes',
  'src/app/railShortcuts',
  'src/ipc/useProjectBreakpoints',
  'src/lib/breakpointLabel',
  'src/lib/i18n/useTranslate',
  'src/ui/busyLock',
  'src/ui/central/CentralIcon',
  'src/ui/central/centralGeometry',
  'src/ui/Dropdown',
  'src/ui/Menu',
  'src/ui/PanelBoundary',
  'src/ui/SegmentedControl',
  'src/ui/Switch',
  'src/ui/TipAnchor',
]);

/** Named imports limited to read-only members of a module that also has others. */
const NAMED_ONLY: Readonly<Record<string, readonly string[]>> = {
  'src/features/ai/aiBridge': ['aiScreenshot'],
  'src/features/ai/panelModes': ['registerPanelMode'],
  'src/app/railShortcuts': ['PREVIEW_SHORTCUT', 'isPullChord', 'railActionOf'],
  'src/editor/canvasQuery': ['hasCanvas', 'tellCanvas'],
  'src/app/App': ['ShellView'],
};

const IMPORT = /^import\s+(?:type\s+)?([\s\S]*?)\s+from\s+'([^']+)';/gm;

function importsOf(file: string): readonly { readonly names: string; readonly target: string }[] {
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
  return [...text.matchAll(IMPORT)].map((match) => {
    const specifier = match[2] ?? '';
    const target = specifier.startsWith('.')
      ? path
          .relative(ROOT, path.resolve(path.dirname(path.join(ROOT, file)), specifier))
          .split(path.sep)
          .join('/')
      : specifier;
    return { names: match[1] ?? '', target: target.replace(/\.(ts|tsx|css)$/, '') };
  });
}

test("Design mode's renderer imports only sandbox-safe modules, and no member of them that writes", () => {
  assert.equal(importsOf('src/app/designMode/DesignModeHost.tsx').length > 5, true, 'the import pattern reads the host');
  const files = sourceFiles().filter((file) => file.startsWith('src/app/designMode/') && /\.tsx?$/.test(file));
  assert.ok(files.length > 10);
  for (const file of files) {
    for (const { names, target } of importsOf(file)) {
      if (target.startsWith('src/app/designMode/') || target.endsWith('.css') || target.startsWith('src/app/designMode')) {
        continue;
      }
      assert.ok(RENDERER_IMPORTS_ALLOWED.has(target), `${file} imports ${target}, which is not on the sandbox list`);
      const only = NAMED_ONLY[target];
      if (only !== undefined) {
        const named = names
          .replace(/[{}]/g, '')
          .split(',')
          .map((name) => name.replace(/^type\s+/, '').trim())
          .filter((name) => name !== '');
        for (const name of named) {
          assert.ok(only.includes(name), `${file} imports ${name} from ${target}`);
        }
      }
    }
  }
});

test('Design mode calls no preload method but the menu listener, fetches nothing itself, and never saves breakpoints', () => {
  const files = sourceFiles().filter((file) => file.startsWith('src/app/designMode/'));
  const avb = /window\.avb\.(\w+)/g;
  assert.deepEqual(
    [...'window.avb.pageEdit('.matchAll(avb)].map((match) => match[1]),
    ['pageEdit'],
    'the pattern sees a preload call',
  );
  for (const file of files) {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    for (const match of text.matchAll(avb)) {
      assert.equal(match[1], 'onMenu', `${file} calls window.avb.${match[1] ?? ''}`);
    }
    assert.doesNotMatch(text, /\bfetch\(|XMLHttpRequest|\.save\(|ipcRenderer/, `${file} reaches a channel of its own`);
  }
  const relay = fs.readFileSync(path.join(ROOT, 'electron/preload/designMode/designModeFrame.ts'), 'utf8');
  const relayed = [...relay.matchAll(/await relayed\(request\.nonce, ([^,]+),/g)].map((match) => match[1]);
  assert.deepEqual(relayed, ['DESIGN_RENDER_ROUTE', "'/__avb/preview?' + query.toString()"], 'the frame relays the two read-only routes only');
});

test('the app hands Design mode a read-only view', () => {
  const host = fs.readFileSync(path.join(ROOT, 'src/app/designMode/DesignModeHost.tsx'), 'utf8');
  const picked = /Pick<\s*ShellView,\s*([^>]+)>/.exec(host)?.[1] ?? '';
  const names = [...picked.matchAll(/'(\w+)'/g)].map((match) => match[1]).sort();
  assert.deepEqual(names, [
    'currentPage',
    'devUrl',
    'leftTab',
    'pageState',
    'pageUrlPath',
    'project',
    'scan',
    'selectedId',
    'setLeftTab',
    'setSelectedId',
    'showToast',
  ]);
});

/** The Modes menu and comment pins: what Design mode shares a menu with, and must be able to leave behind. */
const SHARED_WITH = ['src/features/ai/panelModes.ts', 'src/features/ai/sessions/ModesMenu.tsx', 'src/app/shell/DesktopPins.tsx'];

test('the Modes menu and comment pins know nothing of Design mode', () => {
  const names = /design ?mode|designMode/i;
  assert.ok(names.test('registerPanelMode(DESIGN_MODE)') === false && names.test('Design mode'), 'the pattern sees the name');
  const files = [...SHARED_WITH, ...sourceFiles().filter((file) => file.startsWith('src/features/ai/pins/'))];
  assert.ok(files.length > SHARED_WITH.length, 'the pins folder is read');
  for (const file of files) {
    assert.doesNotMatch(fs.readFileSync(path.join(ROOT, file), 'utf8'), names, file);
  }
});

test("the palette letters Design mode keeps from the editor are the editor's", () => {
  const read = (file: string, pattern: RegExp): readonly string[] =>
    [...(pattern.exec(fs.readFileSync(path.join(ROOT, file), 'utf8'))?.[1] ?? '').matchAll(/'(\w)'/g)].map((match) => match[1] ?? '').sort();
  const editor = read('src/app/model/appKeys.ts', /INSERT_PALETTE_KEYS[^=]*= new Set\(\[([^\]]*)\]\)/);
  assert.ok(editor.length > 0, "the editor's list is read");
  assert.deepEqual(read('src/app/designMode/model/designCoveredKeys.ts', /DESIGN_PALETTE_LETTERS[^=]*= \[([^\]]*)\]/), editor);
});
