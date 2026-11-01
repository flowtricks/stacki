// Goal: renaming routes preserves project links, ordering and source bytes in both hosts.
// Method: temporary Astro projects cover collisions, boundary inputs, literal links,
// imports, metadata, stale writes, rollback and excluded generated/binary files.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parsePageRename, pageURLPath } from '#dist/shared/properties/pageRename.js';
import { pageRenameConflicts } from '#dist/electron/project/pageRenameConflicts.js';
import { planPageRename } from '#dist/electron/project/pageRenamePlan.js';
import { applyPageRename } from '#dist/electron/project/pageRenameWrite.js';
import { desktopRenameWriter } from '#dist/electron/project/pageRenameDesktop.js';
import { renamePageLink, renamePageLinks } from '#dist/electron/project/pageRenameLinks.js';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-page-rename-'));
  const write = (file: string, source: string) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), source);
  };
  const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');
  write('src/pages/about/index.astro', `---\nimport Card from '../../components/Card.astro';\n---\n<Card />`);
  write('src/pages/about/team.astro', '<a href="/about/">About</a>');
  write('src/components/Card.astro', '<a href="/about/team?q=1#bio">Team</a>');
  write('src/pages/index.astro', '<a href="/about">About</a><a href="/about-us">Keep</a>');
  write('src/data/menu.json', '{"url":"/about/team"}');
  write('public/sitemap.xml', '<loc>https://example.com/about/</loc>');
  write('astro.config.mjs', `export default { site: 'https://example.com' };`);
  write('.stacki/pages.json', '{"version":1,"entries":["about/","about/team.astro","about/index.astro","index.astro"]}');
  return { root, read, write, close: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('rename boundaries reject traversal, bad names and invalid page extensions', () => {
  const good = { kind: 'page', from: 'about.astro', to: 'company.astro' };
  assert.deepEqual(parsePageRename(good), good);
  for (const to of ['', '../secret.astro', '/home.astro', 'a\\b.astro', 'a?b.astro', 'a//b.astro', 'file.exe', 'x'.repeat(501)]) {
    assert.throws(() => parsePageRename({ ...good, to }));
  }
  assert.throws(() => parsePageRename({ ...good, kind: 'other' }));
  assert.equal(pageURLPath('about/index.astro'), '/about');
  assert.equal(pageURLPath('index.astro'), '/');
});

test('URL collisions include index aliases, folders, case and dynamic parameter names', () => {
  const inventory = {
    pages: ['old.astro', 'about/index.astro', 'blog/[id].astro'],
    folders: ['about', 'blog', 'empty'],
  };
  for (const to of ['about.astro', 'ABOUT.astro', 'empty.astro', 'blog/[slug].astro']) {
    assert.equal(pageRenameConflicts({ kind: 'page', from: 'old.astro', to }, inventory).ok, false);
  }
  assert.equal(pageRenameConflicts({ kind: 'folder', from: 'about', to: 'about/child' }, inventory).ok, false);
  assert.equal(pageRenameConflicts({ kind: 'folder', from: 'about', to: 'company' }, inventory).ok, true);
});

test('literal link rewriting preserves external URLs, prefix lookalikes, query and hash', () => {
  const context = {
    change: parsePageRename({ kind: 'folder', from: 'about', to: 'company' }),
    file: 'src/pages/index.astro',
    origins: ['https://example.com'],
  };
  for (const [before, after] of [
    ['/about', '/company'],
    ['/about/team/?q=x#bio', '/company/team/?q=x#bio'],
    ['https://example.com/about', 'https://example.com/company'],
    ['https://elsewhere.com/about', 'https://elsewhere.com/about'],
    ['//elsewhere.com/about', '//elsewhere.com/about'],
    ['/about-us', '/about-us'],
    ['/x/about', '/x/about'],
    ['mailto:about@example.com', 'mailto:about@example.com'],
  ]) {
    assert.equal(renamePageLink(before ?? '', context), after);
  }
  assert.equal(renamePageLinks('[Team](/about/team) <a href=/about>About</a>', context), '[Team](/company/team) <a href=/company>About</a>');
  assert.equal(renamePageLinks('{"url":"\\/about"}', context), '{"url":"\\/company"}');
});

test('dynamic route prefixes preserve each actual slug', () => {
  const context = {
    change: parsePageRename({ kind: 'page', from: 'blog/[slug].astro', to: 'news/[slug].astro' }),
    file: 'src/components/Menu.astro',
    origins: [],
  };
  assert.equal(renamePageLink('/blog/story#top', context), '/news/story#top');
  assert.equal(renamePageLink('/blog/story/more', context), '/blog/story/more');
  assert.equal(renamePageLink('/blog/${slug}', context), '/news/${slug}');
});

test('folder rename updates links throughout source, public files and saved order', () => {
  const site = fixture();
  try {
    const change = parsePageRename({ kind: 'folder', from: 'about', to: 'company' });
    const planned = planPageRename(site.root, change);
    assert.ok(planned.ok);
    assert.ok(applyPageRename(planned.value, desktopRenameWriter()).ok);
    assert.equal(fs.existsSync(path.join(site.root, 'src/pages/about')), false);
    assert.match(site.read('src/pages/company/index.astro'), /\.\.\/\.\.\/components\/Card.astro/);
    assert.equal(site.read('src/data/menu.json'), '{"url":"/company/team"}');
    assert.match(site.read('src/components/Card.astro'), /\/company\/team\?q=1#bio/);
    assert.match(site.read('public/sitemap.xml'), /https:\/\/example.com\/company\//);
    assert.match(site.read('src/pages/index.astro'), /href="\/about-us"/);
    assert.match(site.read('.stacki/pages.json'), /company\/team.astro/);
    assert.doesNotMatch(site.read('.stacki/pages.json'), /about/);
  } finally {
    site.close();
  }
});

test('moving a page rebases its imports and does not overwrite a colliding destination', () => {
  const site = fixture();
  try {
    const change = parsePageRename({
      kind: 'page',
      from: 'about/index.astro',
      to: 'welcome.astro',
    });
    const planned = planPageRename(site.root, change);
    assert.ok(planned.ok);
    assert.ok(applyPageRename(planned.value, desktopRenameWriter()).ok);
    assert.match(site.read('src/pages/welcome.astro'), /\.\.\/components\/Card.astro/);
    const again = planPageRename(site.root, { ...change, from: 'index.astro' });
    assert.equal(again.ok, false);
  } finally {
    site.close();
  }
});

test('stale plans refuse writes and a failed write restores earlier links', () => {
  const site = fixture();
  try {
    const change = parsePageRename({ kind: 'folder', from: 'about', to: 'company' });
    const planned = planPageRename(site.root, change);
    assert.ok(planned.ok);
    site.write('src/components/Card.astro', 'New external edit');
    assert.equal(applyPageRename(planned.value, desktopRenameWriter()).ok, false);
    assert.equal(site.read('src/components/Card.astro'), 'New external edit');
    const current = planPageRename(site.root, change);
    assert.ok(current.ok);
    const writer = desktopRenameWriter();
    let writes = 0;
    const result = applyPageRename(current.value, {
      ...writer,
      write: (entry) => {
        writes++;
        return writes === 2 ? { ok: false, error: { code: 'disk', message: 'Disk full' } } : writer.write(entry);
      },
    });
    assert.equal(result.ok, false);
    assert.ok(fs.existsSync(path.join(site.root, 'src/pages/about')));
    assert.equal(site.read('src/data/menu.json'), '{"url":"/about/team"}');
  } finally {
    site.close();
  }
});

test('aliased and extensionless imports follow renamed files', () => {
  const site = fixture();
  try {
    site.write('src/components/Alias.astro', `---\nimport Page from '@/pages/about/team.astro';\n---`);
    site.write('src/pages/about/helper.ts', 'export const title = "Team";');
    site.write('src/pages/consumer.astro', `---\nimport { title } from './about/helper';\n---`);
    const planned = planPageRename(site.root, { kind: 'folder', from: 'about', to: 'company' }, [['@/', ['src/']]]);
    assert.ok(planned.ok);
    assert.ok(applyPageRename(planned.value, desktopRenameWriter()).ok);
    assert.match(site.read('src/components/Alias.astro'), /\.\.\/pages\/company\/team.astro/);
    assert.match(site.read('src/pages/consumer.astro'), /\.\/company\/helper'/);
  } finally {
    site.close();
  }
});

test('relative links remain valid when their owner moves to another depth', () => {
  const context = {
    change: parsePageRename({ kind: 'page', from: 'about/team.astro', to: 'team.astro' }),
    file: 'src/pages/about/team.astro',
    origins: [],
  };
  assert.equal(renamePageLinks('<a href="../contact">Contact</a>', context), '<a href="/contact">Contact</a>');
  assert.equal(renamePageLinks('<a href="other">Other</a>', context), '<a href="/about/other">Other</a>');
  assert.equal(renamePageLinks('<a href="#section">Section</a>', context), '<a href="#section">Section</a>');
});

test('symbolic links refuse the whole rename and generated outputs remain untouched', () => {
  const site = fixture();
  try {
    site.write('dist/index.html', '<a href="/about">Generated</a>');
    site.write('.stacki/preview/index.html', '<a href="/about">Generated</a>');
    const change = parsePageRename({ kind: 'folder', from: 'about', to: 'company' });
    const planned = planPageRename(site.root, change);
    assert.ok(planned.ok);
    assert.ok(applyPageRename(planned.value, desktopRenameWriter()).ok);
    assert.match(site.read('dist/index.html'), /\/about/);
    assert.match(site.read('.stacki/preview/index.html'), /\/about/);
    fs.symlinkSync(path.join(site.root, 'src/pages/company'), path.join(site.root, 'linked'), 'junction');
    assert.throws(() => planPageRename(site.root, { ...change, from: 'company', to: 'about' }), /symbolic link/);
  } finally {
    site.close();
  }
});
