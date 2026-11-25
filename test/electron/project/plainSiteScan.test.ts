// Goal: "Open from folder" tells an Astro project, a plain website and a folder that is neither apart, and
// the listing the copy is made from leaves out what is not the site's own and never reaches outside it.
// Method: real folders under the OS temp directory, one per row of the detection table: Astro by dependency,
// by config and by src/pages alone; plain sites with a root page, a nested page, an uppercase .HTM; folders
// that only look like sites (Markdown only, pages only in node_modules, dist, vendor or a hidden folder, a page
// too deep); links (a loop, a link outside the folder, a link to a folder inside it); and a tree past the
// detection's entry bound. Each folder is removed after its test.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { classifyListing, classifySiteFolder, listSiteFiles, PLAIN_SITE_LIMITS } from '#dist/electron/project/plainSiteScan.js';

function folder(files: Readonly<Record<string, string>>): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-plain-site-')));
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return root;
}

function using(files: Readonly<Record<string, string>>, check: (root: string) => void): void {
  const root = folder(files);
  try {
    check(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const TABLE: readonly (readonly [string, Readonly<Record<string, string>>, string])[] = [
  ['an astro dependency', { 'package.json': '{"dependencies":{"astro":"^7.0.0"}}', 'index.html': '<p>x</p>' }, 'astro'],
  ['an astro config', { 'astro.config.mjs': 'export default {}', 'index.html': '' }, 'astro'],
  ['src/pages with an .astro page and nothing else', { 'src/pages/index.astro': '<p>x</p>' }, 'astro'],
  ['a root index.html', { 'index.html': '<p>x</p>', 'css/site.css': '' }, 'plainWebsite'],
  ['a page one folder down', { 'pages/about.html': '', 'readme.md': '' }, 'plainWebsite'],
  ['an uppercase .HTM', { 'HOME.HTM': '' }, 'plainWebsite'],
  ['a package.json without astro', { 'package.json': '{"devDependencies":{"live-server":"*"}}', 'index.html': '' }, 'plainWebsite'],
  ['an empty folder', {}, 'notWebsite'],
  ['only Markdown', { 'README.md': '# Hi', 'notes/a.md': '' }, 'notWebsite'],
  [
    'pages only in installed packages, build output, vendored code and hidden folders',
    { 'node_modules/x/index.html': '', 'dist/index.html': '', 'build/a.html': '', 'vendor/b.html': '', '.cache/c.html': '' },
    'notWebsite',
  ],
  ['a page two folders down is not in the top two levels', { 'a/b/index.html': '' }, 'notWebsite'],
  ['a file merely named like a page', { 'index.html.bak': '', 'page.xhtml': '' }, 'notWebsite'],
];

test('the detection table', () => {
  for (const [what, files, expected] of TABLE) {
    using(files, (root) => assert.equal(classifySiteFolder(root), expected, what));
  }
});

test('links: a loop and a link to a folder are not followed, a link outside is not read, a link to a page inside is', () => {
  using({ 'pages/real.html': '' }, (root) => {
    fs.symlinkSync(root, path.join(root, 'loop'));
    fs.symlinkSync(path.join(root, 'pages'), path.join(root, 'pages-link'));
    using({ 'outside.html': '' }, (outside) => {
      fs.symlinkSync(path.join(outside, 'outside.html'), path.join(root, 'outside.html'));
      fs.symlinkSync(path.join(root, 'pages', 'real.html'), path.join(root, 'inside.html'));
      const listing = listSiteFiles(root, { depthMax: 8, entriesMax: 100, purpose: 'copy' });
      assert.deepEqual(
        listing.files.map((file) => file.relative),
        ['inside.html', 'pages/real.html'],
      );
      assert.equal(listing.files[0]?.absolute, path.join(root, 'pages', 'real.html'), 'the link is read at its target');
      assert.deepEqual(
        [...listing.skipped].sort((left, right) => left.relative.localeCompare(right.relative)),
        [
          { relative: 'loop', reason: 'link-to-folder' },
          { relative: 'outside.html', reason: 'link-outside' },
          { relative: 'pages-link', reason: 'link-to-folder' },
        ],
      );
      assert.equal(listing.truncated, false);
      // With the only page outside, the folder is not a website.
      fs.rmSync(path.join(root, 'pages'), { recursive: true });
      fs.rmSync(path.join(root, 'inside.html'));
      assert.equal(classifySiteFolder(root), 'notWebsite');
    });
  });
});

test('the copy leaves out packages, version control, top-level build output, system files and hidden files, but serves .well-known', () => {
  using(
    {
      'index.html': '',
      'node_modules/a/index.js': '',
      'js/lib/node_modules/b.js': '',
      '.git/HEAD': '',
      'dist/index.html': '',
      'js/vendor/dist/lib.js': '',
      '.DS_Store': '',
      'img/Thumbs.db': '',
      '.env': 'SECRET=1',
      '.vscode/settings.json': '',
      '.well-known/security.txt': '',
      '.htaccess': '',
    },
    (root) => {
      const listing = listSiteFiles(root, { depthMax: 8, entriesMax: 100, purpose: 'copy' });
      assert.deepEqual(
        listing.files.map((file) => file.relative),
        ['.htaccess', '.well-known/security.txt', 'index.html', 'js/vendor/dist/lib.js'],
      );
      const reasons = Object.fromEntries(listing.skipped.map((entry) => [entry.relative, entry.reason]));
      assert.deepEqual(reasons, {
        '.DS_Store': 'system-file',
        '.env': 'hidden',
        '.git': 'version-control',
        '.vscode': 'hidden',
        dist: 'build-output',
        'img/Thumbs.db': 'system-file',
        'js/lib/node_modules': 'installed-packages',
        node_modules: 'installed-packages',
      });
    },
  );
});

test('the walk is bounded by depth and by entries, and says when it stopped early', () => {
  using({ 'a/b/c/d.html': '', 'top.html': '' }, (root) => {
    const shallow = listSiteFiles(root, { depthMax: 1, entriesMax: 100, purpose: 'copy' });
    assert.deepEqual(
      shallow.files.map((file) => file.relative),
      ['top.html'],
    );
    assert.deepEqual(shallow.skipped, [{ relative: 'a/b', reason: 'too-deep' }]);
  });
  const many: Record<string, string> = { 'zzz-last.html': '' };
  for (let index = 0; index <= PLAIN_SITE_LIMITS.detectEntriesMax; index += 1) {
    many[`note-${String(index).padStart(5, '0')}.md`] = '';
  }
  using(many, (root) => {
    const listing = listSiteFiles(root, { depthMax: 1, entriesMax: PLAIN_SITE_LIMITS.detectEntriesMax, purpose: 'detect' });
    assert.equal(listing.truncated, true);
    assert.equal(listing.files.length, PLAIN_SITE_LIMITS.detectEntriesMax);
    // The page sorts after the bound, so a folder this wide is decided on what was seen.
    assert.equal(classifySiteFolder(root), 'notWebsite');
  });
  assert.throws(() => listSiteFiles('/', { depthMax: -1, entriesMax: 1, purpose: 'copy' }), /Assertion failed/);
  assert.throws(() => listSiteFiles('/', { depthMax: 1, entriesMax: 0, purpose: 'copy' }), /Assertion failed/);
});

test('the pure rule: a listing with a page is a plain website', () => {
  const file = (relative: string) => ({ relative, absolute: `/x/${relative}`, sizeBytes: 0, mode: 0o644 });
  assert.equal(classifyListing({ files: [file('a.css'), file('b/INDEX.HTML')] }), 'plainWebsite');
  assert.equal(classifyListing({ files: [file('a.css'), file('page.html.txt')] }), 'notWebsite');
  assert.equal(classifyListing({ files: [] }), 'notWebsite');
});
