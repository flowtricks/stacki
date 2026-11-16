// Goal: a project's content collections open however they are declared and however their entries
// are named. The content config handlers answer every generated shape with a structured result
// (a missing or unrunnable config is a described state, never an exception), and listing a
// collection's entries reads md, mdx, yaml, json and toml files in nested folders with names that
// hold spaces, unicode, brackets and emoji, with CRLF line ends and a byte-order mark.
// Method: generated projects (test/helpers/projectShapes.ts, area `content`) go through the real
// content:config and content:collections handlers in the windowless harness; entry listing is
// driven directly with a glob collection description, since running a real content config
// needs the project's own installed Astro, which a generated fixture never has.
import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { mainHarness } from '../../helpers/mainHarness.ts';
import { buildProject, removeProject } from '../../helpers/projectFixtures.ts';
import { shapes } from '../../helpers/projectShapes.ts';
import { listEntries } from '#dist/electron/content/contentEntries.js';
import { toRecord } from '#dist/shared/core/record.js';

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-contentshapes-user-'));
const harness = mainHarness(userData);
test.after(() => {
  harness.dispose();
  fs.rmSync(userData, { recursive: true, force: true });
});

for (const shape of shapes().filter((candidate) => candidate.area === 'content')) {
  test(`content config answers: ${shape.name}`, async (context) => {
    const built = buildProject(shape.files);
    context.after(() => removeProject(built.root));
    const config = toRecord(await harness.invoke('content:config', { projectPath: built.root, force: true }));
    assert.ok(config !== undefined, 'content:config answers an object');
    const collections = toRecord(await harness.invoke('content:collections', built.root));
    assert.ok(collections !== undefined, 'content:collections answers an object');
    assert.ok(Array.isArray(collections['collections']), 'content:collections lists collections, possibly none');
  });
}

const POST = '---\ntitle: Hello\n---\nBody text\n';

test('entries of every format are listed, nested and oddly named, with their bodies intact', (context) => {
  const built = buildProject({
    'package.json': '{"dependencies":{"astro":"5"}}',
    'src/content/blog/a.md': POST,
    'src/content/blog/b.mdx': POST,
    'src/content/blog/nested/deep/c.md': POST,
    'src/content/blog/my post.md': POST,
    'src/content/blog/日本.md': POST,
    'src/content/blog/🎉.md': POST,
    'src/content/blog/[x].md': POST,
    'src/content/blog/a.b.c.md': POST,
    'src/content/blog/crlf.md': '---\r\ntitle: Win\r\n---\r\nBody\r\n',
    'src/content/blog/bom.md': '﻿---\ntitle: Bom\n---\nBody\n',
    'src/content/blog/empty.md': '',
    'src/content/blog/broken.md': '---\ntitle: [unclosed\n---\nBody\n',
    'src/content/blog/binary.md': new Uint8Array([0, 255, 0, 1]),
    'src/content/blog/looped': { symlink: '..' },
    'src/content/blog/dangling.md': { symlink: 'nowhere.md' },
    'src/content/people/x.yaml': 'name: X\n',
    'src/content/people/y.json': '{"name":"Y"}',
    'src/content/people/z.toml': 'name = "Z"\n',
  });
  context.after(() => removeProject(built.root));
  const blog = listEntries(built.root, { name: 'blog', loader: { kind: 'glob', base: 'src/content/blog', pattern: '**/*.{md,mdx}' } });
  const ids = blog.entries.map((entry) => entry.id).sort();
  for (const id of ['a', 'b', 'nested/deep/c', 'my post', '日本', '🎉', '[x]', 'a.b.c', 'crlf', 'bom']) {
    assert.ok(ids.includes(id), `${id} listed; got ${JSON.stringify(ids)}`);
  }
  const crlf = blog.entries.find((entry) => entry.id === 'crlf');
  assert.equal(toRecord(crlf?.data)?.['title'], 'Win', 'CRLF front matter is read');
  const people = listEntries(built.root, { name: 'people', loader: { kind: 'glob', base: 'src/content/people', pattern: '**/*.{yaml,json,toml}' } });
  assert.deepEqual(people.entries.map((entry) => entry.id).sort(), ['x', 'y', 'z']);
});

test('a collection whose folder is missing, is a file, or is a folder it may not read lists nothing', (context) => {
  const built = buildProject({ 'package.json': '{}', 'src/content/notfolder': 'x' });
  context.after(() => removeProject(built.root));
  for (const base of ['src/content/missing', 'src/content/notfolder']) {
    const result = listEntries(built.root, { name: 'c', loader: { kind: 'glob', base, pattern: '**/*.md' } });
    assert.deepEqual(result.entries, [], base);
  }
});

test('a collection with a custom loader is read-only with a reason, not an error', (context) => {
  const built = buildProject({ 'package.json': '{}' });
  context.after(() => removeProject(built.root));
  const result = listEntries(built.root, { name: 'remote', loader: { kind: 'custom' } });
  assert.equal(result.readOnly, true);
  assert.deepEqual(result.entries, []);
});
