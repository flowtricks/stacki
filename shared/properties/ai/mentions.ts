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
  | ComponentMemberChip
  | CodeChip
  | PageChip;

/** The chips the host expands (reads a file, names a skill, sends bundled instructions): `mentionsMax` bounds them. */
export type HostChip = Extract<MentionChip, { readonly kind: 'file' | 'skill' | 'builtin' }>;
/** The chips sent as short reference text, bounded by `REFERENCE_CHIPS_MAX`. */
export type ReferenceChip = Exclude<MentionChip, HostChip | CodeChip>;
export type CodeOrReferenceChip = Exclude<MentionChip, HostChip>;

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

/** Component, element, member, CSS, asset and page chips: plain text when sent, so they are bounded apart from the chips the host expands. */
export const REFERENCE_CHIPS_MAX = 96;

/** The reference an element chip sends and its members name it by. */
export function elementKey(chip: Pick<ElementChip, 'path' | 'locator'>): string {
  return `${chip.path}#${chip.locator}`;
}

/** Whether a chip is sent as reference text rather than expanded by the host. A code chip is neither: it carries code. */
export function isReferenceChip(chip: MentionChip): chip is ReferenceChip {
  return !isHostChip(chip) && chip.kind !== 'code';
}

export function isHostChip(chip: MentionChip): chip is HostChip {
  return chip.kind === 'file' || chip.kind === 'skill' || chip.kind === 'builtin';
}

/** The first bound a draft's or a prompt's chips pass, named for a parser's message; undefined when they are within all of them. */
export function chipBoundProblem(chips: readonly MentionChip[]): ChipBoundProblem | undefined {
  if (chips.filter(isHostChip).length > AI_LIMITS.mentionsMax) {
    return 'too many mentions';
  }
  if (chips.filter(isReferenceChip).length > REFERENCE_CHIPS_MAX) {
    return 'too many references';
  }
  const code = chips.filter((chip): chip is CodeChip => chip.kind === 'code');
  if (code.length > AI_LIMITS.codeChipsMax) {
    return 'too many code selections';
  }
  return code.reduce((total, chip) => total + chip.code.length, 0) > AI_LIMITS.codeChipsCharsMax ? 'too much code' : undefined;
}

export type ChipBoundProblem = 'too many mentions' | 'too many references' | 'too many code selections' | 'too much code';

const LOCATOR = /^\d{1,6}(?:\.\d{1,6}){0,63}$/;
const TAG = /^[A-Za-z][\w:.-]{0,63}$/;

export type TextSegment = { readonly kind: 'text'; readonly text: string };
export type ChipSegment = { readonly kind: 'chip'; readonly chip: MentionChip };
export type ComposerSegment = TextSegment | ChipSegment;
/** A draft: text runs and chips in the order the person typed them. Bounded by `composerSegmentsMax`. */
export type ComposerSegments = readonly ComposerSegment[];

/**
 * One part of a prompt sent to the main process. A builtin carries its text, because main cannot read the renderer's
 * bundle. A `reference` carries the chip, which the transcript keeps and draws, and the words the agent reads for it.
 */
