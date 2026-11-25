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

/**
 * What a member chip names on its component or element: a prop (with or without one of its values), a slot, an
 * attribute the instance writes that is not a declared prop (`class`, `data-*`, what a `{...rest}` passes on), or
 * an element's short text.
 */
export const COMPONENT_MEMBER_ROLES = ['prop', 'slot', 'attr', 'text'] as const;
export type ComponentMemberRole = (typeof COMPONENT_MEMBER_ROLES)[number];

/**
 * A chip in a message. `path` is project-relative; a user skill's is `~/`-relative, for display only.
 * A `component` chip names a project component by its project-relative file; a `member` chip names one prop,
 * prop value or slot of the component whose file is `component`, and depends on a chip of that component.
 */
export type MentionChip =
  | { readonly kind: 'file'; readonly path: string; readonly name: string }
  | { readonly kind: 'skill'; readonly name: string; readonly source: SkillSource; readonly path: string }
  | { readonly kind: 'builtin'; readonly id: BuiltinChipId; readonly title: string }
  | { readonly kind: 'component'; readonly path: string; readonly name: string }
  | ElementChip
  | CssChip
  | AssetChip
  | ComponentMemberChip;

/** A project CSS variable (`--brand-1`) or class (`hero-title`, without its dot), and the file that defines it when known. */
export type CssChip = { readonly kind: 'css'; readonly target: 'variable' | 'class'; readonly name: string; readonly path: string | undefined };

/** A project asset by its project-relative path; the kind (from the extension) only picks the chip's look. */
export type AssetChip = { readonly kind: 'asset'; readonly assetKind: AssetKind; readonly path: string };

export const ASSET_KINDS = ['image', 'video', 'font'] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

/** The extensions each asset kind takes: a mention of another kind of file is a file mention. */
export const ASSET_EXTENSIONS: Readonly<Record<AssetKind, readonly string[]>> = {
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg'],
  video: ['mp4', 'webm', 'mov'],
  font: ['woff', 'woff2', 'ttf', 'otf'],
};

/** The asset kind a path's extension names, or undefined for any other file. */
export function assetKindOf(path: string): AssetKind | undefined {
  const dot = path.lastIndexOf('.');
  const extension = dot < 0 ? '' : path.slice(dot + 1).toLowerCase();
  return ASSET_KINDS.find((kind) => ASSET_EXTENSIONS[kind].includes(extension));
}

const CSS_VARIABLE = /^--[\p{L}\p{N}_-]{1,200}$/u;
const CSS_CLASS = /^-?[\p{L}_][\p{L}\p{N}_-]{0,200}$/u;

/**
 * A native element on the canvas: its file, its locator in that file's tree (child indexes, `0.2`) and its tag.
 * Its member chips name it by `elementKey` (`src/pages/index.astro#0.2`).
 */
export type ElementChip = { readonly kind: 'element'; readonly path: string; readonly locator: string; readonly tag: string };

/**
 * A prop, prop value, slot, attribute or text of a mentioned component or element; `component` is the owner's
 * reference (a component's path, an element's `elementKey`). `value` exists for a prop or attribute
 * (`prop:variant=large`, `attr:class=card`) and always for text; never for a slot.
 */
export type ComponentMemberChip =
  | { readonly kind: 'member'; readonly component: string; readonly role: 'prop' | 'attr'; readonly name: string; readonly value: string | undefined }
  | { readonly kind: 'member'; readonly component: string; readonly role: 'slot'; readonly name: string; readonly value: undefined }
  | { readonly kind: 'member'; readonly component: string; readonly role: 'text'; readonly name: 'text'; readonly value: string };

/** Component, element and member chips: plain text when sent, so they are bounded apart from the chips the host expands. */
export const REFERENCE_CHIPS_MAX = 96;

/** The reference an element chip sends and its members name it by. */
export function elementKey(chip: Pick<ElementChip, 'path' | 'locator'>): string {
  return `${chip.path}#${chip.locator}`;
}

/** Whether a chip is sent as reference text (component, element, member) rather than expanded by the host. */
export function isReferenceChip(chip: MentionChip): boolean {
  return chip.kind === 'component' || chip.kind === 'element' || chip.kind === 'member' || chip.kind === 'css' || chip.kind === 'asset';
}

