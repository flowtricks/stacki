// Goal: the Instructions panel's contract sorts every Markdown path into the
// section its agents expect (skills, rules, docs), reads a skill's frontmatter
// only when it names the skill and says what it is for, splits frontmatter
// without moving a byte, and keeps `.stacki/instructions.json` bounded and
// anchored: a hidden path hides itself and everything below it and nothing else,
// and a pattern reaches as far as its `*` and `**` say.
// Method: table tests over paths, parsed frontmatter values and settings files:
// known-good shapes pass, each known-bad shape fails with its message pinned,
// and each bound is tried at and just past its limit. Glob matching is probed on
// both sides of every folder boundary. The listing parser is checked for the
// invariants main must keep (section by path, skill meta only on skills).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  INSTRUCTION_LIMITS,
  EMPTY_INSTRUCTION_SETTINGS,
  classifyInstruction,
  fileNameProblem,
  hiddenMatcher,
  instructionSettingsSource,
  isInstructionFileName,
  parseHiddenPattern,
  parseInstructionFilePath,
  parseInstructionListing,
  parseInstructionSettings,
  parseInstructionWriteResult,
  parseSkillMeta,
  readInstructionSettingsSource,
  ruleScaffold,
  skillNameProblem,
  skillScaffold,
  slugName,
  splitFrontmatter,
  withHidden,
  withoutHidden,
  yamlScalar,
} from '#dist/shared/properties/instructions.js';
import { METADATA_FILES, metadataKind, validateMetadata } from '#dist/shared/properties/projectMetadata.js';
import { ACCESS_FEATURES, ACCESS_GROUPS, ADMIN_VIEW, can } from '#dist/shared/properties/projectRoles.js';

test('files sort into skills, rules and docs by their path alone', () => {
  const cases: readonly (readonly [string, string])[] = [
    ['.claude/skills/write-tests/SKILL.md', 'skills'],
    ['.agents/skills/deploy/SKILL.md', 'skills'],
    ['packages/web/.claude/skills/lint/skill.md', 'skills'],
    ['skills/review/SKILL.md', 'skills'],
    // A skill's other files, and a SKILL.md not in a skill folder, are docs.
    ['.claude/skills/write-tests/reference.md', 'docs'],
    ['.claude/skills/SKILL.md', 'docs'],
    ['SKILL.md', 'docs'],
    ['AGENTS.md', 'rules'],
    ['CLAUDE.md', 'rules'],
    ['claude.local.md', 'rules'],
    ['GEMINI.md', 'rules'],
    ['packages/api/AGENTS.md', 'rules'],
    ['.github/copilot-instructions.md', 'rules'],
    ['.github/instructions/react.instructions.md', 'rules'],
    ['.cursor/rules/style.mdc', 'rules'],
    ['.cursor/rules/nested/style.md', 'rules'],
    ['.claude/rules/testing.md', 'rules'],
    ['.windsurf/rules/a.md', 'rules'],
    ['README.md', 'docs'],
    ['docs/contracts.md', 'docs'],
    ['.github/PULL_REQUEST_TEMPLATE.md', 'docs'],
    // Only the root's rule folders are rule folders.
    ['src/.cursor/rules/a.md', 'docs'],
  ];
  for (const [path, section] of cases) {
    assert.equal(classifyInstruction(path), section, path);
  }
});

test('only Markdown is listed, and .mdc only in a rule folder', () => {
  assert.equal(isInstructionFileName('README.md', ''), true);
  assert.equal(isInstructionFileName('Notes.MD', 'docs'), true);
  assert.equal(isInstructionFileName('style.mdc', '.cursor/rules'), true);
  assert.equal(isInstructionFileName('style.mdc', 'docs'), false);
  assert.equal(isInstructionFileName('page.mdx', 'src/content'), false);
  assert.equal(isInstructionFileName('notes.txt', ''), false);
});

