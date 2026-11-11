import { centralIcon } from '../../ui/central/CentralIcon';
import {
  add as centralAdd,
  close as centralClose,
  copy as centralCopy,
  drag as centralDrag,
  trash as centralTrash,
  warning as centralWarning,
} from '../../ui/central/centralGeometry';
// What the grid settings' parts share: the writers and labels they are handed,
// reading a resolved value, and the small icons they draw (GridSettings.tsx).

import type { ResolvedProp } from './model/resolved';

export type SetProp = (prop: string, value: string, important: boolean) => void;
export type ClearProp = (prop: string | string[]) => void;
export type Read = (prop: string) => ResolvedProp | undefined;
export type OnProvenance = (prop: string, anchor: DOMRect) => void;
export type OnSelectSelector = (selector: string, prop?: string) => void;
// The resolved-model label bits every section header threads through to GroupLabel.
export type LabelProps = {
  read: Read;
  busy: boolean;
  clearProp: ClearProp;
  onProvenance: OnProvenance;
  onSelectSelector: OnSelectSelector;
};

export const resolvedValue = (read: Read, prop: string): string => {
  const resolved = read(prop);
  if (!resolved) {
    return '';
  }
  return (resolved.source === 'selected' && resolved.selectedValue ? resolved.selectedValue.value : resolved.winner.value).trim();
};

// Icons.
export const CloseIcon = centralIcon(centralClose);
export const PlusIcon = centralIcon(centralAdd);
export const TrashIcon = centralIcon(centralTrash);
export const DuplicateIcon = centralIcon(centralCopy);
export const GripIcon = centralIcon(centralDrag);
export const WarnIcon = centralIcon(centralWarning);
