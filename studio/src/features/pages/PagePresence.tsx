import { Avatar } from '../auth/Avatar';
import type { Peer } from '../collaboration/presence';
import { presenceUsers } from '../collaboration/presenceUsers';

export function PagePresence({ peers, page }: { readonly peers: readonly Peer[]; readonly page: string }) {
  // Choose a person's most recent connection before grouping by page, matching
  // the top bar even when they have several tabs or are editing a component.
  const people = presenceUsers(peers).filter((peer) => peer.page === page);
  if (!people.length) {
    return null;
  }
  const names = people.map((peer) => peer.name).join(', ');
  return (
    <span className="page-presence" role="group" aria-label={`On this page: ${names}`} title={`On this page: ${names}`}>
      {people.slice(0, 3).map((peer) => (
        <span className="page-presence-avatar" key={peer.githubId ?? peer.id} title={peer.name}>
          <Avatar id={peer.githubId} name={peer.name} />
        </span>
      ))}
      {people.length > 3 && <span className="page-presence-avatar page-presence-more">+{people.length - 3}</span>}
    </span>
  );
}
