// The pure side of mentions in the composer: how a chip looks, how the picker's
// candidates become rows and chips, how drafts compare and grow, and what a file
// dragged from the Pages or Assets panel is. No React and no editor here, so the
// rules are tested as plain functions (test/renderer/ai/mentions.test.js).
import { assert } from '../../../../shared/core/assert';
import {
  isProjectRelativePath,
  type BuiltinChipId,
  chipBoundProblem,
  isHostChip,
  isReferenceChip,
  type ComponentMemberChip,
  type ComposerSegment,
  type ComposerSegments,
  type MentionCandidate,
  type MentionChip,
  type CodeChip,
  type PageChip,
} from '../../../../shared/properties/ai/mentions';
import type { Translator } from '../../../lib/i18n/localeContext';
import type { ChipLook } from '../../../ui/chipEditor/chipEditor';
import {
  AssetManagerIcon,
  ComponentIcon,
  ComponentPropertiesIcon,
  CodeIcon,
  FileIcon,
  InstructionsIcon,
  LayoutIcon,
  PaintBrushIcon,
  SkillIcon,
  TagIcon,
  VariableIcon,
} from '../../../ui/Icons';
import { BUILTIN_CHIPS, type BuiltinMentionChip } from './builtinChips';

/** Rows the picker shows at once (ChipPicker's own bound). */
export const PICKER_ROWS_MAX = 12;
/** Files keep at least this many rows when there are that many, so skills never crowd them out. */
const FILE_ROWS_MIN = 4;

/** The picker's group headings, as catalog keys. */
export const PICKER_GROUPS = { builtin: 'ai.mention.group.builtin', skill: 'ai.mention.group.skill', file: 'ai.mention.group.file' } as const;

/** One row of the picker: what is shown, and the chip it becomes. */
export interface PickerRow {
  readonly id: string;
  readonly label: string;
  readonly description: string | undefined;
  /** The heading already translated. */
  readonly group: string;
  readonly chip: MentionChip;
  /** What the row's icon shows when the chip's kind does not say it alone (a page is a file chip, a layout a component chip). */
  readonly look?: RowLook | undefined;
}

/** The icon a picker row draws: one per group, a colour swatch for a colour variable, a small thumbnail for an image. */
export type RowLook =
  | { readonly kind: 'page' | 'layout' | 'class' | 'video' | 'font' }
  | { readonly kind: 'variable'; readonly color: string | undefined }
  | { readonly kind: 'image'; readonly abs: string; readonly key: string };

// ---------------------------------------------------------------------------
// Chips
// ---------------------------------------------------------------------------

/** The last segment of a project-relative path. */
export function baseName(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? path : path.slice(slash + 1);
}

export function fileChip(path: string): MentionChip {
  assert(isProjectRelativePath(path), 'fileChip: a chip names a project-relative path');
  return { kind: 'file', path, name: baseName(path) };
}

export function candidateChip(candidate: MentionCandidate): MentionChip {
  if (candidate.kind === 'file') {
    return { kind: 'file', path: candidate.path, name: candidate.name };
  }
  return { kind: 'skill', name: candidate.name, source: candidate.source, path: candidate.path };
}

// ---------------------------------------------------------------------------
// The one table of how each kind of chip looks: its colour (mentions.css, by `data-chip-kind`) and its icon,
// read by the editor's pills, the sent chips and the picker's rows alike
// ---------------------------------------------------------------------------

/** A chip's look: its kind, except that a CSS chip is a class (blue, the paint brush) or a variable (purple, the swatches). */
export const CHIP_STYLES = ['file', 'skill', 'builtin', 'component', 'member', 'element', 'class', 'variable', 'asset', 'code', 'page', 'layout'] as const;
export type ChipStyle = (typeof CHIP_STYLES)[number];

