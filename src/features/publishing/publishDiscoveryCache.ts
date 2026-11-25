import { discoverPublishing } from '../../ipc/publishDiscoveryBridge';
import type { DiscoveryRequest, PublishDiscovery } from '../../../shared/properties/publishDiscovery';

type Entry =
  | { readonly kind: 'loading'; readonly promise: Promise<PublishDiscovery> }
  | { readonly kind: 'ready'; readonly value: PublishDiscovery; readonly expiresMs: number };

// Keep only sanitized discovery results, never credentials or editable project metadata.
// A short lifetime handles external CLI changes; refresh always bypasses settled results.
const ENTRIES_MAX = 32;
const LIFETIME_MS = 60_000;
const entries = new Map<string, Entry>();

export function invalidatePublishingAccounts(projectPath: string, provider: 'github' | 'cloudflare' | 'vercel' = 'github'): void {
  // A sign-in can finish while an older inventory is loading; it must not hide the new account.
  entries.delete(JSON.stringify([projectPath, provider, '']));
}

export function cachedPublishingDiscovery(projectPath: string, request: DiscoveryRequest, freshness: 'reuse' | 'refresh'): Promise<PublishDiscovery> {
  const key = JSON.stringify([projectPath, request.provider, request.account]);
  const previous = entries.get(key);
  if (previous?.kind === 'loading') {
    return previous.promise;
  }
  if (freshness === 'reuse') {
    if (previous?.kind === 'ready' && previous.expiresMs > Date.now()) {
      return Promise.resolve(previous.value);
    }
  }
  entries.delete(key);
  if (entries.size >= ENTRIES_MAX) {
    const oldest = entries.keys().next().value;
    if (oldest !== undefined) {
      entries.delete(oldest);
    }
  }
  const promise = discoverPublishing(projectPath, request);
  const pending: Entry = { kind: 'loading', promise };
  entries.set(key, pending);
  // Evicted requests may finish later; they must not replace newer requests for the same key.
  void promise.then(
    (value) => {
      if (entries.get(key) === pending) {
        if (value.kind === 'ready' && value.notice === undefined) {
          entries.set(key, { kind: 'ready', value, expiresMs: Date.now() + LIFETIME_MS });
        } else {
          entries.delete(key);
        }
      }
    },
    () => {
      if (entries.get(key) === pending) {
        entries.delete(key);
      }
    },
  );
  return promise;
}
