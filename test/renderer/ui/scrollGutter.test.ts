// Goal: no scroll container in the app can move its content sideways when its scrollbar appears or disappears (docs/scroll-gutter.md).
// The app draws an 8px classic scrollbar (`::-webkit-scrollbar` in src/app/styles.css), which takes layout space, so a list that grew
// past its height narrowed its content by 8px and everything re-wrapped; the Properties panel did exactly that when a conditional
// option opened. `scrollbar-gutter: stable` reserves the bar's room whether or not the bar shows. CSS cannot select an element by
// its computed overflow, and a universal gutter rule is wrong because it also narrows hidden-overflow elements by 8px (checked in
// Chromium), so each rule that makes a scroll container carries the declaration and this test fails for the rule that forgets.
// Method: scan every stylesheet and TypeScript style object under src, shared, studio/src and studio/demo (test/helpers/scrollGutter.ts)
// for overflow auto, scroll or overlay, and require a stable gutter in the same block. Exempt by construction: a block that scrolls
// only horizontally with its vertical axis hidden (the gutter is the vertical bar's room), and a block that hides its bar with
// `scrollbar-width: none`. Everything else needs an entry in test/helpers/scrollGutterAllowlist.json with a reason, and an entry that
// no longer matches fails, so none outlives its cause. The two browser-made scroll containers, textarea and CodeMirror's scroller, are
// held by one shared rule in controls.css. Negative space: the scanner itself is tested on valid and invalid text, including
// `text-overflow`, comments, shorthand, camelCase and an `@media` block.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { SCAN_ROOTS, declaresGutterInText, listScanFiles, scanRepository, scanText, scriptAssignsOverflow } from '../../helpers/scrollGutter.ts';

// The runner starts every suite at the repository root.
const REPOSITORY = process.cwd();
const REASON_LENGTH_MIN = 30;

interface Exception {
  readonly file: string;
  readonly locator: string;
  readonly reason: string;
}

function parseExceptions(input: unknown): readonly Exception[] {
  assert(typeof input === 'object', 'allowlist: expected an object');
  assert(input !== null, 'allowlist: expected an object, not null');
  const list: unknown = Reflect.get(input, 'exceptions');
  assert(Array.isArray(list), 'allowlist: exceptions is an array');
  assert(list.length <= 64, 'allowlist: at most 64 exceptions; fix the rule instead of listing it');
  const parsed: Exception[] = [];
  for (const [index, entry] of list.entries()) {
    assert(typeof entry === 'object', `allowlist[${index}]: expected an object`);
    assert(entry !== null, `allowlist[${index}]: expected an object, not null`);
    const file: unknown = Reflect.get(entry, 'file');
    const locator: unknown = Reflect.get(entry, 'locator');
    const reason: unknown = Reflect.get(entry, 'reason');
    assert(typeof file === 'string', `allowlist[${index}].file: expected a path`);
    assert(file.length > 0, `allowlist[${index}].file: expected a path`);
    assert(typeof locator === 'string', `allowlist[${index}].locator: expected a selector or declaration`);
    assert(locator.length > 0, `allowlist[${index}].locator: expected a selector or declaration`);
    assert(typeof reason === 'string', `allowlist[${index}].reason: say why`);
    assert(reason.length >= REASON_LENGTH_MIN, `allowlist[${index}].reason: say why, in at least ${REASON_LENGTH_MIN} characters`);
    parsed.push({ file, locator, reason });
  }
  return parsed;
}

const exceptions = parseExceptions(JSON.parse(readFileSync(path.join(REPOSITORY, 'test/helpers/scrollGutterAllowlist.json'), 'utf8')));

function isException(file: string, locator: string): boolean {
  return exceptions.some((entry) => entry.file === file && entry.locator === locator);
}

test('every scroll container keeps a stable scrollbar gutter', () => {
  const containers = scanRepository(REPOSITORY, SCAN_ROOTS);
  assert(containers.length > 100, `the scan found ${containers.length} scroll containers; the app has well over a hundred, so the scan is broken`);
  const failing = containers.filter((container) => !container.gutterStable && !container.horizontalOnly && !container.barHidden);
  const unexplained = failing.filter((container) => !isException(container.file, container.locator));
  assert.deepEqual(
    unexplained.map((container) => `${container.file}:${container.line} ${container.locator} (${container.axes.join('')})`),
    [],
    'add `scrollbar-gutter: stable;` to each rule (docs/scroll-gutter.md), or list a justified exception in test/helpers/scrollGutterAllowlist.json',
  );
  for (const entry of exceptions) {
    const matched = failing.some((container) => container.file === entry.file && container.locator === entry.locator);
    assert(matched, `stale exception ${entry.file} ${entry.locator}: it no longer names a scroll container without a gutter; delete it`);
  }
});

