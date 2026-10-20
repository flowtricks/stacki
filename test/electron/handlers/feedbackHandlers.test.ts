// Goal: the Feedback file round-trips through the real main handlers, each
// item carrying a trail resolved from disk; Git never sees the file; the
// project's agent instructions name the file once; and a malformed file is refused.
// Methodology: register main in a windowless VM over a temporary project, write
// two items (one on a live node, one on a dead key) through the document actor,
// read them back, ask Git whether it ignores the file, check CLAUDE.md, then
// corrupt the file and check the read throws.
// A second project keeps an AGENTS.md that CLAUDE.md imports: only AGENTS.md changes.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { mainHarness } from '../../helpers/mainHarness.ts';
import { toRecord } from '#dist/shared/core/record.js';

const item = (id: string, key: string) => ({
  id,
  keys: [key],
  label: 'h1',
  note: `Note ${id}`,
  createdAt: '2026-10-20T10:31:00Z',
  done: false,
});

test('feedback writes resolve trails, create .stacki/, and read back', async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-feedback-'));
  fs.mkdirSync(path.join(root, 'src/pages'), { recursive: true });
  fs.mkdirSync(path.join(root, 'user'));
  fs.writeFileSync(path.join(root, 'package.json'), '{"dependencies":{"astro":"*"}}');
  fs.writeFileSync(path.join(root, 'src/pages/index.astro'), '<main>\n  <h1>Hi</h1>\n</main>\n');
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  const harness = mainHarness(path.join(root, 'user'));
  context.after(() => {
    harness.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await harness.invoke('project:scan', root);

  const items = [item('live', 'src/pages/index.astro#0'), item('dead', 'src/pages/index.astro#9')];
  const written = toRecord(await harness.invoke('feedback:write', { projectPath: root, items }));
  const file = path.join(root, '.stacki/feedback.json');
  assert.ok(fs.existsSync(file), 'the write created .stacki/feedback.json');
  const read = toRecord(await harness.invoke('feedback:read', { projectPath: root }));
  assert.deepEqual(read, written, 'a read returns what the write did');
  const trails = (Array.isArray(read?.['items']) ? read['items'] : []).map(
    (entry: unknown) => toRecord(entry)?.['trail'],
  );
  assert.deepEqual(trails, [['src/pages/index.astro:1-3'], ['src/pages/index.astro']]);

  // The notes are the editor's, not the site's: Git ignores them, so they never
  // reach a commit, while the rest of `.stacki/` stays the project's to track.
  const ignored = execFileSync('git', ['check-ignore', '.stacki/feedback.json'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(ignored.trim(), '.stacki/feedback.json');

  // An agent started in the project finds the file: CLAUDE.md names it, once.
  const claude = fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8');
  assert.match(claude, /^## Stacki feedback\n/);
  assert.match(claude, /`\.stacki\/feedback\.json`/);
  await harness.invoke('feedback:write', { projectPath: root, items });
  assert.equal(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8'), claude, 'written once');

  fs.writeFileSync(file, '{"version":2,"items":[]}');
  await assert.rejects(harness.invoke('feedback:read', { projectPath: root }), /version 1/);
  fs.rmSync(file);
  assert.deepEqual(await harness.invoke('feedback:read', { projectPath: root }), { items: [] });
});

test('a kept AGENTS.md gets the note, not the CLAUDE.md importing it', async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-feedback-agents-'));
  fs.mkdirSync(path.join(root, 'src/pages'), { recursive: true });
  fs.mkdirSync(path.join(root, 'user'));
  fs.writeFileSync(path.join(root, 'package.json'), '{"dependencies":{"astro":"*"}}');
  fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Rules');
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), '@AGENTS.md\n');
  const harness = mainHarness(path.join(root, 'user'));
  context.after(() => {
    harness.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await harness.invoke('project:scan', root);
  await harness.invoke('feedback:write', { projectPath: root, items: [] });
  assert.match(
    fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'),
    /^# Rules\n\n## Stacki feedback/,
  );
  assert.equal(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8'), '@AGENTS.md\n');
});
