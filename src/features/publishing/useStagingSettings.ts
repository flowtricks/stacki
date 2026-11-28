// Staging's part of the publish settings form: the destination being edited, its smart defaults, and writing it to
// its own file. Defaults follow what the project declares until the person changes something.
import { useEffect, useState } from 'react';
import { writeMetadata, readMetadata } from '../../ipc/projectMetadataBridge';
import {
  NO_DESTINATIONS,
  parseDestinationsSource,
  parsePublishDestinations,
  stagingConflict,
  stagingDestination,
  suggestStaging,
  withStaging,
  type Destination,
  type DetectedProject,
  type PublishDestinations,
} from '../../../shared/properties/publishDestinations';
import type { PublishConfig } from '../../../shared/properties/publishConfig';
import { STAGING_SUPPORT } from '../../ipc/publishCustomBridge';
import type { StagingAccess } from './PublishStaging';
import type { CustomHostInfo } from './useCustomHostInfo';

export type StoredDestinations =
  { readonly kind: 'read'; readonly base: string | undefined; readonly destinations: PublishDestinations } | { readonly kind: 'unreadable' };

/** An unreadable destinations file never blocks production's settings; staging then says why it cannot be edited. */
export async function readStoredDestinations(projectPath: string): Promise<StoredDestinations> {
  try {
    const file = await readMetadata(projectPath, 'publishDestinations');
    return { kind: 'read', base: file.source, destinations: parseDestinationsSource(file.source) };
  } catch {
    return { kind: 'unreadable' };
  }
}

interface StagingState {
  readonly staging: Destination | undefined;
  /** `suggested`: added in this dialog and not yet touched, so detection may still improve it. */
  readonly origin: 'suggested' | 'chosen';
}

export function useStagingSettings(stored: StoredDestinations) {
  const original = stored.kind === 'read' ? stored.destinations : NO_DESTINATIONS;
  const [state, setState] = useState<StagingState>({ staging: stagingDestination(original), origin: 'chosen' });
  const [base, setBase] = useState(stored.kind === 'read' ? stored.base : undefined);
  const access: StagingAccess = !STAGING_SUPPORT ? 'desktop-only' : stored.kind === 'unreadable' ? 'unreadable' : 'supported';

  /** Writes the destinations file only when it changed, so a project that never had staging never gets one. */
  async function save(projectPath: string): Promise<void> {
    if (access !== 'supported') {
      return;
    }
    const destinations = withStaging(original, state.staging === undefined ? undefined : normalized(state.staging));
    if (base === undefined && destinations.destinations.length === 0) {
      return;
    }
    const source = `${JSON.stringify(parsePublishDestinations(destinations), undefined, 2)}\n`;
    if (source === base) {
      return;
    }
    const written = await writeMetadata(projectPath, { kind: 'publishDestinations', source, ...(base === undefined ? {} : { base }) });
    setBase(written.source);
  }

  return {
    access,
    staging: state.staging,
    suggested: state.origin === 'suggested',
    stored: stagingDestination(original),
    change: (staging: Destination | undefined) => setState({ staging, origin: 'chosen' }),
    suggest: (staging: Destination) => setState({ staging, origin: 'suggested' }),
    save,
  };
}

/** The destination as it is saved: a typed address may end in a slash, which an origin does not. */
export function normalized(staging: Destination): Destination {
  return staging.siteUrl === undefined ? staging : { ...staging, siteUrl: staging.siteUrl.trim().replace(/\/$/, '') };
}

const NOTHING_DETECTED: DetectedProject = { scripts: [], environments: [] };

/**
 * Keeps a suggested destination up to date as the project is read, and replaces a destination that borrows a
 * provider production no longer uses.
 */
export function useStagingDefaults(production: PublishConfig, staging: ReturnType<typeof useStagingSettings>, info: CustomHostInfo | undefined) {
  const { staging: current, suggested, suggest, change } = staging;
  const conflict = current === undefined ? undefined : stagingConflict(production, current);
  const stale = conflict !== undefined && !conflict.ok && conflict.error.messageRef?.key === 'publish.staging.error.providerChanged';
  const provider = production.hosting.provider;
  useEffect(() => {
    if (current === undefined) {
      return;
    }
    const detected = info ?? NOTHING_DETECTED;
    if (suggested) {
      const next = suggestStaging(production, detected);
      if (JSON.stringify(next) !== JSON.stringify(current)) {
        suggest(next);
      }
    } else if (stale) {
      change({ ...current, target: suggestStaging(production, detected).target });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- revisited when what it is suggested from changes, not on every keystroke
  }, [provider, info, suggested, stale]);
  return {
    add: () => suggest(suggestStaging(production, info ?? NOTHING_DETECTED)),
    remove: () => change(undefined),
    changeHost: (host: 'same' | 'custom') => {
      if (current === undefined) {
        return;
      }
      const from: PublishConfig = host === 'custom' ? { ...production, hosting: { provider: 'none' } } : production;
      const { siteUrl: previous, ...rest } = current;
      void previous;
      const next = suggestStaging(from, info ?? NOTHING_DETECTED);
      change({ ...rest, target: next.target, ...(next.siteUrl === undefined ? {} : { siteUrl: next.siteUrl }) });
    },
  };
}
