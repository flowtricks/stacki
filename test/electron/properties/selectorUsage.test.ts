// Goal: the unused-selector check calls a selector `unused` only when nothing in
// the project, its installed packages or its scripts can produce a name the
// selector requires, and a cleanup removes exactly those selectors and nothing
// else.
// Method: build a small Astro project on disk per case, run the real check
// (disk walk, Astro parser, postcss, package scan), and pin each verdict. The
// negative space gets the most cases: every way a class can be produced
// without being written in a template must keep its selector off the unused
// list. Cleanups run against real files and compare bytes before and after.
import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { checkSelectorUsage, removeUnusedSelectors, restoreSelectorFiles } from '#dist/electron/properties/selectorRemoval.js';
import { EMPTY_KEEP_LIST, parseStyleKeepList, keepMatcher, serializeStyleKeepList } from '#dist/shared/properties/styleKeepList.js';
import type { SelectorReport, SelectorVerdict } from '#dist/shared/properties/selectorUsage.js';

type Files = Readonly<Record<string, string>>;

const PACKAGE = { 'node_modules/widget/index.js': "export const active = 'widget-is-open';\n" };

function project(files: Files, options: { readonly packages?: boolean } = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-selectors-'));
  const all = options.packages === false ? files : { ...PACKAGE, ...files };
  for (const [rel, text] of Object.entries(all)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  return root;
}

async function report(root: string, keepList = EMPTY_KEEP_LIST): Promise<SelectorReport> {
  return (await checkSelectorUsage(root, keepList)).report;
}

function verdictOf(result: SelectorReport, selector: string): SelectorVerdict {
  const entry = result.entries.find((candidate) => candidate.selector === selector);
  assert.ok(entry, `no entry for ${selector}: ${result.entries.map((candidate) => candidate.selector).join(', ')}`);
  return entry.verdict;
}

function kinds(result: SelectorReport): Record<string, string> {
  return Object.fromEntries(result.entries.map((entry) => [entry.selector, entry.verdict.kind]));
}

const page = (body: string, style = '') => `---\nconst n = 1;\n---\n${body}\n${style}`;

test('global selectors are unused only when no file mentions their names', async () => {
  const root = project({
    'src/styles/global.css': '.hero { color: red }\n.ghost { color: blue }\n#main { x: y }\n#lost { x: y }\nh1 { x: y }\n',
    'src/pages/index.astro': page('<main id="main"><h1 class="hero">Hi</h1></main>'),
  });
  const result = await report(root);
  assert.deepEqual(kinds(result), { '.hero': 'used', '.ghost': 'unused', '#main': 'used', '#lost': 'unused', h1: 'untracked' });
  assert.deepEqual(verdictOf(result, '.ghost'), { kind: 'unused', names: ['ghost'] });
});

test('a scoped selector ignores other components’ static classes but not their scripts', async () => {
  const root = project({
    'src/components/Card.astro': page('<div class="card">Card</div>', '<style>\n.card { a: b }\n.title { a: b }\n.badge { a: b }\n.open { a: b }\n</style>'),
    'src/components/Hero.astro': page('<h1 class="title">Hero</h1>', '<script>document.querySelector(".card")?.classList.add("open");</script>'),
    'src/components/Note.astro': page('<p>see the badge</p>'),
  });
  const result = await report(root);
  // Hero's static class="title" cannot reach Card's elements; Hero's script can.
  // "badge" in Note's prose is still a mention: loose matching protects.
  assert.deepEqual(kinds(result), { '.card': 'used', '.title': 'unused', '.badge': 'used', '.open': 'used' });
});

test('a component that computes classes or spreads attributes counts every mention', async () => {
  const root = project({
    'src/components/Box.astro': page('<div class={Astro.props.class}>x</div>', '<style>\n.featured { a: b }\n.never { a: b }\n</style>'),
    'src/components/Spread.astro': page('<div {...Astro.props}>x</div>', '<style>\n.wide { a: b }\n</style>'),
    'src/pages/index.astro': page('<Box class="featured" /><Spread class="wide" />'),
  });
  assert.deepEqual(kinds(await report(root)), { '.featured': 'used', '.never': 'unused', '.wide': 'used' });
});

test('names assembled in code protect every selector they could build', async () => {
  const root = project({
    'src/styles/global.css': '.btn-large { a: b }\n.btn-small { a: b }\n.card--active { a: b }\n.tag-red { a: b }\n.lone-rule { a: b }\n',
    'src/scripts/ui.ts':
      "const size = 'x';\nexport const a = `btn-${size}`;\nexport const b = (base: string) => `${base}--active`;\nexport const c = 'tag' + '-' + size;\n",
  });
  // A name the code assembles is one the code uses: in use, never flagged.
  const result = await report(root);
  assert.equal(verdictOf(result, '.btn-large').kind, 'used');
  assert.equal(verdictOf(result, '.btn-small').kind, 'used');
  assert.equal(verdictOf(result, '.card--active').kind, 'used');
  assert.equal(verdictOf(result, '.tag-red').kind, 'used');
  assert.equal(verdictOf(result, '.lone-rule').kind, 'unused');
});

test('installed packages count, and missing packages make nothing unused', async () => {
  const files = { 'src/styles/global.css': '.widget-is-open { a: b }\n.nowhere { a: b }\n' };
  assert.deepEqual(kinds(await report(project(files))), { '.widget-is-open': 'used', '.nowhere': 'unused' });
  const bare = await report(project(files, { packages: false }));
  assert.deepEqual(kinds(bare), { '.widget-is-open': 'unknown', '.nowhere': 'unknown' });
  const verdict = verdictOf(bare, '.nowhere');
  assert.ok(verdict.kind === 'unknown' && /not installed/.test(verdict.reason));
});

test('outside data weakens a proof only where it reaches a template; scripts never do', async () => {
  const css = { 'src/styles/global.css': '.stray { a: b }\n', 'src/components/A.astro': page('<div class="a">x</div>', '<style>\n.gone { a: b }\n</style>') };
  const local = await report(project({ ...css, 'src/pages/blog.astro': page('<article set:html={post.html} />') }));
  assert.equal(verdictOf(local, '.stray').kind, 'unused', 'HTML from the project’s own files has its classes in them');
  const fetched = {
    'src/pages/blog.astro': "---\nimport { posts } from '../lib/cms';\n---\n<article set:html={posts} />\n",
    'src/lib/cms.ts': "export const posts = await fetch('https://cms.example.com');\n",
  };
  const unlinked = {
    'src/pages/blog.astro': page('<article set:html={post.html} />'),
    'src/lib/cms.ts': "export const posts = await fetch('https://cms.example.com');\n",
  };
  assert.equal(verdictOf(await report(project({ ...css, ...unlinked })), '.stray').kind, 'unused', 'data that never reaches the inserted HTML hides nothing');
  const injected = await report(project({ ...css, ...fetched }));
  assert.equal(verdictOf(injected, '.stray').kind, 'unknown');
  assert.equal(verdictOf(injected, '.gone').kind, 'unused', 'inserted HTML never carries a component scope');
  const loader = {
    'src/pages/blog.astro': page('<article set:html={post.html} />'),
    'src/content.config.ts': "import { notionLoader } from 'notion-astro-loader';\nimport { glob } from 'astro/loaders';\n",
  };
  assert.equal(verdictOf(await report(project({ ...css, ...loader })), '.stray').kind, 'unknown', 'a package loader brings outside data');
  const localConfig = {
    'src/pages/blog.astro': page('<article set:html={post.html} />'),
    'src/content.config.ts': 'import { file } from \'astro/loaders\';\nconst schema = z.object({ "from": z.string(), "to": z.string() });\n',
  };
  assert.equal(verdictOf(await report(project({ ...css, ...localConfig })), '.stray').kind, 'unused', 'a field named "from" is not an import');

  // A script's classes are runtime state, not tracked: a remote script, or a
  // script setting classes from fetched values, leaves every verdict alone.
  const remoteScript = page('<div />', '<script src="https://cdn.example.com/lib.js"></script>');
  assert.equal(verdictOf(await report(project({ ...css, 'src/pages/x.astro': remoteScript })), '.stray').kind, 'unused');
  const remoteSink = {
    'src/scripts/a.ts': "const r = await fetch('https://api.example.com/x');\nconst v = await r.text();\ndocument.body.classList.add(v);\nel.innerHTML = v;\n",
  };
  assert.equal(verdictOf(await report(project({ ...css, ...remoteSink })), '.stray').kind, 'unused');
  const apart = {
    'src/components/Copy.astro': page('<div />', "<script>const r = await fetch('/ai');</script>"),
    'src/layouts/Layout.astro': page('<div />', '<script>const c = name(); document.body.classList.add(c);</script>'),
  };
  assert.equal(verdictOf(await report(project({ ...css, ...apart })), '.gone').kind, 'unused', 'two components’ scripts share no data');
  const ownIndex = {
    'src/components/Search.astro': page('<div />', "<script>const r = await fetch('/search.json'); list.innerHTML = r; el.classList.add(r.kind);</script>"),
  };
  assert.equal(verdictOf(await report(project({ ...css, ...ownIndex })), '.stray').kind, 'unused', 'the site’s own files are not outside data');
  const fetchOnly = await report(project({ ...css, 'src/scripts/a.ts': "await fetch('/api/contact', { method: 'POST' });\n" }));
  assert.equal(verdictOf(fetchOnly, '.gone').kind, 'unused', 'a form post sets no classes');
});

test('the keep list protects names, and patterns match whole names', async () => {
  const root = project({ 'src/styles/global.css': '.is-open { a: b }\n.hero-badge { a: b }\n.gone { a: b }\n' });
  const keepList = parseStyleKeepList({ version: 1, keep: ['is-*', 'hero-badge'] });
  assert.deepEqual(kinds(await report(root, keepList)), { '.is-open': 'kept', '.hero-badge': 'kept', '.gone': 'unused' });
  const keep = keepMatcher(keepList);
  assert.equal(keep('is-open'), true);
  assert.equal(keep('this-is-open'), false);
  assert.throws(() => parseStyleKeepList({ version: 1, keep: ['*'] }), /more than a wildcard/);
  assert.throws(() => parseStyleKeepList({ version: 1, keep: ['a b'] }), /whitespace/);
  assert.throws(() => parseStyleKeepList({ version: 2 }), /version/);
  // A file from before scripts stopped mattering still reads, and loses the key on save.
  assert.deepEqual(parseStyleKeepList({ version: 1, keep: ['a'], trustedScripts: ['https://x.com/'] }), { version: 1, keep: ['a'] });
  assert.equal(serializeStyleKeepList(keepList), '{\n  "version": 1,\n  "keep": [\n    "hero-badge",\n    "is-*"\n  ]\n}\n');
});

test('only top-level names are requirements; keyframes, comments and other languages are left alone', async () => {
  const root = project({
    'src/styles/global.css':
      '.live:not(.gone) { a: b }\n:is(.x, .y) { a: b }\n@keyframes spin { from { a: b } to { a: b } }\n.a /* note */ .dead { a: b }\n.md\\:flex { a: b }\n.w-1\\/2 { a: b }\n',
    'src/components/S.astro': page('<div class="md:flex w-1/2 live">x</div>', '<style lang="scss">\n.nested { .deep { a: b } }\n</style>'),
  });
  const result = await report(root);
  assert.equal(verdictOf(result, '.live:not(.gone)').kind, 'used');
  assert.equal(verdictOf(result, ':is(.x, .y)').kind, 'untracked');
  assert.equal(verdictOf(result, '.md\\:flex').kind, 'used');
  assert.equal(verdictOf(result, '.w-1\\/2').kind, 'used');
  const commented = result.entries.find((entry) => entry.selector.includes('.dead'));
  assert.ok(commented?.verdict.kind === 'unknown' && /comment/.test(commented.verdict.reason));
  assert.ok(!result.entries.some((entry) => /from|to|spin/.test(entry.selector)));
  assert.ok(result.notes.some((note) => note.rel === 'src/components/S.astro' && /lang="scss"/.test(note.message)));
});

test('build output, tool folders and stylesheets themselves are not mentions', async () => {
  const root = project({
    'src/styles/global.css': '.old { a: b }\n',
    'src/styles/other.css': '.old .x { a: b }\n',
    'dist/index.html': '<div class="old"></div>',
    '.stacki/styles.json': '{"version":1,"keep":["old"]}',
  });
  assert.deepEqual(kinds(await report(root)), { '.old': 'unused', '.old .x': 'unused' });
});

test('cleanup removes list entries, rules and emptied at-rules, and nothing else', async () => {
  const css =
    '/* Header */\n.keep, .gone-a {\n  color: red;\n}\n\n.gone-b {\n  color: blue;\n}\n\n@media (width > 1px) {\n  .gone-c { a: b }\n}\n\n.keep { .gone-d & { a: b } }\n';
  const root = project({ 'src/styles/global.css': css, 'src/pages/index.astro': page('<p class="keep">x</p>') });
  const analysis = await checkSelectorUsage(root, EMPTY_KEEP_LIST);
  const unused = analysis.report.entries.filter((entry) => entry.verdict.kind === 'unused');
  assert.deepEqual(
    unused.map((entry) => entry.selector),
    ['.gone-a', '.gone-b', '.gone-c', '.gone-d &'],
  );
  const result = await removeUnusedSelectors(root, EMPTY_KEEP_LIST, { ids: unused.map((entry) => entry.id), files: analysis.report.files });
  assert.ok(result.ok, JSON.stringify(result));
  const written = fs.readFileSync(path.join(root, 'src/styles/global.css'), 'utf8');
  assert.equal(written, '/* Header */\n.keep {\n  color: red;\n}\n\n.keep {  }\n');
  const undone = restoreSelectorFiles(root, result.value.changes, 'before');
  assert.ok(undone.ok);
  assert.equal(fs.readFileSync(path.join(root, 'src/styles/global.css'), 'utf8'), css);
});

test('cleanup of a <style> block changes no byte outside it', async () => {
  const source = page('<div class="card">x</div>\n<style>.title {}</style>', '<style>\n.card { a: b }\n.title { a: b }\n</style>\n<!-- end -->\n');
  const root = project({ 'src/components/Card.astro': source });
  const analysis = await checkSelectorUsage(root, EMPTY_KEEP_LIST);
  const unused = analysis.report.entries.filter((entry) => entry.verdict.kind === 'unused');
  assert.equal(unused.length, 2);
  const result = await removeUnusedSelectors(root, EMPTY_KEEP_LIST, { ids: unused.map((entry) => entry.id), files: analysis.report.files });
  assert.ok(result.ok, JSON.stringify(result));
  const written = fs.readFileSync(path.join(root, 'src/components/Card.astro'), 'utf8');
  assert.equal(written, page('<div class="card">x</div>\n<style></style>', '<style>\n.card { a: b }\n</style>\n<!-- end -->\n'));
});

test('cleanup refuses stale files and selectors that are no longer unused', async () => {
  const root = project({ 'src/styles/global.css': '.gone { a: b }\n', 'src/pages/index.astro': page('<p>x</p>') });
  const analysis = await checkSelectorUsage(root, EMPTY_KEEP_LIST);
  const ids = analysis.report.entries.map((entry) => entry.id);
  fs.writeFileSync(path.join(root, 'src/styles/global.css'), '.gone { a: c }\n');
  const stale = await removeUnusedSelectors(root, EMPTY_KEEP_LIST, { ids, files: analysis.report.files });
  assert.deepEqual(stale.ok ? 'ok' : stale.error.code, 'stale');
  fs.writeFileSync(path.join(root, 'src/styles/global.css'), '.gone { a: b }\n');
  fs.writeFileSync(path.join(root, 'src/pages/index.astro'), page('<p class="gone">x</p>'));
  const used = await removeUnusedSelectors(root, EMPTY_KEEP_LIST, { ids, files: analysis.report.files });
  assert.deepEqual(used.ok ? 'ok' : used.error.code, 'changed');
  assert.equal(fs.readFileSync(path.join(root, 'src/styles/global.css'), 'utf8'), '.gone { a: b }\n');
});

test('undo refuses to overwrite a file edited after the cleanup', async () => {
  const root = project({ 'src/styles/global.css': '.a { x: y }\n.gone { a: b }\n', 'src/pages/index.astro': page('<p class="a">x</p>') });
  const analysis = await checkSelectorUsage(root, EMPTY_KEEP_LIST);
  const ids = analysis.report.entries.filter((entry) => entry.verdict.kind === 'unused').map((entry) => entry.id);
  const result = await removeUnusedSelectors(root, EMPTY_KEEP_LIST, { ids, files: analysis.report.files });
  assert.ok(result.ok);
  fs.writeFileSync(path.join(root, 'src/styles/global.css'), '.a { x: z }\n');
  const undone = restoreSelectorFiles(root, result.value.changes, 'before');
  assert.equal(undone.ok, false);
  assert.equal(fs.readFileSync(path.join(root, 'src/styles/global.css'), 'utf8'), '.a { x: z }\n');
});

test('an installed Studio and stylesheets outside the site folders are not the site’s selectors', async () => {
  const root = project({
    'studio/package.json': '{"name":"@stacki/studio"}',
    'studio/vendor/stacki/src/ui/window.css': '.window-resize-n { a: b }\n',
    'studio/vendor/stacki/src/ui/uses.ts': "export const site = 'site-only';\n",
    'tools/report.css': '.report-row { a: b }\n',
    'src/styles/global.css': '.site-only { a: b }\n.gone { a: b }\n',
  });
  const result = await report(root);
  assert.deepEqual(kinds(result), { '.site-only': 'unused', '.gone': 'unused' }, 'Studio’s code is not a mention either');
});

test('a missing semicolon is read past, and a clean-up edits the original bytes', async () => {
  const css = '@keyframes out {\n  0% {\n    opacity: 1\n    transform: none;\n  }\n}\n.keep { color: red }\n.gone {\n  opacity: 0\n  color: blue;\n}\n';
  const root = project({ 'src/styles/global.css': css, 'src/pages/index.astro': page('<p class="keep">x</p>') });
  const analysis = await checkSelectorUsage(root, EMPTY_KEEP_LIST);
  assert.deepEqual(kinds(analysis.report), { '.keep': 'used', '.gone': 'unused' });
  assert.deepEqual(analysis.report.notes, []);
  const ids = analysis.report.entries.filter((entry) => entry.verdict.kind === 'unused').map((entry) => entry.id);
  const result = await removeUnusedSelectors(root, EMPTY_KEEP_LIST, { ids, files: analysis.report.files });
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(
    fs.readFileSync(path.join(root, 'src/styles/global.css'), 'utf8'),
    '@keyframes out {\n  0% {\n    opacity: 1\n    transform: none;\n  }\n}\n.keep { color: red }\n',
  );
  const broken = project({ 'src/styles/global.css': '.open { color: red }\n} .stray { x: y }\n' });
  assert.ok(
    (await report(broken)).notes.some((note) => /could not be read/.test(note.message)),
    'a stray } at the top level still stops the check',
  );
});

test('declarations browsers drop and blocks they close are read the way a browser reads them', async () => {
  const css = '.live {\n\tcolor: red;\n\t// pointer-events: none;\n}\n@container (width < 20em) {\n\t.gone-inside { a: b }\n]\n';
  const root = project({ 'src/styles/global.css': css, 'src/pages/index.astro': page('<p class="live">x</p>') });
  const analysis = await checkSelectorUsage(root, EMPTY_KEEP_LIST);
  assert.deepEqual(analysis.report.notes, []);
  assert.deepEqual(kinds(analysis.report), { '.live': 'used', '.gone-inside': 'unused' });
  const ids = analysis.report.entries.filter((entry) => entry.verdict.kind === 'unused').map((entry) => entry.id);
  const result = await removeUnusedSelectors(root, EMPTY_KEEP_LIST, { ids, files: analysis.report.files });
  assert.ok(result.ok, JSON.stringify(result));
  // The emptied @container goes to the end of the sheet, where the browser closed it.
  assert.equal(fs.readFileSync(path.join(root, 'src/styles/global.css'), 'utf8'), '.live {\n\tcolor: red;\n\t// pointer-events: none;\n}\n');
});

test('a component the visual editor cannot represent still has its <style> blocks read', async () => {
  // A `{` inside an attribute string makes the editor's parser give up; the
  // template scanner skips quoted values and still finds the block inside the
  // {visible && (…)} wrapper Webflow exports use.
  const source =
    '---\nconst visible = true;\n---\n{visible && (<div class="card" data-x="{">\n<style is:inline>\n.card { a: b }\n.orphan { a: b }\n</style>\n</div>)}\n';
  const root = project({ 'src/components/Card.astro': source });
  const result = await report(root);
  assert.deepEqual(result.notes, []);
  assert.deepEqual(kinds(result), { '.card': 'used', '.orphan': 'unused' });
});

test('a cached-only check says "checking" until installed packages are searched', async () => {
  const root = project({
    'node_modules/fresh-lib/index.js': "export const c = 'from-a-package';\n",
    'src/styles/global.css': '.from-a-package { a: b }\n.gone-for-good { a: b }\n.in-the-page { a: b }\n',
    'src/pages/index.astro': page('<p class="in-the-page">x</p>'),
  });
  const early = (await checkSelectorUsage(root, EMPTY_KEEP_LIST, 'cached')).report;
  assert.deepEqual(kinds(early), { '.from-a-package': 'checking', '.gone-for-good': 'checking', '.in-the-page': 'used' });
  const full = (await checkSelectorUsage(root, EMPTY_KEEP_LIST, 'search')).report;
  assert.deepEqual(kinds(full), { '.from-a-package': 'used', '.gone-for-good': 'unused', '.in-the-page': 'used' });
  const later = (await checkSelectorUsage(root, EMPTY_KEEP_LIST, 'cached')).report;
  assert.deepEqual(kinds(later), kinds(full), 'once searched, the cached check is complete');
});

test('HTML outside the site, like an old export, still counts as a mention', async () => {
  const exported = '<html><script src="https://cdn.example.com/jquery.js"></script><div class="kept-by-export"></div></html>';
  const root = project({
    'old-site/export/index.html': exported,
    'src/styles/global.css': '.kept-by-export { a: b }\n.gone { a: b }\n',
  });
  assert.deepEqual(kinds(await report(root)), { '.kept-by-export': 'used', '.gone': 'unused' });
});
