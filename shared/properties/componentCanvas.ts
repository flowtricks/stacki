// i18n-ignore-file: the refusals below describe a hand-edited .stacki/component-canvas.json; they reach people through the generic error path and the CLI, which speak English.
// `.stacki/component-canvas.json`: how the component canvas lays out each component (which props get their own frames)
// and what each frame shows (the preview prop values last applied, its size and its background). Desktop, Studio and
// the CLI read it through this one parser, so all three accept exactly the same file.
//
// Frames are keyed by what they show, never by their position: a key names the split props' values, sorted by prop
// name (`direction=back&variant=arrow`, `variant` alone for "not set", `` for every frame). A frame's settings are the
// merge of every stored entry whose pairs are a subset of its own, least specific first: `` is "all frames",
// `variant=arrow` is "every arrow frame", and the full key is the frame itself. That one rule gives all-frames and
// per-variant defaults with per-frame overrides, and it keeps settings when a split prop is added (the old entry
// still matches as a subset) or the variants are reordered (keys are sorted). Entries no current frame matches are
// kept, never deleted silently: they come back when the split or the variants that made them return.
//
// Preview values are only what the canvas renders with. Nothing here is written to the component or to its instances.
import { assert } from '../core/assert';
import { err, ok, type Result } from '../core/result';
import { record } from '../core/boundary';
import type { PropField, PropUnion } from './propSchema';

export const COMPONENT_CANVAS_FILE = '.stacki/component-canvas.json';

export const CANVAS_LIMITS = {
  /** The file's text: the metadata transport's own bound. */
  sourceCharsMax: 256 * 1024,
  componentsMax: 500,
  /** Props one component may split its frames by. Four props of four values is already 256 combinations. */
  splitPropsMax: 4,
  /** Stored entries per component: every frame, every variant scope and the all-frames scope together. */
  entriesMax: 256,
  /** Preview values one entry holds. */
  valuesMax: 64,
  valueCharsMax: 2_000,
  propNameCharsMax: 100,
  keyCharsMax: 1_024,
  backgroundCharsMax: 256,
  sizePxMin: 1,
  sizePxMax: 10_000,
  /** Frames drawn at once. Every frame is one more render of the component on the one canvas page. */
  framesMax: 64,
  /** Combinations weighed before pruning to the frames that differ. */
  combinationsMax: 4_096,
  /** Values one split prop contributes (its options and "not set"). */
  valuesPerPropMax: 64,
} as const satisfies Record<string, number>;

export type CanvasValue = string | number | boolean;
/** A frame side in CSS pixels, or `hug`: the side follows the component's own size. */
export type FrameLength = number | 'hug';

export interface FrameEntry {
  /** Preview values, by prop name. */
  readonly props?: Readonly<Record<string, CanvasValue>>;
  /** Props this scope shows as not set, over a value a wider scope gives. */
  readonly unset?: readonly string[];
  readonly width?: FrameLength;
  readonly height?: FrameLength;
  /** A CSS colour or `var(--…)`; absent: transparent, or what a wider scope sets. */
  readonly background?: string;
}

export interface ComponentCanvas {
  /** The props that get their own frames, in layout order; absent: the canvas chooses (defaultSplit). */
  readonly split?: readonly string[];
  readonly frames?: Readonly<Record<string, FrameEntry>>;
}

export interface ComponentCanvasFile {
  readonly version: 1;
  /**
   * The project's canvas background: the surface every component canvas draws on, and what a frame shows where neither
   * the frame nor its component sets a background. A CSS colour, `transparent`, or `var(--name)`, which follows the
   * variable. Absent: the app's own canvas grey. Versions before this key ignore it, and drop it on their next save.
   */
  readonly background?: string;
  readonly components: Readonly<Record<string, ComponentCanvas>>;
}

export const EMPTY_CANVAS_FILE: ComponentCanvasFile = { version: 1, components: {} };

// ----- Parsing -----

const PROP_NAME = /^[A-Za-z_$][\w$-]*$/;
const COMPONENT_FILE = /^(?:src\/|node_modules\/)[^\0]*\.astro$/;
const ENTRY_FIELDS = new Set(['props', 'unset', 'width', 'height', 'background']);
const COMPONENT_FIELDS = new Set(['split', 'frames']);

