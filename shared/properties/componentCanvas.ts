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
//
// A prop's preview value is held in one of three places, as `.stacki/components.json` holds its defaults
// (componentDefaultValues.ts): `props` (text, numbers, on and off), `assets` (an imported file under src/) or
// `literals` (a list or object of plain data, read token by token, never run). `content` is the default slot's markup.
// Released Stacki versions have no component canvas and ignore this file. A development build from before `assets`,
// `literals` and `content` refuses a file that holds them, naming the key, rather than dropping them.
import { assert } from '../core/assert';
import { err, ok, type Result } from '../core/result';
import { record } from '../core/boundary';
import {
  defaultAssetUses,
  heldDefaults,
  isAssetDefaultFile,
  parseHeldDefaults,
  relinkDefaultAssets,
  type AssetDefaultUse,
  type HeldDefaults,
  type AssetDefault,
  type AssetDefaults,
  type LiteralDefault,
  type LiteralDefaults,
} from './componentDefaultValues';
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
  valueCharsMax: 16_384,
  contentCharsMax: 16_384,
  propNameCharsMax: 100,
  keyCharsMax: 1_024,
  backgroundCharsMax: 256,
  /** Classes the canvas root (its page's <html>) carries: a theme class or two, never a stylesheet's worth. */
  rootClassesMax: 32,
  classNameCharsMax: 128,
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
  readonly assets?: AssetDefaults;
  readonly literals?: LiteralDefaults;
  /** The default slot's markup here: HTML with no script or event handler; `` is an empty slot. */
  readonly content?: string;
  readonly width?: FrameLength;
  readonly height?: FrameLength;
  /** A CSS colour or `var(--…)`; absent: transparent, or what a wider scope sets. */
  readonly background?: string;
}

/**
 * The canvas root: the page's <html>, which every frame is drawn inside. Its classes re-theme every frame (a site's
 * `theme-dark` on <html>), its background is the surface the frames sit on. The project's is the default; a
 * component's own replaces it, setting by setting (classes as a whole list, not merged).
 */
export interface CanvasRoot {
  /** A CSS colour, `transparent`, or `var(--name)`; absent: what the project sets, else the app's own grey. */
  readonly background?: string;
  /** Class names, in order, after the classes the site's layout puts on <html>. */
  readonly classes?: readonly string[];
}

/**
 * How a canvas lays out what sits together at one level: side by side in one row, stacked in one column, or side by
 * side wrapping into rows at a fixed width. A level is the canvas itself (its <html>, CANVAS_LEVEL: the top-level groups
 * and frames) or one group (its key: that group's direct children). Each level has its own choice; none is inherited.
 * Levels nest no deeper than the split (CANVAS_LIMITS.splitPropsMax).
 */
export const CANVAS_ARRANGEMENTS = ['row', 'column', 'wrap'] as const;
export type CanvasArrangement = (typeof CANVAS_ARRANGEMENTS)[number];
/** The canvas's own level key. Never a frame key (a group's level is one), and not `` since a file's keys are not empty. */
export const CANVAS_LEVEL = '*canvas';
/** What a group nobody arranged does, and the canvas too unless it has groups or rows: side by side. */
export const DEFAULT_ARRANGEMENT = 'row' as const satisfies CanvasArrangement;

/** The levels a canvas has now: its groups' keys, and whether its top level goes down the page (it has groups or rows). */
export interface CanvasLevels {
  readonly groups: readonly string[];
  readonly stacked: boolean;
}

export interface ComponentCanvas {
  /** The props that get their own frames, in layout order; absent: the canvas chooses (defaultSplit). */
  readonly split?: readonly string[];
  readonly frames?: Readonly<Record<string, FrameEntry>>;
  /** This component's canvas root, over the project's. */
  readonly root?: CanvasRoot;
  /**
   * How every level was laid out, as saved before each level had its own choice: read as what each of them shows until
   * the component has `layouts`. The first layout edit adds those and leaves this as it was, which is what versions
   * before `layouts` go on drawing.
   */
  readonly arrange?: Exclude<CanvasArrangement, typeof DEFAULT_ARRANGEMENT>;
  /**
   * Each level's own layout, by level key (CANVAS_LEVEL or a group's); absent: the level's default. In the file this is
   * the top-level `levelLayouts` entry of the component, not a key of the component's own (parseComponentCanvasFile).
   * Empty only beside `arrange`: every level is then at its default, whatever `arrange` says.
   */
  readonly layouts?: Readonly<Record<string, CanvasArrangement>>;
}

export interface ComponentCanvasFile {
  readonly version: 1;
  /**
   * The project's canvas background: the surface every component canvas draws on, and what a frame shows where neither
   * the frame nor its component sets a background. A CSS colour, `transparent`, or `var(--name)`, which follows the
   * variable. Absent: the app's own canvas grey. Versions before this key ignore it, and drop it on their next save.
   */
  readonly background?: string;
  /** The project's canvas root classes (CanvasRoot.classes); versions before this key ignore it. */
  readonly classes?: readonly string[];
  readonly components: Readonly<Record<string, ComponentCanvas>>;
  /** Top-level keys a later version wrote: kept as read, so saving from this one never drops them. */
  readonly later?: Readonly<Record<string, unknown>>;
}

// `levelLayouts` is a top-level key so that a version without it keeps the file: 1.4.20 refuses a whole file over an
// unknown key of a component's, and keeps an unknown top-level key as read (ComponentCanvasFile.later).
const FILE_FIELDS: ReadonlySet<string> = new Set(['version', 'background', 'classes', 'components', 'levelLayouts']);

