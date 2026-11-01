import { useEffect, useState } from 'react';
import type { IpcResults } from '../../../shared/ipc/ipcResults';
import type { Result } from '../../../shared/core/result';
import { boolean, optional, record, text } from '../../../shared/core/boundary';
import { parseIpcPayload } from '../../../shared/ipc/ipcPayloads';
import { assert } from '../../../shared/core/assert';
import { cleanError } from '../../lib/cleanError';

type GitHubStatus = IpcResults['git:ghStatus'];
type PreflightState =
  { readonly kind: 'loading' } | { readonly kind: 'error'; readonly error: string } | { readonly kind: 'ready'; readonly status: GitHubStatus };

export function parseGitHubStatus(input: unknown): GitHubStatus {
  const value = record(input);
  const installed = boolean(value['installed']);
  const authed = boolean(value['authed']);
  if (!installed) {
    if (authed) {
      throw new Error('GitHub status: authentication requires installation');
    }
    return { installed: false, authed: false };
  }
  return authed ? { installed: true, authed: true, user: optional(text)(value['user']) } : { installed: true, authed: false };
}
export async function readGitHubStatus(projectPath: string): Promise<Result<GitHubStatus, string>> {
  const payload = parseIpcPayload('git:ghStatus', projectPath);
  let response: unknown;
  try {
    response = await window.avb.ghStatus(payload);
  } catch (error: unknown) {
    return { ok: false, error: cleanError(error) };
  }
  return { ok: true, value: parseGitHubStatus(response) };
}
export function useGitHubStatus(projectPath: string): PreflightState {
  const [state, setState] = useState<PreflightState>({ kind: 'loading' });
  useEffect(() => {
    let lifetime: 'active' | 'disposed' = 'active';
    setState({ kind: 'loading' });
    void readGitHubStatus(projectPath).then((result) => {
      if (lifetime === 'disposed') {
        return;
      }
      setState(result.ok ? { kind: 'ready', status: result.value } : { kind: 'error', error: result.error });
    });
    return () => {
      lifetime = 'disposed';
    };
  }, [projectPath]);
  return state;
}

// GitHub remotes may use HTTPS or SSH. Other remotes retain their original form.
export function repoSlug(url: string | undefined): string | undefined {
  const value = url === undefined ? '' : text(url);
  const match = value.match(/github\.com[:/]+([^/]+\/[^/]+?)(?:\.git)?$/i);
  if (!match) {
    return url;
  }
  const slug = match[1];
  assert(slug !== undefined, 'GitHub remote: matched slug is required');
  assert(slug.length > 0, 'GitHub remote: matched slug must be nonempty');
  return slug;
}
export function webUrl(url: string | undefined): string | undefined {
  const slug = repoSlug(url);
  return slug && slug !== url ? `https://github.com/${slug}` : url;
}