export type PromptPart =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'reference'; readonly chip: ReferenceChip; readonly text: string }
  | { readonly kind: 'code'; readonly chip: CodeChip }
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
    case 'code':
      return parseCodeChip(value);
    case 'page':
      return parsePageChip(value);
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
    case 'code':
      return codeReadableText(chip);
    case 'page':
      return pageReadableText(chip);
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
    const problem = chipBoundProblem(chips);
    if (problem !== undefined) {
      // i18n-ignore: a diagnostic for a stored draft; the caller treats it as an empty draft.
      return err({ message: `draft: ${problem}` });
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

/** The draft as one string, each chip as its plain text (code on lines of its own): the `text` of an `ai:prompt`. */
export function plainTextOf(segments: ComposerSegments): string {
  assert(segments.length <= AI_LIMITS.composerSegmentsMax, 'plainTextOf: the draft is bounded');
  return joinReadable(
    segments.map((segment, index): ReadablePiece =>
      segment.kind === 'text' ? { text: segment.text, block: false } : { text: chipTextAt(segments, index), block: segment.chip.kind === 'code' },
    ),
  );
}

/**
 * A draft as the parts a prompt carries. Neighbouring text joins into one part. A built-in chip needs its bundled
 * text, which only the renderer holds, so the caller passes it in. A reference chip (component, element, member,
 * CSS, asset, page) is a part of its own that carries both the chip and the words the agent reads for it, so the
 * transcript keeps the chip; the agent receives only the words (nothing else of the file). A code chip carries its snapshot.
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
        parts.push({ kind: 'reference', chip, text: chipTextAt(segments, index) });
        break;
      case 'page':
        parts.push({ kind: 'reference', chip, text: pageAgentText(chip) });
        break;
      case 'code':
        parts.push({ kind: 'code', chip });
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
    case 'reference':
      return { kind: 'reference', chip: parseReferenceChip(value['chip']), text: text(value['text'], AI_LIMITS.promptCharsMax, 'part.text') };
    case 'code': {
      const chip = parseMentionChip(value['chip']);
      if (chip.kind !== 'code') {
        throw new Error('part.chip: expected a code chip');
      }
      return { kind: 'code', chip };
    }
    default:
      throw new Error('part.kind: unknown kind');
  }
}

export function parseReferenceChip(input: unknown): ReferenceChip {
  const chip = parseMentionChip(input);
  if (!isReferenceChip(chip)) {
    throw new Error('chip.kind: expected a reference chip');
  }
  assert(!isHostChip(chip), 'parseReferenceChip: the host never expands a reference');
  return chip;
}

/** The chip a part stands for, or undefined for text. */
function chipOfPart(part: PromptPart): MentionChip | undefined {
  switch (part.kind) {
    case 'text':
      return undefined;
    case 'reference':
    case 'code':
      return part.chip;
    case 'file':
      return { kind: 'file', path: part.path, name: part.path };
    case 'skill':
      return { kind: 'skill', name: part.name, source: part.source, path: part.path };
    case 'builtin':
      return { kind: 'builtin', id: part.id, title: BUILTIN_CHIP_TITLES[part.id] };
    default: {
      const exhaustive: never = part;
      return exhaustive;
    }
  }
}

/** The first chip bound a prompt's parts pass, or undefined: the host checks it again before it reads any file. */
export function promptBoundProblem(parts: readonly PromptPart[]): ChipBoundProblem | undefined {
  assert(parts.length <= AI_LIMITS.promptPartsMax, 'promptBoundProblem: the parts are bounded');
  return chipBoundProblem(parts.map(chipOfPart).filter((chip): chip is MentionChip => chip !== undefined));
}

/** The parts of one prompt: at most `promptPartsMax`, each kind of chip within its bound, text within `promptCharsMax` in all. */
export function parsePromptParts(input: unknown): readonly PromptPart[] {
  const parts = list(input, AI_LIMITS.promptPartsMax, 'parts').map(parsePromptPart);
  const problem = promptBoundProblem(parts);
  if (problem !== undefined) {
    throw new Error(`parts: ${problem}`);
  }
  const characters = parts.reduce((total, part) => total + (part.kind === 'text' || part.kind === 'reference' ? part.text.length : 0), 0);
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
// "Add to chat": the two chips a selection becomes
// ---------------------------------------------------------------------------
//
// A code chip is a snapshot of the code at the moment it was added (unsaved editor text included), with the file and
// lines it came from; a place chip says which file that is, named for what it is (page, layout, component or file)
// and, when it differs, which page was on the canvas. The snapshot travels with the chip: through the draft, the
// queue, the prompt, the stored transcript, Edit and Resend. Nothing reads the file again, so what the agent gets
// is what the person saw.
//
// The two ways a chip is written as text live here, so they cannot drift: readable text (what Copy gives and what
// a message's plain `text` holds) and the agent's text (what the prompt carries). Code is fenced for the agent with
// a fence longer than any run of backticks inside it, so no code can close its own block.

export const PLACE_ROLES = ['page', 'layout', 'component', 'file'] as const;
export type PlaceRole = (typeof PLACE_ROLES)[number];

/** Lines of `path` as they read when the chip was made (1-based, inclusive). `element`: the selected element's name, if one was. */
export interface CodeChip {
  readonly kind: 'code';
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly element: string | undefined;
  readonly code: string;
}

/** The file a selection is in. `viewedOn`: the page that was on the canvas, when it is another file. */
export interface PageChip {
  readonly kind: 'page';
  readonly role: PlaceRole;
  readonly path: string;
  readonly name: string;
  readonly route: string | undefined;
  readonly viewedOn: string | undefined;
}

/** A line number no real source file reaches; past it a stored value is not a line. */
const LINE_MAX = 10_000_000;
const ELEMENT_NAME = /^[A-Za-z][\w:.-]{0,127}$/;

/** Whether `name` can label a code chip as the element it came from; a frontmatter or fragment selection has none. */
export function isElementName(name: string): boolean {
  return ELEMENT_NAME.test(name);
}

function parseCodeChip(value: Record<string, unknown>): CodeChip {
  const code = value['code'];
  if (typeof code !== 'string') {
    throw new Error('chip.code: expected string');
  }
  if (code.length === 0) {
    throw new Error('chip.code: expected non-empty text');
  }
  if (code.length > AI_LIMITS.codeChipCharsMax) {
    throw new Error('chip.code: exceeds limit');
  }
  const startLine = lineNumber(value['startLine'], 'chip.startLine');
  const endLine = lineNumber(value['endLine'], 'chip.endLine');
  if (endLine < startLine) {
    throw new Error('chip.endLine: before the first line');
  }
  const element = value['element'];
  if (element !== undefined && (typeof element !== 'string' || !ELEMENT_NAME.test(element))) {
    throw new Error('chip.element: expected an element name');
  }
  const path = relativePath(value['path'], 'chip.path');
  assert(code.length <= AI_LIMITS.codeChipCharsMax, 'parseCodeChip: the code is within its bound');
  return { kind: 'code', path, startLine, endLine, element, code };
}

function parsePageChip(value: Record<string, unknown>): PageChip {
  const role = PLACE_ROLES.find((candidate) => candidate === value['role']);
  if (role === undefined) {
    throw new Error('chip.role: unknown value');
  }
  const name = boundedText(value['name'], 'chip.name');
  if (name.length === 0) {
    throw new Error('chip.name: expected non-empty text');
  }
  assert(PLACE_ROLES.includes(role), 'parsePageChip: a known role');
  return {
    kind: 'page',
    role,
    path: relativePath(value['path'], 'chip.path'),
    name,
    route: value['route'] === undefined ? undefined : boundedText(value['route'], 'chip.route'),
    viewedOn: value['viewedOn'] === undefined ? undefined : relativePath(value['viewedOn'], 'chip.viewedOn'),
  };
}

function lineNumber(input: unknown, name: string): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 1 || input > LINE_MAX) {
    throw new Error(`${name}: expected a line number`);
  }
  assert(Number.isSafeInteger(input), 'lineNumber: a whole line');
  return input;
}

