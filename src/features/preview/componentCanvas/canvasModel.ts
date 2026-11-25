// What the component canvas shows, worked out from the component's props and its stored canvas settings: the frames
// a split makes, and for each frame the props its instance is given. Pure, so the Desktop host, the panel and the
// tests read one answer. The settings file's own rules (keys, merging, bounds) are shared/properties/componentCanvas.ts.
import { assert } from '../../../../shared/core/assert';
import type { PropField } from '../../../../shared/properties/propSchema';
import type { DefaultValue } from '../../../../shared/properties/componentDefaults';
import {
  CANVAS_LIMITS,
  canvasFrames,
  effectiveSplit,
  resolveFrame,
  splitCandidates,
  splitValueText,
  unionAllows,
  type CanvasFrame,
  type ComponentCanvas,
  type FramePart,
  type ResolvedFrame,
  type SplitCandidate,
} from '../../../../shared/properties/componentCanvas';

export interface CanvasComponent {
  /** Project-relative, as `.stacki` keys components: `src/components/Button.astro`. */
  readonly file: string;
  readonly name: string;
  readonly schema: readonly PropField[];
}

export interface ModelFrame extends CanvasFrame {
  readonly resolved: ResolvedFrame;
  /** What the frame's instance is given, over the component's insertion defaults. */
  readonly props: Readonly<Record<string, DefaultValue>>;
  /** Props the instance is not given, even when the insertion defaults give them. */
  readonly omitted: ReadonlySet<string>;
}

export interface CanvasLayout {
  readonly split: readonly string[];
  readonly candidates: readonly SplitCandidate[];
  readonly frames: readonly ModelFrame[];
  /** Distinct frames the split makes; more than `frames.length` when the frame bound left some out. */
  readonly total: number;
}

/** How the panel edits a prop's preview value. Props only code can set (objects, lists, actions) are not offered. */
export type FieldControl =
  { readonly kind: 'choice'; readonly options: readonly string[] } | { readonly kind: 'switch' } | { readonly kind: 'number' } | { readonly kind: 'text' };

export function buildCanvasLayout(component: CanvasComponent, settings: ComponentCanvas | undefined): CanvasLayout {
  const candidates = splitCandidates(component.schema);
  const split = effectiveSplit(settings, component.schema);
  const chosen = split.map((name) => candidates.find((candidate) => candidate.name === name)).filter((candidate) => candidate !== undefined);
  assert(chosen.length === split.length, 'An effective split names only candidates');
  const unions = unionsOf(component.schema);
  const made = canvasFrames(chosen, (prop, parts) => unionAllows(unions, prop, heldBy(component.schema, parts, {})));
  const frames = made.frames.map((frame, index): ModelFrame => {
    const resolved = resolveFrame(settings, frame.key);
    const instance = instanceProps(component.schema, frame.parts, resolved, index);
    return { ...frame, resolved, props: instance.props, omitted: instance.omitted };
  });
  assert(frames.length <= CANVAS_LIMITS.framesMax, 'The layout draws a bounded number of frames');
  return { split, candidates, frames, total: made.total };
}

export function fieldControl(field: PropField): FieldControl | undefined {
  if (field.type === 'boolean') {
    return { kind: 'switch' };
  }
  if ((field.options?.length ?? 0) > 0) {
    return { kind: 'choice', options: field.options ?? [] };
  }
  if (field.type === 'number') {
    return { kind: 'number' };
  }
  if (field.type === 'string' || field.type === 'text' || field.type === 'url' || field.type === 'color') {
    return { kind: 'text' };
  }
  return undefined;
}

/** Whether the frame's variant takes the prop at all: a discriminated union may forbid it (`direction` on `main`). */
export function frameTakes(component: CanvasComponent, frame: ModelFrame, prop: string): boolean {
  return unionAllows(unionsOf(component.schema), prop, heldBy(component.schema, frame.parts, frame.props));
}

/** The value a frame's instance shows for a prop: its preview value, else the component defaults' value, else the prop's own default. */
export function shownValue(field: PropField, frame: ModelFrame, defaults: Readonly<Record<string, DefaultValue>>): DefaultValue | undefined {
  if (frame.omitted.has(field.name)) {
    return field.default;
  }
  return frame.props[field.name] ?? defaults[field.name] ?? field.default;
}

