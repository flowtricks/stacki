// What a colour control shows while it is being dragged.
//
// Dragging in the colour picker writes straight to the canvas (liveSetProp) so
// the page repaints under the pointer. It deliberately does NOT go through the
// panel's own model — that is rebuilt from the stylesheets, and rebuilding it
// per pointer move would be absurd. The field beside the swatch reads that
// model, though, so it went on showing the colour the drag started from until
// the mouse came up: the swatch and the page moved together and the number sat
// still.
//
// So the control remembers the value it last emitted and shows that, until the
// model comes back with a value of its own.

import { useEffect, useState } from 'react'

/**
 * `[shown, note]` — the value to display, and where to report a live one.
 *
 * Call `note(colour)` on a live drag and `note(null)` when it commits (or is
 * abandoned): the display drops back to `external`, which by then is the same
 * colour, arriving from the model.
 */
export function useLiveColor(external: string): [string, (value: string | null) => void] {
  const [live, setLive] = useState<string | null>(null)
  // The model has answered — whatever it says now is more authoritative than a
  // value this control emitted a moment ago.
  useEffect(() => { setLive(null) }, [external])
  return [live ?? external, setLive]
}
