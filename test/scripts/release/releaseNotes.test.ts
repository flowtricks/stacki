// Goal: the generated release notes are a pure function of the commit subjects: grouped into
// fixed user-facing sections, oldest first, each subject once, release and test noise dropped,
// and a hand-written override that replaces the body but can never break the file's structure.
// Methodology: feed subject lists (including repeats, scopes, breaking marks, non-conventional
// subjects and noise) to the pure functions, compare whole rendered entries byte for byte, render
// twice to prove determinism, and insert into a releases.md text with and without an entry.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifySubject, groupSubjects, insertNotesEntry, NOTES_LIMITS, parseNotesOverride, renderNotesEntry } from '../../../scripts/release/releaseNotes.mts';

const subjects = (list: readonly string[]) => list.map((subject) => ({ subject }));

test('subjects map to sections; release bookkeeping and test-only commits are noise', () => {
  assert.deepEqual(classifySubject('feat(picker): group suggestions'), { section: 'Features', text: 'picker: group suggestions' });
  assert.deepEqual(classifySubject('fix!: drop the old flag'), { section: 'Fixes', text: 'drop the old flag' });
  assert.deepEqual(classifySubject('perf(style): paint in one step'), { section: 'Performance', text: 'style: paint in one step' });
  assert.deepEqual(classifySubject('ci: shard the suites'), { section: 'CI and build', text: 'shard the suites' });
  assert.deepEqual(classifySubject('Merge branch x'), { section: 'Other', text: 'Merge branch x' });
  assert.deepEqual(classifySubject('wip(x): y'), { section: 'Other', text: 'x: y' });
  assert.equal(classifySubject('chore(release): version 1.4.3'), undefined);
  assert.equal(classifySubject('test(style): keep the harness clear'), undefined);
  assert.equal(classifySubject('   '), undefined);
  assert.deepEqual(classifySubject('chore(deps): bump yaml'), { section: 'Maintenance', text: 'deps: bump yaml' });
});

test('grouping keeps commit order (oldest first) and lists a repeated subject once', () => {
  const grouped = groupSubjects(subjects(['fix: b', 'feat: x', 'fix: a', 'fix: b']));
  assert.deepEqual(grouped.get('Fixes'), ['b', 'a']);
  assert.deepEqual(grouped.get('Features'), ['x']);
});

test('the entry is byte-for-byte stable, sections in a fixed order', () => {
  const input = { version: '1.4.4', subjectsNewestFirst: subjects(['docs: runbook', 'fix(picker): reveal', 'feat(release): button', 'chore(release): version 1.4.3']), override: undefined };
  const expected = [
    '## 1.4.4',
    '',
    '- Desktop, the Studio source bundle and `create-stacki` are aligned at 1.4.4.',
    '- **Features**',
    '  - release: button',
    '- **Fixes**',
    '  - picker: reveal',
    '- **Documentation**',
    '  - runbook',
    '',
  ].join('\n');
  assert.equal(renderNotesEntry(input), expected);
  assert.equal(renderNotesEntry(input), renderNotesEntry(input));
});

test('a release with only noise says so instead of an empty body', () => {
  const entry = renderNotesEntry({ version: '1.4.4', subjectsNewestFirst: subjects(['test: x', 'chore(release): version 1.4.3']), override: undefined });
  assert.match(entry, /No user-facing changes/);
});

test('the override replaces the grouped body, is bounded, and may not hold a heading', () => {
  const override = parseNotesOverride('  Fixes the picker.\r\n\r\nNothing else.  ');
  assert.ok(override.ok);
  assert.equal(override.value, 'Fixes the picker.\n\nNothing else.');
  const entry = renderNotesEntry({ version: '1.4.4', subjectsNewestFirst: subjects(['feat: hidden']), override: override.value });
  assert.doesNotMatch(entry, /hidden/);
  assert.match(entry, /aligned at 1\.4\.4\.\nFixes the picker\.\n\nNothing else\.\n$/);
  const empty = parseNotesOverride('   ');
  assert.ok(empty.ok);
  assert.equal(empty.value, undefined);
  assert.ok(!parseNotesOverride('# heading').ok);
  assert.ok(!parseNotesOverride('text\n## 9.9.9').ok);
  assert.ok(!parseNotesOverride('x'.repeat(NOTES_LIMITS.overrideCharsMax + 1)).ok);
  assert.ok(parseNotesOverride('x'.repeat(NOTES_LIMITS.overrideCharsMax)).ok);
});

test('insertion goes before the newest entry, keeps an existing entry, and needs a heading to anchor on', () => {
  const releases = '# Title\n\nIntro.\n\n## 1.4.3 Old\n\n- old\n';
  const entry = renderNotesEntry({ version: '1.4.4', subjectsNewestFirst: subjects(['fix: a']), override: undefined });
  const inserted = insertNotesEntry(releases, '1.4.4', entry);
  assert.ok(inserted.ok);
  assert.equal(inserted.value.kind, 'inserted');
  assert.ok(inserted.value.kind === 'inserted' && inserted.value.text.startsWith('# Title\n\nIntro.\n\n## 1.4.4\n'));
  assert.ok(inserted.value.kind === 'inserted' && inserted.value.text.endsWith('  - a\n\n## 1.4.3 Old\n\n- old\n'));
  const again = insertNotesEntry('## 1.4.4 Hand-edited\n', '1.4.4', entry);
  assert.ok(again.ok);
  assert.equal(again.value.kind, 'unchanged');
  assert.ok(!insertNotesEntry('no headings at all\n', '1.4.4', entry).ok);
  assert.throws(() => insertNotesEntry(releases, '1.4.5', entry), /Assertion failed: insertNotesEntry: the entry is for this version/);
});