export function parseComponentCanvasSource(source: string): Result<ComponentCanvasFile> {
  if (source.length > CANVAS_LIMITS.sourceCharsMax) {
    return err({ code: 'invalid-canvas', message: 'Component canvas settings exceed 256 KiB.' });
  }
  try {
    const input: unknown = JSON.parse(source);
    return ok(parseComponentCanvasFile(input));
  } catch (error: unknown) {
    return err({ code: 'invalid-canvas', message: error instanceof Error ? error.message : 'Invalid component canvas settings' });
  }
}

export function parseComponentCanvasFile(input: unknown): ComponentCanvasFile {
  const value = record(input);
  if (value['version'] !== 1) {
    throw new Error('Component canvas: unsupported version');
  }
  const entries = Object.entries(record(value['components']));
  if (entries.length > CANVAS_LIMITS.componentsMax) {
    throw new Error(`Component canvas: more than ${CANVAS_LIMITS.componentsMax} components`);
  }
  const components: Record<string, ComponentCanvas> = {};
  for (const [file, settings] of entries) {
    components[canvasComponentFile(file)] = parseComponentSettings(settings, file);
  }
  assert(Object.keys(components).length === entries.length, 'Component canvas: every component is kept');
  const background = value['background'] === undefined ? undefined : canvasBackground(value['background']);
  assert((background?.length ?? 0) <= CANVAS_LIMITS.backgroundCharsMax, 'Component canvas: the project background is bounded');
  return { version: 1, ...(background === undefined ? {} : { background }), components };
}

/** A project-relative component path, as `.stacki/components.json` keys them. */
export function canvasComponentFile(input: unknown): string {
  if (typeof input !== 'string' || input.length === 0 || input.length > 500) {
    throw new Error('Component canvas: a component is a path of 1 to 500 characters');
  }
  if (!COMPONENT_FILE.test(input) || input.includes('\\') || input.split('/').includes('..')) {
    throw new Error(`Component canvas: ${input} is not a project .astro component`);
  }
  return input;
}

function parseComponentSettings(input: unknown, file: string): ComponentCanvas {
  const value = record(input);
  for (const key of Object.keys(value)) {
    if (!COMPONENT_FIELDS.has(key)) {
      throw new Error(`Component canvas: ${file} has an unknown key ${key}`);
    }
  }
  const split = value['split'] === undefined ? undefined : parseSplit(value['split'], file);
  const framesInput = value['frames'] === undefined ? undefined : record(value['frames']);
  const frameEntries = Object.entries(framesInput ?? {});
  if (frameEntries.length > CANVAS_LIMITS.entriesMax) {
    throw new Error(`Component canvas: ${file} stores more than ${CANVAS_LIMITS.entriesMax} frame settings`);
  }
  const frames: Record<string, FrameEntry> = {};
  for (const [key, entry] of frameEntries) {
    frames[parseFrameKey(key)] = parseFrameEntry(entry, file);
  }
  return { ...(split === undefined ? {} : { split }), ...(framesInput === undefined ? {} : { frames }) };
}

function parseSplit(input: unknown, file: string): readonly string[] {
  if (!Array.isArray(input) || input.length > CANVAS_LIMITS.splitPropsMax) {
    throw new Error(`Component canvas: ${file} splits by a list of at most ${CANVAS_LIMITS.splitPropsMax} props`);
  }
  const names = input.map((name: unknown) => propName(name));
  if (new Set(names).size !== names.length) {
    throw new Error(`Component canvas: ${file} names a split prop twice`);
  }
  return names;
}

function propName(input: unknown): string {
  if (typeof input !== 'string' || input.length > CANVAS_LIMITS.propNameCharsMax || !PROP_NAME.test(input)) {
    throw new Error('Component canvas: a prop name is a JavaScript identifier of at most 100 characters');
  }
  return input;
}

