// Desktop setup reports disk state separately from deployment, which requires
// account authorization outside the local installer.
import { record, text } from '../core/boundary';
import { isStudioAuthKind, type StudioSignIn } from './studioAuth';

// Run from the website root so copied commands and automatic startup agree.
export const STUDIO_LAUNCH_COMMAND = 'npm run dev -- --config node_modules/.avb/astro.config.mjs';

export type StudioStatus =
  | { readonly kind: 'missing'; readonly desktopVersion: string }
  | { readonly kind: 'installed'; readonly desktopVersion: string; readonly version: string; readonly signIn: StudioSignIn }
  | { readonly kind: 'blocked'; readonly desktopVersion: string; readonly message: string };
/** The result of changing an installed Studio's sign-in type: the file now says `signIn`. */
export type StudioAuthResult = { readonly kind: 'saved'; readonly signIn: StudioSignIn } | { readonly kind: 'error'; readonly message: string };
export type StudioInstallResult =
  { readonly kind: 'installed'; readonly version: string } | { readonly kind: 'canceled' } | { readonly kind: 'error'; readonly message: string };

export function parseStudioSource(input: unknown): 'published' | 'file' {
  if (input === 'published' || input === 'file') {
    return input;
  }
  throw new Error('Expected a published or local Studio release');
}

export function parseStudioStatus(input: unknown): StudioStatus {
  const value = record(input);
  const desktopVersion = text(value['desktopVersion']);
  switch (value['kind']) {
    case 'missing':
      return { kind: 'missing', desktopVersion };
    case 'installed':
      return { kind: 'installed', desktopVersion, version: text(value['version']), signIn: parseSignIn(value['signIn']) };
    case 'blocked':
      return { kind: 'blocked', desktopVersion, message: text(value['message']) };
    default:
      throw new Error('Invalid Studio setup status');
  }
}

export function parseSignIn(input: unknown): StudioSignIn {
  if (input === 'custom' || isStudioAuthKind(input)) {
    return input;
  }
  throw new Error('Invalid Studio sign-in type');
}

export function parseStudioAuthResult(input: unknown): StudioAuthResult {
  const value = record(input);
  switch (value['kind']) {
    case 'saved':
      return { kind: 'saved', signIn: parseSignIn(value['signIn']) };
    case 'error':
      return { kind: 'error', message: text(value['message']) };
    default:
      throw new Error('Invalid Studio sign-in result');
  }
}

export function parseStudioInstallResult(input: unknown): StudioInstallResult {
  const value = record(input);
  switch (value['kind']) {
    case 'installed':
      return { kind: 'installed', version: text(value['version']) };
    case 'canceled':
      return { kind: 'canceled' };
    case 'error':
      return { kind: 'error', message: text(value['message']) };
    default:
      throw new Error('Invalid Studio installation result');
  }
}
