// What a click on the canvas means.
//
// The canvas answers a click with the path of the deepest node it can map under
// the pointer, IN THE SCOPE OF THE OPEN FILE — or nothing when it can't map one
// at all. Nothing is the interesting case, because it has two very different causes:
//
//   the click landed somewhere this file doesn't own — the page around an open
//   component, the layout's own header — which is somebody looking away from
//   what they were editing;
//
//   the click landed on something inside it that carries no marker. Content
//   passed into a slot belongs to the caller, an expression the marker
//   serializer can't wrap emits nothing, a text node has no element of its own.
//   That is the canvas saying "I don't know", not the user saying anything.
//
// Backing out of a component on either one is why clicking inside a component
// kept closing it. Leaving is a real action with real cost — the panel switches
// files and the selection is lost — so it takes a click the canvas could map
// somewhere else. An unmappable one changes nothing.

export type CanvasEventRequest =
  | {
      readonly kind: 'click';
      readonly path: string | undefined;
      readonly outside: boolean;
    }
  | { readonly kind: 'open' };

export interface CanvasEventContext {
  readonly focusPath: string | undefined;
  readonly scope: string;
}

/** Whether an event will select or open source in the file currently being
 * edited. Leaving a component only changes navigation, so requiring that
 * component to be stamped in the page render would reject the very click that
 * is meant to close it. */
export function canvasEventSelectsSource(request: CanvasEventRequest, context: CanvasEventContext): boolean {
  switch (request.kind) {
    case 'open':
      return true;
    case 'click':
      return (
        canvasClickAction({
          path: request.path,
          outside: request.outside,
          focusPath: context.focusPath,
          scope: context.scope,
        }).kind !== 'close'
      );
    default: {
      const exhaustive: never = request;
      return exhaustive;
    }
  }
}

/**
 * @param {object} click
 * @param {string|undefined} click.path   what the canvas mapped, or undefined
 * @param {boolean} click.outside         it mapped something, but not in this
 *                                        file/instance — the canvas narrows to
 *                                        the instance being edited, so a click
 *                                        on the page around it arrives with no
 *                                        path and this flag
 * @param {string|undefined} click.focusPath the instance being edited, or undefined
 * @param {string} click.scope            the open file's path prefix ('' for a page)
 * @returns {{ kind: 'inner'|'select'|'layout'|'close'|'nothing' }}
 *   inner   — a node in the component being edited: select it
 *   select  — a node in the open page: select it
 *   layout  — chrome the layout renders itself: select the layout node
 *   close   — leave the component
 *   nothing — the canvas couldn't say; leave everything as it is
 */
export function canvasClickAction({
  path,
  outside = false,
  focusPath,
  scope = '',
}: {
  readonly path?: string | undefined;
  readonly outside?: boolean;
  readonly focusPath?: string | undefined;
  readonly scope?: string;
}): { readonly kind: 'inner' | 'select' | 'layout' | 'close' | 'nothing' } {
  if (focusPath) {
    // The open file's own markup is marked in its namespace, so a path in that
    // namespace is a node in the file being edited.
    if (scope && path && path.startsWith(scope)) {
      return { kind: 'inner' };
    }
    // Nothing to go on. `outside` is the canvas saying it DID find something,
    // just not in this file or this instance — that is somebody looking away.
    // Without it, the click was inside on something the canvas couldn't name,
    // and staying put is the only honest answer.
    if (!path) {
      return { kind: outside ? 'close' : 'nothing' };
    }
    // The lit instance itself, or something under it: stay.
    if (path === focusPath || path.startsWith(`${focusPath}.`)) {
      return { kind: 'nothing' };
    }
    // A node the canvas DID map, somewhere else on the page: done in here.
    return { kind: 'close' };
  }
  // Not in a component. Chrome the layout renders itself — header, footer,
  // anything outside the page's <slot> — carries no page-model marker, so a
  // click there arrives with no path. The layout owns that markup.
  if (!path) {
    return { kind: 'layout' };
  }
  return { kind: 'select' };
}
