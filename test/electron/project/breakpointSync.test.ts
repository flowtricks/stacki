// Goal: syncing a changed breakpoint finds the media queries that equal its old value in every file kind, writes only the checked
// places and only the number token, never on a scan, never into a file that moved, and remembers what was unchecked.
// Method: build throwaway fixture projects in the temp directory (never a real project): a stylesheet with CRLF line endings, a page
// whose frontmatter and template mention `@media` as text, a minified component, an HTML file, and folders that must be skipped
// (node_modules, dist, a .gitignore'd folder). Scan, then apply and compare disk bytes with the expected text; change a file between
// scan and apply (stale); make a write fail (rollback); repeat a sync to see exclusions honoured; undo and redo through the journal;
// check Lumos conversion and the scan's size bound.
import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { applyBreakpointSync, restoreBreakpointSync, scanBreakpointSync, scanBreakpointUsage } from '#dist/electron/project/breakpointSync.js';
import { parseBreakpointSyncSource, serializeBreakpointSyncRecord, EMPTY_SYNC_RECORD, entryOf } from '#dist/shared/properties/breakpointSyncRecord.js';
import { applyRequest, initialChecked, recordWithChoices } from '#dist/shared/properties/breakpointSyncSelection.js';
import type { BreakpointSyncScan } from '#dist/shared/properties/breakpointSyncPlan.js';
import type { BreakpointSetting } from '#dist/shared/properties/projectBreakpoints.js';

const OLD: BreakpointSetting = { value: 64, unit: 'rem' };
const NEXT: BreakpointSetting = { value: 70, unit: 'rem' };

const SITE_CSS =
  '/* @media (min-width: 64rem) is only a comment */\r\n' +
  '@media (min-width: 64rem) {\r\n\t.a { color: red; }\r\n}\r\n' +
  '@media only screen and (max-width: 64rem) {\r\n\t.b { color: blue; }\r\n}\r\n' +
  '@media (max-width: 1023px) {\r\n\t.c { color: green; }\r\n}\r\n' +
  '@media (width >= 65rem) {\r\n\t.d { color: pink; }\r\n}\r\n' +
  '.e::after { content: "@media (min-width: 64rem)"; }\r\n';

const PAGE =
  '---\nconst note = "@media (min-width: 64rem) { }";\n---\n' +
  '<p>@media (min-width: 64rem) in text</p>\n' +
  '<style>\n  .p { color: red; }\n  @media (width < 64rem) {\n    .p { color: blue; }\n  }\n</style>\n';

const COMPONENT = '<div class="card"></div>\n<style>@media(min-width:64rem){.card{padding:1rem}}.x{y:z}@media (max-width:64rem){.card{padding:0}}</style>\n';

const HTML = '<!doctype html>\n<style>\n@media (min-width: 1024px) { a { color: red } }\n</style>\n<script>const s = "@media (min-width: 64rem)";</script>\n';

function fixture(options: { readonly lumos?: boolean } = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-bp-sync-'));
  const write = (rel: string, text: string): void => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  write('src/styles/site.css', SITE_CSS);
  write('src/pages/index.astro', PAGE);
  write('src/components/Card.astro', COMPONENT);
  write('public/legacy.html', HTML);
  write('node_modules/lib/a.css', '@media (min-width: 64rem) { a { color: red } }');
  write('dist/out.css', '@media (min-width: 64rem) { a { color: red } }');
  write('generated/g.css', '@media (min-width: 64rem) { a { color: red } }');
  write('.gitignore', 'generated/\n');
  if (options.lumos === true) {
    write('LUMOS.md', '# Lumos\n');
  }
  return root;
}

