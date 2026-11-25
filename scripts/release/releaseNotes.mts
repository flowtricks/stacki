// The docs/releases.md entry for a version, generated from the commit subjects since the last
// release. Deterministic by construction: the same commits always give the same text, byte for
// byte, so a second run of prepare.mts finds nothing to change.
//
// Subjects follow the conventional-commit form the commit-msg hook enforces
// (`type(scope): description`). Each type maps to one user-facing section, the sections come in a
// fixed order, the subjects inside a section keep commit order (oldest first), and repeats are
// dropped. Release bookkeeping (`chore(release)`) and test-only commits (`test:`) are noise for a
// reader of the notes, so they are filtered; everything else is listed, so nothing risky is hidden.

import { assert } from '../policy/assert.mts';
import { fail, ok, type Result } from './releaseResult.mts';
import { parseVersion } from './releaseVersion.mts';

export const NOTES_LIMITS = {
  /** Commits read for one release; a release is tens of commits. */
  commitsMax: 1_000,
  subjectCharsMax: 200,
  /** A hand-written override from the workflow's notes input. */
  overrideCharsMax: 4_000,
} as const satisfies Record<string, number>;

export interface CommitSubject {
  readonly subject: string;
}

export type NotesSection = 'Features' | 'Fixes' | 'Performance' | 'Changes under the hood' | 'Documentation' | 'CI and build' | 'Maintenance' | 'Reverts' | 'Other';

// The order sections appear in: what a user notices first.
export const SECTION_ORDER: readonly NotesSection[] = [
  'Features',
  'Fixes',
  'Performance',
  'Changes under the hood',
  'Documentation',
  'CI and build',
  'Maintenance',
  'Reverts',
  'Other',
];

const SECTION_BY_TYPE: Readonly<Record<string, NotesSection>> = {
  feat: 'Features',
  fix: 'Fixes',
  perf: 'Performance',
  refactor: 'Changes under the hood',
  docs: 'Documentation',
  ci: 'CI and build',
  build: 'CI and build',
  chore: 'Maintenance',
  style: 'Maintenance',
  revert: 'Reverts',
};

const CONVENTIONAL = /^([a-z]+)(?:\(([a-z0-9][a-z0-9-]*)\))?!?: (.+)$/;

export interface ClassifiedSubject {
  readonly section: NotesSection;
  readonly text: string;
}

/** The section and display text of one subject, or undefined when it is noise for a reader. */
export function classifySubject(subject: string): ClassifiedSubject | undefined {
  const trimmed = subject.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  const match = CONVENTIONAL.exec(trimmed);
  if (match === null) {
    return { section: 'Other', text: trimmed };
  }
  const [, type = '', scope, description = ''] = match;
  if (type === 'test') {
    return undefined;
  }
  if (type === 'chore' && scope === 'release') {
    return undefined;
  }
  const section = SECTION_BY_TYPE[type] ?? 'Other';
  return { section, text: scope === undefined ? description : `${scope}: ${description}` };
}

/** The grouped bullets for these subjects, oldest first in each section, each listed once. */
export function groupSubjects(subjectsNewestFirst: readonly CommitSubject[]): ReadonlyMap<NotesSection, readonly string[]> {
  assert(subjectsNewestFirst.length <= NOTES_LIMITS.commitsMax, 'groupSubjects: commits are bounded');
  const grouped = new Map<NotesSection, string[]>();
  // Git lists newest first; a reader follows a release in the order it was built.
  for (const commit of [...subjectsNewestFirst].reverse()) {
    const classified = classifySubject(commit.subject.slice(0, NOTES_LIMITS.subjectCharsMax));
    if (classified === undefined) {
      continue;
    }
    const entries = grouped.get(classified.section) ?? [];
    if (!entries.includes(classified.text)) {
      entries.push(classified.text);
    }
    grouped.set(classified.section, entries);
  }
  return grouped;
}

/** The validated hand-written body, or why it cannot go into the notes. */
export function parseNotesOverride(text: string): Result<string | undefined> {
  const normalized = text.replace(/\r\n?/g, '\n').trim();
  if (normalized.length === 0) {
    return ok(undefined);
  }
  if (normalized.length > NOTES_LIMITS.overrideCharsMax) {
    return fail('notes-too-long', `The notes override exceeds ${NOTES_LIMITS.overrideCharsMax} characters.`);
  }
  // A heading inside the body would start a new release entry and corrupt the history.
  if (/^#/m.test(normalized)) {
    return fail('notes-heading', 'The notes override may not contain Markdown headings (lines starting with #).');
  }
  return ok(normalized);
}

export interface NotesInput {
  readonly version: string;
  readonly subjectsNewestFirst: readonly CommitSubject[];
  readonly override: string | undefined;
}

/** The whole entry: heading, the alignment line, then the grouped subjects or the override. */
export function renderNotesEntry(input: NotesInput): string {
  assert(parseVersion(input.version).ok, 'renderNotesEntry: the version is MAJOR.MINOR.PATCH');
  const lines = [`## ${input.version}`, '', `- Desktop, the Studio source bundle and \`create-stacki\` are aligned at ${input.version}.`];
  if (input.override !== undefined) {
    lines.push(...input.override.split('\n').map((line) => (line.length === 0 ? '' : line)));
    return `${lines.join('\n')}\n`;
  }
  const grouped = groupSubjects(input.subjectsNewestFirst);
  if (grouped.size === 0) {
    lines.push('- No user-facing changes: tests and release tooling only.');
  }
  for (const section of SECTION_ORDER) {
    const entries = grouped.get(section);
    if (entries === undefined) {
      continue;
    }
    lines.push(`- **${section}**`);
    lines.push(...entries.map((entry) => `  - ${entry}`));
  }
  return `${lines.join('\n')}\n`;
}

export type NotesInsertion = { readonly kind: 'unchanged' } | { readonly kind: 'inserted'; readonly text: string };

/**
 * The releases.md text with the entry before the newest one. An entry already there for this
 * version is kept as it is: a person may have edited it, and a rerun must not undo that.
 */
export function insertNotesEntry(releasesText: string, version: string, entry: string): Result<NotesInsertion> {
  assert(entry.startsWith(`## ${version}\n`), 'insertNotesEntry: the entry is for this version');
  const lines = releasesText.split('\n');
  const existing = lines.some((line) => line === `## ${version}` || line.startsWith(`## ${version} `));
  if (existing) {
    return ok({ kind: 'unchanged' });
  }
  const first = lines.findIndex((line) => line.startsWith('## '));
  if (first < 0) {
    return fail('notes-layout', 'docs/releases.md has no "## <version>" entry to insert before.');
  }
  const text = [...lines.slice(0, first), ...entry.trimEnd().split('\n'), '', ...lines.slice(first)].join('\n');
  assert(text.length > releasesText.length, 'insertNotesEntry: the text grew');
  return ok({ kind: 'inserted', text });
}
