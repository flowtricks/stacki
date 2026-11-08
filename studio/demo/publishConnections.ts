// The accounts behind the demo's publish settings: one GitHub account with the
// connected repository, and one Cloudflare account with the `stacki-build` Worker. The
// settings dialog shows them as connected. Signing in, connecting another repository
// or creating one answer with a plain reason; nothing opens a sign-in window.
import { parseAccountRequest } from '../vendor/stacki/shared/ipc/publishAccount';
import { parseRepositoryRequest } from '../vendor/stacki/shared/ipc/publishRepository';
import { parseDiscoveryRequest } from '../vendor/stacki/shared/properties/publishDiscovery';
import { sha256Hex } from './nodeCrypto';
import { DEMO_CLOUDFLARE_ACCOUNT, DEMO_CLOUDFLARE_PROJECT, DEMO_GITHUB_ACCOUNT, DEMO_REPOSITORY } from './publish';

export const CONNECTIONS_REASON = 'This demo is already connected. Signing in and changing connections is in the full Stacki app.';

/** `/studio/api/publish/discover`: the accounts and projects a provider has. */
export function publishDiscovery(body: unknown): unknown {
  const request = parseDiscoveryRequest(body);
  switch (request.provider) {
    case 'github':
      return { kind: 'ready', accounts: [{ id: DEMO_GITHUB_ACCOUNT, name: DEMO_GITHUB_ACCOUNT }], projects: [] };
    case 'cloudflare':
    case 'cloudflare-workers':
    case 'linked':
      return {
        kind: 'ready',
        accounts: [{ id: DEMO_CLOUDFLARE_ACCOUNT, name: 'Stacki demo' }],
        projects: [
          { name: DEMO_CLOUDFLARE_PROJECT, hosting: { provider: 'cloudflare-workers', accountId: DEMO_CLOUDFLARE_ACCOUNT, project: DEMO_CLOUDFLARE_PROJECT } },
        ],
      };
    case 'vercel':
      return { kind: 'failed', message: CONNECTIONS_REASON };
    default: {
      const exhaustive: never = request.provider;
      return exhaustive;
    }
  }
}

/** `/studio/api/publish/repository`: the connected repository, which cannot be changed here. */
export function publishRepositories(body: unknown): unknown {
  const request = parseRepositoryRequest(body);
  if (request.action !== 'list') {
    return { ok: false, error: CONNECTIONS_REASON };
  }
  return {
    ok: true,
    value: {
      connected: DEMO_REPOSITORY,
      revision: sha256Hex(DEMO_REPOSITORY),
      repositories: [DEMO_REPOSITORY],
      mode: 'managed',
      notice: 'This demo is connected to a sample repository.',
    },
  };
}

/** `/studio/api/publish/account`: sign-in never starts. */
export function publishAccount(body: unknown): unknown {
  parseAccountRequest(body);
  return { kind: 'failed', message: CONNECTIONS_REASON };
}