test('a skill names itself and says what it is for; anything else says what is missing', () => {
  assert.deepEqual(parseSkillMeta({ name: ' write-tests ', description: 'Writes tests. Use when adding code.' }), {
    kind: 'valid',
    name: 'write-tests',
    description: 'Writes tests. Use when adding code.',
  });
  const invalid: readonly (readonly [unknown, string])[] = [
    [undefined, 'This skill has no frontmatter. Add a name and a description.'],
    [['name'], 'This skill has no frontmatter. Add a name and a description.'],
    ['name: x', 'This skill has no frontmatter. Add a name and a description.'],
    [{ description: 'x' }, 'This skill has no name in its frontmatter.'],
    [{ name: '  ', description: 'x' }, 'This skill has no name in its frontmatter.'],
    [{ name: 42, description: 'x' }, 'This skill has no name in its frontmatter.'],
    [{ name: 'x' }, 'This skill has no description in its frontmatter.'],
    [{ name: 'x', description: ['a'] }, 'This skill has no description in its frontmatter.'],
    [{ name: 'x'.repeat(INSTRUCTION_LIMITS.skillNameCharsMax + 1), description: 'x' }, 'A skill name is at most 64 characters.'],
    [{ name: 'x', description: 'x'.repeat(INSTRUCTION_LIMITS.skillDescriptionCharsMax + 1) }, 'A skill description is at most 1024 characters.'],
  ];
  for (const [input, message] of invalid) {
    assert.deepEqual(parseSkillMeta(input), { kind: 'invalid', message }, JSON.stringify(input));
  }
  // At the bounds, valid.
  assert.equal(parseSkillMeta({ name: 'x'.repeat(64), description: 'd'.repeat(1024) }).kind, 'valid');
});

test('skill names are slugs; a typed name becomes one', () => {
  assert.equal(slugName('  Write Tests!  '), 'write-tests');
  assert.equal(slugName('A--B__c'), 'a-b-c');
  assert.equal(skillNameProblem('write-tests'), undefined);
  assert.equal(skillNameProblem(''), 'Give the skill a name.');
  assert.equal(skillNameProblem('Write'), 'Use lowercase letters, numbers and single hyphens, like "write-tests".');
  assert.equal(skillNameProblem('a--b'), 'Use lowercase letters, numbers and single hyphens, like "write-tests".');
  assert.equal(skillNameProblem('x'.repeat(65)), 'A skill name is at most 64 characters.');
  assert.equal(fileNameProblem('testing.md'), undefined);
  assert.equal(fileNameProblem('a/b'), 'A name cannot hold / \\ : * ? " < > or |.');
  assert.equal(fileNameProblem('.hidden'), 'A name cannot start with a dot.');
  assert.equal(fileNameProblem(' '), 'Give it a name.');
});

test('a scaffolded skill has frontmatter its own parser accepts', () => {
  const source = skillScaffold('write-tests', 'Writes tests: use when adding code.');
  assert.equal(source, '---\nname: write-tests\ndescription: "Writes tests: use when adding code."\n---\n\n# Write Tests\n\n');
  assert.equal(splitFrontmatter(source).yaml, 'name: write-tests\ndescription: "Writes tests: use when adding code."\n');
  assert.equal(ruleScaffold('Testing'), '# Testing\n\n');
  assert.throws(() => skillScaffold('Bad Name', 'x'), /valid name/);
  assert.equal(yamlScalar('plain words'), 'plain words');
  assert.equal(yamlScalar('yes'), '"yes"');
  assert.equal(yamlScalar('- dash'), '"- dash"');
  assert.equal(yamlScalar('a # b'), '"a # b"');
});

test('frontmatter splits without touching a byte, CRLF and unterminated blocks included', () => {
  const cases = [
    '---\nname: a\n---\nbody',
    '---\r\nname: a\r\n---\r\n\r\nbody\r\n',
    '---\nname: a\n...\nbody',
    '---\n---\n',
    '---\nname: a\n',
    'no frontmatter',
    '\n---\nname: a\n---\n',
    '',
  ];
  for (const source of cases) {
    const split = splitFrontmatter(source);
    assert.equal(split.raw + split.body, source, JSON.stringify(source));
  }
  assert.equal(splitFrontmatter('---\r\nname: a\r\n---\r\nbody').yaml, 'name: a\r\n');
  assert.equal(splitFrontmatter('---\nname: a\n').raw, '', 'an unclosed block is body');
  assert.equal(splitFrontmatter('\n---\nname: a\n---\n').raw, '', 'frontmatter starts the file');
  const huge = `---\n${'a: b\n'.repeat(INSTRUCTION_LIMITS.frontmatterCharsMax)}---\nbody`;
  assert.equal(splitFrontmatter(huge).raw, '', 'frontmatter past its bound is read as body');
});

