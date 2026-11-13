// Native styles, as this host answers them: never available. The style panel
// was written against a designer that had them; every native read and write
// answers that there is nothing to read or write (webflow.ts).

import type { StateKey } from './resolved';
import type { TypedMessageRef } from '../../../../shared/properties/i18n/messageRef';
import { failureOf } from './failureMessage';
import type { NativeModel } from './styleTypes';
import type { NativeStyleOptions } from './nativeStyles';
import { type AnyElement } from './webflowElement';

// ───────────────────────── Native styles: not applicable ─────────────────────
//
// Webflow's class styles are a second styling system alongside CSS. Here there
// is only CSS, so the panel is told there are none — every value it shows and
// writes comes from a stylesheet or a <style> block.

// Whether a second, non-CSS styling system exists to write into. In the
// Designer that is Webflow's class styles; here there is none, so every
// property must be authored as CSS. The panel consults this before routing an
// edit away from the stylesheet.
export function nativeStylingAvailable(): boolean {
  return false;
}

export const EMPTY_NATIVE: NativeModel = { styles: [], read: false };

export type NativeWriteTarget = { namePath: string[]; index: number | undefined };

export async function readNativeStyles(_element: AnyElement, _states: readonly StateKey[], onPhase?: (model: NativeModel) => void): Promise<NativeModel> {
  onPhase?.(EMPTY_NATIVE);
  return EMPTY_NATIVE;
}

export async function readNativeStyleByName(_className: string, _states: readonly StateKey[]): Promise<NativeModel> {
  return EMPTY_NATIVE;
}

export const NO_NATIVE: {
  readonly ok: false;
  readonly applied: false;
  readonly error: string;
  readonly errorRef: TypedMessageRef;
} = {
  ...failureOf('styleModel.native.cssProject'),
  applied: false,
};

export async function applyNativePropertyAt(
  _element: AnyElement,
  _target: NativeWriteTarget,
  _prop: string,
  _value: string,
  _options?: NativeStyleOptions,
): Promise<typeof NO_NATIVE> {
  return NO_NATIVE;
}

export async function removeNativePropertyAt(
  _element: AnyElement,
  _target: NativeWriteTarget,
  _props: readonly string[],
  _options?: NativeStyleOptions,
): Promise<typeof NO_NATIVE> {
  return NO_NATIVE;
}

export async function applyNativeToNewBaseClass(
  _element: AnyElement,
  _className: string,
  _prop: string,
  _value: string,
  _options?: NativeStyleOptions,
): Promise<typeof NO_NATIVE> {
  return NO_NATIVE;
}

export async function liveSetNativeProperty(_handle: unknown, _prop: string, _value: string, _options?: NativeStyleOptions): Promise<typeof NO_NATIVE> {
  return NO_NATIVE;
}