export function splitPartOf(frame: ModelFrame, prop: string): FramePart | undefined {
  return frame.parts.find((part) => part.prop === prop);
}

function unionsOf(schema: readonly PropField[]) {
  return schema.find((field) => field.unions !== undefined)?.unions ?? [];
}

// The value a controller holds in a frame, as the union pins name it: the split value, then a preview value, then the default.
function heldBy(schema: readonly PropField[], parts: readonly FramePart[], props: Readonly<Record<string, DefaultValue>>) {
  return (name: string): string | undefined => {
    const part = parts.find((candidate) => candidate.prop === name);
    if (part !== undefined) {
      const text = splitValueText(part.value);
      return text ?? stringOf(schema.find((field) => field.name === name)?.default);
    }
    const value = props[name] ?? schema.find((field) => field.name === name)?.default;
    return stringOf(value);
  };
}

function stringOf(value: DefaultValue | undefined): string | undefined {
  return value === undefined ? undefined : String(value);
}

// The instance's props: preview values, then the split values over them; not set where the frame says so; nothing
// the frame's variant forbids; and a usable value for a required prop nothing gives.
function instanceProps(
  schema: readonly PropField[],
  parts: readonly FramePart[],
  resolved: ResolvedFrame,
  index: number,
): { readonly props: Readonly<Record<string, DefaultValue>>; readonly omitted: ReadonlySet<string> } {
  const names = new Set(schema.map((field) => field.name));
  // A map while the frame's values are laid over one another, a plain record once settled: the record is what the
  // page writer reads, and building it by key would read as a model write to the adapter-surface gate.
  const given = new Map<string, DefaultValue>();
  const omitted = new Set<string>();
  for (const [name, value] of Object.entries(resolved.props)) {
    // A stored value for a prop the component no longer has is kept in the file and left out here.
    if (names.has(name)) {
      given.set(name, typed(schema, name, value));
    }
  }
  for (const name of resolved.unset) {
    omitted.add(name);
  }
  for (const part of parts) {
    if (part.value.kind === 'unset') {
      given.delete(part.prop);
      omitted.add(part.prop);
    } else {
      given.set(part.prop, typed(schema, part.prop, part.value.value));
      omitted.delete(part.prop);
    }
  }
  const unions = unionsOf(schema);
  for (const field of schema) {
    if (!unionAllows(unions, field.name, heldBy(schema, parts, Object.fromEntries(given)))) {
      given.delete(field.name);
      omitted.add(field.name);
    }
  }
  // An element id is what many components need before they render at all (a modal its triggers open by id), and one
  // per frame keeps the page's ids unique; it is only a preview value, like every other.
  const id = schema.find((field) => field.name === 'id' && fieldControl(field)?.kind === 'text');
  if (id !== undefined && !given.has('id') && !omitted.has('id')) {
    given.set('id', `stacki-canvas-${String(index + 1)}`);
  }
  for (const field of schema) {
    if (field.optional || given.has(field.name) || omitted.has(field.name) || field.default !== undefined) {
      continue;
    }
    const sample = sampleValue(field);
    if (sample !== undefined) {
      given.set(field.name, sample);
    }
  }
  const props: Readonly<Record<string, DefaultValue>> = Object.fromEntries(given);
  assert(Object.keys(props).length === given.size, 'Every settled value is in the record');
  assert(
    Object.keys(props).every((name) => names.has(name)),
    'An instance is given only props the component has',
  );
  return { props, omitted };
}

// Numeric options are written as numbers (`size={3}`), the way the component's type reads them.
function typed(schema: readonly PropField[], name: string, value: DefaultValue): DefaultValue {
  const field = schema.find((candidate) => candidate.name === name);
  if (field?.numeric === true && typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return value;
}

// What a required prop shows when nothing gives it a value: its first option, off, its minimum, or its own name as text.
function sampleValue(field: PropField): DefaultValue | undefined {
  const control = fieldControl(field);
  if (control === undefined) {
    return undefined;
  }
  switch (control.kind) {
    case 'choice':
      return control.options[0];
    case 'switch':
      return false;
    case 'number':
      return field.min ?? 0;
    case 'text':
      return humanize(field.name);
    default: {
      const exhaustive: never = control;
      return exhaustive;
    }
  }
}

function humanize(name: string): string {
  const words = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}
