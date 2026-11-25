import { parsePage } from '../source/source';
import { hasOnlyLiteralTextChanges } from './liveTextChanges';

export type SourceRenderMode = 'typing' | 'immediate';

export function sourceRenderMode(file: string, before: string, after: string): SourceRenderMode {
  if (!file.endsWith('.astro')) {
    return 'immediate';
  }
  const previous = parsePage(before, { locs: true });
  const current = parsePage(after, { locs: true });
  if (!previous.editable || !current.editable) {
    return 'immediate';
  }
  return hasOnlyLiteralTextChanges({ source: before, nodes: previous.model.nodes }, { source: after, nodes: current.model.nodes }) ? 'typing' : 'immediate';
}
