// Component mentions in the composer: the project's components as the `@` picker lists them, the props,
// values and slots of one component once its chip is in the draft (`@` right after the chip), the chips
// that depend on a component chip, and which chips no longer match the project.
//
// The components come from the project scan the Components panel and the props panel already read
// (ScanComponent: its project-relative `file`, its prop schema and its slots), handed over by the shell
// through `setMentionComponents`, so the picker never asks the main process and never reads a file. What a
// chip sends is the compact reference in shared/properties/ai/mentions.ts: the path and the bare member,
// never a type, a description or the schema shown here.
//
// Pure but for the small store at the bottom; tested as plain functions (test/renderer/ai/componentMentions.test.js).
import { useSyncExternalStore } from 'react';
import { assert } from '../../../../shared/core/assert';
import {
  elementKey,
  isProjectRelativePath,
  memberReference,
  type ComponentMemberChip,
  type ComposerSegments,
  type MentionChip,
} from '../../../../shared/properties/ai/mentions';
import type { ScanComponent } from '../../../../shared/properties/projectScan';
import type { PropField } from '../../../../shared/properties/propSchema';
import type { Translator } from '../../../lib/i18n/localeContext';
import { registerMentionCheck } from '../aiStore';
import { projectRelativePath } from '../../../lib/projectPath';
import { CHIP_CHARACTER, documentToSegments, segmentsToDocument } from '../../../ui/chipEditor/chipModel';
import { componentLabel, memberLabel, PICKER_ROWS_MAX, type PickerRow } from './mentionChips';

/** Components the picker searches: far more than any real project, so a scan this size is refused rather than walked on every key. */
export const MENTION_COMPONENTS_MAX = 5_000;
/** Props and slots kept of one component, and values kept of one prop (the props panel's own bounds are smaller). */
export const MENTION_MEMBERS_MAX = 512;
export const MENTION_VALUES_MAX = 128;
/** Rows components take in the general picker, so files and skills keep the rest. */
export const COMPONENT_ROWS_MAX = 4;

export interface MentionComponentProp {
  readonly name: string;
  /** The props panel's field type (`string`, `boolean`, ...), shown as a hint; never sent. */
  readonly type: string;
  /** The values the prop takes when it is a choice (or a switch): its variants. */
  readonly values: readonly string[];
  /** The scan's field, as the Properties panel reads it: what the chip popover draws its control from. Never sent. */
  readonly field: PropField;
  /** The prop picks between variant rules (it names a union of the props type), so the popover lists it under Variants. */
  readonly variant: boolean;
}

export interface MentionComponent {
  /** Project-relative and `/`-separated: the path the agent receives. */
  readonly path: string;
  readonly name: string;
  readonly props: readonly MentionComponentProp[];
  readonly slots: readonly string[];
  /** A layout (src/layouts, or a layout folder): listed under Layouts, not Components. */
  readonly layout: boolean;
}

export type ComponentChip = Extract<MentionChip, { readonly kind: 'component' }>;

/** Why a chip no longer matches the project, or undefined when it does (and for chips that are not about components). */
export type ChipProblem = 'component-missing' | 'member-missing' | undefined;

// ---------------------------------------------------------------------------
// From the scan
// ---------------------------------------------------------------------------

/**
 * The components a mention can name: the project's own and its package components, each with the path relative
 * to the project the agent runs in. `file` is that path already (the scan makes it relative to the project root,
 * wherever the components folder is and however deep the project sits in its repository); a package component
 * has no `file`, so its path is taken relative to the project. One not inside the project is left out.
 */
export function mentionComponentsOf(
  components: readonly ScanComponent[],
  project: { readonly path: string; readonly platform: NodeJS.Platform },
): readonly MentionComponent[] {
  const seen = new Set<string>();
  const result: MentionComponent[] = [];
  // A scan past the bound is cut, not refused: the picker still lists the first components and the rest stay unmentionable.
  for (const component of components.slice(0, MENTION_COMPONENTS_MAX)) {
    const path = component.file ?? projectRelativePath(project.path, component.path, project.platform);
    if (isProjectRelativePath(path) && !seen.has(path)) {
      seen.add(path);
      result.push(mentionComponentOf(component, path));
    }
  }
  assert(result.length <= components.length, 'mentionComponentsOf: never more components than the scan');
  assert(result.length <= MENTION_COMPONENTS_MAX, 'mentionComponentsOf: within the mention bound');
  return result;
}