/** The colour each look takes: the chip tokens the rest of the app uses for the same thing. */
export const CHIP_STYLE_COLOURS: Readonly<Record<ChipStyle, 'purple' | 'green' | 'blue'>> = {
  file: 'purple',
  skill: 'purple',
  builtin: 'purple',
  component: 'green',
  member: 'green',
  element: 'purple',
  class: 'blue',
  variable: 'purple',
  asset: 'purple',
  code: 'purple',
  page: 'purple',
  layout: 'purple',
};

export const CHIP_STYLE_ICONS: Readonly<Record<ChipStyle, typeof FileIcon>> = {
  file: FileIcon,
  skill: SkillIcon,
  builtin: InstructionsIcon,
  component: ComponentIcon,
  member: ComponentPropertiesIcon,
  element: TagIcon,
  class: PaintBrushIcon,
  variable: VariableIcon,
  asset: AssetManagerIcon,
  code: CodeIcon,
  page: FileIcon,
  layout: LayoutIcon,
};

export function chipStyleOf(chip: MentionChip): ChipStyle {
  if (chip.kind === 'css') {
    return chip.target;
  }
  if (chip.kind === 'page') {
    // A place chip reads as what its file is: a component is green with the cube, as everywhere else.
    return chip.role === 'file' ? 'file' : chip.role;
  }
  return chip.kind;
}

/**
 * The file a chip stands for, so it wears that file's type icon (ui/ElementIcons.tsx) wherever it is drawn; undefined
 * for a chip that is not a whole file: those take their look's icon above.
 */
export function chipFilePath(chip: MentionChip): string | undefined {
  if (chip.kind === 'file') {
    return chip.path;
  }
  if (chip.kind === 'asset') {
    return chip.path;
  }
  if (chip.kind === 'page') {
    return chip.role === 'file' ? chip.path : undefined;
  }
  return undefined;
}

/** "L116–124" or "L12": the lines of a code chip, as the Code panel's badge writes them. */
export function codeLinesLabel(chip: Pick<CodeChip, 'startLine' | 'endLine'>): string {
  return chip.startLine === chip.endLine ? `L${chip.startLine}` : `L${chip.startLine}–${chip.endLine}`;
}

/** A code chip's label: the element selected, or the file's name, and the lines. */
export function codeChipLabel(chip: CodeChip): string {
  return `${chip.element ?? baseName(chip.path)} · ${codeLinesLabel(chip)}`;
}

/** A place chip's label: a page by its name; anything else says what it is too, so it is never read as a page. */
export function pageChipLabel(chip: PageChip, translate: Translator): string {
  switch (chip.role) {
    case 'page':
      return chip.name;
    case 'layout':
      return translate('ai.chip.place.layoutLabel', { name: chip.name });
    case 'component':
      return translate('ai.chip.place.componentLabel', { name: chip.name });
    case 'file':
      return chip.name;
    default: {
      const exhaustive: never = chip.role;
      return exhaustive;
    }
  }
}

/** The label a member chip shows: the name, `name = value` for a value, `name slot` for a slot. */
export function memberLabel(chip: ComponentMemberChip, translate: Translator): string {
  if (chip.role === 'text') {
    return translate('ai.mention.member.text', { value: chip.value });
  }
  if (chip.role === 'slot') {
    return translate('ai.mention.member.slot', { name: chip.name });
  }
  return chip.value === undefined ? chip.name : translate('ai.mention.member.value', { name: chip.name, value: chip.value });
}

/** The hover text of a member chip: which component it belongs to, and what it names. */
export function memberTitle(chip: ComponentMemberChip, translate: Translator): string {
  return translate('ai.mention.member.title', { component: componentLabel(chip.component), member: memberLabel(chip, translate) });
}

