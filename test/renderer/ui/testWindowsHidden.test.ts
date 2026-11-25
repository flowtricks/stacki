// Goal: no test, probe or gate script ever puts a window on the owner's screen. A gate run is
// background work; the style soak once opened a visible red Card window each time it ran, and
// took focus from whatever the owner was typing in.
// Method: two layers. (1) A source scan of test/ and scripts/ rejects a window created with
// `show: true` and a call to `showInactive` or `app.focus`, unless test/helpers/visibleWindowAllowlist.json
// names the file with a reason (an entry that no longer matches fails, so none outlives its cause).
// (2) `installWindowHiding` (test/helpers/hideWindows.js, loaded by every gate Electron process) is run
// against a fake electron: every created window becomes transparent and click-through, show and
// showInactive move it beyond the display and never activate it, focus does nothing, and installing
// twice patches once. Negative space: the scanner is tested on matching and non-matching text.
// No timing is involved: everything is synchronous.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';

const REPOSITORY = process.cwd();
const SCAN_ROOTS = ['test', 'scripts'] as const;
const SCAN_FILES_MAX = 20000;
const REASON_LENGTH_MIN = 30;
// Built from parts so this file does not match its own scan.
const FORBIDDEN: ReadonlyArray<{ readonly name: string; readonly pattern: RegExp }> = [
  { name: 'a window created shown', pattern: new RegExp('BrowserWindow\\([\\s\\S]{0,400}?show' + ':\\s*true') },
  { name: 'showInactive on a real window', pattern: new RegExp('\\.show' + 'Inactive\\(') },
  { name: 'app focus stealing', pattern: new RegExp('app\\.' + 'focus\\(') },
];
const SELF = 'test/renderer/ui/testWindowsHidden.test.ts';
const HELPER = 'test/helpers/hideWindows.js';

function findViolations(text: string): readonly string[] {
  return FORBIDDEN.filter((rule) => rule.pattern.test(text)).map((rule) => rule.name);
}

// Iterative on purpose: a directory stack with a stated file bound, not recursion (AGENTS.md section 10).
function listFiles(root: string): readonly string[] {
  const found: string[] = [];
  const pending: string[] = [root];
  for (let step = 0; step < SCAN_FILES_MAX; step += 1) {
    const directory = pending.pop();
    if (directory === undefined) {
      return found;
    }
    for (const name of readdirSync(path.join(REPOSITORY, directory))) {
      if (name === 'node_modules' || name.startsWith('.')) {
        continue;
      }
      const relative = `${directory}/${name}`;
      if (statSync(path.join(REPOSITORY, relative)).isDirectory()) {
        pending.push(relative);
      } else if (/\.(js|cjs|mjs|ts|mts|tsx)$/.test(name)) {
        found.push(relative);
      }
    }
  }
  throw new Error('scan: more directories than the stated limit');
}

function parseAllowlist(input: unknown): ReadonlyMap<string, string> {
  assert(typeof input === 'object', 'allowlist: expected an object');
  assert(input !== null, 'allowlist: expected an object, not null');
  const list: unknown = Reflect.get(input, 'exceptions');
  assert(Array.isArray(list), 'allowlist: exceptions is an array');
  assert(list.length <= 16, 'allowlist: at most 16 exceptions');
  const parsed = new Map<string, string>();
  for (const entry of list) {
    assert(typeof entry === 'object', 'allowlist: entry is an object');
    assert(entry !== null, 'allowlist: entry is an object, not null');
    const file: unknown = Reflect.get(entry, 'file');
    const reason: unknown = Reflect.get(entry, 'reason');
    assert(typeof file === 'string', 'allowlist: file is a path');
    assert(file.length > 0, 'allowlist: file is a path');
    assert(typeof reason === 'string', 'allowlist: say why');
    assert(reason.length >= REASON_LENGTH_MIN, `allowlist: say why, in at least ${REASON_LENGTH_MIN} characters`);
    parsed.set(file, reason);
  }
  return parsed;
}

