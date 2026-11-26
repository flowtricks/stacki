// Content being typed and not yet written to its file: what the Navigator shows in place of the node's own children
// while an editor is open (features/structure/navigatorLive.ts). Any editor of a node's content feeds it. The canvas's
// block editor does (useCanvasText.ts); a Content box may. Nothing is written to the file for it, so a cancelled edit
// only has to clear it and the Navigator reads the file's tree again.

import { createLiveValue } from './liveValue';
import { assert } from '../../shared/core/assert';
import { LIMITS } from '../../shared/core/limits';

export interface LiveContent {
  /** Who is typing: a canvas session id, or a name of the feeder's own. Only the owner clears what it set. */
  readonly owner: string;
  /** The node whose children are being typed: the component instance, or the element holding a line of words. */
  readonly nodeID: string;
  /** Those children as HTML, as the editor holds them now. */
  readonly html: string;
  /** The block holding the caret, as element positions from the node down (a block, then an item of a list); empty for
   *  the node itself; absent when the feeder has no caret to show. */
  readonly caret?: readonly number[] | undefined;
}

export const liveContent = createLiveValue<LiveContent | undefined>(undefined);

export function setLiveContent(next: LiveContent): void {
  assert(next.owner !== '', 'Live content names who typed it');
  assert(next.html.length <= LIMITS.ipcFieldCharsMax, 'Live content fits one field');
  const current = liveContent.get();
  if (current?.owner === next.owner && current.nodeID === next.nodeID) {
    if (current.html === next.html && current.caret?.join('.') === next.caret?.join('.')) {
      return;
    }
  }
  liveContent.set(next);
}

export function clearLiveContent(owner: string): void {
  if (liveContent.get()?.owner === owner) {
    liveContent.set(undefined);
  }
}