/** A component's name as its file says it (`Hero` for `src/components/Hero.astro`); an element's key reads as its file and locator. */
export function componentLabel(path: string): string {
  const hash = path.lastIndexOf('#');
  if (hash > 0) {
    return `${baseName(path.slice(0, hash))}${path.slice(hash)}`;
  }
  const name = baseName(path);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

/**
 * How the editor draws a chip: its label, the hover text, and the kind a stylesheet can mark. `problem` is why a
 * component or member chip no longer matches the project (componentMentions.ts): the chip is then marked invalid
 * and its hover text says why, while its label stays what the person picked.
 */
export function chipLook(chip: MentionChip, translate: Translator, problem?: string): ChipLook {
  switch (chip.kind) {
    case 'file':
      return { label: chip.name, title: chip.path, kind: 'file' };
    case 'skill':
      return { label: chip.name, title: translate('ai.mention.skillTitle', { name: chip.name, path: chip.path }), kind: 'skill' };
    case 'builtin':
      return { label: translate(BUILTIN_CHIPS[chip.id].titleKey), title: translate(BUILTIN_CHIPS[chip.id].descriptionKey), kind: 'builtin' };
    case 'component':
      return { label: chip.name, title: problem ?? chip.path, kind: problem === undefined ? 'component' : 'invalid' };
    case 'element':
      return { label: `<${chip.tag}>`, title: chip.path, kind: 'element' };
    case 'css':
      return {
        label: chip.target === 'variable' ? chip.name : `.${chip.name}`,
        title: chip.path ?? (chip.target === 'variable' ? chip.name : `.${chip.name}`),
        kind: chipStyleOf(chip),
      };
    case 'asset':
      return { label: baseName(chip.path), title: chip.path, kind: 'asset' };
    case 'code':
      return { label: codeChipLabel(chip), title: `${chip.path} ${codeLinesLabel(chip)}`, kind: 'code' };
    case 'page':
      return { label: pageChipLabel(chip, translate), title: chip.path, kind: chipStyleOf(chip) };
    case 'member':
      return { label: memberLabel(chip, translate), title: problem ?? memberTitle(chip, translate), kind: problem === undefined ? 'member' : 'invalid' };
    default: {
      const exhaustive: never = chip;
      return exhaustive;
    }
  }
}

// ---------------------------------------------------------------------------
// Picker rows
// ---------------------------------------------------------------------------

/**
 * The rows for what was typed after `@`: the built-in instructions first, then skills, then files,
 * at most `PICKER_ROWS_MAX` in all. Skills are held back to leave files `FILE_ROWS_MIN` rows when the
 * project has that many; the host already ranked each list (AGENTS.md and CLAUDE.md first, then Markdown).
 */
export function pickerRows(builtins: readonly BuiltinMentionChip[], candidates: readonly MentionCandidate[], translate: Translator): readonly PickerRow[] {
  const skills = candidates.filter(isSkillCandidate);
  const files = candidates.filter(isFileCandidate);
  const builtinRows = builtins.slice(0, PICKER_ROWS_MAX);
  const afterBuiltins = PICKER_ROWS_MAX - builtinRows.length;
  const skillRoom = Math.max(0, afterBuiltins - Math.min(files.length, FILE_ROWS_MIN));
  const skillRows = skills.slice(0, skillRoom);
  const fileRows = files.slice(0, afterBuiltins - skillRows.length);
  const rows: PickerRow[] = [
    ...builtinRows.map((chip) => ({
      id: `builtin:${chip.id}`,
      label: translate(BUILTIN_CHIPS[chip.id].titleKey),
      description: translate(BUILTIN_CHIPS[chip.id].descriptionKey),
      group: translate(PICKER_GROUPS.builtin),
      chip,
    })),
    ...skillRows.map((candidate) => ({
      id: `skill:${candidate.source}:${candidate.name}`,
      label: candidate.name,
      description: candidate.description === '' ? undefined : candidate.description,
      group: translate(PICKER_GROUPS.skill),
      chip: candidateChip(candidate),
    })),
    ...fileRows.map((candidate) => ({
      id: `file:${candidate.path}`,
      label: candidate.name,
      description: candidate.path,
      group: translate(PICKER_GROUPS.file),
      chip: candidateChip(candidate),
    })),
  ];
  assert(rows.length <= PICKER_ROWS_MAX, 'pickerRows: the picker shows at most its row bound');
  assert(new Set(rows.map((row) => row.id)).size === rows.length, 'pickerRows: row ids are unique');
  return rows;
}

type SkillCandidate = Extract<MentionCandidate, { readonly kind: 'skill' }>;
type FileCandidate = Extract<MentionCandidate, { readonly kind: 'file' }>;

function isSkillCandidate(candidate: MentionCandidate): candidate is SkillCandidate {
  return candidate.kind === 'skill';
}

function isFileCandidate(candidate: MentionCandidate): candidate is FileCandidate {
  return candidate.kind === 'file';
}

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

/** The draft with empty text runs dropped and neighbouring runs joined, so two drafts that read the same compare equal. */
export function normalizeSegments(segments: ComposerSegments): ComposerSegments {
  const result: ComposerSegment[] = [];
  for (const segment of segments) {
    if (segment.kind === 'text') {
      const last = result[result.length - 1];
      if (segment.text === '') {
        continue;
      }
      if (last?.kind === 'text') {
        result[result.length - 1] = { kind: 'text', text: last.text + segment.text };
        continue;
      }
    }
    result.push(segment);
  }
  assert(result.length <= segments.length, 'normalizeSegments: never longer than the draft it came from');
  return result;
}

/** Whether two chips name the same thing. */
export function chipsEqual(left: MentionChip, right: MentionChip): boolean {
  if (left.kind === 'file' && right.kind === 'file') {
    return left.path === right.path && left.name === right.name;
  }
  if (left.kind === 'skill' && right.kind === 'skill') {
    return left.name === right.name && left.source === right.source && left.path === right.path;
  }
  if (left.kind === 'builtin' && right.kind === 'builtin') {
    return left.id === right.id;
  }
  if (left.kind === 'component' && right.kind === 'component') {
    return left.path === right.path && left.name === right.name;
  }
  if (left.kind === 'css' && right.kind === 'css') {
    return left.target === right.target && left.name === right.name && left.path === right.path;
  }
  if (left.kind === 'asset' && right.kind === 'asset') {
    return left.assetKind === right.assetKind && left.path === right.path;
  }
  if (left.kind === 'element' && right.kind === 'element') {
    return left.path === right.path && left.locator === right.locator && left.tag === right.tag;
  }
  if (left.kind === 'code' && right.kind === 'code') {
    return (
      left.path === right.path &&
      left.startLine === right.startLine &&
      left.endLine === right.endLine &&
      left.element === right.element &&
      left.code === right.code
    );
  }
  if (left.kind === 'page' && right.kind === 'page') {
    return left.path === right.path && left.role === right.role && left.name === right.name && left.route === right.route && left.viewedOn === right.viewedOn;
  }
  if (left.kind === 'member' && right.kind === 'member') {
    return left.component === right.component && left.role === right.role && left.name === right.name && left.value === right.value;
  }
  return false;
}

/** Whether two drafts read the same: same text and chips in the same order. */
export function segmentsEqual(left: ComposerSegments, right: ComposerSegments): boolean {
  if (left === right) {
    return true;
  }
  const first = normalizeSegments(left);
  const second = normalizeSegments(right);
  if (first.length !== second.length) {
    return false;
  }
  return first.every((segment, index) => {
    const other = second[index];
    if (other === undefined) {
      return false;
    }
    if (segment.kind === 'text') {
      return other.kind === 'text' && other.text === segment.text;
    }
    return other.kind === 'chip' && chipsEqual(segment.chip, other.chip);
  });
}

export function chipCountOf(segments: ComposerSegments): number {
  return segments.filter((segment) => segment.kind === 'chip').length;
}

/** The chips `AI_LIMITS.mentionsMax` bounds: those the host expands (files, skills, built-ins), not the reference chips. */
export function hostChipCountOf(segments: ComposerSegments): number {
  return segments.filter((segment) => segment.kind === 'chip' && isHostChip(segment.chip)).length;
}

/** The component, element and member chips, bounded by `REFERENCE_CHIPS_MAX`. */
export function referenceChipCountOf(segments: ComposerSegments): number {
  return segments.filter((segment) => segment.kind === 'chip' && isReferenceChip(segment.chip)).length;
}

/** Whether one more `chip` still fits its bound. */
export function chipFits(segments: ComposerSegments, chip: MentionChip): boolean {
  const chips = segments.flatMap((segment) => (segment.kind === 'chip' ? [segment.chip] : []));
  return chipBoundProblem([...chips, chip]) === undefined;
}

export function hasBuiltinChip(segments: ComposerSegments, id: BuiltinChipId): boolean {
  return segments.some((segment) => segment.kind === 'chip' && segment.chip.kind === 'builtin' && segment.chip.id === id);
}

/**
 * The draft with `chip` added at the end, a space after it so the person's next word does not touch it, and a
 * space before it when the draft ends in a word. A draft already at the mention limit is returned unchanged.
 */
export function appendChip(segments: ComposerSegments, chip: MentionChip): ComposerSegments {
  if (!chipFits(segments, chip)) {
    return segments;
  }
  const last = segments[segments.length - 1];
  const needsSpace = last?.kind === 'text' && last.text !== '' && !/\s$/u.test(last.text);
  const joined: ComposerSegment[] = [...segments];
  if (needsSpace) {
    joined.push({ kind: 'text', text: ' ' });
  }
  joined.push({ kind: 'chip', chip }, { kind: 'text', text: ' ' });
  assert(chipCountOf(joined) === chipCountOf(segments) + 1, 'appendChip: exactly one chip is added');
  return normalizeSegments(joined);
}

/** A draft of one text run, or nothing for empty text. */
export function textSegments(text: string): ComposerSegments {
  return text === '' ? [] : [{ kind: 'text', text }];
}

// ---------------------------------------------------------------------------
// Dragged files
// ---------------------------------------------------------------------------

/** What a drag carries, as `DataTransfer` offers it. */
export interface DragSource {
  readonly types: ReadonlyArray<string>;
  readonly getData: (type: string) => string;
}

export const PAGE_DRAG_TYPE = 'avb/page';
export const ASSET_DRAG_TYPE = 'avb/asset';

/** Whether a drag from the Pages or Assets panel is over the box (decided from type names alone: payloads are unreadable until the drop). */
export function isFileDrag(types: ReadonlyArray<string>): boolean {
  return types.includes(PAGE_DRAG_TYPE) || types.includes(ASSET_DRAG_TYPE);
}

/**
 * The file chip a dropped Pages or Assets row stands for, or undefined for anything else: a payload is
 * another panel's data, so it is parsed here and a path that is not project-relative, or a folder (no
 * extension), is refused.
 */
export function chipFromDrag(source: DragSource): MentionChip | undefined {
  const asset = source.getData(ASSET_DRAG_TYPE);
  if (asset !== '') {
    return fileChipFromPath(asset);
  }
  const page = source.getData(PAGE_DRAG_TYPE);
  if (page === '') {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(page);
    if (typeof parsed !== 'object' || parsed === null || !('path' in parsed) || typeof parsed.path !== 'string') {
      return undefined;
    }
    return fileChipFromPath(parsed.path);
  } catch {
    return undefined; // Not JSON: not ours.
  }
}

function fileChipFromPath(path: string): MentionChip | undefined {
  if (!isProjectRelativePath(path) || !/\.[A-Za-z0-9]+$/u.test(path)) {
    return undefined;
  }
  return fileChip(path);
}
