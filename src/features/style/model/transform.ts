// `transform` is a SPACE-separated list of functions (translate/scale/rotate/skew).
// We model each as one editable layer with up to three axes and parse/serialize back,
// splitting on TOP-LEVEL spaces/commas only so calc()/var() with inner separators
// survive. Mirrors lib/text-shadow.ts (the layered text-shadow model).

import { splitTopLevelCommas, splitTopLevelSpaces } from './background';
import { assert } from '../../../../shared/core/assert';

export type TransformType = 'move' | 'scale' | 'rotate' | 'skew';
/** One transform layer: a type + its per-axis values (skew ignores z). */
export type Transform = { type: TransformType; x: string; y: string; z: string };
// One control's edit. Each member names the fields that control owns — an
// explicit update surface rather than `Partial<T>` (AGENTS.md §4); a retype
// replaces the whole layer.
export type TransformPatch = Transform | Pick<Transform, 'x'> | Pick<Transform, 'y'> | Pick<Transform, 'z'> | Pick<Transform, 'x' | 'y'>;

/** The identity (no-op) value for a type's axis — also the blank default. */
// A move is a length, and this project's lengths are rem: type sizes, spacing
// and the rest of the scale are all set in it, so a translate written in px is
// the one value on the element that stops moving when the root size changes.
// px is still one keystroke away — type it and the field keeps it (see
// parseAxis, which reads the unit off the value before falling back to this).
export const IDENTITY: Record<TransformType, string> = {
  move: '0rem',
  scale: '1',
  rotate: '0deg',
  skew: '0deg',
};
const LABEL: Record<TransformType, string> = {
  move: 'Move',
  scale: 'Scale',
  rotate: 'Rotate',
  skew: 'Skew',
};

/** Whether a type exposes a Z axis (skew is 2D only). */
export const hasZ = (type: TransformType): boolean => type !== 'skew';

// Strip a bogus `none` unit off a numeric axis (`1none` → `1`). No transform axis
// takes a `none` unit — it's leftover from a unit re-attach and would invalidate the
// whole function — so drop it wherever an argument is read.
const cleanAxis = (text: string): string => text.replace(/^(-?\d*\.?\d+)\s*none$/i, '$1');

const functionName = (call: string): string => call.slice(0, call.indexOf('(')).trim().toLowerCase();
const functionArguments = (call: string): string[] => {
  const open = call.indexOf('(');
  const close = call.lastIndexOf(')');
  if (open < 0 || close <= open) {
    return [];
  }
  return splitTopLevelCommas(call.slice(open + 1, close))
    .map((argument) => cleanAxis(argument.trim()))
    .filter(Boolean);
};

/** Parse a `transform` value into ordered layers (`none`/'' → empty). */
export function parseTransforms(value: string): Transform[] {
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === 'none') {
    return [];
  }
  const calls = splitTopLevelSpaces(trimmed).filter((token) => token.includes('('));
  const out: Transform[] = [];
  let i = 0;
  // Every branch advances `i` by at least one, so the loop runs at most calls.length times.
  while (i < calls.length) {
    const call = calls[i];
    assert(call !== undefined, 'parseTransforms: index within calls');
    const name = functionName(call);
    const args = functionArguments(call);
    if (name.startsWith('translate')) {
      out.push(translateLayer(name, args));
      i += 1;
    } else if (name.startsWith('scale')) {
      out.push(scaleLayer(name, args));
      i += 1;
    } else if (name.startsWith('rotate')) {
      const run = rotateRun(calls, i);
      out.push(run.transform);
      // A rotate function the run can't fold (`rotate3d`) is dropped like an unknown one.
      i = Math.max(run.next, i + 1);
    } else if (name.startsWith('skew')) {
      out.push(skewLayer(name, args));
      i += 1;
    } else {
      i += 1; // unknown function — drop it
    }
  }
  assert(out.length <= calls.length, 'parseTransforms: at most one layer per function');
  return out;
}