export const EMPTY_CANVAS_FILE: ComponentCanvasFile = { version: 1, components: {} };

// ----- Parsing -----

const PROP_NAME = /^[A-Za-z_$][\w$-]*$/;
const COMPONENT_FILE = /^(?:src\/|node_modules\/)[^\0]*\.astro$/;
const ENTRY_FIELDS = new Set(['props', 'unset', 'assets', 'literals', 'content', 'width', 'height', 'background']);
const COMPONENT_FIELDS = new Set(['split', 'frames', 'root', 'arrange']);
const ROOT_FIELDS = new Set(['background', 'classes']);
// A class name as a selector can name it without escapes; `stacki-` is the canvas's own (`stacki-designer`).
const CLASS_NAME = /^-?[A-Za-z_][\w-]*$/;

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
  const laidOut = withLevelLayouts(components, value['levelLayouts']);
  const background = value['background'] === undefined ? undefined : canvasBackground(value['background']);
  assert((background?.length ?? 0) <= CANVAS_LIMITS.backgroundCharsMax, 'Component canvas: the project background is bounded');
  const classes = value['classes'] === undefined ? undefined : canvasRootClasses(value['classes']);
  const later = Object.entries(value).filter(([key]) => !FILE_FIELDS.has(key));
  return canvasFileOf({ background, classes, later: later.length === 0 ? undefined : Object.fromEntries(later) }, laidOut);
}

// The file with its project-level settings, each written only when it is set.
function canvasFileOf(
  project: {
    readonly background: string | undefined;
    readonly classes: readonly string[] | undefined;
    readonly later?: Readonly<Record<string, unknown>> | undefined;
  },
  components: Readonly<Record<string, ComponentCanvas>>,
): ComponentCanvasFile {
  assert(Object.keys(components).length <= CANVAS_LIMITS.componentsMax, 'The canvas file keeps settings for a bounded number of components');
  return {
    version: 1,
    ...(project.background === undefined ? {} : { background: project.background }),
    ...(project.classes === undefined ? {} : { classes: project.classes }),
    components,
    ...(project.later === undefined ? {} : { later: project.later }),
  };
}

/** Classes for the canvas root: a bounded list of distinct names a selector can name, none of them the canvas's own. */
export function canvasRootClasses(input: unknown): readonly string[] {
  if (!Array.isArray(input) || input.length > CANVAS_LIMITS.rootClassesMax) {
    throw new Error(`Component canvas: the root's classes are a list of at most ${CANVAS_LIMITS.rootClassesMax} names`);
  }
  const names = input.map((name: unknown): string => {
    if (typeof name !== 'string' || name.length > CANVAS_LIMITS.classNameCharsMax || !CLASS_NAME.test(name)) {
      throw new Error(`Component canvas: ${String(name)} is not a class name of at most ${CANVAS_LIMITS.classNameCharsMax} characters`);
    }
    if (name.startsWith('stacki-')) {
      throw new Error(`Component canvas: ${name} is a class the canvas keeps for itself`);
    }
    return name;
  });
  if (new Set(names).size !== names.length) {
    throw new Error('Component canvas: the root names a class twice');
  }
  return names;
}

function parseCanvasRoot(input: unknown, file: string): CanvasRoot {
  const value = record(input);
  for (const key of Object.keys(value)) {
    if (!ROOT_FIELDS.has(key)) {
      throw new Error(`Component canvas: ${file}'s root has an unknown key ${key}`);
    }
  }
  const background = value['background'] === undefined ? undefined : canvasBackground(value['background']);
  const classes = value['classes'] === undefined ? undefined : canvasRootClasses(value['classes']);
  return { ...(background === undefined ? {} : { background }), ...(classes === undefined ? {} : { classes }) };
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
  const root = value['root'] === undefined ? undefined : parseCanvasRoot(value['root'], file);
  const arrange = value['arrange'] === undefined ? undefined : parseArrangement(value['arrange'], file);
  return {
    ...(split === undefined ? {} : { split }),
    ...(framesInput === undefined ? {} : { frames }),
    ...(root === undefined ? {} : { root }),
    ...(arrange === undefined ? {} : { arrange }),
  };
}

// Each component's `layouts`, from the top-level key. An entry may name a component with no other settings; one whose
// component an older version has renamed or deleted since stays under its old name, drawn nowhere.
function withLevelLayouts(components: Readonly<Record<string, ComponentCanvas>>, input: unknown): Readonly<Record<string, ComponentCanvas>> {
  if (input === undefined) {
    return components;
  }
  const entries = Object.entries(record(input));
  if (entries.length > CANVAS_LIMITS.componentsMax) {
    throw new Error(`Component canvas: more than ${CANVAS_LIMITS.componentsMax} components have layouts`);
  }
  const laidOut = entries.map(([name, layouts]): readonly [string, ComponentCanvas] => {
    const file = canvasComponentFile(name);
    return [file, { ...components[file], layouts: parseLayouts(layouts, file) }];
  });
  const merged = { ...components, ...Object.fromEntries(laidOut) };
  if (Object.keys(merged).length > CANVAS_LIMITS.componentsMax) {
    throw new Error(`Component canvas: more than ${CANVAS_LIMITS.componentsMax} components`);
  }
  return merged;
}