const read = (root: string, rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');
function savedRecord(root: string) {
  const parsed = parseBreakpointSyncSource(read(root, '.stacki/breakpoint-sync.json'));
  assert.equal(parsed.ok, true);
  assert.ok(parsed.ok);
  return parsed.value;
}
const key = (rel: string, locator: string): string => `${rel}\0${locator}`;

async function scanOf(root: string, next: BreakpointSetting = NEXT, old: BreakpointSetting = OLD): Promise<BreakpointSyncScan> {
  return scanBreakpointSync(root, { key: 'laptop', old: { direction: 'down', setting: old }, next });
}

test('the scan lists every place in every kind of file, skips what is not the project, and writes nothing', async () => {
  const root = fixture();
  const before = ['src/styles/site.css', 'src/pages/index.astro', 'src/components/Card.astro', 'public/legacy.html'].map((rel) => read(root, rel));
  const scan = await scanOf(root);
  assert.deepEqual(
    scan.files.map((file) => [file.rel, file.kind, file.occurrences.length]),
    [
      ['public/legacy.html', 'style', 1],
      ['src/components/Card.astro', 'component', 2],
      ['src/pages/index.astro', 'page', 1],
      ['src/styles/site.css', 'css', 3],
    ],
  );
  assert.equal(scan.lumos, false);
  assert.equal(scan.truncated, false);
  const css = scan.files.find((file) => file.rel === 'src/styles/site.css');
  assert.deepEqual(
    css?.occurrences.map((place) => [place.line, place.before, place.after, place.reason, place.checked]),
    [
      [2, '64rem', '70rem', 'exact', true],
      [5, '64rem', '70rem', 'exact', true],
      [8, '1023px', '1119px', 'inclusive', false],
    ],
  );
  assert.deepEqual(
    ['src/styles/site.css', 'src/pages/index.astro', 'src/components/Card.astro', 'public/legacy.html'].map((rel) => read(root, rel)),
    before,
    'scanning writes nothing',
  );
  assert.equal(fs.existsSync(path.join(root, '.stacki')), false, 'not even the record');
  // The HTML file's px bound is the same boundary in the other unit, and is written as the new breakpoint was typed.
  assert.equal(scan.files[0]?.occurrences[0]?.after, '70rem');
});

test('applying writes only the checked tokens, byte for byte, and remembers the unchecked place', async () => {
  const root = fixture();
  const scan = await scanOf(root);
  const checked = initialChecked(scan);
  const result = applyBreakpointSync(root, applyRequest(root, 'laptop', scan, checked));
  assert.equal(result.ok, true);
  assert.equal(result.files, 4);
  assert.equal(result.places, 6);
  assert.deepEqual(result.skipped, []);
  assert.equal(
    read(root, 'src/styles/site.css'),
    SITE_CSS.replace('(min-width: 64rem) {', '(min-width: 70rem) {').replace('(max-width: 64rem) {', '(max-width: 70rem) {'),
  );
  assert.equal(read(root, 'src/pages/index.astro'), PAGE.replace('(width < 64rem)', '(width < 70rem)'), 'frontmatter and template text are untouched');
  assert.equal(
    read(root, 'src/components/Card.astro'),
    COMPONENT.replace('(min-width:64rem)', '(min-width:70rem)').replace('(max-width:64rem)', '(max-width:70rem)'),
  );
  assert.equal(read(root, 'public/legacy.html'), HTML.replace('(min-width: 1024px)', '(min-width: 70rem)'), 'the script string is untouched');
  assert.ok(read(root, 'src/styles/site.css').includes('(max-width: 1023px)'), 'the unchecked inclusive form stays');
  const record = entryOf(savedRecord(root), 'laptop');
  assert.deepEqual(
    record.excluded.map((ref) => ref.file),
    ['src/styles/site.css'],
  );
  assert.equal(record.linked.length, 6);
  assert.match(record.appliedAt ?? '', /^\d{4}-\d{2}-\d{2}T/);
});

test('a file that changed since the scan is skipped and reported; the others are written', async () => {
  const root = fixture();
  const scan = await scanOf(root);
  fs.appendFileSync(path.join(root, 'src/pages/index.astro'), '<!-- edited meanwhile -->\n');
  const result = applyBreakpointSync(root, applyRequest(root, 'laptop', scan, initialChecked(scan)));
  assert.equal(result.ok, true);
  assert.deepEqual(result.skipped, [{ rel: 'src/pages/index.astro', reason: 'stale' }]);
  assert.equal(result.files, 3);
  assert.ok(read(root, 'src/pages/index.astro').includes('(width < 64rem)'));
  assert.ok(read(root, 'src/styles/site.css').includes('(min-width: 70rem)'));
});

test('a place whose text is not what the scan saw is refused, not guessed at', async () => {
  const root = fixture();
  const scan = await scanOf(root);
  const request = applyRequest(root, 'laptop', scan, initialChecked(scan));
  const forged = {
    ...request,
    files: request.files.map((file) => ({ ...file, edits: file.edits.map((edit) => ({ ...edit, start: edit.start + 1, end: edit.end + 1 })) })),
  };
  const result = applyBreakpointSync(root, forged);
  assert.equal(result.files, 0);
  assert.ok(result.skipped.every((entry) => entry.reason === 'mismatch'));
  assert.ok(read(root, 'src/styles/site.css') === SITE_CSS);
});

test('nothing checked writes no file', async () => {
  const root = fixture();
  const scan = await scanOf(root);
  const result = applyBreakpointSync(root, applyRequest(root, 'laptop', scan, new Set()));
  assert.equal(result.files, 0);
  assert.equal(read(root, 'src/styles/site.css'), SITE_CSS);
});

test('a failed write puts back the files already written', async () => {
  const root = fixture();
  const scan = await scanOf(root);
  // Files are written in the scan's order (public, components, pages, styles); the last one cannot be written.
  const locked = path.join(root, 'src/styles');
  const originals = new Map(scan.files.map((file) => [file.rel, read(root, file.rel)]));
  fs.chmodSync(locked, 0o555);
  fs.chmodSync(path.join(root, 'src/styles/site.css'), 0o444);
  try {
    const result = applyBreakpointSync(root, applyRequest(root, 'laptop', scan, initialChecked(scan)));
    if (result.ok) {
      // The platform let the write through (running with elevated rights): nothing to roll back.
      return;
    }
    assert.equal(result.files, 0);
    for (const [rel, text] of originals) {
      assert.equal(read(root, rel), text, `${rel} is back as it was`);
    }
  } finally {
    fs.chmodSync(locked, 0o755);
    fs.chmodSync(path.join(root, 'src/styles/site.css'), 0o644);
  }
});

test('unchecked places are remembered and listed as not synced on the next change, even though they no longer hold the old value', async () => {
  const root = fixture();
  const first = await scanOf(root);
  const checked = new Set(initialChecked(first));
  const hero = first.files.find((file) => file.rel === 'src/styles/site.css');
  assert.ok(hero?.occurrences[1]);
  checked.delete(key(hero.rel, hero.occurrences[1].locator));
  applyBreakpointSync(root, applyRequest(root, 'laptop', first, checked));
  assert.ok(read(root, 'src/styles/site.css').includes('(max-width: 64rem)'), 'the unchecked exact place keeps the old value');
  // 70rem -> 80rem: the checked places hold 70rem now, the remembered one still holds 64rem.
  const second = await scanOf(root, { value: 80, unit: 'rem' }, { value: 70, unit: 'rem' });
  const css = second.files.find((file) => file.rel === 'src/styles/site.css');
  const remembered = css?.occurrences.filter((place) => place.excluded) ?? [];
  assert.equal(remembered.length, 2, 'both unchecked places (the inclusive form and the exact one) are remembered');
  assert.ok(
    remembered.every((place) => !place.checked),
    'and start unchecked',
  );
  assert.deepEqual(
    css?.occurrences.filter((place) => !place.excluded).map((place) => place.before),
    ['70rem'],
  );
  assert.equal(second.recordProblem, undefined);
  // Checking one again writes it and drops it from the remembered list.
  const all = new Set(initialChecked(second));
  const exact = remembered.find((place) => place.before === '64rem');
  assert.ok(exact && css);
  all.add(key(css.rel, exact.locator));
  applyBreakpointSync(root, applyRequest(root, 'laptop', second, all));
  assert.ok(read(root, 'src/styles/site.css').includes('(max-width: 80rem)'));
  assert.equal(entryOf(savedRecord(root), 'laptop').excluded.length, 1, 'only the inclusive form is still left alone');
});

test('a Lumos project is written in rem, a px value converted at 16px per rem', async () => {
  const root = fixture({ lumos: true });
  const scan = await scanOf(root, { value: 1100, unit: 'px' });
  assert.equal(scan.lumos, true);
  const afters = scan.files.flatMap((file) => file.occurrences.map((place) => place.after));
  assert.ok(afters.length > 0);
  assert.ok(
    afters.every((after) => after.endsWith('rem')),
    afters.join(','),
  );
  assert.ok(afters.includes('68.75rem'));
  assert.ok(afters.includes('68.6875rem'), 'the inclusive form is one pixel lower, in rem');
  const plain = await scanOf(fixture(), { value: 1100, unit: 'px' });
  assert.ok(plain.files.flatMap((file) => file.occurrences.map((place) => place.after)).includes('1100px'));
});

test('undo puts every file and the record back, redo writes them again', async () => {
  const root = fixture();
  const scan = await scanOf(root);
  const applied = applyBreakpointSync(root, applyRequest(root, 'laptop', scan, initialChecked(scan)));
  assert.ok(applied.journalId);
  const changed = ['src/styles/site.css', 'src/pages/index.astro', 'src/components/Card.astro', 'public/legacy.html'].map((rel) => read(root, rel));
  const undone = restoreBreakpointSync(root, { journalId: applied.journalId, direction: 'undo' });
  assert.equal(undone.ok, true);
  assert.equal(read(root, 'src/styles/site.css'), SITE_CSS);
  assert.equal(read(root, 'src/pages/index.astro'), PAGE);
  assert.equal(read(root, 'src/components/Card.astro'), COMPONENT);
  assert.equal(read(root, 'public/legacy.html'), HTML);
  assert.equal(read(root, '.stacki/breakpoint-sync.json'), serializeBreakpointSyncRecord(EMPTY_SYNC_RECORD), 'the record is back to nothing');
  const redone = restoreBreakpointSync(root, { journalId: applied.journalId, direction: 'redo' });
  assert.equal(redone.ok, true);
  assert.deepEqual(
    ['src/styles/site.css', 'src/pages/index.astro', 'src/components/Card.astro', 'public/legacy.html'].map((rel) => read(root, rel)),
    changed,
  );
  assert.equal(restoreBreakpointSync(root, { journalId: 'missing', direction: 'undo' }).ok, false);
});

test('a hand-broken record is reported, nothing is remembered, and the file is never written over', async () => {
  const root = fixture();
  fs.mkdirSync(path.join(root, '.stacki'));
  fs.writeFileSync(path.join(root, '.stacki/breakpoint-sync.json'), '{ nope');
  const scan = await scanOf(root);
  assert.match(scan.recordProblem ?? '', /not valid JSON/);
  const checked = new Set(initialChecked(scan));
  const first = scan.files[0];
  assert.ok(first?.occurrences[0]);
  checked.delete(key(first.rel, first.occurrences[0].locator));
  applyBreakpointSync(root, applyRequest(root, 'laptop', scan, checked));
  assert.equal(read(root, '.stacki/breakpoint-sync.json'), '{ nope');
});

test('a file of any size is read in full: nothing is skipped for being big', async () => {
  const root = fixture();
  // Four megabytes of comment, then one place: past the old two-megabyte read bound.
  fs.writeFileSync(path.join(root, 'src/styles/huge.css'), '/* ' + 'x'.repeat(4 * 1024 * 1024) + ' */\n@media (min-width: 64rem) { a { color: red } }\n');
  const scan = await scanOf(root);
  assert.equal(scan.skipped, 0);
  assert.equal(scan.truncated, false);
  assert.equal(scan.files.length, 5);
  const huge = scan.files.find((file) => file.rel === 'src/styles/huge.css');
  assert.equal(huge?.occurrences.length, 1, 'the place after the big comment is found');
});

test('a scan that finds nothing lists nothing', async () => {
  const root = fixture();
  const scan = await scanOf(root, NEXT, { value: 99, unit: 'rem' });
  assert.deepEqual(scan.files, []);
});

const LIST = [
  { id: 'laptop', direction: 'down', setting: { value: 64, unit: 'rem' } },
  { id: 'tablet', direction: 'down', setting: { value: 48, unit: 'rem' } },
  { id: 'phone', direction: 'down', setting: { value: 30, unit: 'rem' } },
] as const;

function usageFixture(): string {
  const root = fixture();
  fs.writeFileSync(
    path.join(root, 'src/styles/small.css'),
    '@media (min-width: 48rem) { .a { color: red } }\n@media (max-width: 30rem) { .b { color: red } }\n@media (min-width: 30rem) { .c { color: red } }\n',
  );
  return root;
}

test('the usage scan counts where every breakpoint is used, per file, and writes nothing', async () => {
  const root = usageFixture();
  const before = fs.readFileSync(path.join(root, 'src/styles/site.css'), 'utf8');
  const usage = await scanBreakpointUsage(root, LIST);
  assert.equal(usage.lumos, false);
  assert.equal(usage.truncated, false);
  const byId = new Map(usage.entries.map((entry) => [entry.id, entry.files.map((file) => [file.rel, file.kind, file.occurrences.length])]));
  assert.deepEqual(byId.get('laptop'), [
    ['public/legacy.html', 'style', 1],
    ['src/components/Card.astro', 'component', 2],
    ['src/pages/index.astro', 'page', 1],
    ['src/styles/site.css', 'css', 3],
  ]);
  assert.deepEqual(byId.get('tablet'), [['src/styles/small.css', 'css', 1]]);
  assert.deepEqual(byId.get('phone'), [['src/styles/small.css', 'css', 2]]);
  const site = usage.entries.find((entry) => entry.id === 'laptop')?.files.find((file) => file.rel === 'src/styles/site.css');
  assert.deepEqual(
    site?.occurrences.map((place) => [place.reason, place.checked]),
    [
      ['exact', true],
      ['exact', true],
      ['inclusive', false],
    ],
    'the 1px inclusive form is listed but starts unchecked',
  );
  assert.ok(
    site?.occurrences.every((place) => place.before === place.after),
    'the usage view shows what is there, not a change',
  );
  assert.equal(fs.readFileSync(path.join(root, 'src/styles/site.css'), 'utf8'), before);
  assert.equal(fs.existsSync(path.join(root, '.stacki')), false, 'scanning writes not even the record');
  // node_modules, dist and the .gitignore'd folder never appear.
  assert.ok(usage.entries.every((entry) => entry.files.every((file) => !/node_modules|dist|generated/.test(file.rel))));
});

test('a rescan sees a changed file, and the choices the person saved are honoured and survive rescans', async () => {
  const root = usageFixture();
  const first = await scanBreakpointUsage(root, LIST);
  const site = first.entries.find((entry) => entry.id === 'laptop')?.files.find((file) => file.rel === 'src/styles/site.css');
  assert.ok(site);
  // The person unticks the first exact place and ticks the inclusive one.
  const record = recordWithChoices(EMPTY_SYNC_RECORD, 'laptop', [
    { file: site.rel, locator: site.occurrences[0]?.locator ?? '', reason: 'exact', checked: false },
    { file: site.rel, locator: site.occurrences[2]?.locator ?? '', reason: 'inclusive', checked: true },
  ]);
  fs.mkdirSync(path.join(root, '.stacki'));
  fs.writeFileSync(path.join(root, '.stacki/breakpoint-sync.json'), serializeBreakpointSyncRecord(record));
  for (let round = 0; round < 2; round += 1) {
    const again = await scanBreakpointUsage(root, LIST);
    const places = again.entries.find((entry) => entry.id === 'laptop')?.files.find((file) => file.rel === 'src/styles/site.css')?.occurrences;
    assert.deepEqual(
      places?.map((place) => [place.excluded, place.checked]),
      [
        [true, false],
        [false, true],
        [false, true],
      ],
      'unticked stays unticked and ticked stays ticked, scan after scan',
    );
  }
  // Other breakpoints' choices are their own.
  const tablet = (await scanBreakpointUsage(root, LIST)).entries.find((entry) => entry.id === 'tablet');
  assert.ok(tablet?.files.every((file) => file.occurrences.every((place) => place.checked && !place.excluded)));
  // The choices reach an apply: the unticked place is not rewritten by a sync, the ticked inclusive one is.
  const sync = await scanOf(root);
  const checked = initialChecked(sync);
  const result = applyBreakpointSync(root, applyRequest(root, 'laptop', sync, checked));
  assert.equal(result.ok, true);
  const text = read(root, 'src/styles/site.css');
  assert.ok(text.includes('(min-width: 64rem)'), 'the unticked place keeps its value');
  assert.ok(text.includes('(max-width: 70rem)'), 'the other exact place moved');
  assert.ok(text.includes('(max-width: 1119px)'), 'the ticked inclusive form moved, one pixel under the new boundary');
  // A file changed on disk shows up on the next scan.
  fs.appendFileSync(path.join(root, 'src/styles/small.css'), '@media (min-width: 48rem) { .d { color: red } }\n');
  const changed = await scanBreakpointUsage(root, LIST);
  assert.equal(changed.entries.find((entry) => entry.id === 'tablet')?.files[0]?.occurrences.length, 2);
});

test('a Lumos project is reported, and an unreadable record is reported once with nothing remembered', async () => {
  const root = fixture({ lumos: true });
  fs.mkdirSync(path.join(root, '.stacki'));
  fs.writeFileSync(path.join(root, '.stacki/breakpoint-sync.json'), '{ nope');
  const usage = await scanBreakpointUsage(root, LIST);
  assert.equal(usage.lumos, true);
  assert.match(usage.recordProblem ?? '', /not valid JSON/);
  assert.equal(read(root, '.stacki/breakpoint-sync.json'), '{ nope');
});
