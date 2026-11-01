import { parseProfile } from '../auth/profile';
import { record, sourcePath, string } from '../../shared/validation';
import { pathFor } from '../project/previewSelection';
import { colorIndex } from './cursorPresence';
export interface Peer {
  readonly id: string;
  readonly name: string;
  readonly selection: string;
  readonly selectionRequest?: number;
  readonly editing?: boolean;
  readonly file: string;
  readonly page: string;
  readonly occurrence: number;
  readonly updatedAt: number;
  readonly githubId?: number;
  readonly color?: number;
}
export function parsePeer(input: unknown, fallbackFile = 'src/pages/index.astro'): Peer {
  const peer = record(input);
  const name = string(peer['name'], 100);
  const file = sourcePath(string(peer['file'] ?? fallbackFile));
  return {
    id: string(peer['id'], 100),
    name,
    file,
    selection: string(peer['selection'], 500),
    ...(typeof peer['editing'] === 'boolean' ? { editing: peer['editing'] } : {}),
    page: sourcePath(string(peer['page'] ?? file)),
    occurrence: occurrenceOf(peer['occurrence']),
    ...(peer['color'] === undefined ? {} : { color: colorIndex(peer['color']) }),
    updatedAt: typeof peer['updatedAt'] === 'number' && Number.isFinite(peer['updatedAt']) ? peer['updatedAt'] : 0,
    ...(peer['githubId'] === undefined ? {} : { githubId: parseProfile({ id: peer['githubId'], login: name }).id }),
  };
}
export function occurrenceOf(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 10000 ? value : 0;
}
export function peerPath(peer: Peer): string {
  return (peer.file.startsWith('src/pages/') ? '' : peer.file + '|') + pathFor(peer.selection);
}