function parseLayouts(input: unknown, file: string): Readonly<Record<string, CanvasArrangement>> {
  const entries = Object.entries(record(input));
  if (entries.length > CANVAS_LIMITS.entriesMax) {
    throw new Error(`Component canvas: ${file} lays out more than ${CANVAS_LIMITS.entriesMax} levels`);
  }
  return Object.fromEntries(
    entries.map(([level, value]) => {
      const arrangement = CANVAS_ARRANGEMENTS.find((candidate) => candidate === value);
      if (arrangement === undefined) {
        throw new Error(`Component canvas: ${file} arranges its frames as row, column or wrap`);
      }
      return [parseLevel(level), arrangement];
    }),
  );
}

// A stored arrangement: one of the choices. The default is written as no key at all, and read as none if a person
// wrote it by hand, so the file still says one thing one way.
function parseArrangement(input: unknown, file: string): ComponentCanvas['arrange'] {
  if (input === 'column' || input === 'wrap') {
    return input;
  }
  if (input === DEFAULT_ARRANGEMENT) {
    return undefined;
  }
  throw new Error(`Component canvas: ${file} arranges its frames as row, column or wrap`);
}

function parseLevel(level: string): string {
  if (level === CANVAS_LEVEL) {
    return level;
  }
  if (level === '') {
    throw new Error(`Component canvas: the canvas’s own layout is keyed ${CANVAS_LEVEL}`);
  }
  return parseFrameKey(level);
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
  const held = parseHeldDefaults(value, entry.props ?? {});
  const heldNames = [...Object.keys(held.assets ?? {}), ...Object.keys(held.literals ?? {})];
  heldNames.forEach((name) => propName(name));
  if (heldNames.some((name) => entry.unset?.includes(name) === true)) {
    throw new Error('Component canvas: a prop is either given a value or unset, not both');
  }
  if (heldNames.length + Object.keys(entry.props ?? {}).length > CANVAS_LIMITS.valuesMax) {
    throw new Error(`Component canvas: a frame holds at most ${CANVAS_LIMITS.valuesMax} values`);
  }
  if (held.assets !== undefined) {
    entry.assets = held.assets;
  }
  if (held.literals !== undefined) {
    entry.literals = held.literals;
  }
  if (value['content'] !== undefined) {
    entry.content = canvasContent(value['content']);
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

// Markup that runs code. The canvas writes content as HTML text (never as Astro source, so braces are only words),
// and this keeps a hand-edited file from putting a script in the preview.
const CONTENT_REFUSED = /<\s*\/?\s*(?:script|style|iframe|object|embed|slot|template|link|meta|base)\b|<[^>]*[\s/"']on[a-z]+\s*=|javascript:/i;

/** A frame's default-slot markup: bounded HTML with nothing that runs. */
export function canvasContent(input: unknown): string {
  if (typeof input !== 'string' || input.length > CANVAS_LIMITS.contentCharsMax) {
    throw new Error(`Component canvas: content is text of at most ${CANVAS_LIMITS.contentCharsMax} characters`);
  }
  if (CONTENT_REFUSED.test(input)) {
    throw new Error('Component canvas: content is words and plain markup, with no script, style or event handler');
  }
  return input;
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
  const names = Object.keys(file.components).sort();
  const components: Record<string, ComponentCanvas> = {};
  const levelLayouts: Record<string, Readonly<Record<string, CanvasArrangement>>> = {};
  for (const name of names) {
    const { layouts, ...settings } = file.components[name] ?? {};
    if (layouts !== undefined) {
      levelLayouts[name] = Object.fromEntries(Object.entries(layouts).sort(([left], [right]) => (left < right ? -1 : 1)));
    }
    // A component whose only settings are its layouts is named there alone.
    if (layouts === undefined || Object.keys(settings).length > 0) {
      components[name] = sortedSettings(settings);
    }
  }
  const { later, ...known } = canvasFileOf({ background: file.background, classes: file.classes, later: file.later }, components);
  const layoutsKey = Object.keys(levelLayouts).length === 0 ? {} : { levelLayouts };
  const text = JSON.stringify({ ...known, ...layoutsKey, ...later }, undefined, 2) + '\n';
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
    // Classes keep their order: a later class wins a tie in the cascade, as on <html> itself.
    ...(settings.root === undefined ? {} : { root: settings.root }),
    ...(settings.arrange === undefined ? {} : { arrange: settings.arrange }),
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
    ...(entry.assets === undefined ? {} : { assets: byName(entry.assets) }),
    ...(entry.literals === undefined ? {} : { literals: byName(entry.literals) }),
    ...(entry.content === undefined ? {} : { content: entry.content }),
    ...(entry.width === undefined ? {} : { width: entry.width }),
    ...(entry.height === undefined ? {} : { height: entry.height }),
    ...(entry.background === undefined ? {} : { background: entry.background }),
  };
}

function byName<T>(held: Readonly<Record<string, T>>): Readonly<Record<string, T>> {
  return Object.fromEntries(Object.entries(held).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)));
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
  readonly assets: AssetDefaults;
  readonly literals: LiteralDefaults;
  /** The default slot's markup; undefined: the component defaults' content. */
  readonly content: string | undefined;
  readonly width: FrameLength;
  readonly height: FrameLength;
  readonly background: string | undefined;
  /** The key of the entry each value, unset prop, `content` or frame field comes from. */
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
  const values: HeldMaps = { props: new Map(), assets: new Map(), literals: new Map(), unset: new Set() };
  const origins = new Map<string, string>();
  let width: FrameLength = 'hug';
  let height: FrameLength = 'hug';
  let background: string | undefined;
  let content: string | undefined;
  for (const [stored, entry] of matchingEntries(settings, key)) {
    for (const name of layEntry(values, entry)) {
      origins.set('prop:' + name, stored);
    }
    if (entry.content !== undefined) {
      content = entry.content;
      origins.set('content', stored);
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
  return {
    props: Object.fromEntries(values.props),
    assets: Object.fromEntries(values.assets),
    literals: Object.fromEntries(values.literals),
    unset: values.unset,
    content,
    width,
    height,
    background,
    origins,
  };
}

interface HeldMaps {
  readonly props: Map<string, CanvasValue>;
  readonly assets: Map<string, AssetDefault>;
  readonly literals: Map<string, LiteralDefault>;
  readonly unset: Set<string>;
}

// One entry's prop values over what wider entries gave: a name it sets leaves whichever place held it before. Returns
// the names the entry speaks for.
function layEntry(values: HeldMaps, entry: FrameEntry): readonly string[] {
  const drop = (name: string): void => {
    values.props.delete(name);
    values.assets.delete(name);
    values.literals.delete(name);
    values.unset.delete(name);
  };
  const lay = <T>(held: Readonly<Record<string, T>> | undefined, into: Map<string, T>): readonly string[] =>
    Object.entries(held ?? {}).map(([name, value]) => {
      drop(name);
      into.set(name, value);
      return name;
    });
  // An empty text is no value (an emptied field stores nothing now; an older version stored ''): wider ones show through.
  const props = entry.props === undefined ? undefined : Object.fromEntries(Object.entries(entry.props).filter(([, value]) => value !== ''));
  const names = [...lay(props, values.props), ...lay(entry.assets, values.assets), ...lay(entry.literals, values.literals)];
  for (const name of entry.unset ?? []) {
    drop(name);
    values.unset.add(name);
  }
  return [...names, ...(entry.unset ?? [])];
}

/** Whether the entry itself says anything about the prop. */
export function entryHolds(entry: FrameEntry | undefined, name: string): boolean {
  if (entry === undefined) {
    return false;
  }
  const valued = Object.hasOwn(entry.props ?? {}, name) || Object.hasOwn(entry.assets ?? {}, name) || Object.hasOwn(entry.literals ?? {}, name);
  return valued || entry.unset?.includes(name) === true;
}

/** One setting of a frame: a prop's preview value (`prop:name`), the slot content or a frame field. */
export type FrameSetting = `prop:${string}` | 'content' | 'width' | 'height' | 'background';

/**
 * Where a setting stands for a frame while edits go to `scope`: set at the scope itself (`own`); not set there, and
 * given by a wider entry (`inherited`, from that entry's key); set by a narrower or sibling entry the frame also has,
 * which wins on this frame whatever the scope says (`overridden`); or set nowhere (`none`).
 */
export type SettingLevel =
  | { readonly kind: 'own' }
  | { readonly kind: 'none' }
  | { readonly kind: 'inherited'; readonly from: string }
  | { readonly kind: 'overridden'; readonly by: string };

export function settingLevel(settings: ComponentCanvas | undefined, frame: string, scope: string, setting: FrameSetting): SettingLevel {
  const winner = resolveFrame(settings, frame).origins.get(setting);
  const atScope = resolveFrame(settings, scope).origins.get(setting);
  if (winner !== undefined && winner !== atScope) {
    return { kind: 'overridden', by: winner };
  }
  if (atScope === undefined) {
    return { kind: 'none' };
  }
  return atScope === scope ? { kind: 'own' } : { kind: 'inherited', from: atScope };
}

// ----- Edits -----

export type FrameEdit =
  | { readonly kind: 'prop'; readonly name: string; readonly value: CanvasValue }
  | { readonly kind: 'asset'; readonly name: string; readonly asset: AssetDefault }
  | { readonly kind: 'literal'; readonly name: string; readonly literal: LiteralDefault }
  /** The default slot's markup at this scope; undefined: what a wider scope or the component defaults give. */
  | { readonly kind: 'content'; readonly value: string | undefined }
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
  const result = withComponentSettings(file, component, { ...settings, frames });
  assert(parseComponentCanvasSource(serializeComponentCanvas(result)).ok, 'An edited canvas file parses');
  return result;
}

function editedEntry(entry: FrameEntry, edit: FrameEdit): FrameEntry {
  switch (edit.kind) {
    case 'prop':
    case 'asset':
    case 'literal':
    case 'unset':
    case 'inherit':
      return editedValues(entry, edit);
    case 'content':
      return withoutAbsent({ ...entry, content: edit.value === undefined ? undefined : canvasContent(edit.value) });
    case 'field':
      return withoutAbsent({ ...entry, [edit.field]: edit.value === undefined ? undefined : frameLength(edit.value) });
    case 'background':
      return withoutAbsent({ ...entry, background: edit.value === undefined ? undefined : canvasBackground(edit.value) });
    default: {
      const exhaustive: never = edit;
      return exhaustive;
    }
  }
}

// The entry with one prop's value set, unset or dropped: whatever held the prop before no longer does.
function editedValues(entry: FrameEntry, edit: Extract<FrameEdit, { readonly kind: 'prop' | 'asset' | 'literal' | 'unset' | 'inherit' }>): FrameEntry {
  propName(edit.name);
  const without = <T>(held: Readonly<Record<string, T>> | undefined): Record<string, T> =>
    Object.fromEntries(Object.entries(held ?? {}).filter(([name]) => name !== edit.name));
  const props = without(entry.props);
  const assets = without(entry.assets);
  const literals = without(entry.literals);
  const unset = (entry.unset ?? []).filter((name) => name !== edit.name);
  if (edit.kind === 'prop') {
    props[edit.name] = canvasValue(edit.value);
  } else if (edit.kind === 'asset') {
    assert(isAssetDefaultFile(edit.asset.file), 'An asset value is a media file under src/');
    assets[edit.name] = edit.asset;
  } else if (edit.kind === 'literal') {
    literals[edit.name] = edit.literal;
  } else if (edit.kind === 'unset') {
    unset.push(edit.name);
  }
  const valued = Object.keys(props).length + Object.keys(assets).length + Object.keys(literals).length;
  if (valued > CANVAS_LIMITS.valuesMax || unset.length > CANVAS_LIMITS.valuesMax) {
    throw new Error(`A frame holds at most ${CANVAS_LIMITS.valuesMax} values`);
  }
  const some = <T>(held: Record<string, T>): Record<string, T> | undefined => (Object.keys(held).length === 0 ? undefined : held);
  return withoutAbsent({ ...entry, props: some(props), assets: some(assets), literals: some(literals), unset: unset.length === 0 ? undefined : unset });
}

type EntryDraft = { [K in keyof FrameEntry]?: FrameEntry[K] | undefined };

// An entry holds only the keys it sets.
function withoutAbsent(draft: EntryDraft): FrameEntry {
  const entry: FrameEntry = Object.fromEntries(Object.entries(draft).filter(([, value]) => value !== undefined));
  assert(
    Object.keys(entry).every((key) => ENTRY_FIELDS.has(key)),
    'An edited entry keeps known keys',
  );
  return entry;
}

function isEmptyEntry(entry: FrameEntry): boolean {
  return Object.keys(entry).length === 0;
}

/** Whether every pair of `scope` is one of `key`'s: the scope's edits reach the frame or narrower scope `key`. */
export function scopeHolds(scope: string, key: string): boolean {
  const pairs = new Set(keyPairs(key));
  return keyPairs(scope).every((pair) => pairs.has(pair));
}

/**
 * The frames among `frames` that `scope` reaches but that show a value of their own for `setting`: one an entry
 * narrower than the scope sets (a frame's own size, a variant's), which wins over what the scope says. Each with the
 * entry its value comes from.
 */
export function overridesIn(
  settings: ComponentCanvas | undefined,
  frames: readonly string[],
  scope: string,
  setting: FrameSetting,
): readonly { readonly frame: string; readonly from: string }[] {
  assert(frames.length <= CANVAS_LIMITS.framesMax, 'A canvas has a bounded number of frames');
  const found = frames.flatMap((frame) => {
    if (!scopeHolds(scope, frame)) {
      return [];
    }
    const from = resolveFrame(settings, frame).origins.get(setting);
    // Narrower than the scope: it holds every pair of the scope and more.
    return from !== undefined && from !== scope && scopeHolds(scope, from) ? [{ frame, from }] : [];
  });
  assert(
    found.every((entry) => entry.from !== scope),
    'An override is never the scope itself',
  );
  return found;
}

/**
 * The file without what entries narrower than `scope` say about `setting`, so every frame the scope reaches shows the
 * scope's value: the reset of overrides. Entries left empty are removed; the scope's own entry and wider ones stay.
 */
export function withoutOverrides(file: ComponentCanvasFile, component: string, scope: string, setting: FrameSetting): ComponentCanvasFile {
  parseFrameKey(scope);
  const settings = file.components[component];
  // Only the entries that say something about the setting: the others are left exactly as they are.
  const entries = Object.keys(settings?.frames ?? {}).filter(
    (key) => key !== scope && scopeHolds(scope, key) && resolveFrame(settings, key).origins.get(setting) === key,
  );
  assert(entries.length <= CANVAS_LIMITS.entriesMax, 'A component keeps a bounded number of entries');
  assert(!entries.includes(scope), "The scope's own entry is never cleared");
  const edit = clearingEdit(setting);
  return entries.reduce((next, key) => withFrameEdit(next, component, key, edit), file);
}

/** A frame setting Frame settings edits under its one "Apply to": a side's size, or the background. */
export type SharedSetting = 'width' | 'height' | 'background';

/** An edit of one of them; an undefined value takes what the scope's frames set away, so wider settings show. */
export type SharedEdit = Extract<FrameEdit, { readonly kind: 'field' | 'background' }>;

/**
 * The file with one setting given to every frame of `frames` that `scope` reaches, and to no other: afterwards each of
 * them shows the value. What narrower entries said about it for those frames goes. A frame can still be won by an entry
 * of another axis (`variant=main` over `emphasis=primary`: as specific, and later in order), which also reaches frames
 * outside the scope and so stays: the value is then written where the two meet, which reaches only frames in scope.
 * Every entry is an ordinary frame key, so older versions read the file as they always have.
 */
export function withSharedEdit(file: ComponentCanvasFile, component: string, scope: string, edit: SharedEdit, frames: readonly string[]): ComponentCanvasFile {
  assert(frames.length <= CANVAS_LIMITS.framesMax, 'A canvas has a bounded number of frames');
  const setting: SharedSetting = edit.kind === 'field' ? edit.field : 'background';
  const reached = frames.filter((frame) => scopeHolds(scope, frame));
  const narrower = Object.entries(file.components[component]?.frames ?? {})
    .filter(([key, entry]) => key !== scope && scopeHolds(scope, key) && entry[setting] !== undefined)
    .map(([key]) => key)
    // An entry no frame here matches (a split turned off) is kept for when its frames return.
    .filter((key) => reached.some((frame) => scopeHolds(key, frame)));
  const cleared = narrower.reduce((next, key) => withFrameEdit(next, component, key, clearingEdit(setting)), file);
  const written = withFrameEdit(cleared, component, scope, edit);
  if (edit.value === undefined) {
    return written;
  }
  const value = written.components[component]?.frames?.[scope]?.[setting];
  assert(value !== undefined, 'The scope holds the value it was given');
  const result = reached.reduce((next, frame) => withValueOn(next, component, { scope, frame, edit, value }), written);
  assert(
    reached.every((frame) => resolveFrame(result.components[component], frame)[setting] === value),
    'Every frame in scope shows the value',
  );
  return result;
}

// One frame in scope made to show the value: while another entry wins on it, the value is written at the scope's pairs
// and that entry's together. Each round's key holds more pairs than the winner, so the frame's pairs bound the rounds.
function withValueOn(
  file: ComponentCanvasFile,
  component: string,
  target: { readonly scope: string; readonly frame: string; readonly edit: SharedEdit; readonly value: FrameLength | string },
): ComponentCanvasFile {
  const setting: SharedSetting = target.edit.kind === 'field' ? target.edit.field : 'background';
  let next = file;
  for (let round = 0; round <= keyPairs(target.frame).length; round++) {
    const shown = resolveFrame(next.components[component], target.frame);
    if (shown[setting] === target.value) {
      return next;
    }
    const winner = shown.origins.get(setting);
    assert(winner !== undefined, 'A frame that differs takes its value from an entry');
    next = withFrameEdit(next, component, joinedKey(target.scope, winner), target.edit);
  }
  assert(false, 'The frame’s own key wins over every entry it matches');
}

// The key that holds both keys' pairs, in a key's order (frameKey: by prop name).
function joinedKey(left: string, right: string): string {
  const prop = (pair: string): string => pair.split('=')[0] ?? '';
  // No two pairs name one prop: both keys are pairs of one frame, which names each once.
  const pairs = [...new Set([...keyPairs(left), ...keyPairs(right)])].sort((first, second) => (prop(first) < prop(second) ? -1 : 1));
  return parseFrameKey(pairs.join('&'));
}

/**
 * The frames among `frames` that `scope` reaches and that Reset would change: with a value at the scope, those showing
 * another; without one, those a narrower entry gives a value.
 */
export function sharedOverrides(settings: ComponentCanvas | undefined, frames: readonly string[], scope: string, setting: SharedSetting): readonly string[] {
  const own = settings?.frames?.[scope]?.[setting];
  if (own === undefined) {
    return overridesIn(settings, frames, scope, setting).map((entry) => entry.frame);
  }
  return frames.filter((frame) => scopeHolds(scope, frame) && resolveFrame(settings, frame)[setting] !== own);
}

// The edit that drops one setting from an entry.
function clearingEdit(setting: FrameSetting): FrameEdit {
  if (setting === 'width' || setting === 'height') {
    return { kind: 'field', field: setting, value: undefined };
  }
  if (setting === 'background') {
    return { kind: 'background', value: undefined };
  }
  if (setting === 'content') {
    return { kind: 'content', value: undefined };
  }
  const name = setting.slice('prop:'.length);
  assert(name.length > 0, 'A prop setting names its prop');
  return { kind: 'inherit', name };
}

/**
 * Whether the frames of `frames` that `scope` reaches show different values for `setting`: the field that edits them
 * all then says Mixed rather than one frame's value.
 */
export function settingMixed(settings: ComponentCanvas | undefined, frames: readonly string[], scope: string, setting: FrameSetting): boolean {
  assert(frames.length <= CANVAS_LIMITS.framesMax, 'A canvas has a bounded number of frames');
  const shown = new Set(frames.filter((frame) => scopeHolds(scope, frame)).map((frame) => settingText(resolveFrame(settings, frame), setting)));
  assert(shown.size <= frames.length, 'A frame shows one value for a setting');
  return shown.size > 1;
}

// One frame's value for a setting, as text that is equal exactly when the values are.
function settingText(frame: ResolvedFrame, setting: FrameSetting): string {
  if (setting === 'width' || setting === 'height' || setting === 'background' || setting === 'content') {
    // A side or value that is absent is left out of the object, so absent and absent compare equal.
    return JSON.stringify({ value: frame[setting] });
  }
  const name = setting.slice('prop:'.length);
  assert(name.length > 0, 'A prop setting names its prop');
  return JSON.stringify({ prop: frame.props[name], asset: frame.assets[name], literal: frame.literals[name], unset: frame.unset.has(name) });
}

/** The file with the props a component splits by set; `undefined` goes back to the default choice. */
export function withSplit(file: ComponentCanvasFile, component: string, split: readonly string[] | undefined): ComponentCanvasFile {
  canvasComponentFile(component);
  if (split !== undefined) {
    parseSplit(split, component);
  }
  return withComponentSettings(file, component, { ...file.components[component], split });
}

/** What a level nobody arranged does: the canvas goes down the page when it has groups or rows; else side by side. */
export function defaultArrangement(level: string, levels: CanvasLevels): CanvasArrangement {
  return level === CANVAS_LEVEL && levels.stacked ? 'column' : DEFAULT_ARRANGEMENT;
}

/**
 * The layouts a component's canvas has chosen, by level. A single `arrange` saved before levels had their own stands for
 * each level the canvas has now, as it drew them: every group, and the canvas itself, except that wrapping never
 * reached a top level that goes down the page.
 */
export function chosenLayouts(settings: ComponentCanvas | undefined, levels: CanvasLevels): Readonly<Record<string, CanvasArrangement>> {
  const before = settings?.arrange;
  if (settings?.layouts !== undefined || before === undefined) {
    return settings?.layouts ?? {};
  }
  assert(levels.groups.length <= CANVAS_LIMITS.entriesMax, 'A canvas has a bounded number of levels');
  const top = before === 'wrap' && levels.stacked ? [] : [CANVAS_LEVEL];
  return Object.fromEntries([...top, ...levels.groups].map((level) => [level, before]));
}

/** How one level is laid out, and whether that is a choice saved for it (else the level's default). */
export function levelArrangement(
  settings: ComponentCanvas | undefined,
  level: string,
  levels: CanvasLevels,
): { readonly value: CanvasArrangement; readonly chosen: boolean } {
  const held = chosenLayouts(settings, levels)[level];
  return held === undefined ? { value: defaultArrangement(level, levels), chosen: false } : { value: held, chosen: true };
}

/**
 * The file with one level laid out as `arrangement`, or back at its default with `undefined`. Choosing the default is
 * no setting. Every other level keeps what it shows.
 */
export function withLevelArrangement(
  file: ComponentCanvasFile,
  component: string,
  level: string,
  arrangement: CanvasArrangement | undefined,
  levels: CanvasLevels,
): ComponentCanvasFile {
  canvasComponentFile(component);
  parseLevel(level);
  const settings = file.components[component];
  const layouts: Record<string, CanvasArrangement> = { ...chosenLayouts(settings, levels) };
  if (arrangement === undefined || arrangement === defaultArrangement(level, levels)) {
    delete layouts[level];
  } else {
    layouts[level] = arrangement;
  }
  assert(Object.keys(layouts).length <= CANVAS_LIMITS.entriesMax, 'A canvas lays out a bounded number of levels');
  // Beside an `arrange`, even no choice at all is kept: it says every level is at its default.
  const kept = Object.keys(layouts).length === 0 && settings?.arrange === undefined ? undefined : layouts;
  const next = withComponentSettings(file, component, { ...settings, layouts: kept });
  const shown = levelArrangement(next.components[component], level, levels).value;
  assert(shown === (arrangement ?? defaultArrangement(level, levels)), 'The arrangement written is the one read back');
  return next;
}

// The file with one component's settings replaced. `settings` is everything the component keeps: a writer starts from
// what is stored and changes only its own key. Only an empty `frames` or `root` is left out.
function withComponentSettings(
  file: ComponentCanvasFile,
  component: string,
  settings: { readonly [K in keyof ComponentCanvas]: ComponentCanvas[K] | undefined },
): ComponentCanvasFile {
  const components: Record<string, ComponentCanvas> = { ...file.components };
  const kept: ComponentCanvas = Object.fromEntries(Object.entries(settings).filter(([key, value]) => keepsSetting(key, value)));
  if (Object.keys(kept).length === 0) {
    // Nothing chosen and nothing set: the component leaves the file rather than sitting in it empty.
    delete components[component];
  } else {
    components[component] = kept;
  }
  if (Object.keys(components).length > CANVAS_LIMITS.componentsMax) {
    throw new Error(`The canvas keeps settings for at most ${CANVAS_LIMITS.componentsMax} components`);
  }
  return { ...file, components };
}

function keepsSetting(key: string, value: unknown): boolean {
  if (value === undefined) {
    return false;
  }
  // A chosen split of no props is a choice (one frame), as is an arrangement, and layouts of no level beside one
  // (withLevelArrangement writes none otherwise); empty frames or an empty root say nothing.
  if (key === 'split' || key === 'arrange' || key === 'layouts') {
    return true;
  }
  return Object.values(value as object).some((held) => held !== undefined);
}

/** The file with the project's canvas background set, or cleared with `undefined` (the app's own grey again). */
export function withProjectBackground(file: ComponentCanvasFile, background: string | undefined): ComponentCanvasFile {
  return withRootEdit(file, PROJECT_ROOT, { kind: 'background', value: background });
}

/** Where a canvas root setting is written: the project's default, or one component's own. */
export const PROJECT_ROOT = { kind: 'project' } as const;
export type RootTarget = typeof PROJECT_ROOT | { readonly kind: 'component'; readonly file: string };

export type RootEdit =
  { readonly kind: 'background'; readonly value: string | undefined } | { readonly kind: 'classes'; readonly value: readonly string[] | undefined };

/** The file with one canvas root setting set at `target`, or cleared with `undefined` (the wider one shows again). */
export function withRootEdit(file: ComponentCanvasFile, target: RootTarget, edit: RootEdit): ComponentCanvasFile {
  const background = edit.kind === 'background' && edit.value !== undefined ? canvasBackground(edit.value) : undefined;
  const classes = edit.kind === 'classes' && edit.value !== undefined ? canvasRootClasses(edit.value) : undefined;
  const edited = (root: CanvasRoot): CanvasRoot => {
    const next = edit.kind === 'background' ? { ...root, background } : { ...root, classes };
    return {
      ...(next.background === undefined ? {} : { background: next.background }),
      ...(next.classes === undefined ? {} : { classes: next.classes }),
    };
  };
  if (target.kind === 'project') {
    const root = edited({
      ...(file.background === undefined ? {} : { background: file.background }),
      ...(file.classes === undefined ? {} : { classes: file.classes }),
    });
    const next = canvasFileOf({ background: root.background, classes: root.classes, later: file.later }, file.components);
    assert(edit.kind !== 'background' || next.background === background, 'The project background is what was set');
    return next;
  }
  canvasComponentFile(target.file);
  const settings = file.components[target.file] ?? {};
  const next = withComponentSettings(file, target.file, { ...settings, root: edited(settings.root ?? {}) });
  assert(edit.kind !== 'background' || next.components[target.file]?.root?.background === background, 'The component’s own background is what was set');
  return next;
}

/** Whether this component's own value of a root setting replaces the project's, so a project edit does not show on it. */
export function rootOverrides(file: ComponentCanvasFile, component: string, setting: RootEdit['kind']): boolean {
  return file.components[component]?.root?.[setting] !== undefined;
}

/** Where a canvas root setting comes from: the component, the project, or nowhere. */
export type RootSource = 'component' | 'project' | 'none';

/** The canvas root a component's canvas draws with: each setting from the component, else the project. */
export function canvasRoot(
  file: ComponentCanvasFile,
  component: string,
): {
  readonly background: string | undefined;
  readonly backgroundSource: RootSource;
  readonly classes: readonly string[];
  readonly classesSource: RootSource;
} {
  const own = file.components[component]?.root;
  const background = own?.background ?? file.background;
  const classes = own?.classes ?? file.classes ?? [];
  assert(classes.length <= CANVAS_LIMITS.rootClassesMax, 'The canvas root carries a bounded number of classes');
  return {
    background,
    backgroundSource: own?.background !== undefined ? 'component' : file.background !== undefined ? 'project' : 'none',
    classes,
    classesSource: own?.classes !== undefined ? 'component' : file.classes !== undefined ? 'project' : 'none',
  };
}

/** Where a frame's background comes from: a frame or scope entry (its key), the project, or nowhere (the app's grey). */
export type BackgroundSource =
  { readonly kind: 'entry'; readonly key: string } | { readonly kind: 'root' } | { readonly kind: 'project' } | { readonly kind: 'none' };

/** The background a frame shows and where it comes from: the frame, then its scopes and component, then the project. */
export function frameBackground(
  file: ComponentCanvasFile,
  resolved: ResolvedFrame,
  component: string,
): { readonly value: string | undefined; readonly source: BackgroundSource } {
  const key = resolved.origins.get('background');
  assert(resolved.background === undefined || key !== undefined, 'A frame’s own background says which entry set it');
  if (resolved.background !== undefined && key !== undefined) {
    return { value: resolved.background, source: { kind: 'entry', key } };
  }
  const root = canvasRoot(file, component);
  if (root.background !== undefined) {
    return { value: root.background, source: { kind: root.backgroundSource === 'component' ? 'root' : 'project' } };
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
      const root = settings.root?.background === undefined ? settings.root : { ...settings.root, background: next(settings.root.background) };
      const renamed =
        frames === undefined
          ? undefined
          : Object.fromEntries(
              Object.entries(frames).map(([key, entry]): [string, FrameEntry] => [
                key,
                entry.background === undefined ? entry : { ...entry, background: next(entry.background) },
              ]),
            );
      return [component, { ...settings, ...(renamed === undefined ? {} : { frames: renamed }), ...(root === undefined ? {} : { root }) }];
    }),
  );
  const background = file.background === undefined ? undefined : next(file.background);
  if (!changed) {
    return file;
  }
  const project = { background: background === undefined ? undefined : canvasBackground(background), classes: file.classes, later: file.later };
  const result = canvasFileOf(project, components);
  assert(Object.keys(result.components).length === Object.keys(file.components).length, 'A rename keeps every component');
  assert((result.background === undefined) === (file.background === undefined), 'A rename neither adds nor drops the project background');
  return result;
}