function parseFrameEntry(input: unknown, file: string): FrameEntry {
  const value = record(input);
  for (const key of Object.keys(value)) {
    if (!ENTRY_FIELDS.has(key)) {
      throw new Error(`Component canvas: a frame of ${file} has an unknown key ${key}`);
    }
  }
  const entry: { -readonly [K in keyof FrameEntry]: FrameEntry[K] } = {};
  if (value['props'] !== undefined) {
    const props = Object.entries(record(value['props']));
    if (props.length > CANVAS_LIMITS.valuesMax) {
      throw new Error(`Component canvas: a frame holds at most ${CANVAS_LIMITS.valuesMax} values`);
    }
    entry.props = Object.fromEntries(props.map(([name, held]) => [propName(name), canvasValue(held)]));
  }
  if (value['unset'] !== undefined) {
    const unset = value['unset'];
    if (!Array.isArray(unset) || unset.length > CANVAS_LIMITS.valuesMax) {
      throw new Error(`Component canvas: unset is a list of at most ${CANVAS_LIMITS.valuesMax} props`);
    }
    entry.unset = unset.map((name: unknown) => propName(name));
    if (entry.unset.some((name) => entry.props?.[name] !== undefined)) {
      throw new Error('Component canvas: a prop is either given a value or unset, not both');
    }
  }
  if (value['width'] !== undefined) {
    entry.width = frameLength(value['width']);
  }
  if (value['height'] !== undefined) {
    entry.height = frameLength(value['height']);
  }
  if (value['background'] !== undefined) {
    entry.background = canvasBackground(value['background']);
  }
  return entry;
}

export function canvasValue(input: unknown): CanvasValue {
  if (typeof input === 'boolean') {
    return input;
  }
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) {
      throw new Error('Component canvas: a number value is finite');
    }
    return input;
  }
  if (typeof input === 'string') {
    if (input.length > CANVAS_LIMITS.valueCharsMax) {
      throw new Error(`Component canvas: a text value is at most ${CANVAS_LIMITS.valueCharsMax} characters`);
    }
    return input;
  }
  throw new Error('Component canvas: a value is text, a number or true or false');
}

export function frameLength(input: unknown): FrameLength {
  if (input === 'hug') {
    return input;
  }
  if (typeof input !== 'number' || !Number.isInteger(input)) {
    throw new Error('Component canvas: a frame side is "hug" or a whole number of pixels');
  }
  if (input < CANVAS_LIMITS.sizePxMin || input > CANVAS_LIMITS.sizePxMax) {
    throw new Error(`Component canvas: a frame side is ${CANVAS_LIMITS.sizePxMin} to ${CANVAS_LIMITS.sizePxMax} pixels`);
  }
  return input;
}

// A colour goes into a style attribute of the generated canvas page, so anything that could end the declaration or
// the attribute is refused here rather than escaped there: the canvas never writes a value this did not accept.
export function canvasBackground(input: unknown): string {
  if (typeof input !== 'string' || input.trim().length === 0 || input.length > CANVAS_LIMITS.backgroundCharsMax) {
    throw new Error(`Component canvas: a background is a CSS colour of at most ${CANVAS_LIMITS.backgroundCharsMax} characters`);
  }
  if (/[;{}<>"'\\]|\/\*/.test(input)) {
    throw new Error('Component canvas: a background is one CSS colour value');
  }
  return input.trim();
}

/** A stored frame key, checked and returned unchanged: sorted unique prop names, each `name` or `name=value`. */
export function parseFrameKey(input: unknown): string {
  if (typeof input !== 'string' || input.length > CANVAS_LIMITS.keyCharsMax) {
    throw new Error('Component canvas: a frame key is text of at most 1024 characters');
  }
  if (input === '') {
    return input;
  }
  const pairs = input.split('&');
  if (pairs.length > CANVAS_LIMITS.splitPropsMax) {
    throw new Error(`Component canvas: a frame key names at most ${CANVAS_LIMITS.splitPropsMax} props`);
  }
  const names = pairs.map((pair) => {
    const at = pair.indexOf('=');
    const name = at < 0 ? pair : pair.slice(0, at);
    propName(name);
    if (at >= 0) {
      decodeKeyValue(pair.slice(at + 1));
    }
    return name;
  });
  for (let index = 1; index < names.length; index++) {
    const previous = names[index - 1] ?? '';
    const name = names[index] ?? '';
    if (previous < name) {
      continue;
    }
    throw new Error('Component canvas: a frame key names its props once each, sorted by name');
  }
  return input;
}

function decodeKeyValue(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    throw new Error('Component canvas: a frame key value is URI-encoded');
  }
}

