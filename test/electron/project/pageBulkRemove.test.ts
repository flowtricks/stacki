// Goal: deleting several pages and folders at once (the Pages panel's Select mode) is ONE step: planned from the disk
// with the links it breaks, written all pages or none, and taken back byte for byte, folders included, by one undo.
// Method: temporary Astro projects on a real disk (CRLF and LF pages, nested folders, an empty folder, a layout that
// links to several of the pages) are planned and applied through the same planner and writer Desktop uses. Every case
// snapshots every file and every folder first, so "nothing written" and "undo is byte-exact" are checked over the
// whole tree. The failure cases make the second of several writes fail for real (a read-only folder) and check that
// the first is put back.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planBulkRemoveSliced } from '#dist/electron/handlers/pageBulkRemovePlan.js';
import { applyRelocationStep, inverseStep } from '#dist/electron/project/pageRelocationWrite.js';
import { desktopRenameWriter } from '#dist/electron/project/pageRenameDesktop.js';
import { PAGE_BULK_REMOVE_LIMITS } from '#dist/shared/properties/pageBulkRemove.js';

type Files = Readonly<Record<string, string>>;

function project(files: Files, folders: readonly string[] = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-bulk-remove-'));
  for (const [file, text] of Object.entries(files)) {
    const full = path.join(root, ...file.split('/'));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
  }
  for (const folder of folders) {
    fs.mkdirSync(path.join(root, ...folder.split('/')), { recursive: true });
  }
  // Every authored file's bytes and every folder, the staging folder left out: what "nothing changed" is checked against.
  const snapshot = (): Readonly<Record<string, string>> => {
    const found: Record<string, string> = {};
    const pending = [''];
    for (let index = 0; index < pending.length && index < 10_000; index++) {
      const folder = pending[index] ?? '';
      for (const entry of fs.readdirSync(path.join(root, folder), { withFileTypes: true })) {
        const file = folder ? folder + '/' + entry.name : entry.name;
        if (file === '.stacki' || file.startsWith('.stacki/')) {
          continue;
        }
        if (entry.isDirectory()) {
          found[file + '/'] = '<folder>';
          pending.push(file);
        } else {
          found[file] = fs.readFileSync(path.join(root, ...file.split('/')), 'utf8');
        }
      }
    }
    return found;
  };
  const exists = (file: string) => fs.existsSync(path.join(root, ...file.split('/')));
  return { root, snapshot, exists, close: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const SITE: Files = {
  'package.json': '{"name":"site"}',
  'src/layouts/Base.astro': '<nav><a href="/about">About</a> <a href="/blog/post">Post</a> <a href="/contact">Contact</a></nav>\r\n<slot />\r\n',
  'src/pages/index.astro':
    '---\r\nimport Base from "../layouts/Base.astro";\r\n---\r\n<Base><a href="/about">About</a> and <a href="/contact">contact</a></Base>\r\n',
  'src/pages/about.astro': '<h1>About</h1>\n',
  'src/pages/contact.md': '# Contact\n\nSee [home](/).\n',
  'src/pages/404.astro': '<h1>Missing</h1>\n',
  'src/pages/blog/index.astro': '<h1>Blog</h1>\n',
  'src/pages/blog/post.mdx': '# Post\n',
  'src/pages/blog/2024/older.md': '# Older\n',
  'src/pages/keep.astro': '<h1>Keep</h1>\n',
};
const EMPTY_FOLDER = ['src/pages/empty'];

async function planned(root: string, request: { readonly pages: readonly string[]; readonly folders: readonly string[] }) {
  const plan = await planBulkRemoveSliced(root, request);
  assert.ok(plan.ok, plan.ok ? '' : plan.error.message);
  return plan.value;
}

test('several pages and a folder are deleted as one step, with the links they break counted once per place', async () => {
  const site = project(SITE, EMPTY_FOLDER);
  try {
    const before = site.snapshot();
    const plan = await planned(site.root, { pages: ['about.astro', 'contact.md', '404.astro'], folders: ['blog'] });
    assert.deepEqual(plan.step.files.map((change) => change.kind === 'delete' && change.from).sort(), [
      'src/pages/404.astro',
      'src/pages/about.astro',
      'src/pages/blog/2024/older.md',
      'src/pages/blog/index.astro',
      'src/pages/blog/post.mdx',
      'src/pages/contact.md',
    ]);
    assert.deepEqual(plan.step.folders.removed, ['src/pages/blog/2024', 'src/pages/blog'], 'subfolders go before their folder');
    assert.equal(plan.summary.pages, 6);
    assert.equal(plan.summary.folders, 2);
    assert.equal(plan.summary.errorPages, 1);
    assert.equal(plan.summary.impact.moves.length, 0);
    assert.deepEqual(
      plan.summary.impact.reviews.map((review) => review.file + ':' + review.line),
      ['src/layouts/Base.astro:1', 'src/pages/index.astro:4'],
      'a line linking two deleted pages is one place to look at',
    );
    assert.equal(plan.summary.impact.links, 5, 'about, post and contact in the layout, about and contact on the homepage');
    assert.deepEqual(site.snapshot(), before, 'planning writes nothing');
    const written = applyRelocationStep(plan.step, desktopRenameWriter());
    assert.ok(written.ok, written.ok ? '' : written.error.message);
    assert.deepEqual(
      Object.keys(site.snapshot())
        .filter((file) => file.startsWith('src/pages'))
        .sort(),
      ['src/pages/', 'src/pages/empty/', 'src/pages/index.astro', 'src/pages/keep.astro'],
    );
    // One undo brings every page and every folder back, byte for byte.
    const undone = applyRelocationStep(inverseStep(plan.step), desktopRenameWriter());
    assert.ok(undone.ok, undone.ok ? '' : undone.error.message);
    assert.deepEqual(site.snapshot(), before);
    // And redo takes them away again from the same step.
    assert.ok(applyRelocationStep(plan.step, desktopRenameWriter()).ok);
    assert.equal(site.exists('src/pages/blog'), false);
    assert.ok(applyRelocationStep(inverseStep(plan.step), desktopRenameWriter()).ok);
    assert.deepEqual(site.snapshot(), before);
  } finally {
    site.close();
  }
});

test('an empty folder is deleted alone, and its undo brings the folder back', async () => {
  const site = project(SITE, EMPTY_FOLDER);
  try {
    const before = site.snapshot();
    const plan = await planned(site.root, { pages: [], folders: ['empty'] });
    assert.equal(plan.summary.pages, 0);
    assert.equal(plan.summary.folders, 1);
    assert.ok(applyRelocationStep(plan.step, desktopRenameWriter()).ok);
    assert.equal(site.exists('src/pages/empty'), false);
    assert.ok(applyRelocationStep(inverseStep(plan.step), desktopRenameWriter()).ok);
    assert.deepEqual(site.snapshot(), before);
  } finally {
    site.close();
  }
});

test('the plan refuses what Page settings would, and what Undo could not put back, and writes nothing', async () => {
  const site = project({ ...SITE, 'src/pages/blog/data.json': '{}', 'src/pages/binary/page.astro': 'ok', 'src/pages/binary/logo.bin': 'x' });
  try {
    const before = site.snapshot();
    const refusals: readonly (readonly [{ readonly pages: readonly string[]; readonly folders: readonly string[] }, RegExp])[] = [
      [{ pages: ['about.astro', 'index.astro'], folders: [] }, /homepage can’t be deleted/],
      [{ pages: ['nothing.astro'], folders: [] }, /no longer exists|does not exist|missing|not found/i],
      [{ pages: [], folders: ['nothing'] }, /no longer exists|does not exist|missing|not found/i],
      [{ pages: [], folders: ['blog'] }, /holds src\/pages\/blog\/data\.json, which is not a page/],
      [{ pages: ['about.astro'], folders: ['binary'] }, /logo\.bin/],
    ];
    for (const [request, expected] of refusals) {
      const plan = await planBulkRemoveSliced(site.root, request);
      assert.equal(plan.ok, false, JSON.stringify(request));
      assert.match(plan.ok ? '' : plan.error.message, expected, JSON.stringify(request));
    }
    assert.deepEqual(site.snapshot(), before);
  } finally {
    site.close();
  }
});

test('Finder litter does not keep a folder from being deleted', async () => {
  const site = project({ ...SITE, 'src/pages/blog/.DS_Store': 'junk' });
  try {
    const plan = await planBulkRemoveSliced(site.root, { pages: [], folders: ['blog'] });
    assert.ok(plan.ok, plan.ok ? '' : plan.error.message);
  } finally {
    site.close();
  }
});

test('a project over the limit is refused before anything is read', async () => {
  const files: Record<string, string> = { 'package.json': '{}' };
  for (let index = 0; index <= PAGE_BULK_REMOVE_LIMITS.pagesMax; index++) {
    files[`src/pages/many/p${index}.md`] = 'x';
  }
  const site = project(files);
  try {
    const plan = await planBulkRemoveSliced(site.root, { pages: [], folders: ['many'] });
    assert.equal(plan.ok, false);
    assert.match(plan.ok ? '' : plan.error.message, /at most 500 pages and 100 folders/);
  } finally {
    site.close();
  }
});

test('a page changed since the plan stops the whole step before any page goes', async () => {
  const site = project(SITE, EMPTY_FOLDER);
  try {
    const plan = await planned(site.root, { pages: ['about.astro', 'contact.md'], folders: ['blog'] });
    fs.writeFileSync(path.join(site.root, 'src', 'pages', 'blog', 'post.mdx'), '# Edited since\n');
    const before = site.snapshot();
    const written = applyRelocationStep(plan.step, desktopRenameWriter());
    assert.equal(written.ok, false);
    assert.deepEqual(site.snapshot(), before, 'not one page was deleted');
  } finally {
    site.close();
  }
});

test('a write that fails half way puts back every page already moved', async (context) => {
  if (process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0)) {
    context.skip('A read-only folder stops nothing on Windows or for root');
    return;
  }
  const site = project(SITE, EMPTY_FOLDER);
  const locked = path.join(site.root, 'src', 'pages', 'blog');
  try {
    const plan = await planned(site.root, { pages: ['about.astro', 'contact.md', '404.astro'], folders: ['blog'] });
    const before = site.snapshot();
    // Pages in a read-only folder cannot be taken out of it: the move fails after the earlier pages were already moved.
    fs.chmodSync(locked, 0o555);
    const written = applyRelocationStep(plan.step, desktopRenameWriter());
    fs.chmodSync(locked, 0o755);
    assert.equal(written.ok, false);
    assert.deepEqual(site.snapshot(), before, 'every page is back where it was, byte for byte');
  } finally {
    fs.chmodSync(locked, 0o755);
    site.close();
  }
});
