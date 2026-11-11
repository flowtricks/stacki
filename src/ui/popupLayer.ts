// Where popups and menus portal to: the document's body, or the element marked
// `data-popup-layer` when a page has one. The editor has none. The app UI kit
// (src/features/apps/uiKit/kitElements.tsx) adds one inside its styled scope, so
// the editor's own popups, rendered in an app, are styled there as in the editor.
import { assert } from '../../shared/core/assert';

export const POPUP_LAYER_ATTRIBUTE = 'data-popup-layer';

export function popupLayer(): HTMLElement {
  const layer = document.querySelector<HTMLElement>(`[${POPUP_LAYER_ATTRIBUTE}]`) ?? document.body;
  assert(layer.isConnected, 'The popup layer is in the document');
  return layer;
}
