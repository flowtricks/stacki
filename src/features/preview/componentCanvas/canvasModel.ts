// What the component canvas shows, worked out from the component's props and its stored canvas settings: the frames
// a split makes, and for each frame the props its instance is given. Pure, so the Desktop host, the panel and the
// tests read one answer. The settings file's own rules (keys, merging, bounds) are shared/properties/componentCanvas.ts.
import { assert } from '../../../../shared/core/assert';
import type { PropField } from '../../../../shared/properties/propSchema';
import type { Attr } from '../../../../shared/page/pageNodeTypes';
import type { DefaultValue } from '../../../../shared/properties/componentDefaults';
import type { AssetDefaults, LiteralDefaults } from '../../../../shared/properties/componentDefaultValues';
import {
  CANVAS_LIMITS,
  canvasFrames,
  effectiveSplit,
  resolveFrame,
  splitCandidates,
  splitValueText,
  unionAllows,
  type CanvasFrame,
  type CanvasValue,
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
  /** Whether the component passes other attributes on (`...rest`), `style` among them. */
  readonly rest?: boolean;
}

export interface ModelFrame extends CanvasFrame {
  readonly resolved: ResolvedFrame;
  /** What the frame's instance is given, over the component's insertion defaults. */
  readonly props: Readonly<Record<string, DefaultValue>>;
  /** Imported files and literal data the instance is given, over the insertion defaults. */
  readonly assets: AssetDefaults;
  readonly literals: LiteralDefaults;
  /** The default slot's markup; undefined: the insertion defaults' content. */
  readonly content: string | undefined;
  /** Props the instance is not given, even when the insertion defaults give them. */
  readonly omitted: ReadonlySet<string>;
}

/** Attributes every element takes, which a frame may hold even where the component declares no prop for them. */
export const FRAME_ATTRIBUTES = ['class', 'style'] as const;

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
    return { ...frame, resolved, ...instance, content: resolved.content };
  });
  assert(frames.length <= CANVAS_LIMITS.framesMax, 'The layout draws a bounded number of frames');
  return { split, candidates, frames, total: made.total };
}

export function fieldControl(field: Pick<PropField, 'type' | 'options'>): FieldControl | undefined {
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

interface InstanceValues {
  readonly props: Readonly<Record<string, DefaultValue>>;
  readonly assets: AssetDefaults;
  readonly literals: LiteralDefaults;
  readonly omitted: ReadonlySet<string>;
}

// The instance's props: preview values, then the split values over them; not set where the frame says so; nothing
// the frame's variant forbids; and a usable value for a required prop nothing gives.
function instanceProps(schema: readonly PropField[], parts: readonly FramePart[], resolved: ResolvedFrame, index: number): InstanceValues {
  const names = new Set([...schema.map((field) => field.name), ...FRAME_ATTRIBUTES]);
  // A map while the frame's values are laid over one another, a plain record once settled: the record is what the
  // page writer reads, and building it by key would read as a model write to the adapter-surface gate.
  const given = new Map<string, DefaultValue>();
  // A stored value for a prop the component no longer has is kept in the file and left out here.
  const known = <T>(held: Readonly<Record<string, T>>): Map<string, T> => new Map(Object.entries(held).filter(([name]) => names.has(name)));
  const assets = known(resolved.assets);
  const literals = known(resolved.literals);
  const omitted = new Set<string>(resolved.unset);
  for (const [name, value] of Object.entries(resolved.props)) {
    if (names.has(name)) {
      given.set(name, typed(schema, name, value));
    }
  }
  const drop = (name: string): void => {
    given.delete(name);
    assets.delete(name);
    literals.delete(name);
  };
  for (const part of parts) {
    drop(part.prop);
    if (part.value.kind === 'unset') {
      omitted.add(part.prop);
    } else {
      given.set(part.prop, typed(schema, part.prop, part.value.value));
      omitted.delete(part.prop);
    }
  }
  const unions = unionsOf(schema);
  for (const field of schema) {
    if (!unionAllows(unions, field.name, heldBy(schema, parts, Object.fromEntries(given)))) {
      drop(field.name);
      omitted.add(field.name);
    }
  }
  const held = (name: string): boolean => given.has(name) || assets.has(name) || literals.has(name) || omitted.has(name);
  // An element id is what many components need before they render at all (a modal its triggers open by id), and one
  // per frame keeps the page's ids unique; it is only a preview value, like every other.
  const id = schema.find((field) => field.name === 'id' && fieldControl(field)?.kind === 'text');
  if (id !== undefined && !held('id')) {
    given.set('id', `stacki-canvas-${String(index + 1)}`);
  }
  for (const field of schema) {
    if (field.optional || held(field.name) || field.default !== undefined) {
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
  return { props, assets: Object.fromEntries(assets), literals: Object.fromEntries(literals), omitted };
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
export function sampleValue(field: Pick<PropField, 'name' | 'type' | 'options' | 'min'>): DefaultValue | undefined {
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

// A prop value as the canvas settings hold it: text, a number or a switch. An expression that is none of those
// (data, a function, an object) is code the canvas cannot replay, so it is refused rather than stored as text.
export function previewValue(value: Attr): CanvasValue | undefined {
  switch (value.type) {
    case 'string':
      return value.value;
    case 'bare':
      return true;
    case 'spread':
      return undefined;
    case 'expr': {
      const code = value.value.trim();
      if (code === 'true' || code === 'false') {
        return code === 'true';
      }
      if (/^-?\d+(\.\d+)?$/.test(code)) {
        const number = Number(code);
        return Number.isFinite(number) ? number : undefined;
      }
      const quoted = /^(["'`])(.*)\1$/s.exec(code);
      return quoted === null || /[\\${}]/.test(quoted[2] ?? '') ? undefined : quoted[2];
    }
    default: {
      const exhaustive: never = value;
      return exhaustive;
    }
  }
}