const LOCATOR = /^\d{1,6}(?:\.\d{1,6}){0,63}$/;
const TAG = /^[A-Za-z][\w:.-]{0,63}$/;

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
  // i18n-ignore: the words the agent receives for the chip; the chip is shown translated.
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
    case 'component':
      return { kind: 'component', path: relativePath(value['path'], 'chip.path'), name: nonEmpty(value['name'], AI_LIMITS.labelCharsMax, 'chip.name') };
    case 'element': {
      const locator = text(value['locator'], 400, 'chip.locator');
      if (!LOCATOR.test(locator)) {
        throw new Error('chip.locator: expected child indexes');
      }
      const tag = text(value['tag'], 64, 'chip.tag');
      if (!TAG.test(tag)) {
        throw new Error('chip.tag: expected a tag name');
      }
      return { kind: 'element', path: relativePath(value['path'], 'chip.path'), locator, tag };
    }
    case 'css': {
      const target = oneOf(value['target'], ['variable', 'class'] as const, 'chip.target');
      const name = text(value['name'], 202, 'chip.name');
      if (!(target === 'variable' ? CSS_VARIABLE : CSS_CLASS).test(name)) {
        throw new Error('chip.name: expected a CSS variable or class name');
      }
      return { kind: 'css', target, name, path: value['path'] === undefined ? undefined : relativePath(value['path'], 'chip.path') };
    }
    case 'asset': {
      const path = relativePath(value['path'], 'chip.path');
      const assetKind = oneOf(value['assetKind'], ASSET_KINDS, 'chip.assetKind');
      if (assetKindOf(path) !== assetKind) {
        throw new Error('chip.path: the extension is not an asset of that kind');
      }
      return { kind: 'asset', assetKind, path };
    }
    case 'member':
      return parseMemberChip(value);
    default:
      throw new Error('chip.kind: unknown kind');
  }
}

function parseMemberChip(value: Record<string, unknown>): ComponentMemberChip {
  const component = relativePath(value['component'], 'chip.component');
  const name = nonEmpty(value['name'], AI_LIMITS.labelCharsMax, 'chip.name');
  const role = oneOf(value['role'], COMPONENT_MEMBER_ROLES, 'chip.role');
  if (role === 'slot') {
    if (value['value'] !== undefined) {
      throw new Error('chip.value: a slot has no value');
    }
    return { kind: 'member', component, role, name, value: undefined };
  }
  if (role === 'text') {
    if (name !== 'text') {
      throw new Error('chip.name: a text member is named text');
    }
    return { kind: 'member', component, role, name, value: text(value['value'], AI_LIMITS.labelCharsMax, 'chip.value') };
  }
  const memberValue = value['value'] === undefined ? undefined : text(value['value'], AI_LIMITS.labelCharsMax, 'chip.value');
  return { kind: 'member', component, role, name, value: memberValue };
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
    case 'component':
      return referenceToken(chip.path);
    case 'element':
      return referenceToken(elementKey(chip));
    case 'css': {
      const subject = chip.target === 'variable' ? `css:var(${chip.name})` : `css:.${chip.name}`;
      return chip.path === undefined ? subject : `${subject} (${referenceToken(chip.path)})`;
    }
    case 'asset':
      return `asset:${referenceToken(chip.path)}`;
    case 'member':
      return `${referenceToken(chip.component)} ${memberReference(chip)}`;
    default: {
      const exhaustive: never = chip;
      return exhaustive;
    }
  }
}

// ---------------------------------------------------------------------------
// Component references: the compact text a component mention sends
// ---------------------------------------------------------------------------
//
// A component mention reaches the agent as a short reference and nothing else (no type, description,
// schema or file contents): the agent reads the file itself if it needs more.
//
//   component            <path>                  src/components/Hero.astro
//   prop                 prop:<name>             prop:title
//   prop and a value     prop:<name>=<value>     prop:variant=large
//   slot                 slot:<name>             slot:header
//   element              <path>#<locator>        src/pages/index.astro#0.2
//   attribute            attr:<name>=<value>     attr:class=card
//   text                 text=<value>            text="Read more" (always quoted)
//   CSS variable         css:var(<name>) (<file>)  css:var(--brand-1) (src/styles/global.css)
//   CSS class            css:.<name> (<file>)    css:.hero-title (src/styles/global.css)
//   asset                asset:<path>            asset:public/images/hero.png (the path only, never the bytes)
//
// A token that is empty or holds whitespace, a double quote, `=` or a control character is written as a
// JSON string (`prop:label="Read more"`; a path is one token, so `"src/components/My Hero.astro"`), so a
// reference always splits back into the same pieces.
// A member chip right after its component (only whitespace or that component's other members between) is
// written alone; anywhere else it carries its component's path first (`src/components/Hero.astro prop:title`),
// so a member is never ambiguous about which component it belongs to.

