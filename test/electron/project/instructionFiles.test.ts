// Goal: the main process lists every Markdown file a project keeps for agents
// and people, and none it does not (dependencies, build output, Stacki's own
// folder, hidden paths, links); reads a skill's frontmatter, good and bad; and
// writes only through the document actors, refusing a save whose base the disk
// no longer holds, a create over an existing file, and any path that leads out
// of the project. The watcher announces Markdown and settings changes and
// skips the app's own writes.
// Method: build temporary projects on disk and call the real module the IPC
// handlers delegate to (electron/project/instructionFiles.ts), then drive the
// watcher with a fake `fs.watch` that replays events.
import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createInstruction,
  createInstructionFolder,
  instructionPath,
  listInstructions,
  readInstruction,
  readSkillMeta,
  writeInstruction,
} from '#dist/electron/project/instructionFiles.js';
import { concerns, watchInstructions } from '#dist/electron/project/instructionsWatcher.js';

function project(files: Readonly<Record<string, string>>): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-instructions-')));
  for (const [relative, text] of Object.entries(files)) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  return root;
}

const SKILL = '---\nname: write-tests\ndescription: Writes tests. Use when adding code.\n---\n\n# Write tests\n';

test('the listing holds the project Markdown and leaves out what nobody writes', (context) => {
  const root = project({
    'package.json': '{}',
    'AGENTS.md': '# Agents\n',
    'CLAUDE.md': '# Claude\n',
    'README.md': '# Readme\n',
    'docs/guide.md': '# Guide\n',
    'docs/archive/old.md': '# Old\n',
    '.claude/skills/write-tests/SKILL.md': SKILL,
    '.claude/skills/broken/SKILL.md': 'no frontmatter\n',
    '.cursor/rules/style.mdc': 'rule\n',
    '.claude/rules/empty/.keep': '',
    'node_modules/pkg/README.md': 'dependency\n',
    'packages/web/node_modules/pkg/README.md': 'nested dependency\n',
    'dist/README.md': 'build\n',
    '.git/HEAD.md': 'git\n',
    '.stacki/apps/x/README.md': 'app\n',
    '.stacki/instructions.json': '{"version":1,"hidden":["docs/archive"]}',
    'src/pages/index.astro': '---\n---\n',
    'notes.txt': 'not markdown\n',
  });
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.symlinkSync(path.join(root, 'docs'), path.join(root, 'linked-docs'));
  const listing = listInstructions(root);
  assert.deepEqual(
    listing.files.map((file) => `${file.section}:${file.path}`),
    [
      'skills:.claude/skills/broken/SKILL.md',
      'skills:.claude/skills/write-tests/SKILL.md',
      'rules:.cursor/rules/style.mdc',
      'rules:AGENTS.md',
      'rules:CLAUDE.md',
      'docs:docs/guide.md',
      'docs:README.md',
    ],
  );
  assert.deepEqual(listing.folders, ['.claude/rules', '.claude/rules/empty', '.cursor/rules']);
  assert.equal(listing.truncated, false);
  const skill = listing.files.find((file) => file.path.endsWith('write-tests/SKILL.md'));
  assert.deepEqual(skill?.skill, { kind: 'valid', name: 'write-tests', description: 'Writes tests. Use when adding code.' });
  assert.equal(listing.files.find((file) => file.path.endsWith('broken/SKILL.md'))?.skill?.kind, 'invalid');
  assert.equal(listing.files.find((file) => file.path === 'AGENTS.md')?.skill, undefined);
});

test('an invalid settings file hides nothing rather than hiding the panel', (context) => {
  const root = project({ 'package.json': '{}', 'docs/a.md': '# A\n', '.stacki/instructions.json': '{"version":9}' });
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(
    listInstructions(root).files.map((file) => file.path),
    ['docs/a.md'],
  );
});

test('skill frontmatter: good, missing, malformed and incomplete', () => {
  assert.deepEqual(readSkillMeta(SKILL), { kind: 'valid', name: 'write-tests', description: 'Writes tests. Use when adding code.' });
  assert.deepEqual(readSkillMeta('---\nname: deploy\ndescription: >-\n  Ships the site.\n  Use before a release.\n---\n'), {
    kind: 'valid',
    name: 'deploy',
    description: 'Ships the site. Use before a release.',
  });
  assert.deepEqual(readSkillMeta('# No frontmatter\n'), { kind: 'invalid', message: 'This skill has no frontmatter. Add a name and a description.' });
  assert.deepEqual(readSkillMeta('---\nname: x\n---\n'), { kind: 'invalid', message: 'This skill has no description in its frontmatter.' });
  assert.deepEqual(readSkillMeta('---\ndescription: x\n---\n'), { kind: 'invalid', message: 'This skill has no name in its frontmatter.' });
  const malformed = readSkillMeta('---\nname: [unclosed\n---\n');
  assert.equal(malformed.kind, 'invalid');
  assert.match(malformed.kind === 'invalid' ? malformed.message : '', /^The frontmatter is not valid YAML/);
  // An alias bomb is refused by the YAML reader's alias bound, not expanded.
  assert.equal(readSkillMeta('---\na: &a [1]\nname: *a\ndescription: d\n---\n').kind, 'invalid');
});

