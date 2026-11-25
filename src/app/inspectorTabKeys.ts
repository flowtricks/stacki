// The keys that switch the right panel between Style and Settings, in one place that the key handlers (Desktop
// appKeys.ts, Studio Editor.tsx) and the tabs' tooltips (shell/InspectorTabButton.tsx) all read, so the key a tip
// names is the key that works. Plain letters: they act only outside fields, and never with ⌘, Ctrl or ⌥ (⌥S and ⌥D
// are other chords).

export type InspectorTabId = 'style' | 'settings';

export const INSPECTOR_TAB_KEYS = { style: 'S', settings: 'D' } as const satisfies Readonly<Record<InspectorTabId, string>>;

/** The tab a key press asks for, or undefined. The caller has already ruled out a press in a field. */
export function inspectorTabOfKey(event: Pick<KeyboardEvent, 'key' | 'altKey' | 'metaKey' | 'ctrlKey'>): InspectorTabId | undefined {
  if (event.altKey || event.metaKey || event.ctrlKey) {
    return undefined;
  }
  const key = event.key.toUpperCase();
  if (key === INSPECTOR_TAB_KEYS.style) {
    return 'style';
  }
  return key === INSPECTOR_TAB_KEYS.settings ? 'settings' : undefined;
}