const BARE_TOKEN = /^[^\s"=\p{Cc}]+$/u;

/** One token of a reference: the text itself when it is bare, else the text as a JSON string. */
export function referenceToken(value: string): string {
  return BARE_TOKEN.test(value) ? value : JSON.stringify(value);
}

/** A member's own part of a reference, without its component: `prop:variant=large`, `prop:title`, `slot:header`. */
export function memberReference(chip: ComponentMemberChip): string {
  if (chip.role === 'text') {
    return `text=${JSON.stringify(chip.value)}`;
  }
  const head = `${chip.role}:${referenceToken(chip.name)}`;
  return chip.value === undefined ? head : `${head}=${referenceToken(chip.value)}`;
}

/** Whether the member chip at `index` follows its own component chip, with only whitespace or that component's members between. */
function memberIsAnchored(segments: ComposerSegments, index: number, component: string): boolean {
  for (let at = index - 1; at >= 0; at -= 1) {
    const segment = segments[at];
    assert(segment !== undefined, 'memberIsAnchored: the walk stays inside the draft');
    if (segment.kind === 'text') {
      if (segment.text.trim() !== '') {
        return false;
      }
    } else if (segment.chip.kind === 'component') {
      return segment.chip.path === component;
    } else if (segment.chip.kind === 'element') {
      return elementKey(segment.chip) === component;
    } else if (segment.chip.kind !== 'member' || segment.chip.component !== component) {
      return false;
    }
  }
  return false;
}

/** The text that stands for the chip at `index` of a draft: a member's reference depends on what precedes it. */
function chipTextAt(segments: ComposerSegments, index: number): string {
  const segment = segments[index];
  assert(segment !== undefined, 'chipTextAt: the index is inside the draft');
  assert(segment.kind === 'chip', 'chipTextAt: the segment is a chip');
  const chip = segment.chip;
  if (chip.kind !== 'member') {
    return chipPlainText(chip);
  }
  const previous = segments[index - 1];
  // A reference must not run into the word or chip before it.
  const gap = previous === undefined || (previous.kind === 'text' && /\s$/u.test(previous.text)) ? '' : ' ';
  return memberIsAnchored(segments, index, chip.component) ? `${gap}${memberReference(chip)}` : `${gap}${chipPlainText(chip)}`;
}

// ---------------------------------------------------------------------------
// Drafts (browser storage) and the parts a send is made of
// ---------------------------------------------------------------------------

/** A draft read back from storage. Never throws: the caller treats a failure as an empty draft. */
export function parseDraftSegments(input: unknown): Result<ComposerSegments, DraftError> {
  try {
    const values = list(input, AI_LIMITS.composerSegmentsMax, 'draft');
    const segments = values.map(parseSegment);
    const chips = segments.flatMap((segment) => (segment.kind === 'chip' ? [segment.chip] : []));
    const references = chips.filter(isReferenceChip).length;
    if (chips.length - references > AI_LIMITS.mentionsMax || references > REFERENCE_CHIPS_MAX) {
      // i18n-ignore: a diagnostic for a stored draft; the caller treats it as an empty draft.
      return err({ message: 'draft: too many chips' });
    }
    const characters = segments.reduce((total, segment) => total + (segment.kind === 'text' ? segment.text.length : 0), 0);
    if (characters > AI_LIMITS.promptCharsMax) {
      // i18n-ignore: a diagnostic for a stored draft; the caller treats it as an empty draft.
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
  return segments.map((segment, index) => (segment.kind === 'text' ? segment.text : chipTextAt(segments, index))).join('');
}

/**
 * A draft as the parts a prompt carries. Neighbouring text joins into one part. A built-in chip
 * needs its bundled text, which only the renderer holds, so the caller passes it in. A component or
 * member chip is text: its compact reference (above), joined with the text around it, so the host
 * needs no new part and the agent receives only the reference.
 */
export function promptPartsOf(segments: ComposerSegments, builtinText: (id: BuiltinChipId) => string): readonly PromptPart[] {
  assert(segments.length <= AI_LIMITS.composerSegmentsMax, 'promptPartsOf: the draft is bounded');
  const parts: PromptPart[] = [];
  const pushText = (value: string): void => {
    const last = parts[parts.length - 1];
    if (last?.kind === 'text') {
      parts[parts.length - 1] = { kind: 'text', text: last.text + value };
    } else if (value !== '') {
      parts.push({ kind: 'text', text: value });
    }
  };
  segments.forEach((segment, index) => {
    if (segment.kind === 'text') {
      pushText(segment.text);
      return;
    }
    const chip = segment.chip;
    switch (chip.kind) {
      case 'file':
        parts.push({ kind: 'file', path: chip.path });
        break;
      case 'skill':
        parts.push({ kind: 'skill', name: chip.name, source: chip.source, path: chip.path });
        break;
      case 'builtin':
        parts.push({ kind: 'builtin', id: chip.id, text: builtinText(chip.id) });
        break;
      case 'component':
      case 'element':
      case 'css':
      case 'asset':
      case 'member':
        pushText(chipTextAt(segments, index));
        break;
      default: {
        const exhaustive: never = chip;
        return exhaustive;
      }
    }
  });
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

/** The `@` picker's rows (up to `mentionResultsMax`) or the `/` menu's skill list (up to `skillListMax`), whichever is longer. */
export function parseMentionCandidates(input: unknown): readonly MentionCandidate[] {
  const bound = Math.max(AI_LIMITS.mentionResultsMax, AI_LIMITS.skillListMax);
  const candidates = list(input, bound, 'candidates').map(parseMentionCandidate);
  assert(candidates.length <= bound, 'parseMentionCandidates: bounded');
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
