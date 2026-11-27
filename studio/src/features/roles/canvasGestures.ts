// What a role does on Studio's canvas, in one place for the frame, the canvas and
// the keys. Free of React, so tests read the same answers.
import { assert } from '../../../vendor/stacki/shared/core/assert';
import type { RoleView } from '../../../vendor/stacki/shared/properties/projectRoles';

export interface CanvasGestures {
  /** Drag to reorder on the page. */
  readonly drag: boolean;
  /** Double-click a picture to change it or its alt text. */
  readonly images: boolean;
  /** Type into text on the page. */
  readonly text: boolean;
  /** Add, paste, duplicate and delete elements. */
  readonly elements: boolean;
  /** The bar over the page. */
  readonly bar: boolean;
}

export function canvasGestures(role: RoleView): CanvasGestures {
  const off = role.editorOff;
  assert(!role.isAdmin || off.size === 0, 'Admin has every editing option');
  // Changing a picture was never open to a role with neither right panel (Style or Settings), and the
  // canvas popup does not open it to one: the permissions decide, as the file stores them, so switching
  // the panel off in the editing options keeps the popup.
  const imagesBefore = role.isAdmin || role.features.has('panel:settings') || role.features.has('panel:style');
  return {
    drag: !off.has('drag'),
    images: imagesBefore && !off.has('images'),
    text: !off.has('text'),
    elements: !off.has('elements'),
    bar: !off.has('canvasBar'),
  };
}