function mentionComponentOf(component: ScanComponent, path: string): MentionComponent {
  const schema = (component.schema ?? []).slice(0, MENTION_MEMBERS_MAX);
  const controllers = new Set(schema.flatMap((field) => (field.unions ?? []).flatMap((union) => union.names)));
  const props = schema.map((field) => ({
    name: field.name,
    type: field.type,
    values: (field.options ?? (field.type === 'boolean' ? ['true', 'false'] : [])).slice(0, MENTION_VALUES_MAX),
    field,
    variant: controllers.has(field.name),
  }));
  const slots = (component.slots ?? []).slice(0, MENTION_MEMBERS_MAX);
  return { path, name: component.name === '' ? componentLabel(path) : component.name, props, slots, layout: component.isLayout === true };
}

// ---------------------------------------------------------------------------
// Chips
// ---------------------------------------------------------------------------

export function componentChip(component: MentionComponent): ComponentChip {
  assert(isProjectRelativePath(component.path), 'componentChip: a component chip names a project-relative path');
  return { kind: 'component', path: component.path, name: component.name };
}

/** Whether a chip still matches the project. Unknown components (no scan yet) leave every chip valid. */
export function chipProblem(chip: MentionChip, components: readonly MentionComponent[] | undefined): ChipProblem {
  if (components === undefined) {
    return undefined;
  }
  if (chip.kind === 'component') {
    return components.some((component) => component.path === chip.path) ? undefined : 'component-missing';
  }
  if (chip.kind !== 'member') {
    return undefined;
  }
  // An element's members name it by file and locator: the scan lists components only, so there is nothing to check them against.
  if (chip.component.includes('#')) {
    return undefined;
  }
  const component = components.find((candidate) => candidate.path === chip.component);
  if (component === undefined) {
    return 'component-missing';
  }
  return memberExists(component, chip) ? undefined : 'member-missing';
}

function memberExists(component: MentionComponent, chip: ComponentMemberChip): boolean {
  switch (chip.role) {
    case 'slot':
      return component.slots.includes(chip.name);
    case 'attr':
    case 'text':
      // What an instance writes beyond its declared props (a class, a data attribute) is the instance's, not the scan's.
      return true;
    case 'prop': {
      const prop = component.props.find((candidate) => candidate.name === chip.name);
      if (prop === undefined) {
        return false;
      }
      // A choice takes only its options; a free-form prop takes any value.
      return chip.value === undefined || prop.values.length === 0 || prop.values.includes(chip.value);
    }
    default: {
      const exhaustive: never = chip;
      return exhaustive;
    }
  }
}

/** Why a chip no longer matches, as the sentence its hover text and the send refusal show; undefined for a chip that matches. */
export function chipProblemText(chip: MentionChip, components: readonly MentionComponent[] | undefined, translate: Translator): string | undefined {
  const problem = chipProblem(chip, components);
  if (problem === undefined) {
    return undefined;
  }
  if (chip.kind === 'member') {
    return problem === 'component-missing'
      ? translate('ai.mention.component.missing', { name: componentLabel(chip.component) })
      : translate('ai.mention.member.missing', { member: memberLabel(chip, translate), component: componentLabel(chip.component) });
  }
  assert(chip.kind === 'component', 'chipProblemText: only component and member chips can stop matching');
  return translate('ai.mention.component.missing', { name: chip.name });
}

/**
 * What names each of a draft's chips that no longer match the project, in draft order, for the send refusal:
 * the component's name, or the component's name and the member's reference (`Hero prop:variant=large`).
 */
export function invalidMentions(segments: ComposerSegments, components: readonly MentionComponent[] | undefined): readonly string[] {
  const names: string[] = [];
  for (const segment of segments) {
    if (segment.kind === 'chip' && chipProblem(segment.chip, components) !== undefined) {
      const chip = segment.chip;
      if (chip.kind === 'member') {
        names.push(`${componentLabel(chip.component)} ${memberReference(chip)}`);
      } else {
        assert(chip.kind === 'component', 'invalidMentions: only component and member chips can stop matching');
        names.push(chip.name);
      }
    }
  }
  assert(names.length <= segments.length, 'invalidMentions: at most one name per chip');
  return names;
}