test('hidden paths are normalized, and bad ones fail with their reason', () => {
  assert.equal(parseHiddenPattern(' ./docs/archive/ '), 'docs/archive');
  assert.equal(parseHiddenPattern('**/CHANGELOG.md'), '**/CHANGELOG.md');
  const bad: readonly (readonly [unknown, RegExp])[] = [
    ['', /never empty/],
    ['/', /never empty/],
    ['/etc', /relative to the project/],
    ['C:/x', /relative to the project/],
    ['docs\\a', /uses \//],
    ['docs/../x', /stays inside/],
    ['docs//x', /stays inside/],
    ['a\u0001b', /control characters/],
    ['x'.repeat(INSTRUCTION_LIMITS.patternCharsMax + 1), /at most 256/],
    [42, /Expected string/],
  ];
  for (const [input, message] of bad) {
    assert.throws(() => parseHiddenPattern(input), message, String(input));
  }
  assert.equal(parseHiddenPattern('x'.repeat(INSTRUCTION_LIMITS.patternCharsMax)).length, 256);
});

test('a hidden path hides itself and what is below it, anchored at the root', () => {
  const hides = hiddenMatcher(['docs/archive', 'AGENTS.md', '**/CHANGELOG.md', 'notes/*.draft.md', 'tmp/**', 'v?/old']);
  const cases: readonly (readonly [string, boolean])[] = [
    ['docs/archive', true],
    ['docs/archive/a.md', true],
    ['docs/archive/deep/b.md', true],
    ['docs/archived.md', false],
    ['docs/archive-old/a.md', false],
    ['other/docs/archive/a.md', false],
    ['AGENTS.md', true],
    ['packages/AGENTS.md', false],
    ['CHANGELOG.md', true],
    ['packages/web/CHANGELOG.md', true],
    ['CHANGELOG.md.bak', false],
    ['notes/a.draft.md', true],
    ['notes/deep/a.draft.md', false],
    ['tmp', true],
    ['tmp/x/y.md', true],
    ['tmpx/y.md', false],
    ['v1/old/a.md', true],
    ['v10/old/a.md', false],
  ];
  for (const [path, hidden] of cases) {
    assert.equal(hides(path), hidden, path);
  }
  assert.equal(hiddenMatcher([])('anything.md'), false);
  // Characters that mean something to a regular expression mean only themselves.
  assert.equal(hiddenMatcher(['a+b.(c)'])('a+b.(c)/x.md'), true);
  assert.equal(hiddenMatcher(['a+b.(c)'])('aab.(c)'), false);
});

test('the settings file is versioned, bounded and free of duplicates', () => {
  assert.deepEqual(parseInstructionSettings({ version: 1, hidden: ['docs/archive'] }), { version: 1, hidden: ['docs/archive'] });
  assert.deepEqual(parseInstructionSettings({ version: 1 }), EMPTY_INSTRUCTION_SETTINGS);
  assert.throws(() => parseInstructionSettings({ version: 2, hidden: [] }), /Unsupported instructions settings version/);
  assert.throws(() => parseInstructionSettings({ version: 1, hidden: ['a', 'a'] }), /listed twice/);
  assert.throws(() => parseInstructionSettings({ version: 1, hidden: 'a' }), /Expected/);
  const many = Array.from({ length: INSTRUCTION_LIMITS.hiddenMax }, (_, index) => `p${index}`);
  assert.equal(parseInstructionSettings({ version: 1, hidden: many }).hidden.length, 200);
  assert.throws(() => parseInstructionSettings({ version: 1, hidden: [...many, 'one-more'] }), /At most 200/);
  assert.deepEqual(readInstructionSettingsSource(undefined), { ok: true, value: EMPTY_INSTRUCTION_SETTINGS });
  assert.equal(readInstructionSettingsSource('{').ok, false);
  assert.deepEqual(readInstructionSettingsSource('x'.repeat(INSTRUCTION_LIMITS.settingsCharsMax + 1)), {
    ok: false,
    error: '.stacki/instructions.json is larger than 65536 characters.',
  });
});

test('adding and removing hidden paths round-trips through the file', () => {
  const added = withHidden(EMPTY_INSTRUCTION_SETTINGS, './docs/archive/');
  assert.ok(added.ok);
  assert.deepEqual(added.value.hidden, ['docs/archive']);
  const again = withHidden(added.value, 'docs/archive');
  assert.ok(again.ok);
  assert.equal(again.value, added.value, 'a path already hidden leaves the settings as they are');
  assert.deepEqual(withHidden(added.value, '../x'), { ok: false, error: 'A hidden path stays inside the project.' });
  const source = instructionSettingsSource(added.value);
  assert.equal(source, '{\n  "version": 1,\n  "hidden": [\n    "docs/archive"\n  ]\n}\n');
  assert.deepEqual(readInstructionSettingsSource(source), { ok: true, value: added.value });
  assert.deepEqual(withoutHidden(added.value, 'docs/archive'), EMPTY_INSTRUCTION_SETTINGS);
  const full = { version: 1 as const, hidden: Array.from({ length: INSTRUCTION_LIMITS.hiddenMax }, (_, index) => `p${index}`) };
  assert.deepEqual(withHidden(full, 'more'), { ok: false, error: 'A project hides at most 200 paths.' });
});

test('the settings are a project metadata kind validated at the same boundary', () => {
  assert.equal(METADATA_FILES.instructions, '.stacki/instructions.json');
  assert.equal(metadataKind('instructions'), 'instructions');
  validateMetadata('instructions', instructionSettingsSource({ version: 1, hidden: ['a'] }));
  assert.throws(() => validateMetadata('instructions', '{"version":1,"hidden":["../a"]}'), /stays inside/);
});

test('the listing parser holds main to its invariants', () => {
  const good = {
    files: [
      { path: '.claude/skills/a/SKILL.md', section: 'skills', sizeBytes: 10, skill: { kind: 'valid', name: 'a', description: 'd' } },
      { path: 'AGENTS.md', section: 'rules', sizeBytes: 10 },
    ],
    folders: ['.claude/rules'],
    truncated: false,
  };
  const listing = parseInstructionListing(good);
  assert.equal(listing.files.length, 2);
  assert.equal(listing.files[1]?.skill, undefined);
  assert.ok(Object.hasOwn(listing.files[1] ?? {}, 'skill'), 'every entry carries its skill field');
  assert.throws(() => parseInstructionListing({ ...good, files: [{ path: 'AGENTS.md', section: 'docs', sizeBytes: 1 }] }), /wrong section/);
  assert.throws(
    () => parseInstructionListing({ ...good, files: [{ path: '.claude/skills/a/SKILL.md', section: 'skills', sizeBytes: 1 }] }),
    /skill frontmatter/,
  );
  assert.throws(() => parseInstructionListing({ ...good, files: [{ path: '../x.md', section: 'docs', sizeBytes: 1 }] }), /inside the project/);
  assert.throws(() => parseInstructionListing({ ...good, files: [{ path: 'a.txt', section: 'docs', sizeBytes: 1 }] }), /Only Markdown/);
  assert.throws(() => parseInstructionListing({ ...good, truncated: 'no' }), /truncated/);
  assert.throws(() => parseInstructionFilePath('/abs.md'), /project-relative/);
  assert.deepEqual(parseInstructionWriteResult({ ok: false, error: { code: 'conflict', message: 'm' } }), {
    ok: false,
    error: { code: 'conflict', message: 'm' },
  });
  assert.throws(() => parseInstructionWriteResult({ ok: false, error: { code: 'other', message: 'm' } }), /Unknown instructions write failure/);
});

test('the panel and its editing are role features; editing needs the panel', () => {
  for (const feature of ['panel:instructions', 'instructions:edit', 'settings:instructions'] as const) {
    assert.ok(ACCESS_FEATURES.includes(feature), feature);
    assert.ok(
      ACCESS_GROUPS.some((group) => group.features.some((entry) => entry.feature === feature)),
      `${feature} has a Roles toggle`,
    );
  }
  assert.equal(can(ADMIN_VIEW, 'instructions:edit'), true);
  const editorOnly = { id: 'writer', name: 'Writer', isAdmin: false, features: new Set(['instructions:edit'] as const), appPermissions: {}, pinnedApps: [] };
  assert.equal(can(editorOnly, 'instructions:edit'), false, 'a grant without the panel gives nothing');
  const both = { ...editorOnly, features: new Set(['instructions:edit', 'panel:instructions'] as const) };
  assert.equal(can(both, 'instructions:edit'), true);
});