function boundedText(input: unknown, name: string): string {
  if (typeof input !== 'string') {
    throw new Error(`${name}: expected string`);
  }
  if (input.length > AI_LIMITS.labelCharsMax) {
    throw new Error(`${name}: exceeds limit`);
  }
  return input;
}

// ---------------------------------------------------------------------------
// As text
// ---------------------------------------------------------------------------

/** "line 12" or "lines 116–124". */
export function linesText(chip: Pick<CodeChip, 'startLine' | 'endLine'>): string {
  assert(chip.startLine <= chip.endLine, 'linesText: the lines run forward');
  // i18n-ignore: part of a message's plain text, which the agent reads and Copy gives.
  return chip.startLine === chip.endLine ? `line ${chip.startLine}` : `lines ${chip.startLine}–${chip.endLine}`;
}

/** The readable form of a code chip: a short location line, then the code exactly as captured. */
export function codeReadableText(chip: CodeChip): string {
  assert(chip.code.length > 0, 'codeReadableText: a code chip holds code');
  return `${chip.path}, ${linesText(chip)}\n${chip.code}`;
}

/** The readable form of a place chip: its name and file. */
export function pageReadableText(chip: PageChip): string {
  assert(chip.name.length > 0, 'pageReadableText: a place has a name');
  return `${chip.name} (${chip.path})`;
}