test('no test or script opens a window on the screen', () => {
  const rawAllowlist: unknown = JSON.parse(readFileSync(path.join(REPOSITORY, 'test/helpers/visibleWindowAllowlist.json'), 'utf8'));
  const allowed = parseAllowlist(rawAllowlist);
  const files = SCAN_ROOTS.flatMap((root) => listFiles(root));
  const offenders: string[] = [];
  const matched = new Set<string>();
  for (const file of files) {
    if (file === SELF || file === HELPER) {
      continue;
    }
    const violations = findViolations(readFileSync(path.join(REPOSITORY, file), 'utf8'));
    if (violations.length > 0) {
      if (allowed.has(file)) {
        matched.add(file);
      } else {
        offenders.push(`${file}: ${violations.join(', ')}`);
      }
    }
  }
  assert.deepEqual(offenders, [], 'windows must stay hidden: use show: false, or list the file in test/helpers/visibleWindowAllowlist.json with a reason');
  assert.deepEqual(
    [...allowed.keys()].filter((file) => !matched.has(file)),
    [],
    'an allowlist entry no longer matches a violation; remove it',
  );
});

test('the scanner flags a shown window and passes a hidden one', () => {
  assert.deepEqual(findViolations('new BrowserWindow({ ' + 'show: true })'), ['a window created shown']);
  assert.deepEqual(findViolations('new BrowserWindow({ show: false })'), []);
  assert.deepEqual(findViolations('app.' + 'focus({ steal: true })'), ['app focus stealing']);
});

interface FakeWindow {
  opacity: number | undefined;
  clickThrough: boolean;
  position: readonly [number, number] | undefined;
  activated: boolean;
  visible: boolean;
}

function fakeElectron() {
  const created: Array<(event: unknown, window: unknown) => void> = [];
  class FakeBrowserWindow {
    public readonly state: FakeWindow = { opacity: undefined, clickThrough: false, position: undefined, activated: false, visible: false };
    public setOpacity(value: number): void {
      this.state.opacity = value;
    }
    public setIgnoreMouseEvents(value: boolean): void {
      this.state.clickThrough = value;
    }
    public setPosition(x: number, y: number): void {
      this.state.position = [x, y];
    }
    public isVisible(): boolean {
      return this.state.visible;
    }
    public show(): void {
      this.state.activated = true;
      this.state.visible = true;
    }
    public showInactive(): void {
      this.state.visible = true;
    }
    public focus(): void {
      this.state.activated = true;
    }
  }
  const app = {
    on(name: string, listener: (event: unknown, window: unknown) => void) {
      assert.equal(name, 'browser-window-created');
      created.push(listener);
    },
  };
  return { electron: { app, BrowserWindow: FakeBrowserWindow }, created, FakeBrowserWindow };
}

test('installWindowHiding hides, parks and never activates a window', () => {
  const require = createRequire(import.meta.url);
  const helper: unknown = require(path.join(REPOSITORY, HELPER));
  assert(typeof helper === 'object', 'hideWindows exports an object');
  assert(helper !== null, 'hideWindows exports an object, not null');
  const installFunction: unknown = Reflect.get(helper, 'installWindowHiding');
  const OFFSCREEN_PX: unknown = Reflect.get(helper, 'OFFSCREEN_PX');
  assert(typeof installFunction === 'function', 'installWindowHiding is exported');
  const installWindowHiding = (target: unknown): boolean => {
    const installed: unknown = Reflect.apply(installFunction, undefined, [target]);
    assert(typeof installed === 'boolean', 'installWindowHiding returns whether it installed');
    return installed;
  };
  assert(typeof OFFSCREEN_PX === 'number', 'OFFSCREEN_PX is exported');
  const { electron, created, FakeBrowserWindow } = fakeElectron();
  assert.equal(installWindowHiding(electron), true);
  assert.equal(installWindowHiding(electron), false, 'a second install patches nothing');
  assert.equal(created.length, 1);
  const window = new FakeBrowserWindow();
  created[0]?.({}, window);
  assert.equal(window.state.opacity, undefined, 'a window that was never shown is left as the test made it');
  window.show();
  assert.equal(window.state.opacity, 0);
  assert.equal(window.state.clickThrough, true);
  assert.equal(window.state.visible, true);
  assert.deepEqual(window.state.position, [OFFSCREEN_PX, OFFSCREEN_PX]);
  window.focus();
  assert.equal(window.state.activated, false, 'neither show nor focus activates the window');
  const created2 = new FakeBrowserWindow();
  created2.state.visible = true;
  created[0]?.({}, created2);
  assert.equal(created2.state.opacity, 0, 'a window created already visible is hidden at once');
  assert.throws(() => installWindowHiding(undefined), /Assertion failed/);
});
