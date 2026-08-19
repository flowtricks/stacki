import { useEffect, useState } from 'react';

// Whether a popup is on screen anywhere.
//
// Asked by roles rather than by class names: every menu, colour picker and
// modal in the style panel already says what it is — `role="menu"`,
// `role="dialog"`, `role="listbox"` — and a rule written against that is one a
// new popup obeys without being added to a list. Tooltips are `role="tooltip"`
// and deliberately not included: they appear on hover, and a panel that stopped
// scrolling because the pointer paused over a segment would be worse than the
// problem this solves.
const POPUPS = '[role="menu"],[role="dialog"],[role="listbox"]';

/**
 * `host` is the element whose own subtree also counts — the menus that render
 * inline in a control rather than portaling to <body>.
 *
 * Watched in two places for the same reason they render in two places, and each
 * as narrowly as it can be: <body> at its top level only, since a portal is a
 * direct child of it, and the host in full, since an inline menu appears deep
 * inside a control. Watching all of <body>'s subtree would mean a callback on
 * every render anywhere in the app.
 */
export default function usePopupOpen(host) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const look = () => setOpen(!!document.querySelector(POPUPS));
    look();
    const watch = new MutationObserver(look);
    watch.observe(document.body, { childList: true });
    if (host?.current) watch.observe(host.current, { childList: true, subtree: true });
    return () => watch.disconnect();
  }, [host]);
  return open;
}
