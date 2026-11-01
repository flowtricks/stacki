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
export const CloseIcon = () => (
  <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" width="16" height="16">
    <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
  </svg>
);
export const PlusIcon = () => (
  <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" width="16" height="16">
    <path d="M8 3.5v9M3.5 8h9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
  </svg>
);
export const TrashIcon = () => (
  <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className="embed-editor_bg-glyph">
    <path
      d="M3 4h10M6.5 4V3h3v1M5 4l.5 8.5a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1L11 4"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);
export const DuplicateIcon = () => (
  <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className="embed-editor_bg-glyph">
    <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
    <path
      d="M10.5 5.5V4A1.5 1.5 0 0 0 9 2.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);
export const GripIcon = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true" className="embed-editor_bg-glyph">
    <circle cx="6" cy="4" r="1" />
    <circle cx="10" cy="4" r="1" />
    <circle cx="6" cy="8" r="1" />
    <circle cx="10" cy="8" r="1" />
    <circle cx="6" cy="12" r="1" />
    <circle cx="10" cy="12" r="1" />
  </svg>
);
export const WarnIcon = () => (
  <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" width="16" height="16">
    <path d="M8 2 1.5 13.5h13L8 2Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    <path d="M8 6.5v3.2M8 11.4v.1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
  </svg>
);
