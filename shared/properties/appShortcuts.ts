// Keyboard shortcuts and Stacki Apps (docs/apps.md, "Shortcuts and commands").
//
// Three sets of keys, kept apart so they cannot collide:
// - The editor shortcuts an app frame forwards to Stacki (APP_FORWARDED_KEYS):
//   undo, redo, save, the insert palette and Escape, unless the app claims them.
// - Shortcuts an app claims for itself while it has focus (`shortcutClaims` in
//   the manifest, or `stacki.shortcuts.claim`): any key below, at most
//   APP_SHORTCUT_LIMITS.claimsMax per app.
// - The reserved range for app commands (APP_RESERVED_SHORTCUTS), which no Stacki
//   shortcut uses (test/shared/properties/appShortcuts.test.ts holds that): ⌘⌥⇧ on
//   macOS, Ctrl+Alt+Shift elsewhere, with a digit 1 to 9. These work wherever
//   focus is, while the app is installed and the role allows it.
//
// A shortcut is written and compared in one canonical text: modifiers in the
// order Mod, Alt, Shift, then the key (`Mod+Shift+1`, `Mod+K`, `Escape`). `Mod` is
// ⌘ on macOS and Ctrl elsewhere, as Electron's `CmdOrCtrl`.
import { assert } from '../core/assert';
import { record, text } from '../core/boundary';
import { toArray } from '../core/record';

export const APP_SHORTCUT_LIMITS = {
  /** Shortcuts one app may claim while it has focus. */
  claimsMax: 32,
  /** Commands one app may declare. */
  commandsMax: 16,
  commandIdCharsMax: 64,
  commandTitleCharsMax: 80,
  /** What a command opens inside its app (`panel`), as the app names it. */
  commandPanelCharsMax: 64,
  /** A shortcut's text, `Mod+Alt+Shift+Backspace` with room. */
  shortcutCharsMax: 32,
} as const satisfies Record<string, number>;

/** The editor shortcuts an app frame forwards to Stacki when it does not claim them. */
export const APP_SHORTCUTS = ['undo', 'redo', 'save', 'palette', 'escape'] as const;
export type AppShortcut = (typeof APP_SHORTCUTS)[number];

/** Each forwarded key, as canonical text, and what it asks Stacki for. The SDK is generated from this table. */
export const APP_FORWARDED_KEYS: Readonly<Record<string, AppShortcut>> = {
  'Mod+Z': 'undo',
  'Mod+Shift+Z': 'redo',
  'Mod+Y': 'redo',
  'Mod+S': 'save',
  'Mod+E': 'palette',
  Escape: 'escape',
};

/**
 * The app command range: ⌘⌥⇧ on macOS, Ctrl+Alt+Shift elsewhere, with a digit 1
 * to 9. No browser, Electron menu, macOS or Stacki shortcut uses it (⌘⇧3 to 6 are
 * macOS screenshots, ⌘⇧7 to 9 are the rich text lists, ⌥⌘0 to 6 its headings
 * without Shift). On a Windows layout where AltGr+Shift+digit types a character,
 * only a digit an app has bound is taken.
 */
export const APP_RESERVED_SHORTCUTS = [
  'Mod+Alt+Shift+1',
  'Mod+Alt+Shift+2',
  'Mod+Alt+Shift+3',
  'Mod+Alt+Shift+4',
  'Mod+Alt+Shift+5',
  'Mod+Alt+Shift+6',
  'Mod+Alt+Shift+7',
  'Mod+Alt+Shift+8',
  'Mod+Alt+Shift+9',
] as const;
export type AppReservedShortcut = (typeof APP_RESERVED_SHORTCUTS)[number];