export function serializeComponentCanvas(file: ComponentCanvasFile): string {
  // Sorted, so the same settings are always the same bytes and nothing churns in git.
  const components = Object.fromEntries(
    Object.keys(file.components)
      .sort()
      .map((name) => [name, sortedSettings(file.components[name] ?? {})]),
  );
  const text = JSON.stringify({ version: 1, ...(file.background === undefined ? {} : { background: file.background }), components }, undefined, 2) + '\n';
  assert(parseComponentCanvasSource(text).ok, 'A serialised canvas file parses');
  return text;
}

function sortedSettings(settings: ComponentCanvas): ComponentCanvas {
  const frames = settings.frames;
  return {
    ...(settings.split === undefined ? {} : { split: settings.split }),
    ...(frames === undefined
      ? {}
      : {
          frames: Object.fromEntries(
            Object.keys(frames)
              .sort()
              .map((key) => [key, sortedEntry(frames[key] ?? {})]),
          ),
        }),
  };
}

function sortedEntry(entry: FrameEntry): FrameEntry {
  const props = entry.props;
  return {
    ...(props === undefined
      ? {}
      : {
          props: Object.fromEntries(
            Object.keys(props)
              .sort()
              .map((name) => [name, props[name] ?? '']),
          ),
        }),
    ...(entry.unset === undefined ? {} : { unset: [...entry.unset].sort() }),
    ...(entry.width === undefined ? {} : { width: entry.width }),
    ...(entry.height === undefined ? {} : { height: entry.height }),
    ...(entry.background === undefined ? {} : { background: entry.background }),
  };
}

// ----- Split props and frames -----

/** One value a split prop takes: an option, a switch state, or not set. */
export type SplitValue = { readonly kind: 'value'; readonly value: string | boolean } | { readonly kind: 'unset' };

export interface SplitCandidate {
  readonly name: string;
  readonly values: readonly SplitValue[];
}

/** A prop of the frame's identity: the split prop and the value this frame shows. */
export interface FramePart {
  readonly prop: string;
  readonly value: SplitValue;
}

export interface CanvasFrame {
  readonly key: string;
  /** In split order; a split prop the frame's variant does not take is left out. */
  readonly parts: readonly FramePart[];
  readonly row: number;
  readonly column: number;
}

export interface CanvasFrames {
  readonly frames: readonly CanvasFrame[];
  /** Distinct frames before the framesMax bound: more than `frames.length` when some were left out. */
  readonly total: number;
}

/** The props whose values can each get a frame: string options and switches, plus "not set" when that differs from every value. */
export function splitCandidates(schema: readonly PropField[]): readonly SplitCandidate[] {
  const candidates: SplitCandidate[] = [];
  for (const field of schema) {
    if (!PROP_NAME.test(field.name) || field.name.length > CANVAS_LIMITS.propNameCharsMax) {
      continue;
    }
    // Not set differs from every value only when nothing fills it in: an optional prop without a default.
    const unset: readonly SplitValue[] = field.optional && field.default === undefined ? [{ kind: 'unset' }] : [];
    if (field.type === 'boolean') {
      candidates.push({
        name: field.name,
        values: [
          { kind: 'value', value: true },
          { kind: 'value', value: false },
        ],
      });
      continue;
    }
    const options = field.options ?? [];
    if (options.length > 0 && options.length < CANVAS_LIMITS.valuesPerPropMax) {
      candidates.push({ name: field.name, values: [...options.map((option): SplitValue => ({ kind: 'value', value: option })), ...unset] });
    }
  }
  assert(candidates.length <= schema.length, 'Each field is at most one candidate');
  return candidates;
}

// Words a design system names its main variant prop with, in the order they are preferred.
const VARIANT_NAMES = ['variant', 'kind', 'appearance', 'style', 'type'] as const;

/**
 * The split a component starts with: its variant prop alone. `variant` when it has one; otherwise the first prop a
 * discriminated union is controlled by (the TypeScript shape design systems write variants in); otherwise another
 * prop named for variants. A component with none of those starts with one frame.
 */
