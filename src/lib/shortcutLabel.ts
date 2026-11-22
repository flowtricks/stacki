type ShortcutModifier = 'primary' | 'primary-shift';

export function currentDesktopPlatform(): NodeJS.Platform {
  if (typeof window === 'undefined') {
    return 'linux';
  }
  return window.avb?.platform ?? (/Mac|iPhone|iPad/.test(navigator.platform) ? 'darwin' : /Win/.test(navigator.platform) ? 'win32' : 'linux');
}

export function shortcutLabel(key: string, modifier: ShortcutModifier, platform: NodeJS.Platform): string {
  if (platform === 'darwin') {
    return modifier === 'primary-shift' ? `⌘⇧${key}` : `⌘${key}`;
  }
  return modifier === 'primary-shift' ? `Ctrl+Shift+${key}` : `Ctrl+${key}`;
}

// The modifier glyphs a Mac label is written with, as the names `aria-keyshortcuts` expects.
const GLYPH_MODIFIERS: Readonly<Record<string, string>> = { '⌘': 'Meta', '⌥': 'Alt', '⌃': 'Control', '⇧': 'Shift' };
const GLYPH_KEYS: Readonly<Record<string, string>> = { '⌫': 'Backspace' };
const WORD_KEYS: Readonly<Record<string, string>> = { Ctrl: 'Control', Del: 'Delete' };

/**
 * A shortcut as shown ("⌥E", "⌘⇧D", "Ctrl+C", "⌫") in the form `aria-keyshortcuts` takes ("Alt+E", "Meta+Shift+D", "Control+C",
 * "Backspace"). Why: a screen reader cannot be told to announce a glyph, and the tooltip that shows the glyph is hidden from it,
 * so the element itself must carry the chord in the standard names.
 */
export function ariaKeyShortcuts(display: string): string {
  const parts: string[] = [];
  let rest = display;
  // A chord has a handful of modifiers; the bound keeps a malformed label from looping.
  for (let guard = 0; guard < 8; guard += 1) {
    const modifier = GLYPH_MODIFIERS[rest.charAt(0)];
    if (modifier === undefined) {
      break;
    }
    parts.push(modifier);
    rest = rest.slice(1);
  }
  const tail = rest
    .split('+')
    .map((word) => WORD_KEYS[word] ?? GLYPH_KEYS[word] ?? word)
    .filter((word) => word.length > 0);
  return [...parts, ...tail].join('+');
}