test('scripts that set an overflow style declare the gutter in the same file', () => {
  const missing: string[] = [];
  for (const file of listScanFiles(REPOSITORY, SCAN_ROOTS)) {
    if (/\.tsx?$/.test(file)) {
      const source = readFileSync(path.join(REPOSITORY, file), 'utf8');
      if (scriptAssignsOverflow(source) && !declaresGutterInText(source) && !isException(file, '.style.overflow =')) {
        missing.push(file);
      }
    }
  }
  assert.deepEqual(missing, [], 'a `.style.overflowY = ...` assignment needs `scrollbarGutter: "stable"` on the same element');
});

test('textareas and CodeMirror scrollers are covered by the shared rule in controls.css', () => {
  const source = readFileSync(path.join(REPOSITORY, 'src/ui/controls.css'), 'utf8');
  const rule = /(?:^|\})\s*([^{}]*\.cm-scroller[^{}]*)\{([^{}]*)\}/.exec(source.replace(/\/\*[\s\S]*?\*\//g, ''));
  assert(rule !== null, 'controls.css has a rule for .cm-scroller');
  assert(/(^|,)\s*textarea\s*(,|$)/.test(rule[1] ?? ''), 'the same rule names textarea');
  assert(/scrollbar-gutter\s*:\s*stable/.test(rule[2] ?? ''), 'and it keeps a stable gutter');
});

test('no rule applies a gutter to every element', () => {
  // A universal gutter also narrows `overflow: hidden` elements by the bar's width (verified in Chromium), which would move every clipped box.
  const offenders: string[] = [];
  for (const file of listScanFiles(REPOSITORY, SCAN_ROOTS)) {
    if (file.endsWith('.css')) {
      const source = readFileSync(path.join(REPOSITORY, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      if (/(?:^|[}\n,])[ \t]*(?:\*|:where\(\s*\*\s*\)|html|body)\s*\{[^{}]*scrollbar-gutter/.test(source)) {
        offenders.push(file);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test('scanner: what it reads as a scroll container', () => {
  const scan = (text: string) => scanText('fixture.css', text);
  assert.equal(scan('.a { overflow: auto; }').length, 1);
  assert.equal(scan('.a { overflow-y: scroll; }').length, 1);
  assert.equal(scan('.a { overflow: overlay; }').length, 1);
  assert.equal(scan('.a { overflow: hidden auto; }')[0]?.axes.join(''), 'y');
  assert.equal(scan('.a { overflow: auto hidden; }')[0]?.horizontalOnly, true);
  assert.equal(scan('.a { overflow-x: auto; }')[0]?.horizontalOnly, false, 'x alone leaves y to compute as auto');
  assert.equal(scan('.a { overflow-x: auto; overflow-y: hidden; }')[0]?.horizontalOnly, true);
  assert.equal(scan('.a { overflow: hidden; overflow-y: auto; }')[0]?.axes.join(''), 'y', 'a later longhand wins');
  assert.equal(scan('.a { overflow: auto; scrollbar-width: none; }')[0]?.barHidden, true);
  assert.equal(scan('@media (min-width: 1px) {\n  .a {\n    overflow-y: auto;\n    scrollbar-gutter: stable;\n  }\n}')[0]?.gutterStable, true);
  assert.equal(scan('.a { overflow: auto; scrollbar-gutter: stable both-edges; }')[0]?.gutterStable, true);
});

test('scanner: what it must not read as a scroll container, or as a gutter', () => {
  const scan = (text: string) => scanText('fixture.css', text);
  assert.deepEqual(scan('.a { overflow: hidden; text-overflow: ellipsis; }'), []);
  assert.deepEqual(scan('.a { overflow: visible; overflow-x: clip; }'), []);
  assert.deepEqual(scan('/* .a { overflow: auto; } */ .b { color: red; }'), []);
  assert.deepEqual(scan('.a { overscroll-behavior: contain; }'), []);
  assert.equal(scan('.a { overflow: auto; scrollbar-gutter: auto; }')[0]?.gutterStable, false);
  assert.equal(scan('.a { overflow: auto; } .b { scrollbar-gutter: stable; }')[0]?.gutterStable, false, 'a gutter on another rule does not count');
  assert.equal(scan('.a { overflow: auto; /* scrollbar-gutter: stable; */ }')[0]?.gutterStable, false, 'a comment does not count');
});

test('scanner: style objects in TypeScript', () => {
  const scan = (text: string) => scanText('fixture.tsx', text);
  assert.equal(scan("const s = { maxHeight: 10, overflowY: 'auto' };")[0]?.gutterStable, false);
  assert.equal(scan("const s = { maxHeight: 10, overflowY: 'auto', scrollbarGutter: 'stable' };")[0]?.gutterStable, true);
  assert.deepEqual(scan("const s = { overflowX: 'hidden' };"), []);
  assert.equal(scriptAssignsOverflow("element.style.overflowY = 'auto';"), true);
  assert.equal(scriptAssignsOverflow('// element.style.overflowY = x;'), false);
});
