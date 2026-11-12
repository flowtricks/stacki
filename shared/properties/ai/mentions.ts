// Mentions: the chips a person puts in a message with `@` (a project file, a
// skill, the bundled App builder instructions), the draft that holds them
// between keystrokes, the parts a prompt carries to the main process, and the
// candidates the `@` picker lists. One definition for the composer (renderer),
// the draft's browser storage, the `ai:prompt` and `ai:mentions` channels and
// the stored transcript, so a chip means the same everywhere (docs/contracts.md,
// "Composer, mentions and chips").
//
// A draft is read back from browser storage and a prompt arrives over IPC, so
// both are parsed here, with every bound from `AI_LIMITS` checked at the boundary
// (AGENTS.md §2, §10). A bad draft is an expected failure (`Result`) that reads as
// an empty draft; a bad prompt is refused by the channel's parser (it throws, as
// every payload parser does).
import { assert } from '../../core/assert';
import { err, ok, type Result } from '../../core/result';
import { toArray, toRecord } from '../../core/record';
import { AI_LIMITS } from './aiLimits';

/** Instructions Stacki bundles itself; the renderer supplies their text, main never reads them from the project. */
export const BUILTIN_CHIP_IDS = ['app-builder'] as const;
export type BuiltinChipId = (typeof BUILTIN_CHIP_IDS)[number];

export const SKILL_SOURCES = ['project', 'user'] as const;
export type SkillSource = (typeof SKILL_SOURCES)[number];

export const MENTION_KINDS = ['file', 'skill'] as const;
export type MentionKind = (typeof MENTION_KINDS)[number];

/** A chip in a message. `path` is project-relative; a user skill's is `~/`-relative, for display only. */
export type MentionChip =
  | { readonly kind: 'file'; readonly path: string; readonly name: string }
  | { readonly kind: 'skill'; readonly name: string; readonly source: SkillSource; readonly path: string }
  | { readonly kind: 'builtin'; readonly id: BuiltinChipId; readonly title: string };

export type TextSegment = { readonly kind: 'text'; readonly text: string };
export type ChipSegment = { readonly kind: 'chip'; readonly chip: MentionChip };
export type ComposerSegment = TextSegment | ChipSegment;
/** A draft: text runs and chips in the order the person typed them. Bounded by `composerSegmentsMax`. */
export type ComposerSegments = readonly ComposerSegment[];

/** One part of a prompt sent to the main process. A builtin carries its text, because main cannot read the renderer's bundle. */
export type PromptPart =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'file'; readonly path: string }
  | { readonly kind: 'skill'; readonly name: string; readonly source: SkillSource; readonly path: string }
  | { readonly kind: 'builtin'; readonly id: BuiltinChipId; readonly text: string };

/** A row of the `@` picker. */
export type MentionCandidate =
  | { readonly kind: 'file'; readonly path: string; readonly name: string }
  | { readonly kind: 'skill'; readonly name: string; readonly description: string; readonly source: SkillSource; readonly path: string };

export interface DraftError {
  readonly message: string;
}

/** The title a built-in chip shows, and what the plain-text fallback says in its place. */
export const BUILTIN_CHIP_TITLES: Readonly<Record<BuiltinChipId, string>> = {
  'app-builder': 'App builder instructions',
};

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * A project-relative path a chip may carry: forward slashes, no `..`, no leading slash or drive,
 * no NUL, no empty or `.` segment. Why strict: the path later names a file main reads, so
 * the boundary refuses anything that could leave the project before main checks it again.
 */
export function isProjectRelativePath(value: string): boolean {
  if (value.length === 0 || value.length > AI_LIMITS.labelCharsMax || value.includes('\0') || value.includes('\\')) {
    return false;
  }
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) {
    return false;
  }
  return value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/** A skill's display path: project-relative, or `~/`-relative for a user skill. */
export function isSkillDisplayPath(value: string): boolean {
  return value.startsWith('~/') ? isProjectRelativePath(value.slice(2)) : isProjectRelativePath(value);
}

// ---------------------------------------------------------------------------
// Chips
// ---------------------------------------------------------------------------

export function parseMentionChip(input: unknown): MentionChip {
  const value = object(input, 'chip');
  switch (value['kind']) {
    case 'file':
      return { kind: 'file', path: relativePath(value['path'], 'chip.path'), name: nonEmpty(value['name'], AI_LIMITS.labelCharsMax, 'chip.name') };
    case 'skill':
      return {
        kind: 'skill',
        name: skillName(value['name']),
        source: oneOf(value['source'], SKILL_SOURCES, 'chip.source'),
        path: displayPath(value['path'], 'chip.path'),
      };
    case 'builtin': {
      const id = oneOf(value['id'], BUILTIN_CHIP_IDS, 'chip.id');
      return { kind: 'builtin', id, title: nonEmpty(value['title'], AI_LIMITS.labelCharsMax, 'chip.title') };
    }
    default:
      throw new Error('chip.kind: unknown kind');
  }
}

