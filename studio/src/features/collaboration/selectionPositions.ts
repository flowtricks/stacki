import * as Y from 'yjs';
import { flatten, parsePage } from '../source/source';
import type { Peer } from './presence';

// Undo and redo arrive as CRDT updates, not tree actions. Anchor selections to
// the original source characters so surviving siblings retain their owners.
export function captureSelectionPositions(document: Y.Doc, peers: Iterable<Peer>) {
  const text = document.getText('source');
  const source = text.toString();
  const parsed = parsePage(source, { locs: true });
  const nodes = new Map(parsed.editable ? flatten(parsed.model.nodes).map((node) => [node.id, node]) : []);
  const positions = new Map(
    [...peers].flatMap((peer) => {
      const node = nodes.get(peer.selection);
      return node?.start === undefined
        ? []
        : [
            [
              peer.id,
              {
                kind: node.kind,
                position: Y.createRelativePositionFromTypeIndex(text, node.start),
              },
            ] as const,
          ];
    }),
  );
  return <Key>(clients: Map<Key, Peer>) => {
    if (source === text.toString()) {
      return;
    }
    const next = parsePage(text.toString(), { locs: true });
    if (!next.editable) {
      return;
    }
    const nodes = new Map(flatten(next.model.nodes).map((node) => [`${node.kind}:${node.start}`, node]));
    for (const [key, peer] of clients) {
      const anchor = positions.get(peer.id);
      if (!anchor) {
        continue;
      }
      const position = Y.createAbsolutePositionFromRelativePosition(anchor.position, document);
      const node = position?.type === text ? nodes.get(`${anchor.kind}:${position.index}`) : undefined;
      clients.set(key, { ...peer, selection: node?.id ?? '' });
    }
  };
}
