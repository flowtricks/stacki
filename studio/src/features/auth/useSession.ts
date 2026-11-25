import { useEffect, useState } from 'react';
import { request } from '../project/projectClient';
import { record, string } from '../../shared/validation';
import { parseProfile, type GitHubProfile } from './profile';

// `account` is a person signed in by an installed authentication provider other than GitHub (docs/auth-providers.md).
export interface AccountProfile {
  readonly kind: 'account';
  readonly identity: string;
  readonly name: string;
  readonly email?: string;
  readonly avatarUrl?: string;
  /** Other identities core vouched for, matched against roles.json members like `identity`. */
  readonly aliases: readonly string[];
}
export type Session = { readonly kind: 'local'; readonly editing: 'source' | 'draft' } | (GitHubProfile & { readonly kind: 'github' }) | AccountProfile;

export function parseSession(value: unknown): Session {
  const data = record(value);
  if (data['kind'] === 'local') {
    const editing = data['editing'] ?? 'draft';
    if (editing !== 'source' && editing !== 'draft') {
      throw new Error('Invalid local editing mode');
    }
    return { kind: 'local', editing };
  }
  if (data['kind'] === 'account') {
    const email = data['email'] === undefined ? undefined : string(data['email'], 254);
    const avatarUrl = data['avatarUrl'] === undefined ? undefined : string(data['avatarUrl'], 500);
    return {
      kind: 'account',
      identity: string(data['identity'], 233),
      aliases: stringList(data['aliases']),
      name: string(data['name'], 100),
      ...(email === undefined ? {} : { email }),
      ...(avatarUrl === undefined ? {} : { avatarUrl }),
    };
  }
  if (data['kind'] !== 'github') {
    throw new Error('Invalid Studio session');
  }
  return { kind: 'github', ...parseProfile(data) };
}

export function useSession(report: (error: unknown) => void) {
  const [session, setSession] = useState<Session>();
  useEffect(() => {
    let active = true;
    void request('/studio/api/session')
      .then((value) => {
        if (!active) {
          return;
        }
        setSession(parseSession(value));
      })
      .catch((error: unknown) => {
        if (active) {
          report(error);
        }
      });
    return () => {
      active = false;
    };
  }, [report]);
  return session;
}

function stringList(value: unknown): readonly string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.length > 8) {
    throw new Error('Invalid aliases');
  }
  return value.map((item: unknown) => string(item, 233));
}
