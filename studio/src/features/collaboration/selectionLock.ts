import type { Peer } from './presence';

export function selectionOwner(peers: Iterable<Peer>, selfId: string, file: string, selection: string): Peer | undefined {
  if (!selection) {
    return undefined;
  }
  for (const peer of peers) {
    if (peer.id !== selfId && peer.file === file && peer.selection === selection && peer.editing !== false) {
      return peer;
    }
  }
  return undefined;
}

// Keep inspection separate from editing. When an owner leaves, one remaining
// inspector inherits editing so two viewers never both become owners.
export function releaseSelectionOwners<Key>(clients: Map<Key, Peer>) {
  const owned = new Set([...clients.values()].filter((peer) => peer.editing !== false).map((peer) => peer.selection));
  for (const [key, peer] of clients) {
    if (peer.selection && !owned.has(peer.selection)) {
      clients.set(key, { ...peer, editing: true });
      owned.add(peer.selection);
    }
  }
}