export function defaultSplit(schema: readonly PropField[]): readonly string[] {
  const candidates = splitCandidates(schema).filter((candidate) => candidate.values.some((value) => value.kind === 'value' && typeof value.value === 'string'));
  const named = (name: string) => candidates.find((candidate) => candidate.name === name);
  const variant = named('variant');
  if (variant !== undefined) {
    return [variant.name];
  }
  const unions = schema.find((field) => field.unions !== undefined)?.unions ?? [];
  const controllers = new Set(unions.flatMap((union) => union.branches.flatMap((branch) => Object.keys(branch.pins))));
  const controller = candidates.find((candidate) => controllers.has(candidate.name));
  if (controller !== undefined) {
    return [controller.name];
  }
  const word = VARIANT_NAMES.map(named).find((candidate) => candidate !== undefined);
  return word === undefined ? [] : [word.name];
}

/** The split a component uses: the stored one with props it no longer has left out, or the default. */
export function effectiveSplit(settings: ComponentCanvas | undefined, schema: readonly PropField[]): readonly string[] {
  if (settings?.split === undefined) {
    return defaultSplit(schema);
  }
  const names = new Set(splitCandidates(schema).map((candidate) => candidate.name));
  return settings.split.filter((name) => names.has(name));
}

export function splitValueText(value: SplitValue): string | undefined {
  return value.kind === 'unset' ? undefined : String(value.value);
}

/** The key of a frame: its parts sorted by prop name, `name=value` (URI-encoded) or `name` for not set. */
export function frameKey(parts: readonly FramePart[]): string {
  const pairs = [...parts]
    .sort((left, right) => (left.prop < right.prop ? -1 : left.prop > right.prop ? 1 : 0))
    .map((part) => (part.value.kind === 'unset' ? part.prop : `${part.prop}=${encodeURIComponent(String(part.value.value))}`));
  const key = pairs.join('&');
  assert(new Set(parts.map((part) => part.prop)).size === parts.length, 'A frame names each split prop once');
  return key;
}

/** The pairs of a key; `` has none. */
export function keyPairs(key: string): readonly string[] {
  return key === '' ? [] : key.split('&');
}

/**
 * The frames a split makes: every combination of the split props' values, in order, with each prop a frame's
 * variant does not take left out and the duplicates that leaves removed. One split prop is one row; with more,
 * the first split prop's values are the rows and the rest vary along each row. `applies` says whether a prop is used, given the values chosen so far.
 */
export function canvasFrames(split: readonly SplitCandidate[], applies: (prop: string, chosen: readonly FramePart[]) => boolean): CanvasFrames {
  assert(split.length <= CANVAS_LIMITS.splitPropsMax, 'A split has a bounded number of props');
  const frames: CanvasFrame[] = [];
  const seen = new Set<string>();
  let total = 0;
  let combinations = 1;
  for (const candidate of split) {
    assert(candidate.values.length > 0, 'A split prop has a value');
    combinations = Math.min(combinations * candidate.values.length, CANVAS_LIMITS.combinationsMax);
  }
  let indexes: readonly number[] = split.map(() => 0);
  const rows = new Map<string, number>();
  const columns = new Map<number, number>();
  for (let step = 0; step < combinations; step++) {
    const parts: FramePart[] = [];
    split.forEach((candidate, at) => {
      const value = candidate.values[indexes[at] ?? 0];
      assert(value !== undefined, 'A combination picks one of the prop values');
      if (at === 0 || applies(candidate.name, parts)) {
        parts.push({ prop: candidate.name, value });
      }
    });
    indexes = advance(indexes, split);
    const key = frameKey(parts);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    total += 1;
    if (frames.length < CANVAS_LIMITS.framesMax) {
      // One split prop lays its frames out side by side; with more, the first one's values are the rows.
      const rowKey = split.length < 2 || parts[0] === undefined ? '' : frameKey([parts[0]]);
      const row = rows.get(rowKey) ?? rows.size;
      rows.set(rowKey, row);
      const column = columns.get(row) ?? 0;
      columns.set(row, column + 1);
      frames.push({ key, parts, row, column });
    }
  }
  assert(frames.length >= 1, 'A canvas has at least one frame');
  assert(frames.length <= CANVAS_LIMITS.framesMax, 'A canvas draws a bounded number of frames');
  return { frames, total };
}

// The combination after this one: the last prop changes fastest, like counting.
function advance(indexes: readonly number[], split: readonly SplitCandidate[]): readonly number[] {
  const next = [...indexes];
  for (let at = split.length - 1; at >= 0; at--) {
    const value = (next[at] ?? 0) + 1;
    if (value < (split[at]?.values.length ?? 0)) {
      next[at] = value;
      return next;
    }
    next[at] = 0;
  }
  return next;
}

