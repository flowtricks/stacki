// `transform` is a SPACE-separated list of functions (translate/scale/rotate/skew).
// We model each as one editable layer with up to three axes and parse/serialize back,
// splitting on TOP-LEVEL spaces/commas only so calc()/var() with inner separators
// survive. Mirrors lib/text-shadow.ts (the layered text-shadow model).

import { splitTopLevelCommas, splitTopLevelSpaces } from './background'

export type TransformType = 'move' | 'scale' | 'rotate' | 'skew'
/** One transform layer: a type + its per-axis values (skew ignores z). */
export type Transform = { type: TransformType; x: string; y: string; z: string }

/** The identity (no-op) value for a type's axis — also the blank default. */
// A move is a length, and this project's lengths are rem: type sizes, spacing
// and the rest of the scale are all set in it, so a translate written in px is
// the one value on the element that stops moving when the root size changes.
// px is still one keystroke away — type it and the field keeps it (see
// parseAxis, which reads the unit off the value before falling back to this).
export const IDENTITY: Record<TransformType, string> = { move: '0rem', scale: '1', rotate: '0deg', skew: '0deg' }
const LABEL: Record<TransformType, string> = { move: 'Move', scale: 'Scale', rotate: 'Rotate', skew: 'Skew' }

/** Whether a type exposes a Z axis (skew is 2D only). */
export const hasZ = (type: TransformType): boolean => type !== 'skew'

// Strip a bogus `none` unit off a numeric axis (`1none` → `1`). No transform axis
// takes a `none` unit — it's leftover from a unit re-attach and would invalidate the
// whole function — so drop it wherever an argument is read.
const cleanAxis = (v: string): string => v.replace(/^(-?\d*\.?\d+)\s*none$/i, '$1')

const fnName = (fn: string): string => fn.slice(0, fn.indexOf('(')).trim().toLowerCase()
const fnArgs = (fn: string): string[] => {
  const open = fn.indexOf('(')
  const close = fn.lastIndexOf(')')
  if (open < 0 || close <= open) return []
  return splitTopLevelCommas(fn.slice(open + 1, close)).map((s) => cleanAxis(s.trim())).filter(Boolean)
}

/** Parse a `transform` value into ordered layers (`none`/'' → empty). */
export function parseTransforms(value: string): Transform[] {
  const v = value.trim()
  if (!v || v.toLowerCase() === 'none') return []
  const fns = splitTopLevelSpaces(v).filter((f) => f.includes('('))
  const out: Transform[] = []
  let i = 0
  while (i < fns.length) {
    const name = fnName(fns[i])
    const args = fnArgs(fns[i])
    if (name.startsWith('translate')) {
      const t: Transform = { type: 'move', x: '0px', y: '0px', z: '0px' }
      if (name === 'translatex') t.x = args[0] ?? '0px'
      else if (name === 'translatey') t.y = args[0] ?? '0px'
      else if (name === 'translatez') t.z = args[0] ?? '0px'
      else if (name === 'translate3d') { t.x = args[0] ?? '0px'; t.y = args[1] ?? '0px'; t.z = args[2] ?? '0px' }
      else { t.x = args[0] ?? '0px'; t.y = args[1] ?? '0px' }
      out.push(t); i += 1
    } else if (name.startsWith('scale')) {
      const t: Transform = { type: 'scale', x: '1', y: '1', z: '1' }
      if (name === 'scalex') t.x = args[0] ?? '1'
      else if (name === 'scaley') t.y = args[0] ?? '1'
      else if (name === 'scalez') t.z = args[0] ?? '1'
      else if (name === 'scale3d') { t.x = args[0] ?? '1'; t.y = args[1] ?? '1'; t.z = args[2] ?? '1' }
      else { t.x = args[0] ?? '1'; t.y = args[1] ?? args[0] ?? '1' }
      out.push(t); i += 1
    } else if (name.startsWith('rotate')) {
      // Fold a consecutive run of rotateX/Y/Z (how we serialize) into one layer.
      const t: Transform = { type: 'rotate', x: '0deg', y: '0deg', z: '0deg' }
      while (i < fns.length && fnName(fns[i]).startsWith('rotate')) {
        const rn = fnName(fns[i]); const ra = fnArgs(fns[i])
        if (rn === 'rotatex') t.x = ra[0] ?? '0deg'
        else if (rn === 'rotatey') t.y = ra[0] ?? '0deg'
        else if (rn === 'rotatez' || rn === 'rotate') t.z = ra[0] ?? '0deg'
        else break
        i += 1
      }
      out.push(t)
    } else if (name.startsWith('skew')) {
      const t: Transform = { type: 'skew', x: '0deg', y: '0deg', z: '0deg' }
      if (name === 'skewx') t.x = args[0] ?? '0deg'
      else if (name === 'skewy') t.y = args[0] ?? '0deg'
      else { t.x = args[0] ?? '0deg'; t.y = args[1] ?? '0deg' }
      out.push(t); i += 1
    } else {
      i += 1 // unknown function — drop it
    }
  }
  return out
}

const axis = (value: string, type: TransformType): string => (value.trim() || IDENTITY[type])

/** Serialize one layer to its CSS function(s). */
function serializeOne(t: Transform): string {
  const x = axis(t.x, t.type); const y = axis(t.y, t.type); const z = axis(t.z, t.type)
  switch (t.type) {
    case 'move': return `translate3d(${x}, ${y}, ${z})`
    case 'scale': return `scale3d(${x}, ${y}, ${z})`
    case 'rotate': return `rotateX(${x}) rotateY(${y}) rotateZ(${z})`
    case 'skew': return `skew(${x}, ${y})`
  }
}

/** Serialize layers back to a `transform` value ('' when empty). */
export function serializeTransforms(list: Transform[]): string {
  return list.map(serializeOne).filter(Boolean).join(' ')
}

/** A new layer of `type`, all axes at identity. */
export function blankTransform(type: TransformType = 'move'): Transform {
  const id = IDENTITY[type]
  return { type, x: id, y: id, z: id }
}

/** Re-type a layer, resetting its axes to the new type's identity. */
export function retypeTransform(type: TransformType): Transform {
  return blankTransform(type)
}

/** A short label for a collapsed row ("Move: 0px, 0px, 0px"). */
export function transformLabel(t: Transform): string {
  const axes = hasZ(t.type) ? [t.x, t.y, t.z] : [t.x, t.y]
  return `${LABEL[t.type]}: ${axes.map((a) => a.trim() || IDENTITY[t.type]).join(', ')}`
}
