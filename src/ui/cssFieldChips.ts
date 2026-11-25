// The CSS chips a field of CSS draws (the style attribute's editor, a conditional style's branch).
//
// The chips are the style feature's (features/style/codeChips): the same ones every code window
// draws, with the Style panel's own pickers behind them. The fields live in features/props, which may
// not import that feature, so each shell that draws the props panel installs them here as its module
// loads (desktop's AppPanes, Studio's Settings). With nothing installed a field is plain CSS text.
import type { Extension } from '@codemirror/state';
import type { ReactNode } from 'react';
import { assert } from '../../shared/core/assert';

/** What a CSS editor needs for its chips: the extension, and the pickers a press opens. */
export interface CssFieldChips {
  readonly extension: Extension;
  /** Render it anywhere beside the editor. */
  readonly overlay: ReactNode;
}

/** The chips of an editor whose text is CSS declarations. A hook. */
export type CssFieldChipsHook = (text: 'stylesheet') => CssFieldChips;

const NO_CHIPS: CssFieldChips = { extension: [], overlay: undefined };
let installed: CssFieldChipsHook = () => NO_CHIPS;
// A field that has drawn once has called the hook it must go on calling.
let drawn: CssFieldChipsHook | undefined;

/** Installs the chips. Called as a shell's module loads, before any field is drawn. */
export function installCssFieldChips(useChips: CssFieldChipsHook): void {
  assert(drawn === undefined || drawn === useChips, 'installCssFieldChips: install before the first CSS field is drawn');
  installed = useChips;
}

/** The chips of a field of CSS declarations. */
export function useCssFieldChips(): CssFieldChips {
  drawn = installed;
  return installed('stylesheet');
}