/** What stands in for a chip in the plain-text fallback a prompt carries (old readers and the agent's own history see this). */
export function chipPlainText(chip: MentionChip): string {
  switch (chip.kind) {
    case 'file':
      return `@${chip.path}`;
    case 'skill':
      return `/${chip.name}`;
    case 'builtin':
      return chip.title;
    default: {
      const exhaustive: never = chip;
      return exhaustive;
    }
  }
}

// ---------------------------------------------------------------------------
// Drafts (browser storage) and the parts a send is made of
// ---------------------------------------------------------------------------

/** A draft read back from storage. Never throws: the caller treats a failure as an empty draft. */
export function parseDraftSegments(input: unknown): Result<ComposerSegments, DraftError> {
  try {
    const values = list(input, AI_LIMITS.composerSegmentsMax, 'draft');
    const segments = values.map(parseSegment);
    const chips = segments.filter((segment) => segment.kind === 'chip').length;
    if (chips > AI_LIMITS.mentionsMax) {
      return err({ message: 'draft: too many chips' });
    }
    const characters = segments.reduce((total, segment) => total + (segment.kind === 'text' ? segment.text.length : 0), 0);
    if (characters > AI_LIMITS.promptCharsMax) {
      return err({ message: 'draft: text exceeds limit' });
    }
    assert(segments.length === values.length, 'parseDraftSegments: one segment per entry');
    return ok(segments);
  } catch (error: unknown) {
    // A stored draft is another program's data (older build, edited storage): an expected failure here.
    return err({ message: error instanceof Error ? error.message : String(error) });
  }
}

function parseSegment(input: unknown): ComposerSegment {
  const value = object(input, 'segment');
  if (value['kind'] === 'text') {
    return { kind: 'text', text: text(value['text'], AI_LIMITS.promptCharsMax, 'segment.text') };
  }
  if (value['kind'] === 'chip') {
    return { kind: 'chip', chip: parseMentionChip(value['chip']) };
  }
  throw new Error('segment.kind: unknown kind');
}

/** The draft as one string, each chip as its plain text: the `text` of an `ai:prompt`. */
export function plainTextOf(segments: ComposerSegments): string {
  assert(segments.length <= AI_LIMITS.composerSegmentsMax, 'plainTextOf: the draft is bounded');
  return segments.map((segment) => (segment.kind === 'text' ? segment.text : chipPlainText(segment.chip))).join('');
}

/**
 * A draft as the parts a prompt carries. Neighbouring text joins into one part. A built-in chip
 * needs its bundled text, which only the renderer holds, so the caller passes it in.
 */
export function promptPartsOf(segments: ComposerSegments, builtinText: (id: BuiltinChipId) => string): readonly PromptPart[] {
  assert(segments.length <= AI_LIMITS.composerSegmentsMax, 'promptPartsOf: the draft is bounded');
  const parts: PromptPart[] = [];
  for (const segment of segments) {
    const last = parts[parts.length - 1];
    if (segment.kind === 'text') {
      if (last?.kind === 'text') {
        parts[parts.length - 1] = { kind: 'text', text: last.text + segment.text };
      } else if (segment.text !== '') {
        parts.push({ kind: 'text', text: segment.text });
      }
    } else if (segment.chip.kind === 'file') {
      parts.push({ kind: 'file', path: segment.chip.path });
    } else if (segment.chip.kind === 'skill') {
      parts.push({ kind: 'skill', name: segment.chip.name, source: segment.chip.source, path: segment.chip.path });
    } else {
      parts.push({ kind: 'builtin', id: segment.chip.id, text: builtinText(segment.chip.id) });
    }
  }
  assert(parts.length <= segments.length, 'promptPartsOf: never more parts than segments');
  return parts;
}

export function parsePromptPart(input: unknown): PromptPart {
  const value = object(input, 'part');
  switch (value['kind']) {
    case 'text':
      return { kind: 'text', text: text(value['text'], AI_LIMITS.promptCharsMax, 'part.text') };
    case 'file':
      return { kind: 'file', path: relativePath(value['path'], 'part.path') };
    case 'skill':
      return {
        kind: 'skill',
        name: skillName(value['name']),
        source: oneOf(value['source'], SKILL_SOURCES, 'part.source'),
        path: displayPath(value['path'], 'part.path'),
      };
    case 'builtin':
      return {
        kind: 'builtin',
        id: oneOf(value['id'], BUILTIN_CHIP_IDS, 'part.id'),
        text: nonEmpty(value['text'], AI_LIMITS.mentionBuiltinCharsMax, 'part.text'),
      };
    default:
      throw new Error('part.kind: unknown kind');
  }
}