/** The longest run of backticks anywhere in `code`, so a fence can be made longer than all of them. */
function longestBacktickRun(code: string): number {
  let longest = 0;
  for (const match of code.matchAll(/`+/g)) {
    longest = Math.max(longest, match[0].length);
  }
  assert(longest <= code.length, 'longestBacktickRun: a run is part of the code');
  return longest;
}

/** `code` as a Markdown fenced block that nothing inside it can close. */
export function fencedCode(code: string, language: string): string {
  const fence = '`'.repeat(Math.max(3, longestBacktickRun(code) + 1));
  const ending = code.endsWith('\n') ? '' : '\n';
  const block = `${fence}${language}\n${code}${ending}${fence}`;
  assert(block.includes(code), 'fencedCode: the code is carried whole');
  return block;
}

/** The fence's language word: the file's extension, when it is a plain one. */
export function fenceLanguage(path: string): string {
  assert(path.length > 0, 'fenceLanguage: a file is named');
  const extension = /\.([A-Za-z0-9]{1,12})$/.exec(path)?.[1];
  return extension === undefined ? '' : extension.toLowerCase();
}

/** What the agent receives for a code chip: where it is from, and the captured code, fenced. */
export function codeAgentText(chip: CodeChip): string {
  assert(chip.startLine <= chip.endLine, 'codeAgentText: the lines run forward');
  const lines = chip.startLine === chip.endLine ? `${chip.startLine}` : `${chip.startLine}-${chip.endLine}`;
  const element = chip.element === undefined ? '' : ` element=${JSON.stringify(chip.element)}`;
  // i18n-ignore: sent to the agent, never shown.
  return `<selected-code file=${JSON.stringify(chip.path)} lines="${lines}"${element}>\n${fencedCode(chip.code, fenceLanguage(chip.path))}\n</selected-code>`;
}

/** What the agent receives for a place chip: what the file is, its path, its route and the page it was seen on. */
export function pageAgentText(chip: PageChip): string {
  assert(chip.path.length > 0, 'pageAgentText: a place names its file');
  const facts = [
    `file ${JSON.stringify(chip.path)}`,
    ...(chip.route === undefined ? [] : [`route ${JSON.stringify(chip.route)}`]),
    // i18n-ignore: sent to the agent, never shown.
    ...(chip.viewedOn === undefined ? [] : [`viewed on the page ${JSON.stringify(chip.viewedOn)}`]),
  ];
  return `[${chip.role} ${JSON.stringify(chip.name)}: ${facts.join(', ')}]`;
}

/** One stretch of a message's readable text; a `block` stands on lines of its own. */
export interface ReadablePiece {
  readonly text: string;
  readonly block: boolean;
}

/**
 * The pieces joined into one plain text, each block starting and ending its own line: no words run into the code
 * before or after them, and no line break is added where one is already there.
 */
export function joinReadable(pieces: readonly ReadablePiece[]): string {
  let joined = '';
  let afterBlock = false;
  for (const piece of pieces) {
    if (piece.text === '') {
      continue;
    }
    if (piece.block) {
      // The spaces typed beside a chip belong to the line it left.
      joined = joined.replace(/[ \t]+$/u, '');
      if (joined !== '' && !joined.endsWith('\n')) {
        joined += '\n';
      }
      joined += piece.text;
      afterBlock = true;
      continue;
    }
    let text = piece.text;
    if (afterBlock) {
      text = text.replace(/^[ \t]+/u, '');
      if (text === '') {
        continue;
      }
      if (!joined.endsWith('\n') && !text.startsWith('\n')) {
        joined += '\n';
      }
      afterBlock = false;
    }
    joined += text;
  }
  assert(
    pieces.every((piece) => !piece.block || joined.includes(piece.text)),
    'joinReadable: every block is carried whole',
  );
  return joined;
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
