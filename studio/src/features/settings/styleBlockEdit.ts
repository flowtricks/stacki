// The Studio half of the Style panel's first styles (src/features/style/model/firstStyleBlock.ts).
// Desktop makes the block and the class one gesture; here they are one source text, so a single
// edit of the shared document is a single undo step for both, and the block is laid out by the
// same shared function (fileLayoutOf, styleBlockInner) as Desktop's.

import {
  fileLayoutOf,
  styleBlockFileSupported,
  styleBlockInner,
  UNSUPPORTED_FILE_MESSAGE,
} from '../../../vendor/stacki/src/features/style/model/firstStyleBlock';
import type { StyleBlockRequest } from '../../../vendor/stacki/src/features/style/model/host';
import { addStyleClass } from './styleClassEdit';

/**
 * The source after the first styles: `request.className` on the element `id` (when given) and a
 * `<style is:global>` block holding `request.css` as the last thing in the file. Throws, with a
 * message for the person, when the file cannot hold a block or the class cannot be added; the
 * source is then unchanged because nothing was returned.
 */
export function addStyleBlockSource(source: string, file: string, id: string, request: Pick<StyleBlockRequest, 'className' | 'css'>): string {
  if (!styleBlockFileSupported(file)) {
    throw new Error(UNSUPPORTED_FILE_MESSAGE);
  }
  const layout = fileLayoutOf(source);
  const classed = request.className === undefined ? source : addStyleClass(source, id, request.className);
  const closed = classed.endsWith('\n') ? classed : `${classed}${layout.eol}`;
  return `${closed}<style is:global>${styleBlockInner(request.css, layout)}</style>${layout.eol}`;
}
