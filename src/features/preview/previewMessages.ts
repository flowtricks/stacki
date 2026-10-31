import { parseContextPoint, type ContextPoint } from './contextPosition';
import type { Box } from './outlineBoxes';
import type { Spacing } from './spacingBands';
import {
  boolean,
  count,
  dictionary,
  digest,
  list,
  optional,
  pathText,
  record,
} from '../../../shared/core/boundary';
import type { Digest } from '../../../shared/core/brand';
import { parsePreviewRender, type PreviewRender } from '../../../shared/page/previewToken';
import { GUIDE_LIMITS, parseGuideVariableName, type GuideMetrics } from './guideModel';

export type PreviewMessage =
  | {
      readonly kind: 'rects';
      readonly rects: Readonly<Record<string, readonly Box[] | undefined>>;
      readonly classes: Readonly<Record<string, readonly (readonly string[])[]>>;
      readonly spacing: Readonly<Record<string, readonly (Spacing | undefined)[]>>;
    }
  | {
      readonly kind: 'node-classes';
      readonly classes: Readonly<Record<string, readonly string[]>>;
    }
  | { readonly kind: 'rendered-nodes'; readonly paths: readonly string[] }
  | {
      readonly kind: 'node-states';
      readonly hidden: readonly string[];
      readonly inert: readonly string[];
    }
  | { readonly kind: 'modifiers'; readonly shiftKey: boolean; readonly altKey: boolean }
  | ({ readonly kind: 'hover-node' } & LocatedEvent)
  | ({ readonly kind: 'click-node'; readonly outside: boolean } & LocatedEvent)
  | ({ readonly kind: 'open-node' } & LocatedEvent)
  | ({ readonly kind: 'context-node'; readonly outside: boolean } & LocatedEvent & ContextPoint)
  | { readonly kind: 'canvas-ready' }
  /** What the column guide is drawn from (electron/preload/frameGuide.ts). */
  | { readonly kind: 'guide'; readonly metrics: GuideMetrics }
  /** The rendering the canvas shows: its manifest and token (plan §9, step 7). */
  | { readonly kind: 'render'; readonly render: PreviewRender }
  /** The canvas reloaded instead of patching, and why (step 7). */
  | { readonly kind: 'preview-reload'; readonly reason: PreviewReloadReason }
  | { readonly kind: 'query-result'; readonly input: unknown }
  | {
      readonly kind: 'text-marks';
      readonly hover: TextMarkBox | undefined;
      readonly picked: TextMarkBox | undefined;
    };

/**
 * Text a page hands to the selected component instance, as the canvas frame
 * draws it hovered or picked: its element's box and what to call it. It has
 * no page node of its own to outline, so the frame reports the box itself.
 */
export interface TextMarks {
  readonly hover: TextMarkBox | undefined;
  readonly picked: TextMarkBox | undefined;
}

export const NO_TEXT_MARKS: TextMarks = { hover: undefined, picked: undefined };

export interface TextMarkBox extends Box {
  readonly label: string;
  /** `component` when the element is a component's own root, `text` otherwise. */
  readonly kind: 'component' | 'text';
}

/** Why the canvas patcher reloaded (electron/previewClient/morphClient.ts): past one of its
 * caps, or for the reasons a patch was never possible. */
export const PREVIEW_RELOAD_REASONS = [
  'markers-over-cap',
  'diff-over-cap',
  'scripts-changed',
  'patch-failed',
] as const;
export type PreviewReloadReason = (typeof PREVIEW_RELOAD_REASONS)[number];

/** The notice for a reload a cap caused, or undefined for one the canvas could
 * never have avoided (those stay quiet, as they always were). */