// ----- Project upkeep -----

/** Every project file a frame's preview values name, with the component and prop that name it. */
export function canvasAssetUses(file: ComponentCanvasFile): readonly AssetDefaultUse[] {
  const uses = defaultAssetUses({ version: 1, components: canvasRecipes(file) });
  assert(uses.length <= CANVAS_LIMITS.componentsMax * CANVAS_LIMITS.entriesMax * CANVAS_LIMITS.valuesMax * 32, 'Asset uses are bounded');
  return uses.map((use) => ({ ...use, owner: use.owner.slice(use.owner.indexOf('\u0000') + 1) }));
}

// Each frame entry as a default recipe, so the one walk over assets and literal imports serves both files.
function canvasRecipes(file: ComponentCanvasFile): Record<string, HeldDefaults> {
  const recipes: Record<string, HeldDefaults> = {};
  for (const [component, settings] of Object.entries(file.components)) {
    for (const [key, entry] of Object.entries(settings.frames ?? {})) {
      recipes[`${key}\u0000${component}`] = heldDefaults({
        ...(entry.assets === undefined ? {} : { assets: entry.assets }),
        ...(entry.literals === undefined ? {} : { literals: entry.literals }),
      });
    }
  }
  return recipes;
}

/** The settings after a file or folder moved from `from` to `to`; the same file when no preview value named it. */
export function relinkCanvasAssets(file: ComponentCanvasFile, from: string, to: string): ComponentCanvasFile {
  const before = { version: 1 as const, components: canvasRecipes(file) };
  const moved = relinkDefaultAssets(before, from, to);
  if (moved === before) {
    return file;
  }
  const components = Object.fromEntries(
    Object.entries(file.components).map(([component, settings]): [string, ComponentCanvas] => {
      if (settings.frames === undefined) {
        return [component, settings];
      }
      const frames = Object.fromEntries(
        Object.entries(settings.frames).map(([key, entry]): [string, FrameEntry] => {
          const held = moved.components[`${key}\u0000${component}`];
          return [key, withoutAbsent({ ...entry, assets: held?.assets, literals: held?.literals })];
        }),
      );
      return [component, { ...settings, frames }];
    }),
  );
  assert(Object.keys(components).length === Object.keys(file.components).length, 'A relink keeps every component');
  return { ...file, components };
}

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
