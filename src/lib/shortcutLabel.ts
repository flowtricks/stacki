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
