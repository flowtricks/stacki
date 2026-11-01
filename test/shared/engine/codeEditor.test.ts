// Goal: the code editor is on the actor (plan §3.6, §7, §11 step 8). A code
// save is the byte diff from the text the editor read to the text it holds,
// sent through `page:edit` and spliced by the page's actor — the one write
// path. It may write bytes that do not parse: the page then reads as a parse
// error, visual edits are refused `source-invalid`, and visual editing resumes
// as soon as a later save makes it parse. An outside edit elsewhere in the file
// is merged; one that overlaps the patch is a `merge-conflict` with the disk
// untouched, never an overwrite. A patch whose witnesses do not hold, or whose
// payload is past `intentPayloadBytesMax`, is refused and writes nothing.
// Method: the real main-process handlers in the windowless harness on
// temporary files; outside edits are made directly on disk between requests.
// The wire parser gets its known-good and each known-bad shape; the corpus is
// swept with malformed intermediates written and then repaired, byte for byte.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { mainHarness } from '../../helpers/mainHarness.ts';
import { diffCodePatch, type CodeHunk } from '#dist/shared/engine/codePatch.js';
import { parseEditRequest, type Edit } from '#dist/shared/engine/editRequest.js';
import { LIMITS } from '#dist/shared/core/limits.js';
import type { PageNode } from '#dist/shared/page/pageNode.js';
import { toByteSpan, toUtf16Span } from '#dist/shared/core/span.js';
import { parsePageDiskRead, parsePageEditResult, type PageDiskRead } from '#dist/shared/ipc/pageSave.js';