/**
 * The member chips that cannot stand once a component chip is gone: every member whose component has no chip
 * left (in document order, as indexes into `chips`). A second chip of the same component keeps its members.
 */
export function orphanMembers(chips: readonly MentionChip[]): readonly number[] {
  const present = new Set(chips.flatMap((chip) => (chip.kind === 'component' ? [chip.path] : chip.kind === 'element' ? [elementKey(chip)] : [])));
  const orphans: number[] = [];
  chips.forEach((chip, index) => {
    if (chip.kind === 'member' && !present.has(chip.component)) {
      orphans.push(index);
    }
  });
  assert(orphans.length <= chips.length, 'orphanMembers: a subset of the chips');
  return orphans;
}

/** The draft up to `offset`, a position in the editor's document (where each chip is one placeholder character). */
export function segmentsBefore(segments: ComposerSegments, offset: number): ComposerSegments {
  const document = segmentsToDocument(segments);
  assert(offset >= 0, 'segmentsBefore: the offset is not negative');
  // The trigger is measured a frame after the edit that made it; a draft replaced in between (sent, restored) may
  // already be shorter, and then the whole of it is what precedes the trigger.
  const text = document.text.slice(0, Math.min(offset, document.text.length));
  const chipCount = text.split(CHIP_CHARACTER).length - 1;
  return documentToSegments({ text, chips: document.chips.slice(0, chipCount) });
}

/**
 * The component whose members `@` lists: the one whose chip (or one of whose member chips) is the last thing
 * before the trigger, with only whitespace between. `before` is the draft up to the trigger.
 */
