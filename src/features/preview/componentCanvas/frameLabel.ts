// What a frame is called, above it on the canvas and in the panel: the split values it shows (`variant: arrow ·
// direction: back`), or the component's name when nothing is split.
import { assert } from '../../../../shared/core/assert';
import type { CanvasFrame, FramePart } from '../../../../shared/properties/componentCanvas';
import type { Translator } from '../../../lib/i18n/localeContext';
import type { CanvasComponent } from './canvasModel';

export function frameLabel(frame: Pick<CanvasFrame, 'parts'>, component: Pick<CanvasComponent, 'name'>, translate: Translator): string {
  if (frame.parts.length === 0) {
    return prettyComponentName(component.name);
  }
  const label = frame.parts.map((part) => partLabel(part, translate)).join(' · ');
  assert(label.length > 0, 'A split frame has a label');
  return label;
}

// `ButtonWrapper` as `Button Wrapper`, the way the Components panel names it (palette/paletteModel.ts prettyComponentName).
export function prettyComponentName(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
}

export function partLabel(part: FramePart, translate: Translator): string {
  const value = part.value.kind === 'unset' ? translate('componentCanvas.frame.unset') : String(part.value.value);
  return translate('componentCanvas.frame.part', { prop: part.prop, value });
}
