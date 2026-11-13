// The pure side of mentions in the composer: how a chip looks, how the picker's
// candidates become rows and chips, how drafts compare and grow, and what a file
// dragged from the Pages or Assets panel is. No React and no editor here, so the
// rules are tested as plain functions (test/renderer/ai/mentions.test.js).
import { assert } from '../../../../shared/core/assert';
import { AI_LIMITS } from '../../../../shared/properties/ai/aiLimits';
import {
  isProjectRelativePath,
  type BuiltinChipId,
  type ComposerSegment,
  type ComposerSegments,
  type MentionCandidate,
  type MentionChip,
} from '../../../../shared/properties/ai/mentions';
import type { Translator } from '../../../lib/i18n/localeContext';
import type { ChipLook } from '../../../ui/chipEditor/chipEditor';
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
}

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

/** How the editor draws a chip: its label, the hover text, and the kind a stylesheet can mark. */
export function chipLook(chip: MentionChip, translate: Translator): ChipLook {
  switch (chip.kind) {
    case 'file':
      return { label: chip.name, title: chip.path, kind: 'file' };
    case 'skill':
      return { label: chip.name, title: translate('ai.mention.skillTitle', { name: chip.name, path: chip.path }), kind: 'skill' };
    case 'builtin':
      return { label: translate(BUILTIN_CHIPS[chip.id].titleKey), title: translate(BUILTIN_CHIPS[chip.id].descriptionKey), kind: 'builtin' };
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

function chipsEqual(left: MentionChip, right: MentionChip): boolean {
  if (left.kind === 'file' && right.kind === 'file') {
    return left.path === right.path && left.name === right.name;
  }
  if (left.kind === 'skill' && right.kind === 'skill') {
    return left.name === right.name && left.source === right.source && left.path === right.path;
  }
  if (left.kind === 'builtin' && right.kind === 'builtin') {
    return left.id === right.id;
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

export function hasBuiltinChip(segments: ComposerSegments, id: BuiltinChipId): boolean {
  return segments.some((segment) => segment.kind === 'chip' && segment.chip.kind === 'builtin' && segment.chip.id === id);
}

/**
 * The draft with `chip` added at the end, a space after it so the person's next word does not touch it, and a
 * space before it when the draft ends in a word. A draft already at the mention limit is returned unchanged.
 */
export function appendChip(segments: ComposerSegments, chip: MentionChip): ComposerSegments {
  if (chipCountOf(segments) >= AI_LIMITS.mentionsMax) {
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
