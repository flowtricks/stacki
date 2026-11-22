// Goal: the `@` picker lists the right things in the right order and stays inside
// its bounds: text files only, never dependencies or Stacki's preview, AGENTS.md
// and CLAUDE.md first, Markdown before other files, skills from each agent's known
// folders with the project's winning, and nothing that is not a valid candidate. The
// `/` menu's skill list keeps each agent's copy of a name, stops at `skillListMax`,
// never follows a link out of the project or home folder, and reads only a SKILL.md's
// header however large the file is.
// Methodology: a temporary project and home folder with fixture files and
// SKILL.md files, a fake file lister for ranking and bounds, the real walk for
// the outside-git case, and every result run back through the candidate parser.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { MentionIndex, isMentionableFile, matchScore, parseFrontmatter, rankFiles, readSkills, walkProject } from '#dist/electron/handlers/ai/mentionIndex.js';
import { AI_LIMITS } from '#dist/shared/properties/ai/aiLimits.js';
import { parseMentionCandidates } from '#dist/shared/properties/ai/mentions.js';

function write(root: string, relative: string, text = 'x'): void {
  const file = path.join(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-mentions-project-')));
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-mentions-home-')));
  return { root, home };
}

test('only text files outside dependency, build and preview folders are mentionable', () => {
  for (const good of ['AGENTS.md', 'src/pages/index.astro', 'docs/a.mdx', 'package.json', 'src/styles/site.css', '.claude/skills/x/SKILL.md']) {
    assert.equal(isMentionableFile(good), true, good);
  }
  for (const bad of [
    'node_modules/x/readme.md',
    'a/node_modules/b.md',
    '.git/config',
    'dist/index.html',
    '.astro/types.d.ts',
    '.stacki/preview/index.html',
    'logo.png',
    'archive.zip',
    'LICENSE',
    '../escape.md',
    '/abs.md',
    'a/../b.md',
  ]) {
    assert.equal(isMentionableFile(bad), false, bad);
  }
});

test('ranking: AGENTS.md and CLAUDE.md first, then Markdown, then the rest, each by how well it matches', () => {
  const files = ['src/pages/index.astro', 'docs/index.md', 'notes/AGENTS.md', 'src/components/Hero.astro', 'CLAUDE.md', 'README.md', 'src/data/INDEX.json'];
  assert.deepEqual(rankFiles(files, '').slice(0, 2), ['CLAUDE.md', 'notes/AGENTS.md']);
  assert.deepEqual(rankFiles(files, 'index'), ['docs/index.md', 'src/data/INDEX.json', 'src/pages/index.astro']);
  assert.deepEqual(rankFiles(files, 'agents'), ['notes/AGENTS.md']);
  assert.deepEqual(rankFiles(files, 'zzz'), []);
  assert.deepEqual(rankFiles(files, 'hro'), ['src/components/Hero.astro'], 'letters in order still match, weakly');
  assert.ok(matchScore('a/hero.astro', 'hero') > matchScore('hero/a.astro', 'hero'), 'a name beats a folder');
  assert.ok(matchScore('a/hero.astro', 'hero.astro') > matchScore('a/hero.astro', 'hero'));
  const many = Array.from({ length: AI_LIMITS.mentionResultsMax * 3 }, (_, position) => `docs/page-${position}.md`);
  assert.ok(rankFiles(many, 'page').length <= AI_LIMITS.mentionResultsMax * 2, 'the ranked list is bounded');
});

test('a search lists skills first, then files, within the result bound, all valid candidates', async () => {
  const { root, home } = fixture();
  write(root, 'AGENTS.md');
  write(root, 'src/pages/index.astro');
  write(root, 'gone.md');
  write(root, '.claude/skills/design/SKILL.md', '---\nname: design\ndescription: Make pages look right\n---\nBody');
  write(home, '.claude/skills/design/SKILL.md', '---\nname: design\ndescription: The user copy\n---\n');
  write(home, '.codex/skills/review/SKILL.md', '---\nname: "review"\ndescription: >\n  Review a change\n  carefully\n---\n');
  const lister = async () => [
    'AGENTS.md',
    'src/pages/index.astro',
    'gone.md',
    'logo.png',
    'node_modules/a/b.md',
    ...Array.from({ length: 100 }, (_, position) => `docs/d${position}.md`),
  ];
  fs.rmSync(path.join(root, 'gone.md'));
  write(root, 'docs/exists.md');
  const index = new MentionIndex({ home: () => home, now: () => 1, listFiles: async () => [...(await lister()), 'docs/exists.md'] });
  const all = await index.search(root, '', []);
  assert.ok(all.length <= AI_LIMITS.mentionResultsMax);
  assert.deepEqual(parseMentionCandidates(all), all);
  assert.deepEqual(
    all
      .filter((candidate) => candidate.kind === 'skill')
      .map((candidate) => [candidate.kind === 'skill' ? candidate.name : '', candidate.kind === 'skill' ? candidate.source : '']),
    [
      ['design', 'project'],
      ['review', 'user'],
    ],
    'the project’s skill hides the user’s of the same name',
  );
  assert.equal(all[0]?.kind, 'skill');
  const files = all.filter((candidate) => candidate.kind === 'file').map((candidate) => (candidate.kind === 'file' ? candidate.path : ''));
  assert.equal(files[0], 'AGENTS.md');
  assert.ok(!files.includes('gone.md'), 'a listed file that no longer exists is not offered');
  assert.ok(!files.includes('logo.png') && !files.includes('node_modules/a/b.md'));
  const review = all.find((candidate) => candidate.kind === 'skill' && candidate.name === 'review');
  assert.ok(review?.kind === 'skill');
  assert.equal(review.description, 'Review a change carefully');
  assert.equal(review.path, '~/.codex/skills/review/SKILL.md');
  const onlySkills = await index.search(root, 'rev', ['skill']);
  assert.deepEqual(
    onlySkills.map((candidate) => candidate.kind),
    ['skill'],
  );
  const onlyFiles = await index.search(root, '@agents', ['file']);
  assert.deepEqual(
    onlyFiles.map((candidate) => (candidate.kind === 'file' ? candidate.name : '')),
    ['AGENTS.md'],
    'a leading @ is not part of the query',
  );
});

test('the scan is cached for a short while and forgotten on invalidate; cached projects are bounded', async () => {
  const { root, home } = fixture();
  let scans = 0;
  let clock = 0;
  const index = new MentionIndex({
    home: () => home,
    now: () => clock,
    listFiles: async () => {
      scans += 1;
      return ['a.md'];
    },
  });
  await index.search(root, 'a', []);
  await index.search(root, 'a', []);
  assert.equal(scans, 1);
  clock = AI_LIMITS.mentionCacheMs;
  await index.search(root, 'a', []);
  assert.equal(scans, 2, 'past the cache time it scans again');
  index.invalidate();
  await index.search(root, 'a', []);
  assert.equal(scans, 3);
  for (let position = 0; position <= AI_LIMITS.mentionCachedProjectsMax; position++) {
    await index.search(path.join(root, `p${position}`), 'a', []);
  }
  scans = 0;
  await index.search(path.join(root, 'p0'), 'a', []);
  assert.equal(scans, 1, 'the oldest project’s scan was dropped to hold the bound');
  await assert.rejects(() => index.search('relative/path', 'a', []), /absolute/);
});

test('outside git the walk skips dependency folders, links and the preview, and stays bounded', () => {
  const { root } = fixture();
  write(root, 'src/a.ts');
  write(root, 'node_modules/dep/index.js');
  write(root, '.git/HEAD');
  write(root, '.stacki/preview/p.html');
  write(root, '.stacki/components.json');
  fs.mkdirSync(path.join(root, 'linked'));
  try {
    fs.symlinkSync(root, path.join(root, 'linked', 'loop'));
  } catch {
    // A platform without symlinks has nothing to loop on.
  }
  assert.deepEqual([...walkProject(root)].sort(), ['.stacki/components.json', 'src/a.ts']);
});

test('skills: frontmatter forms, folder-name fallback, bad names and a missing SKILL.md', () => {
  const { root, home } = fixture();
  write(root, '.agents/skills/plain/SKILL.md', 'No frontmatter at all');
  write(root, '.agents/skills/two words/SKILL.md', '---\nname: two words\n---\n');
  write(root, '.agents/skills/empty/notes.md', 'not a skill');
  write(root, '.agents/skills/long/SKILL.md', `---\nname: long\ndescription: ${'d'.repeat(AI_LIMITS.mentionSkillDescriptionCharsMax * 2)}\n---\n`);
  const skills = readSkills(root, home);
  assert.deepEqual(skills.map((skill) => skill.name).sort(), ['long', 'plain']);
  assert.equal(skills.find((skill) => skill.name === 'plain')?.path, '.agents/skills/plain/SKILL.md');
  assert.equal(skills.find((skill) => skill.name === 'long')?.description.length, AI_LIMITS.mentionSkillDescriptionCharsMax);
  assert.deepEqual(
    [...parseFrontmatter('---\nname: x\ndescription: "quoted: yes"\nother: y\n---\nname: no')],
    [
      ['name', 'x'],
      ['description', 'quoted: yes'],
      ['other', 'y'],
    ],
  );
  assert.deepEqual([...parseFrontmatter('name: x')], [], 'no fence, no frontmatter');
  assert.equal(parseFrontmatter('---\nname: first\nname: second\n---').get('name'), 'first');
});

test('skills for the / menu: each agent keeps its own of a name, the @ picker folds them, and the list is bounded and parseable', async () => {
  const { root, home } = fixture();
  write(root, '.claude/skills/lumos-audit/SKILL.md', '---\nname: lumos-audit\ndescription: Audit props\n---\n');
  write(home, '.claude/skills/shared/SKILL.md', '---\nname: shared\ndescription: Claude copy\n---\n');
  write(home, '.codex/skills/shared/SKILL.md', '---\nname: shared\ndescription: Codex copy\n---\n');
  write(home, '.agents/skills/agents-skill/SKILL.md', '---\nname: agents-skill\n---\n');
  write(root, '.codex/skills/codex-project/SKILL.md', '---\nname: codex-project\n---\n');
  const skills = readSkills(root, home);
  assert.deepEqual(
    skills.map((skill) => `${skill.agent}:${skill.source}:${skill.name}`),
    ['claude:project:lumos-audit', 'codex:project:codex-project', 'claude:user:shared', 'codex:user:shared', 'codex:user:agents-skill'],
  );
  const index = new MentionIndex({ home: () => home, now: () => 1, listFiles: async () => [] });
  const list = await index.search(root, '', ['skill']);
  assert.equal(list.filter((candidate) => candidate.name === 'shared').length, 2, 'the / list keeps both agents’ copies');
  assert.deepEqual(parseMentionCandidates(list), list);
  const picker = await index.search(root, '', []);
  assert.equal(picker.filter((candidate) => candidate.name === 'shared').length, 1, 'the @ picker shows a name once');

  const crowded = fixture();
  for (let position = 0; position < AI_LIMITS.skillListMax + 10; position++) {
    write(crowded.home, `.claude/skills/s${String(position).padStart(4, '0')}/SKILL.md`, '---\ndescription: x\n---\n');
  }
  const bounded = await new MentionIndex({ home: () => crowded.home, now: () => 1, listFiles: async () => [] }).search(crowded.root, '', ['skill']);
  assert.equal(bounded.length, AI_LIMITS.skillListMax, 'the / list stops at its bound');
  assert.deepEqual(parseMentionCandidates(bounded), bounded, 'and the reply parser accepts a full list');
  assert.throws(() => parseMentionCandidates([...bounded, ...bounded]), /candidates/, 'a longer reply is refused at the boundary');
});

test('skills: a linked folder is read inside its base and skipped when it leads out; an oversize file is read only for its header', () => {
  const { root, home } = fixture();
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-mentions-outside-')));
  write(outside, 'escape/SKILL.md', '---\nname: escape\n---\n');
  write(root, 'shared-skills/linked/SKILL.md', '---\nname: linked\n---\n');
  fs.mkdirSync(path.join(root, '.claude', 'skills'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude', 'skills'), { recursive: true });
  try {
    fs.symlinkSync(path.join(outside, 'escape'), path.join(root, '.claude', 'skills', 'escape'));
    fs.symlinkSync(path.join(root, 'shared-skills', 'linked'), path.join(root, '.claude', 'skills', 'linked'));
    fs.symlinkSync(path.join(outside, 'escape'), path.join(home, '.claude', 'skills', 'escape-home'));
    fs.symlinkSync(path.join(root, 'missing'), path.join(root, '.claude', 'skills', 'broken'));
  } catch {
    return; // A platform without symlinks has no link to escape through.
  }
  write(root, '.claude/skills/huge/SKILL.md', `---\nname: huge\ndescription: big\n---\n${'x'.repeat(5 * 1024 * 1024)}`);
  write(root, '.claude/skills/late/SKILL.md', `---\n${'# filler\n'.repeat(2000)}name: late-name\n---\n`);
  const names = readSkills(root, home).map((skill) => skill.name);
  assert.ok(names.includes('linked'), 'a link inside the project is read');
  assert.ok(!names.includes('escape'), 'a link out of the project is skipped');
  assert.ok(!names.includes('escape-home'), 'a link out of the home folder is skipped');
  assert.ok(!names.includes('broken'), 'a broken link is no skill');
  assert.ok(names.includes('huge'), 'a large SKILL.md still lists by its header');
  assert.ok(!names.includes('late-name'), 'frontmatter past the header bound is not read');
  assert.ok(names.includes('late'), 'such a skill falls back to its folder name');
});