// Null as a boundary receives it, parsed from JSON: inputs may hold it; our values never do.
const jsonNull: unknown = JSON.parse('null');

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
const DIGEST = 'a'.repeat(64);
const CORPUS = path.resolve('test/corpus');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-code-editor-'));
  fs.mkdirSync(path.join(root, 'src/pages'), { recursive: true });
  fs.mkdirSync(path.join(root, 'user'));
  fs.writeFileSync(path.join(root, 'package.json'), '{"dependencies":{"astro":"*"}}');
  const harness = mainHarness(path.join(root, 'user'));
  return {
    root,
    ...harness,
    dispose: () => {
      harness.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

type Harness = ReturnType<typeof fixture>;

function page(harness: Harness, name: string, text: string): string {
  const file = path.join(harness.root, 'src/pages', name);
  fs.writeFileSync(file, text);
  return file;
}

async function read(harness: Harness, file: string): Promise<PageDiskRead> {
  return parsePageDiskRead(await harness.invoke('page:read', file));
}

async function send(harness: Harness, file: string, authoredChecksum: string, edit: Edit) {
  const payload = { pagePath: file, authoredChecksum, edit };
  return parsePageEditResult(await harness.invoke('page:edit', payload));
}

function hunks(baseline: string, next: string): readonly CodeHunk[] {
  const patch = diffCodePatch(baseline, next);
  assert.ok(patch.ok, 'the text is inside the bounds');
  return patch.value;
}

/** Save `next` as the code editor does: the patch from the text `from` holds. */
function saveCode(harness: Harness, file: string, from: PageDiskRead, next: string) {
  return send(harness, file, from.checksum, { tag: 'code-patch', hunks: hunks(from.source, next) });
}

function rejection(result: Awaited<ReturnType<typeof send>>): string {
  assert.ok(!result.ok, 'the edit was refused');
  assert.equal(result.error.code, 'rejected');
  return result.error.code === 'rejected' ? result.error.reason : '';
}

/** The source range of the node at `at` in a parsed page. */
function rangeAt(parsed: PageDiskRead, at: readonly number[]): { start: number; end: number } {
  assert.ok(parsed.editable, 'the page parses');
  let list: readonly PageNode[] = parsed.model.nodes;
  let node: PageNode | undefined;
  for (const step of at) {
    node = list[step];
    assert.ok(node !== undefined, `a node at ${at.join('/')}`);
    list = 'children' in node && Array.isArray(node.children) ? node.children : [];
  }
  assert.ok(node?.start !== undefined && node.end !== undefined, 'the parse carries ranges');
  return { start: node.start, end: node.end };
}

/** The visual edit the renderer sends for the element at `at` of its parse. */
function title(at: readonly number[], span: { start: number; end: number }): Edit {
  return {
    tag: 'set-attribute',
    target: { path: at, kind: 'element', span: toUtf16Span(span.start, span.end) },
    name: 'title',
    value: { type: 'string', value: 'Visual' },
  };
}

test('parseEditRequest takes a code patch and refuses each malformed shape', () => {
  const hunk = { span: { start: 0, end: 3 }, expected: 'abc', text: 'x' };
  const good = {
    pagePath: '/p.astro',
    authoredChecksum: DIGEST,
    edit: { tag: 'code-patch', hunks: [hunk] },
  };
  assert.deepEqual(parseEditRequest(good).edit, { tag: 'code-patch', hunks: [hunk] });
  const bad: readonly [unknown, RegExp][] = [
    [[], /at least one hunk/],
    [{}, /expected array/],
    [[{ ...hunk, expected: 1 }], /expected string/],
    [[{ ...hunk, text: jsonNull }], /expected string/],
    [[{ span: { start: 2, end: 1 }, expected: '', text: '' }], /end/],
    [[hunk, hunk], /ascending disjoint/],
    [Array.from({ length: LIMITS.splicesPerIntentMax + 1 }, () => hunk), /exceeds/],
  ];
  for (const [hunks, message] of bad) {
    assert.throws(() => parseEditRequest({ ...good, edit: { tag: 'code-patch', hunks } }), message);
  }
});

test('a code save writes only its hunks, and the reply is the page as written', async (context) => {
  const harness = fixture();
  context.after(harness.dispose);
  const text = '---\nconst a = 1;\n---\n<main>\n  <h1>Old</h1>\n</main>\n';
  const file = page(harness, 'index.astro', text);
  const before = await read(harness, file);
  const next = text.replace('const a = 1;', 'const a = 2;').replace('Old', 'New');
  const result = await saveCode(harness, file, before, next);
  assert.ok(result.ok, 'applied');
  assert.equal(fs.readFileSync(file, 'utf8'), next);
  assert.equal(result.value.source, next);
  assert.equal(result.value.checksum, sha256(next));
  assert.equal(result.value.editable, true);
  assert.equal(result.value.inverse.length, 2, 'two hunks, two inverses');
});

test('an invalid intermediate is written; visual edits wait until it parses', async (context) => {
  const harness = fixture();
  context.after(harness.dispose);
  const text = '<main>\n  <p title="Old">Hi</p>\n</main>\n';
  const file = page(harness, 'index.astro', text);
  const valid = await read(harness, file);
  assert.ok(valid.editable);
  const target = { path: [0, 0], span: rangeAt(valid, [0, 0]) };
  // Mid-typing: an unclosed element. The patch lands byte for byte.
  const broken = text.replace('</p>', '</p>\n  <div');
  const written = await saveCode(harness, file, valid, broken);
  assert.ok(written.ok, 'a code patch may leave the file invalid (plan §3.6)');
  assert.equal(fs.readFileSync(file, 'utf8'), broken);
  assert.equal(written.value.editable, false, 'the page reads as a parse error');
  const invalid = await read(harness, file);
  assert.equal(invalid.editable, false);
  assert.equal(invalid.source, broken);
  // A visual edit stated against the page it showed before is refused.
  assert.equal(rejection(await send(harness, file, valid.checksum, title(target.path, target.span))), 'source-invalid');
  assert.equal(fs.readFileSync(file, 'utf8'), broken, 'the refusal wrote nothing');
  // Typing on from the broken text: once it parses, visual editing resumes.
  const repaired = broken.replace('\n  <div', '\n  <div></div>');
  const fixed = await saveCode(harness, file, invalid, repaired);
  assert.ok(fixed.ok);
  assert.equal(fixed.value.editable, true, 'the page parses again');
  const again = await read(harness, file);
  assert.ok(again.editable);
  const edited = await send(harness, file, again.checksum, title([0, 0], rangeAt(again, [0, 0])));
  assert.ok(edited.ok, 'the visual edit applies');
  assert.equal(fs.readFileSync(file, 'utf8'), repaired.replace('"Old"', '"Visual"'));
});

test('an outside edit elsewhere merges; one that overlaps is refused', async (context) => {
  const harness = fixture();
  context.after(harness.dispose);
  const lines = Array.from({ length: 12 }, (_, index) => `  <p>line ${index}</p>`);
  const text = `<main>\n${lines.join('\n')}\n</main>\n`;
  const file = page(harness, 'index.astro', text);
  const before = await read(harness, file);
  const outside = text.replace('line 10<', 'line ten<');
  fs.writeFileSync(file, outside);
  const mine = text.replace('line 1<', 'line one<');
  const merged = await saveCode(harness, file, before, mine);
  assert.ok(merged.ok, 'mapped through the outside edit');
  const both = outside.replace('line 1<', 'line one<');
  assert.equal(fs.readFileSync(file, 'utf8'), both, 'both edits survive');
  assert.equal(merged.value.source, both, 'the reply shows the merge');
  // Now the outside editor and the code editor change the same word.
  const read2 = await read(harness, file);
  fs.writeFileSync(file, both.replace('line 5<', 'line FIVE<'));
  const overlap = await saveCode(harness, file, read2, both.replace('line 5<', 'line five<'));
  assert.equal(rejection(overlap), 'merge-conflict');
  assert.ok(!overlap.ok && overlap.error.code === 'rejected');
  assert.equal(overlap.error.diskChecksum, sha256(both.replace('line 5<', 'line FIVE<')));
  assert.equal(fs.readFileSync(file, 'utf8'), both.replace('line 5<', 'line FIVE<'), 'untouched');
});

test("a code save authored before the app's own edit rebases, or conflicts", async (context) => {
  const harness = fixture();
  context.after(harness.dispose);
  const text = '<main>\n  <p title="a">One</p>\n  <p>Two</p>\n</main>\n';
  const file = page(harness, 'index.astro', text);
  const before = await read(harness, file);
  assert.ok(before.editable);
  const visual = await send(harness, file, before.checksum, title([0, 0], rangeAt(before, [0, 0])));
  assert.ok(visual.ok);
  // The code editor still holds the text before the visual edit.
  const rebased = await saveCode(harness, file, before, text.replace('Two', 'Deux'));
  assert.ok(rebased.ok, 'rebased through the commit exactly');
  const expected = text.replace('"a"', '"Visual"').replace('Two', 'Deux');
  assert.equal(fs.readFileSync(file, 'utf8'), expected);
  // A patch of the attribute the visual edit rewrote cannot be merged.
  const clash = await saveCode(harness, file, before, text.replace('"a"', '"b"'));
  assert.equal(rejection(clash), 'merge-conflict');
  assert.equal(fs.readFileSync(file, 'utf8'), expected, 'untouched');
});

test('hunks that are not of the named bytes are refused, writing nothing', async (context) => {
  const harness = fixture();
  context.after(harness.dispose);
  const text = '<p>café</p>\n';
  const file = page(harness, 'index.astro', text);
  const before = await read(harness, file);
  const patch = (hunk: CodeHunk): Edit => ({ tag: 'code-patch', hunks: [hunk] });
  const cases: readonly [string, CodeHunk][] = [
    ['a witness that does not hold', { span: toByteSpan(3, 7), expected: 'cafe', text: 'x' }],
    ['a span inside a character', { span: toByteSpan(3, 7), expected: 'cafÃ', text: '' }],
    ['a span past the end', { span: toByteSpan(3, 99), expected: 'café</p>\n', text: '' }],
  ];
  for (const [what, hunk] of cases) {
    assert.equal(rejection(await send(harness, file, before.checksum, patch(hunk))), 'merge-conflict', what);
  }
  // Bytes the host never held cannot be merged either.
  const unknown = await send(harness, file, DIGEST, patch({ span: toByteSpan(0, 0), expected: '', text: 'x' }));
  assert.equal(rejection(unknown), 'merge-conflict');
  assert.equal(fs.readFileSync(file, 'utf8'), text);
});

test('a patch past intentPayloadBytesMax is a resource-limit, never truncated', async (context) => {
  const harness = fixture();
  context.after(harness.dispose);
  const text = '<p>x</p>\n';
  const file = page(harness, 'index.astro', text);
  const before = await read(harness, file);
  // Inside the wire bound in characters, past the payload bound in bytes.
  const wide = 'é'.repeat(Math.floor(LIMITS.intentPayloadBytesMax / 2) + 1);
  assert.ok(wide.length <= LIMITS.intentPayloadBytesMax);
  const edit: Edit = {
    tag: 'code-patch',
    hunks: [{ span: toByteSpan(3, 4), expected: 'x', text: wide }],
  };
  assert.equal(rejection(await send(harness, file, before.checksum, edit)), 'resource-limit');
  assert.equal(fs.readFileSync(file, 'utf8'), text, 'nothing was written');
  // The renderer's own diff refuses the same text before sending it.
  assert.deepEqual(diffCodePatch(before.source, wide), { ok: false, error: 'resource-limit' });
});

test('Markdown pages take code patches, and gestures on what they wrote', async (context) => {
  const harness = fixture();
  context.after(harness.dispose);
  const text = '---\ntitle: Post\n---\n\n# Heading\r\n\nBody.\n';
  const file = page(harness, 'post.md', text);
  const before = await read(harness, file);
  const next = text.replace('Body.', 'Body, edited.');
  const saved = await saveCode(harness, file, before, next);
  assert.ok(saved.ok);
  assert.equal(fs.readFileSync(file, 'utf8'), next, 'CRLF and all');
  // Step 10: the reply's parse names the heading; removing it is a splice.
  assert.ok(saved.value.editable);
  const heading = saved.value.model.nodes[0];
  assert.ok(heading?.start !== undefined && heading.end !== undefined);
  const gesture = await send(harness, file, saved.value.checksum, {
    tag: 'remove-node',
    target: { path: [0], kind: 'element', span: toUtf16Span(heading.start, heading.end) },
  });
  assert.ok(gesture.ok, 'the gesture applies');
  assert.equal(fs.readFileSync(file, 'utf8'), next.replace('# Heading\r\n\n', ''));
});

test('every corpus page survives a malformed intermediate and its repair', async (context) => {
  const harness = fixture();
  context.after(harness.dispose);
  const names = fs.readdirSync(CORPUS).filter((name) => name.endsWith('.astro'));
  assert.ok(names.length >= 30, 'the corpus is not thin');
  const breaks = ['<div', '{', '<p title="', '---\n', '</main>'];
  let invalid = 0;
  for (const [index, name] of names.entries()) {
    const text = fs.readFileSync(path.join(CORPUS, name), 'utf8');
    const file = page(harness, name, text);
    const clean = await read(harness, file);
    const at = text.lastIndexOf('\n', Math.floor(text.length / 2)) + 1;
    const broken = text.slice(0, at) + breaks[index % breaks.length] + text.slice(at);
    const written = await saveCode(harness, file, clean, broken);
    assert.ok(written.ok, `${name}: the intermediate is written`);
    assert.equal(fs.readFileSync(file, 'utf8'), broken, `${name}: byte for byte`);
    invalid += written.value.editable ? 0 : 1;
    const repaired = await saveCode(harness, file, written.value, text);
    assert.ok(repaired.ok, `${name}: the repair is written`);
    assert.equal(fs.readFileSync(file, 'utf8'), text, `${name}: back to the original bytes`);
    assert.equal(repaired.value.editable, clean.editable, `${name}: parses as it did`);
  }
  // The parser is lenient: a stray `---` or `</main>` still parses.
  assert.ok(invalid * 3 >= names.length, `a third or more do not parse: ${invalid}`);
});