/**
 * Whether a discriminated union lets `prop` be passed, given the values `held` gives its controllers: a prop every
 * branch that fits forbids (`direction?: never` on every variant but `arrow`) is not one this frame takes. The same
 * reading the Properties panel's union rules make (src/features/props/propRules.ts appliesNow).
 */
export function unionAllows(unions: readonly PropUnion[], prop: string, held: (name: string) => string | undefined): boolean {
  for (const union of unions) {
    if (!union.names.includes(prop)) {
      continue;
    }
    const fitting = union.branches.filter((branch) =>
      Object.entries(branch.pins).every(([name, wanted]) => {
        const value = held(name);
        return value === undefined || wanted.includes(value);
      }),
    );
    const branches = fitting.length > 0 ? fitting : union.branches;
    if (branches.length > 0 && branches.every((branch) => branch.forbids.includes(prop))) {
      return false;
    }
  }
  return true;
}

// ----- What a frame shows -----

export type FrameField = 'width' | 'height' | 'background';

export interface ResolvedFrame {
  readonly props: Readonly<Record<string, CanvasValue>>;
  readonly unset: ReadonlySet<string>;
  readonly width: FrameLength;
  readonly height: FrameLength;
  readonly background: string | undefined;
  /** The key of the entry each value, unset prop or frame field comes from. */
  readonly origins: ReadonlyMap<string, string>;
}

/** The stored entries that apply to a frame, least specific first: every one whose pairs are all in the frame's key. */
export function matchingEntries(settings: ComponentCanvas | undefined, key: string): readonly (readonly [string, FrameEntry])[] {
  const pairs = new Set(keyPairs(key));
  const matches = Object.entries(settings?.frames ?? {}).filter(([stored]) => keyPairs(stored).every((pair) => pairs.has(pair)));
  matches.sort(([left], [right]) => keyPairs(left).length - keyPairs(right).length || (left < right ? -1 : left > right ? 1 : 0));
  assert(matches.length <= CANVAS_LIMITS.entriesMax, 'A frame merges a bounded number of entries');
  return matches;
}

export function resolveFrame(settings: ComponentCanvas | undefined, key: string): ResolvedFrame {
  const props: Record<string, CanvasValue> = {};
  const unset = new Set<string>();
  const origins = new Map<string, string>();
  let width: FrameLength = 'hug';
  let height: FrameLength = 'hug';
  let background: string | undefined;
  for (const [stored, entry] of matchingEntries(settings, key)) {
    for (const [name, value] of Object.entries(entry.props ?? {})) {
      props[name] = value;
      unset.delete(name);
      origins.set('prop:' + name, stored);
    }
    for (const name of entry.unset ?? []) {
      delete props[name];
      unset.add(name);
      origins.set('prop:' + name, stored);
    }
    if (entry.width !== undefined) {
      width = entry.width;
      origins.set('width', stored);
    }
    if (entry.height !== undefined) {
      height = entry.height;
      origins.set('height', stored);
    }
    if (entry.background !== undefined) {
      background = entry.background;
      origins.set('background', stored);
    }
  }
  return { props, unset, width, height, background, origins };
}

// ----- Edits -----

export type FrameEdit =
  | { readonly kind: 'prop'; readonly name: string; readonly value: CanvasValue }
  | { readonly kind: 'unset'; readonly name: string }
  /** Drops what this scope says about the prop, so a wider scope's value shows. */
  | { readonly kind: 'inherit'; readonly name: string }
  | { readonly kind: 'field'; readonly field: 'width' | 'height'; readonly value: FrameLength | undefined }
  | { readonly kind: 'background'; readonly value: string | undefined };

/** The file with one edit to one scope's entry (`` for all frames). An entry left empty is removed; nothing else is. */
export function withFrameEdit(file: ComponentCanvasFile, component: string, scope: string, edit: FrameEdit): ComponentCanvasFile {
  canvasComponentFile(component);
  parseFrameKey(scope);
  const settings = file.components[component] ?? {};
  const entry = settings.frames?.[scope] ?? {};
  const next = editedEntry(entry, edit);
  const frames: Record<string, FrameEntry> = { ...settings.frames };
  if (isEmptyEntry(next)) {
    delete frames[scope];
  } else {
    frames[scope] = next;
  }
  if (Object.keys(frames).length > CANVAS_LIMITS.entriesMax) {
    throw new Error(`A component keeps at most ${CANVAS_LIMITS.entriesMax} frame settings`);
  }
  const result = withComponentSettings(file, component, { ...(settings.split === undefined ? {} : { split: settings.split }), frames });
  assert(parseComponentCanvasSource(serializeComponentCanvas(result)).ok, 'An edited canvas file parses');
  return result;
}

