import { useEffect, useState } from 'react';
import { request } from '../project/projectClient';
import { record } from '../../shared/validation';
import { parseProfile, type GitHubProfile } from './profile';

export type Session = { readonly kind: 'local'; readonly editing: 'source' | 'draft' } | (GitHubProfile & { readonly kind: 'github' });

export function parseSession(value: unknown): Session {
  const data = record(value);
  if (data['kind'] === 'local') {
    const editing = data['editing'] ?? 'draft';
    if (editing !== 'source' && editing !== 'draft') {
      throw new Error('Invalid local editing mode');
    }
    return { kind: 'local', editing };
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
