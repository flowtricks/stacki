import { createContext, useContext } from 'react';

// Which parts of the app answer with a sound.
//
// The two design panels do — the style panel and the settings panel. A note
// under the pointer is feedback for shaping something, and that is what those
// two are for. The title bar, the pages list and the terminal's own controls
// are not: a sound there would be the app talking about itself.
//
// A context rather than a class on a wrapper, because a dropdown's menu portals
// to <body>. The DOM then says it is nowhere near the panel; the React tree
// says exactly where it came from, which is the honest answer and the same one
// the panels' click handler relies on.
const SoundScope = createContext(false);

/** Everything rendered under here may sound, if the setting is on. */
export function SoundHere({ children }) {
  return <SoundScope.Provider value>{children}</SoundScope.Provider>;
}

/** Whether the control calling this is inside a panel that sounds. */
export const useSoundHere = () => useContext(SoundScope);