function editedEntry(entry: FrameEntry, edit: FrameEdit): FrameEntry {
  const props: Record<string, CanvasValue> = { ...entry.props };
  let unset = [...(entry.unset ?? [])];
  let width = entry.width;
  let height = entry.height;
  let background = entry.background;
  switch (edit.kind) {
    case 'prop':
      propName(edit.name);
      props[edit.name] = canvasValue(edit.value);
      unset = unset.filter((name) => name !== edit.name);
      break;
    case 'unset':
      propName(edit.name);
      delete props[edit.name];
      unset = [...unset.filter((name) => name !== edit.name), edit.name];
      break;
    case 'inherit':
      delete props[edit.name];
      unset = unset.filter((name) => name !== edit.name);
      break;
    case 'field':
      if (edit.field === 'width') {
        width = edit.value === undefined ? undefined : frameLength(edit.value);
      } else {
        height = edit.value === undefined ? undefined : frameLength(edit.value);
      }
      break;
    case 'background':
      background = edit.value === undefined ? undefined : canvasBackground(edit.value);
      break;
    default: {
      const exhaustive: never = edit;
      return exhaustive;
    }
  }
  if (Object.keys(props).length > CANVAS_LIMITS.valuesMax || unset.length > CANVAS_LIMITS.valuesMax) {
    throw new Error(`A frame holds at most ${CANVAS_LIMITS.valuesMax} values`);
  }
  return {
    ...(Object.keys(props).length === 0 ? {} : { props }),
    ...(unset.length === 0 ? {} : { unset }),
    ...(width === undefined ? {} : { width }),
    ...(height === undefined ? {} : { height }),
    ...(background === undefined ? {} : { background }),
  };
}

function isEmptyEntry(entry: FrameEntry): boolean {
  return entry.props === undefined && entry.unset === undefined && entry.width === undefined && entry.height === undefined && entry.background === undefined;
}

/** The file with the props a component splits by set; `undefined` goes back to the default choice. */
export function withSplit(file: ComponentCanvasFile, component: string, split: readonly string[] | undefined): ComponentCanvasFile {
  canvasComponentFile(component);
  if (split !== undefined) {
    parseSplit(split, component);
  }
  const settings = file.components[component] ?? {};
  return withComponentSettings(file, component, {
    ...(split === undefined ? {} : { split }),
    ...(settings.frames === undefined ? {} : { frames: settings.frames }),
  });
}

function withComponentSettings(file: ComponentCanvasFile, component: string, settings: ComponentCanvas): ComponentCanvasFile {
  const components: Record<string, ComponentCanvas> = { ...file.components };
  const frames = settings.frames !== undefined && Object.keys(settings.frames).length > 0 ? settings.frames : undefined;
  if (settings.split === undefined && frames === undefined) {
    // Nothing chosen and nothing set: the component leaves the file rather than sitting in it empty.
    delete components[component];
  } else {
    components[component] = { ...(settings.split === undefined ? {} : { split: settings.split }), ...(frames === undefined ? {} : { frames }) };
  }
  if (Object.keys(components).length > CANVAS_LIMITS.componentsMax) {
    throw new Error(`The canvas keeps settings for at most ${CANVAS_LIMITS.componentsMax} components`);
  }
  return { ...file, components };
}

/** The file with the project's canvas background set, or cleared with `undefined` (the app's own grey again). */
export function withProjectBackground(file: ComponentCanvasFile, background: string | undefined): ComponentCanvasFile {
  const value = background === undefined ? undefined : canvasBackground(background);
  const next: ComponentCanvasFile = { version: 1, ...(value === undefined ? {} : { background: value }), components: file.components };
  assert(next.background === value, 'The project background is what was set');
  return next;
}