/** Named keys a shortcut may use besides letters and digits. */
const NAMED_KEYS = ['Escape', 'Enter', 'Backspace', 'Delete', 'Tab', 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'] as const;
const MODIFIERS = ['Mod', 'Alt', 'Shift'] as const;

/** A key press, as a KeyboardEvent carries it. */
export interface AppKeyPress {
  readonly key: string;
  readonly code: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
}

/**
 * A press as canonical text, or undefined for a key no shortcut uses (a bare
 * modifier, punctuation). Letters and digits are read from the physical key
 * (`code`), so Shift+1 is `Shift+1` and not `!`, and ⌥ cannot turn K into ˚.
 */
export function shortcutOfPress(press: AppKeyPress): string | undefined {
  const key = keyOfPress(press);
  if (key === undefined) {
    return undefined;
  }
  const parts: string[] = [];
  if (press.metaKey || press.ctrlKey) {
    parts.push('Mod');
  }
  if (press.altKey) {
    parts.push('Alt');
  }
  if (press.shiftKey) {
    parts.push('Shift');
  }
  parts.push(key);
  return parts.join('+');
}

/** The editor shortcut a press asks Stacki for, or undefined. */
export function forwardedShortcutOf(press: AppKeyPress): AppShortcut | undefined {
  const shortcut = shortcutOfPress(press);
  return shortcut === undefined ? undefined : APP_FORWARDED_KEYS[shortcut];
}

export function isReservedShortcut(shortcut: string): shortcut is AppReservedShortcut {
  return APP_RESERVED_SHORTCUTS.some((reserved) => reserved === shortcut);
}

/** A shortcut as an app writes it, in any case and order (`shift+mod+k`), to canonical text. */
export function parseShortcut(input: unknown): string {
  const raw = text(input);
  if (raw.length === 0 || raw.length > APP_SHORTCUT_LIMITS.shortcutCharsMax) {
    throw new Error(`A shortcut is 1 to ${APP_SHORTCUT_LIMITS.shortcutCharsMax} characters, like "Mod+Shift+1"`);
  }
  const parts = raw.split('+').map((part) => part.trim());
  const key = parts.at(-1) ?? '';
  const modifiers = new Set<string>();
  for (const part of parts.slice(0, -1)) {
    const modifier = MODIFIERS.find((name) => name.toLowerCase() === part.toLowerCase());
    if (modifier === undefined) {
      throw new Error(`"${part.slice(0, 20)}" is not a modifier: use Mod, Alt or Shift`);
    }
    modifiers.add(modifier);
  }
  const named = NAMED_KEYS.find((name) => name.toLowerCase() === key.toLowerCase());
  const canonicalKey = named ?? (/^[A-Za-z0-9]$/.test(key) ? key.toUpperCase() : undefined);
  if (canonicalKey === undefined) {
    throw new Error(`"${key.slice(0, 20)}" is not a key: use a letter, a digit or ${NAMED_KEYS.join(', ')}`);
  }
  const shortcut = [...MODIFIERS.filter((name) => modifiers.has(name)), canonicalKey].join('+');
  assert(shortcut.length <= APP_SHORTCUT_LIMITS.shortcutCharsMax + 8, 'A canonical shortcut stays short');
  return shortcut;
}

/** A command's shortcut: inside the reserved range, or refused with the range named. */
export function parseCommandShortcut(input: unknown): AppReservedShortcut {
  const shortcut = parseShortcut(input);
  if (!isReservedShortcut(shortcut)) {
    throw new Error(`App command shortcuts are ${APP_RESERVED_SHORTCUTS.join(', ')} (Mod is ⌘ on macOS, Ctrl elsewhere); "${shortcut}" is Stacki's`);
  }
  return shortcut;
}

/** The shortcuts an app claims while it has focus: bounded, unique, canonical. */
export function parseShortcutClaims(input: unknown): readonly string[] {
  if (input === undefined) {
    return [];
  }
  const items = toArray(input);
  if (items === undefined) {
    throw new Error('shortcutClaims must be a list of shortcuts');
  }
  if (items.length > APP_SHORTCUT_LIMITS.claimsMax) {
    throw new Error(`An app claims at most ${APP_SHORTCUT_LIMITS.claimsMax} shortcuts`);
  }
  return [...new Set(items.map(parseShortcut))];
}

/** A global command an app declares (`commands` in the manifest, or `commands.register`). */
export interface AppCommand {
  readonly id: string;
  readonly title: string;
  /** A key in the reserved range that runs it from anywhere in the editor. */
  readonly shortcut: AppReservedShortcut | undefined;
  /** What the app opens when the command runs, as the app names it; the event carries it. */
  readonly panel: string | undefined;
}

export function parseAppCommand(input: unknown): AppCommand {
  const value = record(input);
  const id = text(value['id']);
  if (!new RegExp(`^[a-z0-9][a-z0-9._-]{0,${APP_SHORTCUT_LIMITS.commandIdCharsMax - 1}}$`).test(id)) {
    throw new Error('A command id is lowercase letters, digits, dots, dashes and underscores');
  }
  const title = text(value['title']).trim();
  if (title.length === 0 || title.length > APP_SHORTCUT_LIMITS.commandTitleCharsMax) {
    throw new Error(`A command title is 1 to ${APP_SHORTCUT_LIMITS.commandTitleCharsMax} characters`);
  }
  const panelInput = value['panel'];
  let panel: string | undefined;
  if (panelInput !== undefined) {
    panel = text(panelInput);
    if (!new RegExp(`^[A-Za-z0-9_.:/-]{1,${APP_SHORTCUT_LIMITS.commandPanelCharsMax}}$`).test(panel)) {
      throw new Error('A command panel is letters, digits and _.:/-');
    }
  }
  const shortcutInput = value['shortcut'];
  return { id, title, shortcut: shortcutInput === undefined ? undefined : parseCommandShortcut(shortcutInput), panel };
}

/** An app's commands: bounded, ids and shortcuts unique within the app. */
export function parseAppCommands(input: unknown): readonly AppCommand[] {
  if (input === undefined) {
    return [];
  }
  const items = toArray(input);
  if (items === undefined) {
    throw new Error('commands must be a list');
  }
  if (items.length > APP_SHORTCUT_LIMITS.commandsMax) {
    throw new Error(`An app declares at most ${APP_SHORTCUT_LIMITS.commandsMax} commands`);
  }
  const commands = items.map(parseAppCommand);
  if (new Set(commands.map((command) => command.id)).size !== commands.length) {
    throw new Error('Command ids are unique within an app');
  }
  const shortcuts = commands.flatMap((command) => (command.shortcut === undefined ? [] : [command.shortcut]));
  if (new Set(shortcuts).size !== shortcuts.length) {
    throw new Error('Two commands of one app share a shortcut');
  }
  return commands;
}

/** The text a menu or hint shows for a shortcut on this platform: `⌘⇧1` on macOS, `Ctrl+Shift+1` elsewhere. */
export function shortcutLabel(shortcut: string, platform: 'mac' | 'other'): string {
  const parts = shortcut.split('+');
  if (platform === 'mac') {
    const symbols: Readonly<Record<string, string>> = { Mod: '⌘', Alt: '⌥', Shift: '⇧' };
    return parts.map((part) => symbols[part] ?? part).join('');
  }
  return parts.map((part) => (part === 'Mod' ? 'Ctrl' : part)).join('+');
}

function keyOfPress(press: AppKeyPress): string | undefined {
  const letter = /^Key([A-Z])$/.exec(press.code);
  if (letter?.[1] !== undefined) {
    return letter[1];
  }
  const digit = /^(?:Digit|Numpad)([0-9])$/.exec(press.code);
  if (digit?.[1] !== undefined) {
    return digit[1];
  }
  if (press.key === ' ') {
    return 'Space'; // i18n-ignore: key name, shown like Cmd and Esc, which stay English.
  }
  const named = NAMED_KEYS.find((name) => name === press.key);
  if (named !== undefined) {
    return named;
  }
  // A press without a physical code (a synthetic event): its letter or digit, as typed.
  return /^[A-Za-z0-9]$/.test(press.key) ? press.key.toUpperCase() : undefined;
}
