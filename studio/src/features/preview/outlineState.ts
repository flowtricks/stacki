import { parsePreviewMessage } from '../../../vendor/stacki/src/features/preview/previewMessages';
import type { RectMap, SpacingMap } from '../../../vendor/stacki/src/features/preview/PreviewOverlays';
import { record, string } from '../../shared/validation';
interface Target {
  readonly id: string;
  readonly occurrence: number | undefined;
}
export interface OutlineState {
  readonly selected: Target | undefined;
  readonly hovered: Target | undefined;
  readonly rects: RectMap;
  readonly spacing: SpacingMap;
  readonly classes: Readonly<Record<string, readonly (readonly string[])[]>>;
}
export const emptyOutlines: OutlineState = {
  selected: undefined,
  hovered: undefined,
  rects: {},
  spacing: {},
  classes: {},
};
export function parseOutlines(input: unknown): OutlineState | undefined {
  try {
    const data = record(input);
    if (data['type'] !== 'studio:outlines') {
      return undefined;
    }
    const rects = record(data['rects']);
    // The selection's and hover's paths and box paths (4), an app highlight's (1), the focus (1) and 30 collaborators.
    if (Object.keys(rects).length > 36 || Object.values(rects).some((value) => !Array.isArray(value) || value.length > 500)) {
      return undefined;
    }
    const parsed = parsePreviewMessage({ ...data, type: 'avb:rects' });
    if (parsed?.kind !== 'rects') {
      return undefined;
    }
    return {
      selected: target(data['selected']),
      hovered: target(data['hovered']),
      rects: parsed.rects,
      spacing: parsed.spacing,
      classes: parsed.classes,
    };
  } catch {
    return undefined;
  }
}
function target(input: unknown): Target | undefined {
  if (input === undefined) {
    return undefined;
  }
  const data = record(input);
  const occurrence = data['occurrence'];
  if (occurrence !== undefined && (typeof occurrence !== 'number' || !Number.isSafeInteger(occurrence) || occurrence < 0 || occurrence > 10000)) {
    throw new Error('Invalid occurrence');
  }
  return { id: string(data['id'], 500), occurrence };
}