export function mentionScope(before: ComposerSegments): string | undefined {
  for (let index = before.length - 1; index >= 0; index -= 1) {
    const segment = before[index];
    assert(segment !== undefined, 'mentionScope: the walk stays inside the draft');
    if (segment.kind === 'text') {
      if (segment.text.trim() !== '') {
        return undefined;
      }
    } else if (segment.chip.kind === 'component') {
      return segment.chip.path;
    } else if (segment.chip.kind === 'member') {
      return segment.chip.component;
    } else {
      return undefined;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// The chip's popover: which members follow a component chip, and the one edit a toggle makes
// ---------------------------------------------------------------------------

/** A chip and the position of its placeholder in the editor's document. */
export interface PlacedChip {
  readonly from: number;
  readonly chip: MentionChip;
}

export interface PlacedMember {
  readonly from: number;
  readonly chip: ComponentMemberChip;
}

/** What the popover asks for: this prop (with this value, or none) or this slot on, or off. */
export type MemberWish =
  | { readonly role: 'prop'; readonly name: string; readonly value: string | undefined; readonly on: boolean }
  | { readonly role: 'slot'; readonly name: string; readonly value: undefined; readonly on: boolean };

/** The single change a wish needs: a chip added after the run, one replaced in place, or one removed with the space before it. */
export type MemberEdit =
  | { readonly kind: 'insert'; readonly at: number; readonly chip: ComponentMemberChip }
  | { readonly kind: 'replace'; readonly at: number; readonly chip: ComponentMemberChip }
  | { readonly kind: 'remove'; readonly from: number; readonly to: number };

/** A draft's chips with their positions in the editor's document, where each chip is one placeholder character. */
export function placedChips(segments: ComposerSegments): readonly PlacedChip[] {
  const placed: PlacedChip[] = [];
  let at = 0;
  for (const segment of segments) {
    if (segment.kind === 'text') {
      at += segment.text.length;
    } else {
      placed.push({ from: at, chip: segment.chip });
      at += 1;
    }
  }
  assert(placed.length <= segments.length, 'placedChips: at most one chip per segment');
  return placed;
}

/**
 * The member chips of the component chip at `componentFrom` that follow it directly: only whitespace between,
 * all of that component (the run the serialization writes without repeating the path).
 */
export function memberRun(text: string, chips: readonly PlacedChip[], componentFrom: number): readonly PlacedMember[] {
  const component = chips.find((entry) => entry.from === componentFrom)?.chip;
  assert(component !== undefined, 'memberRun: a chip sits at the component position');
  assert(component.kind === 'component', 'memberRun: the chip there is a component');
  const run: PlacedMember[] = [];
  let end = componentFrom + 1;
  for (const entry of chips) {
    if (entry.from > componentFrom) {
      const chip = entry.chip;
      if (text.slice(end, entry.from).trim() !== '' || chip.kind !== 'member' || chip.component !== component.path) {
        break;
      }
      run.push({ from: entry.from, chip });
      end = entry.from + 1;
    }
  }
  assert(run.length <= chips.length, 'memberRun: a subset of the chips');
  return run;
}

/** The edit that makes the run match `wish`, or undefined when it already does. A prop holds one chip: a new value replaces the old. */
export function planMemberEdit(
  text: string,
  run: readonly PlacedMember[],
  target: { readonly componentFrom: number; readonly path: string },
  wish: MemberWish,
): MemberEdit | undefined {
  const existing = run.find((entry) => entry.chip.role === wish.role && entry.chip.name === wish.name);
  if (!wish.on) {
    if (existing === undefined) {
      return undefined;
    }
    assert(text.charAt(existing.from) === CHIP_CHARACTER, 'planMemberEdit: the member sits on its placeholder');
    // The space the popover typed before the chip goes with it, so removing what was added leaves the text as it was.
    const from = text.charAt(existing.from - 1) === ' ' ? existing.from - 1 : existing.from;
    return { kind: 'remove', from, to: existing.from + 1 };
  }
  const chip: ComponentMemberChip =
    wish.role === 'slot'
      ? { kind: 'member', component: target.path, role: 'slot', name: wish.name, value: undefined }
      : { kind: 'member', component: target.path, role: 'prop', name: wish.name, value: wish.value };
  if (existing !== undefined) {
    return existing.chip.value === wish.value ? undefined : { kind: 'replace', at: existing.from, chip };
  }
  const last = run[run.length - 1];
  return { kind: 'insert', at: (last?.from ?? target.componentFrom) + 1, chip };
}

// ---------------------------------------------------------------------------
// Picker rows
// ---------------------------------------------------------------------------

/** How well `query` matches `text`: 0 for a prefix, 1 for anywhere, undefined for not at all. Case is ignored. */
function matchRank(text: string, query: string): number | undefined {
  const haystack = text.toLocaleLowerCase();
  if (haystack.startsWith(query)) {
    return 0;
  }
  return haystack.includes(query) ? 1 : undefined;
}

/** The components matching what was typed after `@`: name prefixes first, then names or paths containing it, at most `limit`. */
export function componentRows(
  components: readonly MentionComponent[],
  query: string,
  translate: Translator,
  limit: number,
  options: { readonly layouts?: boolean } = {},
): readonly PickerRow[] {
  assert(limit >= 0, 'componentRows: a non-negative row bound');
  assert(components.length <= MENTION_COMPONENTS_MAX, 'componentRows: the components are bounded');
  const needle = query.trim().toLocaleLowerCase();
  const wantLayouts = options.layouts === true;
  const ranked: { readonly rank: number; readonly component: MentionComponent }[] = [];
  for (const component of components.filter((candidate) => candidate.layout === wantLayouts)) {
    const rank = needle === '' ? 0 : (matchRank(component.name, needle) ?? (matchRank(component.path, needle) === undefined ? undefined : 2));
    if (rank !== undefined) {
      ranked.push({ rank, component });
    }
  }
  // A stable sort keeps the scan's own order within a rank.
  ranked.sort((left, right) => left.rank - right.rank);
  const group = translate(wantLayouts ? 'ai.mention.group.layout' : 'ai.mention.group.component');
  const rows = ranked.slice(0, limit).map(({ component }) => ({
    id: `component:${component.path}`,
    label: component.name,
    description: component.path,
    group,
    chip: componentChip(component),
    ...(wantLayouts ? { look: { kind: 'layout' as const } } : {}),
  }));
  assert(rows.length <= limit, 'componentRows: within the row bound');
  return rows;
}

/**
 * The props, values and slots of one component matching what was typed: each prop followed by its values (its
 * variants), then the slots, at most `PICKER_ROWS_MAX`. A query matches a name, a value, or `name=value`.
 */
export function memberRows(component: MentionComponent, query: string, translate: Translator): readonly PickerRow[] {
  const needle = query.trim().toLocaleLowerCase();
  const group = translate('ai.mention.group.members', { name: component.name });
  const rows: PickerRow[] = [];
  const add = (chip: ComponentMemberChip, description: string, keys: readonly string[]): void => {
    if (rows.length < PICKER_ROWS_MAX && (needle === '' || keys.some((key) => key.toLocaleLowerCase().includes(needle)))) {
      const value = chip.value === undefined ? '' : `=${chip.value}`;
      rows.push({ id: `member:${component.path}:${chip.role}:${chip.name}${value}`, label: memberLabel(chip, translate), description, group, chip });
    }
  };
  for (const prop of component.props) {
    add(
      { kind: 'member', component: component.path, role: 'prop', name: prop.name, value: undefined },
      translate('ai.mention.member.propDescription', { type: prop.type }),
      [prop.name],
    );
    for (const value of prop.values) {
      add(
        { kind: 'member', component: component.path, role: 'prop', name: prop.name, value },
        translate('ai.mention.member.valueDescription', { name: prop.name }),
        [value, `${prop.name}=${value}`],
      );
    }
  }
  for (const slot of component.slots) {
    add({ kind: 'member', component: component.path, role: 'slot', name: slot, value: undefined }, translate('ai.mention.member.slotDescription'), [slot]);
  }
  assert(rows.length <= PICKER_ROWS_MAX, 'memberRows: within the picker bound');
  assert(new Set(rows.map((row) => row.id)).size === rows.length, 'memberRows: row ids are unique');
  return rows;
}

/**
 * The rows the picker shows: with a component in scope, its members first; then up to `COMPONENT_ROWS_MAX`
 * components; then the rows the picker already had (built-in, skills, files), all within `PICKER_ROWS_MAX`.
 */
export function withComponentRows(
  rest: readonly PickerRow[],
  options: {
    readonly components: readonly MentionComponent[] | undefined;
    readonly scope: string | undefined;
    readonly query: string;
    readonly translate: Translator;
  },
): readonly PickerRow[] {
  const components = options.components ?? [];
  const scoped = options.scope === undefined ? undefined : components.find((component) => component.path === options.scope);
  const members = scoped === undefined ? [] : memberRows(scoped, options.query, options.translate);
  const componentRoom = Math.min(COMPONENT_ROWS_MAX, PICKER_ROWS_MAX - members.length);
  const found = componentRows(components, options.query, options.translate, componentRoom);
  const rows = [...members, ...found, ...rest].slice(0, PICKER_ROWS_MAX);
  assert(rows.length <= PICKER_ROWS_MAX, 'withComponentRows: within the picker bound');
  return rows;
}

// ---------------------------------------------------------------------------
// The components the shell hands over
// ---------------------------------------------------------------------------

// Undefined until a project's scan arrives: nothing is listed, and no chip is called invalid on a guess.
let current: readonly MentionComponent[] | undefined;
const listeners = new Set<() => void>();

/** Called by the shell whenever the project scan changes; undefined when no project is open. */
export function setMentionComponents(components: readonly MentionComponent[] | undefined): void {
  if (components === current) {
    return;
  }
  assert(components === undefined || components.length <= MENTION_COMPONENTS_MAX, 'setMentionComponents: the list is bounded');
  current = components;
  for (const listener of [...listeners]) {
    listener();
  }
}

/** The components as last handed over, for code outside React (the store's send check). */
export function currentMentionComponents(): readonly MentionComponent[] | undefined {
  return current;
}

// The store refuses a send whose component chips no longer match; it asks here, so it needs no import of this feature's model.
registerMentionCheck((segments) => invalidMentions(segments, current));

export function useMentionComponents(): readonly MentionComponent[] | undefined {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
  );
}