/** The parts of one prompt: at most `promptPartsMax`, at most `mentionsMax` chips, text within `promptCharsMax` in all. */
export function parsePromptParts(input: unknown): readonly PromptPart[] {
  const parts = list(input, AI_LIMITS.promptPartsMax, 'parts').map(parsePromptPart);
  const chips = parts.filter((part) => part.kind !== 'text').length;
  if (chips > AI_LIMITS.mentionsMax) {
    throw new Error('parts: too many mentions');
  }
  const characters = parts.reduce((total, part) => total + (part.kind === 'text' ? part.text.length : 0), 0);
  if (characters > AI_LIMITS.promptCharsMax) {
    throw new Error('parts: text exceeds limit');
  }
  assert(parts.length <= AI_LIMITS.promptPartsMax, 'parsePromptParts: bounded');
  return parts;
}

// ---------------------------------------------------------------------------
// The picker
// ---------------------------------------------------------------------------

export function parseMentionKinds(input: unknown): readonly MentionKind[] {
  const kinds = list(input, MENTION_KINDS.length, 'kinds').map((entry) => oneOf(entry, MENTION_KINDS, 'kinds'));
  if (new Set(kinds).size !== kinds.length) {
    throw new Error('kinds: repeated kind');
  }
  return kinds;
}

export function parseMentionQuery(input: unknown): string {
  return text(input, AI_LIMITS.mentionQueryCharsMax, 'query');
}

export function parseMentionCandidate(input: unknown): MentionCandidate {
  const value = object(input, 'candidate');
  if (value['kind'] === 'file') {
    return { kind: 'file', path: relativePath(value['path'], 'candidate.path'), name: nonEmpty(value['name'], AI_LIMITS.labelCharsMax, 'candidate.name') };
  }
  if (value['kind'] === 'skill') {
    return {
      kind: 'skill',
      name: skillName(value['name']),
      description: text(value['description'], AI_LIMITS.mentionSkillDescriptionCharsMax, 'candidate.description'),
      source: oneOf(value['source'], SKILL_SOURCES, 'candidate.source'),
      path: displayPath(value['path'], 'candidate.path'),
    };
  }
  throw new Error('candidate.kind: unknown kind');
}

export function parseMentionCandidates(input: unknown): readonly MentionCandidate[] {
  const candidates = list(input, AI_LIMITS.mentionResultsMax, 'candidates').map(parseMentionCandidate);
  assert(candidates.length <= AI_LIMITS.mentionResultsMax, 'parseMentionCandidates: bounded');
  return candidates;
}

// ---------------------------------------------------------------------------
// Bounded readers
// ---------------------------------------------------------------------------

const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function skillName(input: unknown): string {
  const value = text(input, 128, 'skill.name');
  if (!SKILL_NAME.test(value)) {
    throw new Error('skill.name: expected letters, digits, dot, colon, dash or underscore');
  }
  return value;
}

function relativePath(input: unknown, name: string): string {
  const value = text(input, AI_LIMITS.labelCharsMax, name);
  if (!isProjectRelativePath(value)) {
    throw new Error(`${name}: expected a project-relative path`);
  }
  return value;
}

function displayPath(input: unknown, name: string): string {
  const value = text(input, AI_LIMITS.labelCharsMax, name);
  if (!isSkillDisplayPath(value)) {
    throw new Error(`${name}: expected a project-relative or ~/ path`);
  }
  return value;
}

function object(input: unknown, name: string): Record<string, unknown> {
  const value = toRecord(input);
  if (value === undefined) {
    throw new Error(`${name}: expected object`);
  }
  return value;
}

function list(input: unknown, max: number, name: string): readonly unknown[] {
  const values = toArray(input);
  if (values === undefined) {
    throw new Error(`${name}: expected array`);
  }
  if (values.length > max) {
    throw new Error(`${name}: exceeds limit`);
  }
  return values;
}

function text(input: unknown, max: number, name: string): string {
  if (typeof input !== 'string') {
    throw new Error(`${name}: expected string`);
  }
  if (input.length > max) {
    throw new Error(`${name}: exceeds limit`);
  }
  return input;
}

function nonEmpty(input: unknown, max: number, name: string): string {
  const value = text(input, max, name);
  if (value.length === 0) {
    throw new Error(`${name}: expected non-empty text`);
  }
  return value;
}

function oneOf<T extends string>(input: unknown, allowed: readonly T[], name: string): T {
  const found = allowed.find((candidate) => candidate === input);
  if (found === undefined) {
    throw new Error(`${name}: unknown value`);
  }
  return found;
}
