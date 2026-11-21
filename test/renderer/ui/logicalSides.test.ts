// Goal: the interface lays out right to left for Arabic and Hebrew (docs/i18n.md, "Direction") without a second stylesheet. The
// document root takes `dir="rtl"` from the locale list, and every horizontal side in the interface's CSS is logical
// (`margin-inline-start`, `inset-inline-end`, `text-align: start`), so the same rule is right in both directions. A physical
// `margin-left` written tomorrow would look fine in English and break only in Arabic, where nobody on the team looks, so this
// test is the one place that sees it.
// Method: scan every stylesheet and TypeScript style object under src, studio/src and studio/demo (the same file walk as the
// scroll-gutter test) for physical horizontal declarations: margin, padding and border sides, `left`/`right` offsets, corner
// radii by side, `text-align` and `float` left or right, and their camelCase forms in style objects. A declaration that must stay
// physical (placed from measured screen coordinates, the macOS traffic-light inset, anything drawn over the user's own page,
// code that is forced left to right) carries a `physical:` comment on its line with a reason of at least three words; the
// reason sits next to the code it excuses, so parallel work never edits one shared list. Negative space: the scanner itself is
// tested on text that must be found and text that must not (logical properties, comments, `left` as a value, `scroll-left`).
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { FILE_BYTES_MAX, listScanFiles } from '../../helpers/scrollGutter.ts';

// The runner starts every suite at the repository root.
const REPOSITORY = process.cwd();
const SCAN_ROOTS = ['src', 'studio/src', 'studio/demo'] as const;
const FINDINGS_SHOWN_MAX = 40;
const REASON_WORDS_MIN = 3;
const FILES_MIN = 100;

const CSS_PHYSICAL =
  /(?:^|[;{\s])(?:(?:margin|padding|border)-(?:left|right)(?:-[a-z]+)?|left|right|border-(?:top|bottom)-(?:left|right)-radius)\s*:|text-align\s*:\s*(?:left|right)\b|float\s*:\s*(?:left|right)\b/;
const SCRIPT_PHYSICAL =
  /\b(?:margin|padding|border)(?:Left|Right)[A-Za-z]*\s*:|\bborder(?:Top|Bottom)(?:Left|Right)Radius\s*:|textAlign\s*:\s*['"](?:left|right)['"]|float\s*:\s*['"](?:left|right)['"]/;
const MARKER = /physical:\s*([^*\n]*)/;

interface Finding {
  readonly file: string;
  readonly line: number;
  readonly text: string;
  /** Why the finding fails: no marker, or a marker without a real reason. */
  readonly problem: 'unmarked' | 'reason-too-short';
}

/** The physical declarations in one file's text that carry no reasoned `physical:` marker. */
function scanSides(file: string, source: string): readonly Finding[] {
  assert(source.length <= FILE_BYTES_MAX, `scanSides: ${file} is within the scan bound`);
  const isScript = file.endsWith('.ts') || file.endsWith('.tsx');
  const findings: Finding[] = [];
  let insideComment = false;
  for (const [index, line] of source.split('\n').entries()) {
    let code = line;
    if (isScript) {
      code = code.replace(/\/\/.*$/, '');
    } else {
      if (insideComment) {
        const end = code.indexOf('*/');
        if (end < 0) {
          continue;
        }
        code = code.slice(end + 2);
        insideComment = false;
      }
      code = code.replace(/\/\*[\s\S]*?\*\//g, '');
      const opened = code.indexOf('/*');
      if (opened >= 0) {
        insideComment = true;
        code = code.slice(0, opened);
      }
    }
    const physical = isScript ? SCRIPT_PHYSICAL.test(code) : CSS_PHYSICAL.test(code);
    if (physical) {
      const marker = MARKER.exec(line);
      if (marker === null) {
        findings.push({ file, line: index + 1, text: line.trim(), problem: 'unmarked' });
      } else {
        const words = (marker[1] ?? '')
          .trim()
          .split(/\s+/)
          .filter((word) => word.length > 0);
        if (words.length < REASON_WORDS_MIN) {
          findings.push({ file, line: index + 1, text: line.trim(), problem: 'reason-too-short' });
        }
      }
    }
  }
  return findings;
}

test('the scanner finds physical sides and nothing else', () => {
  const found = (file: string, text: string): number => scanSides(file, text).length;
  for (const bad of [
    '.a { margin-left: 4px; }',
    '.a {\n  padding-right: 2px;\n}',
    '.a { left: 0; }',
    '.a { border-left-color: red; }',
    '.a { border-top-right-radius: 4px; }',
    '.a { text-align: right; }',
    '.a { float: left; }',
    '.a{right:0}',
  ]) {
    assert.equal(found('x.css', bad), 1, bad);
  }
  for (const bad of ['const s = { marginLeft: 4 };', "style={{ paddingRight: '2px' }}", "{ textAlign: 'left' }", '{ borderTopLeftRadius: 4 }']) {
    assert.equal(found('x.tsx', bad), 1, bad);
  }
  for (const good of [
    '.a { margin-inline-start: 4px; }',
    '.a { inset-inline: 0; }',
    '.a { text-align: start; }',
    '.a { transform-origin: left; }',
    '.a { background-position: left center; }',
    '.a { scroll-padding-inline-start: 0; }',
    '/* margin-left: 4px; */',
    '/*\n  left: 0;\n*/',
    '.a { left: 0; } /* physical: placed from the pointer position */',
  ]) {
    assert.equal(found('x.css', good), 0, good);
  }
  for (const good of [
    '{ marginInlineStart: 4 }',
    '// marginLeft: 4',
    '{ left: x }',
    "{ textAlign: 'start' }",
    '{ marginLeft: 4 } // physical: aligned to the measured rectangle',
  ]) {
    assert.equal(found('x.tsx', good), 0, good);
  }
  assert.deepEqual(
    scanSides('x.css', '.a { left: 0; } /* physical: why */').map((finding) => finding.problem),
    ['reason-too-short'],
  );
});

test('every horizontal side in the interface is logical, or says why it is physical', () => {
  const files = listScanFiles(REPOSITORY, SCAN_ROOTS);
  assert.ok(files.length >= FILES_MIN, `the scan reached the interface (${files.length} files)`);
  const findings: Finding[] = [];
  for (const file of files) {
    const absolute = path.join(REPOSITORY, file);
    if (statSync(absolute).size > FILE_BYTES_MAX) {
      continue;
    }
    findings.push(...scanSides(file, readFileSync(absolute, 'utf8')));
  }
  assert.deepEqual(
    findings.slice(0, FINDINGS_SHOWN_MAX).map((finding) => `${finding.file}:${finding.line} ${finding.problem}: ${finding.text}`),
    [],
    'use margin-inline-start, padding-inline-end, inset-inline-start, text-align: start; or mark the line /* physical: <reason> */',
  );
});
