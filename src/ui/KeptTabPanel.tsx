import type { ReactNode } from 'react';

// One inspector tab's panel, kept mounted while another tab is showing.
//
// Why: the Style panel resolves its rules, cascade and selector chips
// asynchronously (stylesheet inventory, page scan, canvas queries). Mounting it
// on every switch back from Settings painted it empty for a frame or more and
// then filled it in, which read as a flicker. A kept panel switches by display
// alone, so it reappears exactly as it was left. Desktop and Studio both wrap
// their Style and Settings panels in this, so the two shells switch tabs the
// same way.
//
// `display: contents` lets the panel's children lay out as direct children of
// the inspector column, as they did before the wrapper existed.
export function KeptTabPanel({ shown, children }: { readonly shown: boolean; readonly children: ReactNode }) {
  return <div style={{ display: shown ? 'contents' : 'none' }}>{children}</div>;
}