function translateLayer(name: string, args: readonly string[]): Transform {
  const transform: Transform = { type: 'move', x: '0px', y: '0px', z: '0px' };
  if (name === 'translatex') {
    transform.x = args[0] ?? '0px';
  } else if (name === 'translatey') {
    transform.y = args[0] ?? '0px';
  } else if (name === 'translatez') {
    transform.z = args[0] ?? '0px';
  } else if (name === 'translate3d') {
    transform.x = args[0] ?? '0px';
    transform.y = args[1] ?? '0px';
    transform.z = args[2] ?? '0px';
  } else {
    transform.x = args[0] ?? '0px';
    transform.y = args[1] ?? '0px';
  }
  return transform;
}

function scaleLayer(name: string, args: readonly string[]): Transform {
  const transform: Transform = { type: 'scale', x: '1', y: '1', z: '1' };
  if (name === 'scalex') {
    transform.x = args[0] ?? '1';
  } else if (name === 'scaley') {
    transform.y = args[0] ?? '1';
  } else if (name === 'scalez') {
    transform.z = args[0] ?? '1';
  } else if (name === 'scale3d') {
    transform.x = args[0] ?? '1';
    transform.y = args[1] ?? '1';
    transform.z = args[2] ?? '1';
  } else {
    transform.x = args[0] ?? '1';
    transform.y = args[1] ?? args[0] ?? '1';
  }
  return transform;
}

// Fold a consecutive run of rotateX/Y/Z (how we serialize) into one layer, starting at
// `start`; `next` is the index of the first function the run did not consume.
function rotateRun(calls: readonly string[], start: number): { readonly transform: Transform; readonly next: number } {
  const transform: Transform = { type: 'rotate', x: '0deg', y: '0deg', z: '0deg' };
  let i = start;
  while (i < calls.length && functionName(calls[i] ?? '').startsWith('rotate')) {
    const rotateCall = calls[i] ?? '';
    const rotateName = functionName(rotateCall);
    const rotateArguments = functionArguments(rotateCall);
    if (rotateName === 'rotatex') {
      transform.x = rotateArguments[0] ?? '0deg';
    } else if (rotateName === 'rotatey') {
      transform.y = rotateArguments[0] ?? '0deg';
    } else if (rotateName === 'rotatez' || rotateName === 'rotate') {
      transform.z = rotateArguments[0] ?? '0deg';
    } else {
      break;
    }
    i += 1;
  }
  return { transform, next: i };
}

function skewLayer(name: string, args: readonly string[]): Transform {
  const transform: Transform = { type: 'skew', x: '0deg', y: '0deg', z: '0deg' };
  if (name === 'skewx') {
    transform.x = args[0] ?? '0deg';
  } else if (name === 'skewy') {
    transform.y = args[0] ?? '0deg';
  } else {
    transform.x = args[0] ?? '0deg';
    transform.y = args[1] ?? '0deg';
  }
  return transform;
}

const axis = (value: string, type: TransformType): string => value.trim() || IDENTITY[type];

/** Serialize one layer to its CSS function(s). */
function serializeOne(transform: Transform): string {
  const x = axis(transform.x, transform.type);
  const y = axis(transform.y, transform.type);
  const z = axis(transform.z, transform.type);
  switch (transform.type) {
    case 'move':
      return `translate3d(${x}, ${y}, ${z})`;
    case 'scale':
      return `scale3d(${x}, ${y}, ${z})`;
    case 'rotate':
      return `rotateX(${x}) rotateY(${y}) rotateZ(${z})`;
    case 'skew':
      return `skew(${x}, ${y})`;
  }
}

/** Serialize layers back to a `transform` value ('' when empty). */
export function serializeTransforms(list: Transform[]): string {
  return list.map(serializeOne).filter(Boolean).join(' ');
}

/** A new layer of `type`, all axes at identity. */
export function blankTransform(type: TransformType = 'move'): Transform {
  const id = IDENTITY[type];
  return { type, x: id, y: id, z: id };
}

/** Re-type a layer, resetting its axes to the new type's identity. */
export function retypeTransform(type: TransformType): Transform {
  return blankTransform(type);
}

/** A short label for a collapsed row ("Move: 0px, 0px, 0px"). */
export function transformLabel(transform: Transform): string {
  const axes = hasZ(transform.type) ? [transform.x, transform.y, transform.z] : [transform.x, transform.y];
  const shown = axes.map((axis) => axis.trim() || IDENTITY[transform.type]);
  return `${LABEL[transform.type]}: ${shown.join(', ')}`;
}
