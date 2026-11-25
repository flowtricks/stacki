// Which sign-in method a project's hosted Studio uses, read from `studio/cloudflare/wrangler.jsonc` (`AUTH_PROVIDER`).
// Why: the Members view offers the add form that fits the method (a GitHub username, an email, or none for passkeys, whose
// invites are created in Studio). A project without Studio, an unreadable file or an unknown value reads as GitHub, the
// method every project starts with, so Desktop never hides the form it has always shown.
import { useEffect, useState } from 'react';
import { parseProviderId } from '../../../shared/properties/memberIdentity';
import { readText } from '../../ipc/bridge';

export const WRANGLER_FILE = 'studio/cloudflare/wrangler.jsonc';
/** The wrangler file is read only up to this many characters: it is a small config. */
const WRANGLER_CHARS_MAX = 200_000;

/** The `AUTH_PROVIDER` in wrangler.jsonc text, or `github` when absent or not a provider id. */
export function authProviderOf(source: string): string {
  if (source.length > WRANGLER_CHARS_MAX) {
    return 'github';
  }
  const match = /"AUTH_PROVIDER"\s*:\s*"([^"]*)"/.exec(source);
  const parsed = match?.[1] === undefined ? undefined : parseProviderId(match[1]);
  return parsed?.ok === true ? parsed.value : 'github';
}

export type AuthProviderState = { readonly kind: 'loading' } | { readonly kind: 'ready'; readonly provider: string };

/** The project's provider, read once per project; `loading` until the file answers. */
export function useAuthProvider(projectPath: string | undefined): AuthProviderState {
  const [state, setState] = useState<{ readonly projectPath: string | undefined; readonly provider: string } | undefined>(undefined);
  useEffect(() => {
    if (projectPath === undefined) {
      return undefined;
    }
    let lifetime: 'active' | 'disposed' = 'active';
    const settle = (provider: string) => {
      if (lifetime === 'active') {
        setState({ projectPath, provider });
      }
    };
    readText(projectPath, WRANGLER_FILE).then(
      (text) => settle(authProviderOf(text)),
      () => settle('github'),
    );
    return () => {
      lifetime = 'disposed';
    };
  }, [projectPath]);
  if (projectPath === undefined) {
    return { kind: 'ready', provider: 'github' };
  }
  if (state === undefined || state.projectPath !== projectPath) {
    return { kind: 'loading' };
  }
  return { kind: 'ready', provider: state.provider };
}
