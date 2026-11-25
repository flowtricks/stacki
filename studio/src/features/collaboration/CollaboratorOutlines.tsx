import { outlineInfo } from '../preview/outlineInfo';
import type { ParserNode } from '../source/source';
import type { RectMap } from '../../../vendor/stacki/src/features/preview/PreviewOverlays';
import { Avatar } from '../auth/Avatar';
import { peerPath, type Peer } from './presence';
import { presenceColor } from './presenceColors';
export function CollaboratorOutlines({
  peers,
  rects,
  scale,
  nodes,
  file,
}: {
  readonly peers: readonly Peer[];
  readonly nodes: readonly ParserNode[];
  readonly file: string;
  readonly rects: RectMap;
  readonly scale: number;
}) {
  return (
    <>
      {peers.map((peer) => {
        const rect = rects[peerPath(peer)]?.[peer.occurrence];
        if (!rect) {
          return null;
        }
        return (
          <div
            key={peer.id}
            className="collaborator-outline"
            data-peer={peer.name}
            style={{
              left: rect.x * scale,
              top: rect.y * scale,
              width: rect.w * scale,
              height: rect.h * scale,
              outlineColor: presenceColor(peer),
            }}
          >
            <span className={`collaborator-outline-tag ${rect.y * scale < 24 ? 'inside' : ''}`} style={{ backgroundColor: presenceColor(peer) }}>
              <span className="collaborator-avatar">
                <Avatar id={peer.githubId} name={peer.name} />
              </span>
              {(peer.file === file ? outlineInfo(nodes, peerPath(peer))?.label : undefined) ?? peer.name}
            </span>
          </div>
        );
      })}
    </>
  );
}
