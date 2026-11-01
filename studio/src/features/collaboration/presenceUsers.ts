interface PresenceIdentity {
  readonly id: string;
  readonly githubId?: number;
  readonly updatedAt?: number;
}

// Connections stay independent for editing; only the people list is grouped.
export function presenceUsers<T extends PresenceIdentity>(peers: readonly T[]): T[] {
  const users = new Map<string, T>();
  for (const peer of peers) {
    const key = peer.githubId === undefined ? `connection:${peer.id}` : `github:${peer.githubId}`;
    if (!users.has(key) || (peer.updatedAt ?? 0) > (users.get(key)?.updatedAt ?? 0)) {
      users.set(key, peer);
    }
  }
  return [...users.values()];
}

// The viewer's account comes from the session, not from an asynchronously updated peer list.
// Exclude every connection for that account before choosing one connection per collaborator.
export function otherPresenceUsers<T extends PresenceIdentity>(peers: readonly T[], selfId: string, githubId?: number): T[] {
  if (!selfId && githubId === undefined) {
    return [];
  }
  return presenceUsers(peers.filter((peer) => peer.id !== selfId && (githubId === undefined || peer.githubId !== githubId)));
}