export function describePreviewReload(reason: PreviewReloadReason): string | undefined {
  switch (reason) {
    case 'markers-over-cap':
      return 'The canvas reloaded: this page has more elements than it updates in place.';
    case 'diff-over-cap':
      return 'The canvas reloaded: the change was too large to update in place.';
    case 'scripts-changed':
    case 'patch-failed':
      return undefined;
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

/** A shortcut the canvas frame forwards while it holds keyboard focus
 * (electron/preload/frameDesign.ts): the app replays it as its own key event. */
export type ShortcutMessage =
  | { readonly name: 'insert' }
  | { readonly name: 'arrow'; readonly key: string }
  | { readonly name: 'key'; readonly key: string; readonly meta: boolean };

// A KeyboardEvent key is one character or a short name ("ArrowDown").
const SHORTCUT_KEY_CHARS_MAX = 32;

function shortcutKey(input: unknown): string {
  if (typeof input === 'string') {
    if (input.length <= SHORTCUT_KEY_CHARS_MAX) {
      return input;
    }
    throw new Error('Shortcut key exceeds limit');
  }
  throw new Error('Expected shortcut key');
}

/** A forwarded shortcut, or undefined for any other message — project code
 * posts to the same window, so a message that is not one is ignored. */
export function parseShortcutMessage(input: unknown): ShortcutMessage | undefined {
  try {
    const value = record(input);
    if (value['type'] !== 'avb:shortcut') {
      return undefined;
    }
    switch (value['name']) {
      case 'insert':
        return { name: 'insert' };
      case 'arrow':
        return { name: 'arrow', key: shortcutKey(value['key']) };
      case 'key':
        return { name: 'key', key: shortcutKey(value['key']), meta: value['meta'] === true };
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
}

/** Where on the canvas an event landed, and which rendering it landed on: the
 * token is absent until the frame has digested its rendering's manifest. */
export interface LocatedEvent {
  readonly path: string | undefined;
  readonly occurrence: number;
  readonly token: Digest | undefined;
}

export function parsePreviewMessage(input: unknown): PreviewMessage | undefined {
  let value: Readonly<Record<string, unknown>>;
  try {
    value = record(input);
    return parseKnownMessage(value);
  } catch {
    // Messages originate in project code. Malformed input is ignored at this
    // boundary so one page cannot break the editor's own event loop.
    return undefined;
  }
}

function parseKnownMessage(value: Readonly<Record<string, unknown>>): PreviewMessage | undefined {
  switch (value['type']) {
    case 'avb:rects':
      return parseRects(value);
    case 'avb:node-classes':
      return { kind: 'node-classes', classes: dictionary(list(pathText))(value['classes']) };
    case 'avb:rendered-nodes':
      return { kind: 'rendered-nodes', paths: list(pathText)(value['paths']) };
    case 'avb:node-states':
      return {
        kind: 'node-states',
        hidden: list(pathText)(value['hidden']),
        inert: list(pathText)(value['inert']),
      };
    case 'avb:modifiers':
      return {
        kind: 'modifiers',
        shiftKey: boolean(value['shiftKey']),
        altKey: boolean(value['altKey']),
      };
    case 'avb:hover-node':
      return { kind: 'hover-node', ...parseLocatedMessage(value) };
    case 'avb:click-node':
      return {
        kind: 'click-node',
        ...parseLocatedMessage(value),
        outside: boolean(value['outside']),
      };
    case 'avb:context-node':
      return {
        kind: 'context-node',
        ...parseLocatedMessage(value),
        ...parseContextPoint(value),
        outside: boolean(value['outside']),
      };
    case 'avb:open-node':
      return { kind: 'open-node', ...parseLocatedMessage(value) };
    case 'avb:canvas-ready':
      return { kind: 'canvas-ready' };
    case 'avb:guide':
      return { kind: 'guide', metrics: parseGuideMetrics(value) };
    case 'avb:render':
      return { kind: 'render', render: parsePreviewRender(value) };
    case 'avb:preview-reload':
      return { kind: 'preview-reload', reason: parseReloadReason(value['reason']) };
    case 'avb:query-result':
      return { kind: 'query-result', input: value };
    case 'avb:text-marks':
      return {
        kind: 'text-marks',
        hover: optional(parseTextMarkBox)(value['hover']),
        picked: optional(parseTextMarkBox)(value['picked']),
      };
    default:
      return undefined;
  }
}

function parseRects(value: Readonly<Record<string, unknown>>): PreviewMessage {
  return {
    kind: 'rects',
    rects: dictionary(optional(list(parseBox)))(value['rects']),
    classes: dictionary(list(list(pathText)))(value['classes']),
    spacing: dictionary(list(optional(parseSpacing)))(value['spacing']),
  };
}

function parseGuideMetrics(value: Readonly<Record<string, unknown>>): GuideMetrics {
  const rootFontPx = guideLength(value['rootFontSize']);
  if (rootFontPx === 0) {
    throw new Error('Preview guide: expected a positive root font size');
  }
  if (rootFontPx > GUIDE_LIMITS.rootFontPxMax) {
    throw new Error('Preview guide: root font size exceeds limit');
  }
  return {
    viewportWidthPx: guideLength(value['viewportWidth']),
    rootFontPx,
    marginPx: optional(guideLength)(value['margin']),
    gutterPx: optional(guideLength)(value['gutter']),
    widthMaxPx: optional(guideLength)(value['widthMax']),
    variablesPx: Object.fromEntries(
      guideVariableEntries(value['variables']).map(([name, px]) => [
        name,
        optional(guideLength)(px),
      ]),
    ),
    variableCounts: Object.fromEntries(
      guideVariableEntries(value['counts']).map(([name, input]) => [name, declaredCount(input)]),
    ),
  };
}

// One custom property per menu value plus the project's column fallback.
function guideVariableEntries(input: unknown): ReadonlyArray<readonly [string, unknown]> {
  const entries = Object.entries(record(input));
  if (entries.length > GUIDE_LIMITS.variablesMax) {
    throw new Error('Preview guide: too many variables');
  }
  for (const [name] of entries) {
    if (parseGuideVariableName(name) === undefined) {
      throw new Error('Preview guide: not a variable name');
    }
  }
  return entries;
}

function guideLength(input: unknown): number {
  const value = nonnegativeFinite(input);
  if (value > GUIDE_LIMITS.lengthPxMax) {
    throw new Error('Preview guide: length exceeds limit');
  }
  return value;
}

// A whole number as the page read it. Whether the guide can use it is the
// model's to decide, so invalid variable values remain distinguishable from counts.
function declaredCount(input: unknown): number | undefined {
  return optional(count)(input);
}

function parseReloadReason(input: unknown): PreviewReloadReason {
  const found = PREVIEW_RELOAD_REASONS.find((reason) => reason === input);
  if (found === undefined) {
    throw new Error('Preview reload: unknown reason');
  }
  return found;
}

function parseLocatedMessage(value: Readonly<Record<string, unknown>>): LocatedEvent {
  return {
    path: optional(pathText)(value['path']),
    occurrence: count(value['occurrence']),
    token: optional(digest)(value['token']),
  };
}

function parseBox(input: unknown): Box {
  const value = record(input);
  const width = finite(value['w']);
  const height = finite(value['h']);
  if (width < 0 || height < 0) {
    throw new Error('Preview rectangle: expected nonnegative size');
  }
  return { x: finite(value['x']), y: finite(value['y']), w: width, h: height };
}

function parseTextMarkBox(input: unknown): TextMarkBox {
  const value = record(input);
  const kind = value['kind'];
  if (kind !== 'component' && kind !== 'text') {
    throw new Error('Text mark: expected component or text');
  }
  return { ...parseBox(value), label: pathText(value['label']), kind };
}

function parseSpacing(input: unknown): Spacing {
  const value = record(input);
  const padding = optional(parseSides)(value['padding']);
  const margin = optional(parseSides)(value['margin']);
  const gaps = optional(list(parseGap))(value['gaps']);
  const units = optional(dictionary(nonnegativeFinite))(value['units']);
  return {
    ...(padding === undefined ? {} : { padding }),
    ...(margin === undefined ? {} : { margin }),
    ...(gaps === undefined ? {} : { gaps }),
    ...(units === undefined ? {} : { units }),
  };
}

function parseSides(input: unknown) {
  const value = record(input);
  return optionalFields({
    top: optional(nonnegativeFinite)(value['top']),
    right: optional(nonnegativeFinite)(value['right']),
    bottom: optional(nonnegativeFinite)(value['bottom']),
    left: optional(nonnegativeFinite)(value['left']),
  });
}

function parseGap(input: unknown): Box & { readonly axis: 'row' | 'column' } {
  const value = record(input);
  const axis = value['axis'];
  if (axis !== 'row' && axis !== 'column') {
    throw new Error('Preview gap: unknown axis');
  }
  return { ...parseBox(value), axis };
}

function finite(input: unknown): number {
  if (typeof input !== 'number' || !Number.isFinite(input)) {
    throw new Error('Preview measurement: expected finite number');
  }
  return input;
}

function nonnegativeFinite(input: unknown): number {
  const value = finite(input);
  if (value < 0) {
    throw new Error('Preview spacing: expected nonnegative number');
  }
  return value;
}

function optionalFields<Value extends Readonly<Record<string, unknown>>>(value: Value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}