test('a save is witnessed by its base: a stale one is refused and the disk is untouched', (context) => {
  const root = project({ 'package.json': '{}', 'AGENTS.md': 'one\r\n' });
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const written = writeInstruction(root, 'AGENTS.md', 'two\r\n', 'one\r\n');
  assert.deepEqual(written, { ok: true, value: { source: 'two\r\n' } });
  assert.equal(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), 'two\r\n');
  const stale = writeInstruction(root, 'AGENTS.md', 'three\n', 'one\r\n');
  assert.equal(stale.ok, false);
  assert.equal(stale.ok ? '' : stale.error.code, 'conflict');
  assert.equal(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), 'two\r\n');
  // Writing what is already there writes nothing, and succeeds.
  const mtime = fs.statSync(path.join(root, 'AGENTS.md')).mtimeMs;
  assert.deepEqual(writeInstruction(root, 'AGENTS.md', 'two\r\n', 'two\r\n'), { ok: true, value: { source: 'two\r\n' } });
  assert.equal(fs.statSync(path.join(root, 'AGENTS.md')).mtimeMs, mtime);
});

test('creating never overwrites; folders are made as needed', (context) => {
  const root = project({ 'package.json': '{}', 'AGENTS.md': 'keep\n' });
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const created = createInstruction(root, '.claude/skills/new-skill/SKILL.md', SKILL);
  assert.deepEqual(created, { ok: true, value: { source: SKILL } });
  const again = createInstruction(root, 'AGENTS.md', 'replaced\n');
  assert.equal(again.ok ? '' : again.error.code, 'exists');
  assert.equal(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), 'keep\n');
  assert.deepEqual(createInstructionFolder(root, '.claude/rules/frontend'), { ok: true, value: { source: '' } });
  assert.ok(fs.statSync(path.join(root, '.claude/rules/frontend')).isDirectory());
  const twice = createInstructionFolder(root, '.claude/rules/frontend');
  assert.equal(twice.ok ? '' : twice.error.code, 'exists');
});

test('no path leads out of the project or into a folder the panel skips', (context) => {
  const outside = project({ 'secret.md': 'outside\n' });
  const root = project({ 'package.json': '{}', 'docs/a.md': '# A\n' });
  context.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });
  fs.symlinkSync(outside, path.join(root, 'escape'));
  fs.symlinkSync(path.join(root, 'docs/a.md'), path.join(root, 'link.md'));
  const refused = (relative: string): string => {
    const target = instructionPath(root, relative);
    return target.ok ? 'accepted' : target.error.message;
  };
  assert.match(refused('escape/secret.md'), /leads outside the project/);
  assert.match(refused('escape/new.md'), /leads outside the project/);
  assert.match(refused('../x.md'), /not a path inside the project/);
  assert.match(refused('node_modules/x/README.md'), /does not list/);
  assert.match(refused('link.md'), /is a link/);
  assert.equal(refused('docs/new/b.md'), 'accepted');
  const read = readInstruction(root, 'escape/secret.md');
  assert.equal(read.ok, false);
  const create = createInstruction(root, 'escape/new.md', 'x');
  assert.equal(create.ok, false);
  assert.equal(fs.existsSync(path.join(outside, 'new.md')), false);
});

test('a file past the size bound is refused rather than read', (context) => {
  const root = project({ 'package.json': '{}' });
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'big.md'), 'x'.repeat(2 * 1024 * 1024 + 1));
  const read = readInstruction(root, 'big.md');
  assert.equal(read.ok ? '' : read.error.code, 'too-large');
});

test('the watcher announces Markdown and settings, and skips the app’s own writes', async () => {
  const sent: unknown[] = [];
  const external: string[] = [];
  let listener: ((event: string, filename: unknown) => void) | undefined;
  const watch = (_folder: string, _options: { readonly recursive: boolean }, callback: (event: string, filename: unknown) => void) => {
    listener = callback;
    return { close: () => {} };
  };
  const root = path.resolve(os.tmpdir(), 'stacki-watch-root');
  const watcher = watchInstructions({
    projectPath: root,
    send: (_channel: string, payload: unknown) => sent.push(payload),
    isSelfWrite: (absolute: string) => absolute.endsWith('SELF.md'),
    noteExternalChange: (absolute: string) => external.push(absolute),
    platform: 'darwin',
    watch,
  });
  assert.ok(listener);
  listener('change', 'AGENTS.md');
  listener('change', path.join('docs', 'guide.md'));
  listener('change', 'SELF.md');
  listener('change', path.join('node_modules', 'x', 'README.md'));
  listener('change', path.join('src', 'index.astro'));
  listener('change', path.join('.stacki', 'instructions.json'));
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.deepEqual(sent, [{ files: ['AGENTS.md', 'docs/guide.md', '.stacki/instructions.json'] }]);
  assert.equal(external.length, 3);
  listener('rename', undefined);
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.deepEqual(sent[1], { files: [] }, 'an unnamed change asks for a fresh listing');
  watcher.close();
  assert.equal(concerns('docs'), true, 'a folder may hold Markdown');
  assert.equal(concerns('styles.css'), false);
});
