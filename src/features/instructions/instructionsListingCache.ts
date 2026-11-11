// The Instructions panel's last listing per project, outside the panel's lazy
// chunk, so the app can fill it before the panel first opens (panelPrefetch.ts).
//
// Why: the panel read the project on every mount and drew "Reading the
// project…" until the answer came back, then swapped in the sections, on every
// open of the panel, not only the first. It now opens on the kept listing and
// reads again in place.
import { assert } from '../../../shared/core/assert';
import type { InstructionListing } from '../../../shared/properties/instructions';
import { createPanelCache } from '../../lib/usePanelData';
import { listInstructions } from './instructionsBridge';

export const instructionsListingCache = createPanelCache<InstructionListing>();

/** Reads the project's instructions into the cache the panel opens on. A failure is left for the panel to report. */
export async function prewarmInstructionsListing(projectPath: string): Promise<void> {
  assert(projectPath.length > 0, 'prewarmInstructionsListing: a project is open');
  if (instructionsListingCache.get(projectPath) !== undefined) {
    return;
  }
  const listing = await listInstructions(projectPath);
  // A listing the panel read meanwhile is newer than this one.
  if (instructionsListingCache.get(projectPath) === undefined) {
    instructionsListingCache.set(projectPath, listing);
  }
}
