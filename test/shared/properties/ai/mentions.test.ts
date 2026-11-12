// Goal: a mention chip means the same in a draft, a prompt, a candidate and the
// stored transcript, and nothing that could leave the project, exceed a bound or
// pass for another kind gets through any of those four doors.
// Methodology: known-good values of every chip kind through each parser, the
// draft/parts conversions as round trips, then each known-bad shape (wrong kind,
// `..` and absolute paths, over-long text, too many chips) one at a time.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AI_LIMITS } from '#dist/shared/properties/ai/aiLimits.js';
import {
  isProjectRelativePath,
  parseDraftSegments,
  parseMentionCandidate,
  parseMentionCandidates,
  parseMentionChip,
  parseMentionKinds,
  parsePromptParts,
  plainTextOf,
  promptPartsOf,
  type ComposerSegments,
} from '#dist/shared/properties/ai/mentions.js';

const file = { kind: 'file', path: 'src/pages/index.astro', name: 'index.astro' } as const;
const skill = { kind: 'skill', name: 'frontend-design', source: 'user', path: '~/.claude/skills/frontend-design/SKILL.md' } as const;
const builtin = { kind: 'builtin', id: 'app-builder', title: 'App builder instructions' } as const;

test('every chip kind parses, and a draft round-trips through parts and plain text', () => {
  for (const chip of [file, skill, builtin]) {
    assert.deepEqual(parseMentionChip(chip), chip);
  }
  const segments: ComposerSegments = [
    { kind: 'chip', chip: builtin },
    { kind: 'text', text: ' fix ' },
    { kind: 'text', text: 'the ' },
    { kind: 'chip', chip: file },
    { kind: 'text', text: ' with ' },
    { kind: 'chip', chip: skill },
  ];
  const stored = parseDraftSegments(JSON.parse(JSON.stringify(segments)));
  assert.ok(stored.ok);
  assert.deepEqual(stored.value, segments);
  assert.equal(plainTextOf(segments), 'App builder instructions fix the @src/pages/index.astro with /frontend-design');
  const parts = promptPartsOf(segments, () => 'INSTRUCTIONS');
  assert.deepEqual(parts, [
    { kind: 'builtin', id: 'app-builder', text: 'INSTRUCTIONS' },
    { kind: 'text', text: ' fix the ' },
    { kind: 'file', path: 'src/pages/index.astro' },
    { kind: 'text', text: ' with ' },
    { kind: 'skill', name: 'frontend-design', source: 'user', path: '~/.claude/skills/frontend-design/SKILL.md' },
  ]);
  assert.deepEqual(parsePromptParts(parts), parts);
});

test('paths: only project-relative forward-slash paths are accepted', () => {
  for (const good of ['a', 'src/a.ts', 'docs/My File.md', '.claude/skills/x/SKILL.md']) {
    assert.equal(isProjectRelativePath(good), true, good);
  }
  for (const bad of ['', '/etc/passwd', '../x', 'a/../b', 'a//b', './a', 'a/.', 'C:/x', 'c:\\x', 'a\\b', 'a\0b', 'x'.repeat(AI_LIMITS.labelCharsMax + 1)]) {
    assert.equal(isProjectRelativePath(bad), false, JSON.stringify(bad));
  }
  assert.throws(() => parseMentionChip({ ...file, path: '../secrets' }), /project-relative/);
  assert.throws(() => parseMentionChip({ ...skill, path: '~/../x' }), /~\/ path/);
  assert.equal(parseMentionChip({ ...skill, path: '.claude/skills/x/SKILL.md', source: 'project' }).kind, 'skill');
});

test('bad chips are refused: unknown kind or id, empty name, bad skill name', () => {
  const bad = [
    { kind: 'link', path: 'a', name: 'a' },
    { kind: 'file', path: 'a', name: '' },
    { kind: 'file', name: 'a' },
    { kind: 'skill', ...{ name: 'two words', source: 'user', path: '~/x' } },
    { kind: 'skill', name: 'x', source: 'team', path: '~/x' },
    { kind: 'builtin', id: 'secrets', title: 'x' },
    { kind: 'builtin', id: 'app-builder', title: '' },
    'file',
    undefined,
  ];
  for (const chip of bad) {
    assert.throws(() => parseMentionChip(chip), Error, JSON.stringify(chip));
  }
});