/** Where a frame's background comes from: a frame or scope entry (its key), the project, or nowhere (the app's grey). */
export type BackgroundSource = { readonly kind: 'entry'; readonly key: string } | { readonly kind: 'project' } | { readonly kind: 'none' };

/** The background a frame shows and where it comes from: the frame, then its scopes and component, then the project. */
export function frameBackground(file: ComponentCanvasFile, resolved: ResolvedFrame): { readonly value: string | undefined; readonly source: BackgroundSource } {
  const key = resolved.origins.get('background');
  assert(resolved.background === undefined || key !== undefined, 'A frame’s own background says which entry set it');
  if (resolved.background !== undefined && key !== undefined) {
    return { value: resolved.background, source: { kind: 'entry', key } };
  }
  if (file.background !== undefined) {
    return { value: file.background, source: { kind: 'project' } };
  }
  return { value: undefined, source: { kind: 'none' } };
}

// `var(--name` in a background, for a rename: the name is a custom property's, ended where a name ends.
const VARIABLE_REFERENCE = /var\(\s*(--[^\s,()]+)/g;

/** The file with every `var(--name)` its backgrounds read renamed by `rename`; the same file when nothing changed. */
export function renameCanvasVariables(file: ComponentCanvasFile, rename: (name: string) => string): ComponentCanvasFile {
  let changed = false;
  const next = (value: string): string => {
    const renamed = value.replace(VARIABLE_REFERENCE, (match: string, name: string) => match.slice(0, match.length - name.length) + rename(name));
    changed ||= renamed !== value;
    return renamed;
  };
  const components = Object.fromEntries(
    Object.entries(file.components).map(([component, settings]): [string, ComponentCanvas] => {
      const frames = settings.frames;
      if (frames === undefined) {
        return [component, settings];
      }
      const renamed = Object.fromEntries(
        Object.entries(frames).map(([key, entry]): [string, FrameEntry] => [
          key,
          entry.background === undefined ? entry : { ...entry, background: next(entry.background) },
        ]),
      );
      return [component, { ...settings, frames: renamed }];
    }),
  );
  const background = file.background === undefined ? undefined : next(file.background);
  if (!changed) {
    return file;
  }
  const result: ComponentCanvasFile = { version: 1, ...(background === undefined ? {} : { background: canvasBackground(background) }), components };
  assert(Object.keys(result.components).length === Object.keys(file.components).length, 'A rename keeps every component');
  assert((result.background === undefined) === (file.background === undefined), 'A rename neither adds nor drops the project background');
  return result;
}

// ----- Project upkeep -----

/** The settings after a component file was renamed or moved: its key follows the file. A target that already has settings keeps them. */
export function relinkComponentCanvas(file: ComponentCanvasFile, from: string, to: string): ComponentCanvasFile {
  canvasComponentFile(to);
  const settings = file.components[from];
  if (settings === undefined || file.components[to] !== undefined) {
    return file;
  }
  const components: Record<string, ComponentCanvas> = {};
  for (const [name, held] of Object.entries(file.components)) {
    components[name === from ? to : name] = held;
  }
  assert(Object.keys(components).length === Object.keys(file.components).length, 'A relink keeps every component');
  return { ...file, components };
}

/** The settings without the components a deletion removes (`owns` says which files it removes). */
export function dropComponentCanvas(file: ComponentCanvasFile, owns: (component: string) => boolean): ComponentCanvasFile {
  const components = Object.fromEntries(Object.entries(file.components).filter(([name]) => !owns(name)));
  assert(Object.keys(components).length <= Object.keys(file.components).length, 'A drop never adds a component');
  return { ...file, components };
}

/**
 * What `astro-studio check-project` reports: each canvas key that names no component the project has. The canvas
 * itself ignores such a key, and the app's own renames and deletions keep keys current, so one left here means a
 * component was renamed, moved or deleted outside the app and its key has to follow it.
 */
export function canvasIssues(file: ComponentCanvasFile, componentFiles: readonly string[]): readonly string[] {
  const known = new Set(componentFiles);
  const issues = Object.keys(file.components)
    .filter((component) => !known.has(component))
    .map((component) => `${COMPONENT_CANVAS_FILE} names ${component}, which is not a component in this project.`);
  assert(issues.length <= Object.keys(file.components).length, 'At most one issue per component');
  return issues;
}