test('a stored draft that is wrong in any way reads as a failure value, never a throw', () => {
  const chips = (count: number) => Array.from({ length: count }, () => ({ kind: 'chip', chip: file }));
  assert.equal(parseDraftSegments(chips(AI_LIMITS.mentionsMax)).ok, true);
  const bad: readonly unknown[] = [
    'text',
    { kind: 'text' },
    [{ kind: 'text', text: 3 }],
    [{ kind: 'sticker' }],
    [{ kind: 'chip', chip: { kind: 'file', path: '../x', name: 'x' } }],
    [{ kind: 'chip', chip: { kind: 'file', path: '/abs', name: 'x' } }],
    chips(AI_LIMITS.mentionsMax + 1),
    Array.from({ length: AI_LIMITS.composerSegmentsMax + 1 }, () => ({ kind: 'text', text: 'a' })),
    [{ kind: 'text', text: 'x'.repeat(AI_LIMITS.promptCharsMax + 1) }],
    [
      { kind: 'text', text: 'x'.repeat(AI_LIMITS.promptCharsMax) },
      { kind: 'text', text: 'y' },
    ],
  ];
  for (const draft of bad) {
    const result = parseDraftSegments(draft);
    assert.equal(result.ok, false, JSON.stringify(draft).slice(0, 80));
    assert.ok(!result.ok && result.error.message.length > 0);
  }
});

test('prompt parts: bounds at the edge and one past it', () => {
  const part = { kind: 'file', path: 'a.md' };
  assert.equal(parsePromptParts(Array.from({ length: AI_LIMITS.mentionsMax }, () => part)).length, AI_LIMITS.mentionsMax);
  assert.throws(() => parsePromptParts(Array.from({ length: AI_LIMITS.mentionsMax + 1 }, () => part)), /too many mentions/);
  assert.throws(() => parsePromptParts(Array.from({ length: AI_LIMITS.promptPartsMax + 1 }, () => ({ kind: 'text', text: 'a' }))), /exceeds limit/);
  assert.throws(() => parsePromptParts([{ kind: 'text', text: 'x'.repeat(AI_LIMITS.promptCharsMax + 1) }]), /exceeds limit/);
  assert.equal(parsePromptParts([{ kind: 'builtin', id: 'app-builder', text: 'x'.repeat(AI_LIMITS.mentionBuiltinCharsMax) }]).length, 1);
  assert.throws(() => parsePromptParts([{ kind: 'builtin', id: 'app-builder', text: 'x'.repeat(AI_LIMITS.mentionBuiltinCharsMax + 1) }]), /exceeds limit/);
  assert.throws(() => parsePromptParts([{ kind: 'builtin', id: 'app-builder', text: '' }]), /non-empty/);
  assert.throws(() => parsePromptParts([{ kind: 'file', path: '../a' }]), /project-relative/);
  assert.throws(() => parsePromptParts([{ kind: 'image' }]), /unknown kind/);
  assert.throws(() => parsePromptParts('a'), /expected array/);
});

test('candidates and kinds', () => {
  const candidates = [
    { kind: 'file', path: 'AGENTS.md', name: 'AGENTS.md' },
    { kind: 'skill', name: 'a', description: 'd', source: 'project', path: '.claude/skills/a/SKILL.md' },
  ];
  assert.deepEqual(parseMentionCandidates(candidates), candidates);
  assert.throws(() => parseMentionCandidates(Array.from({ length: AI_LIMITS.mentionResultsMax + 1 }, () => candidates[0])), /exceeds limit/);
  assert.throws(() =>
    parseMentionCandidate({ kind: 'skill', name: 'a', description: 'x'.repeat(AI_LIMITS.mentionSkillDescriptionCharsMax + 1), source: 'user', path: '~/a' }),
  );
  assert.throws(() => parseMentionCandidate({ kind: 'file', path: '/etc/hosts', name: 'hosts' }));
  assert.deepEqual(parseMentionKinds(['file']), ['file']);
  assert.throws(() => parseMentionKinds(['file', 'file']), /repeated/);
  assert.throws(() => parseMentionKinds(['folder']), /unknown value/);
});
