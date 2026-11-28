// The destinations' part of the publish settings form: the list being edited, each new one's smart defaults, and
// writing the list to its own file. A new destination follows what the project declares until the person changes it.
import { useEffect, useState } from 'react';
import { writeMetadata, readMetadata } from '../../ipc/projectMetadataBridge';
import {
  DESTINATION_LIMITS,
  NO_DESTINATIONS,
  nextDestinationLabel,
  parseDestinationsSource,
  parsePublishDestinations,
  type Destination,
  type DestinationId,
  type DestinationTarget,
  type OwnHosting,
  type PublishDestinations,
} from '../../../shared/properties/publishDestinations';
import { suggestDestination, type DetectedProject } from '../../../shared/properties/publishDestinationDefaults';
import { borrowsAnotherProvider } from '../../../shared/properties/publishDestinationConflicts';
import type { PublishConfig } from '../../../shared/properties/publishConfig';
import { DESTINATION_SUPPORT } from '../../ipc/publishCustomBridge';
import type { CustomHostInfo } from './useCustomHostInfo';

export type StoredDestinations =
  { readonly kind: 'read'; readonly base: string | undefined; readonly destinations: PublishDestinations } | { readonly kind: 'unreadable' };

/** An unreadable destinations file never blocks production's settings; the destinations then say why they cannot be edited. */
export async function readStoredDestinations(projectPath: string): Promise<StoredDestinations> {
  try {
    const file = await readMetadata(projectPath, 'publishDestinations');
    return { kind: 'read', base: file.source, destinations: parseDestinationsSource(file.source) };
  } catch {
    return { kind: 'unreadable' };
  }
}

/** Whether this host can publish to added destinations, or why the controls are not offered. */
export type DestinationAccess = 'supported' | 'desktop-only' | 'unreadable';

/** `custom` is a branch, a script or a link; the providers are an account and project of the destination's own. */
export type DestinationHost = 'same' | 'cloudflare' | 'vercel' | 'netlify' | 'custom';

export function destinationHost(target: DestinationTarget): DestinationHost {
  switch (target.kind) {
    case 'cloudflare-environment':
    case 'cloudflare-worker':
    case 'cloudflare-pages':
    case 'vercel':
    case 'netlify':
      return 'same';
    case 'host':
      return target.hosting.provider === 'cloudflare-workers' ? 'cloudflare' : target.hosting.provider;
    case 'github-branch':
    case 'script':
    case 'link':
      return 'custom';
  }
}

/** A chosen provider with nothing picked yet, exactly as production's starts. */
function emptyOwnHosting(host: 'cloudflare' | 'vercel' | 'netlify'): OwnHosting {
  switch (host) {
    case 'cloudflare':
      return { provider: 'cloudflare-workers', accountId: '', project: '' };
    case 'vercel':
      return { provider: 'vercel', organizationId: '', projectId: '' };
    case 'netlify':
      return { provider: 'netlify', siteId: '' };
  }
}

/** `suggested`: added in this dialog and not yet touched, so detection may still improve it. */
interface Entry {
  readonly destination: Destination;
  readonly origin: 'suggested' | 'chosen';
}

const NOTHING_DETECTED: DetectedProject = { scripts: [], environments: [] };

export function useDestinationSettings(stored: StoredDestinations) {
  const original = stored.kind === 'read' ? stored.destinations : NO_DESTINATIONS;
  const [entries, setEntries] = useState<readonly Entry[]>(() => original.destinations.map((destination) => ({ destination, origin: 'chosen' })));
  const [base, setBase] = useState(stored.kind === 'read' ? stored.base : undefined);
  const access: DestinationAccess = !DESTINATION_SUPPORT ? 'desktop-only' : stored.kind === 'unreadable' ? 'unreadable' : 'supported';
  const destinations = entries.map((entry) => entry.destination);

  /** Writes the destinations file only when it changed, so a project that never added one never gets the file. */
  async function save(projectPath: string): Promise<void> {
    if (access !== 'supported') {
      return;
    }
    if (base === undefined && destinations.length === 0) {
      return;
    }
    const source = `${JSON.stringify(parsePublishDestinations({ version: 1, destinations: destinations.map(normalized) }), undefined, 2)}\n`;
    if (source === base) {
      return;
    }
    const written = await writeMetadata(projectPath, { kind: 'publishDestinations', source, ...(base === undefined ? {} : { base }) });
    setBase(written.source);
  }

  return {
    access,
    entries,
    setEntries,
    destinations,
    /** The destinations as the file had them when the dialog opened. */
    stored: original.destinations,
    full: destinations.length >= DESTINATION_LIMITS.destinationsMax,
    change: (destination: Destination) =>
      setEntries((previous) => previous.map((entry) => (entry.destination.id === destination.id ? { destination, origin: 'chosen' } : entry))),
    remove: (id: DestinationId) => setEntries((previous) => previous.filter((entry) => entry.destination.id !== id)),
    save,
  };
}

export type DestinationSettings = ReturnType<typeof useDestinationSettings>;

/** The destination as it is saved: a typed address may end in a slash, which an origin does not. */
export function normalized(destination: Destination): Destination {
  const label = destination.label.trim();
  const trimmed = { ...destination, label };
  return destination.siteUrl === undefined ? trimmed : { ...trimmed, siteUrl: destination.siteUrl.trim().replace(/\/$/, '') };
}

/** A new id, never one a destination had: a removed destination's receipt and link are never inherited. */
function newDestinationId(): DestinationId {
  return `d-${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * Adds destinations and moves them between hosts. Keeps an untouched suggestion up to date as the project is read, and
 * replaces a target that borrows a provider production no longer uses.
 */
export function useDestinationDefaults(production: PublishConfig, settings: DestinationSettings, info: CustomHostInfo | undefined, defaultLabel: string) {
  const { entries, setEntries, destinations, change, full } = settings;
  const stale = destinations.some((destination) => borrowsAnotherProvider(production, destination.target));
  const suggested = entries.some((entry) => entry.origin === 'suggested');
  const provider = production.hosting.provider;
  useEffect(() => {
    setEntries((previous) => refreshed(production, previous, info ?? NOTHING_DETECTED));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- revisited when what it is suggested from changes, not on every keystroke
  }, [provider, info, suggested, stale]);
  return {
    /** Adds one and answers its id, so the form can open it; nothing past the limit. */
    add: (): DestinationId | undefined => {
      if (full) {
        return undefined;
      }
      const labels = destinations.map((destination) => destination.label);
      const identity = { id: newDestinationId(), label: nextDestinationLabel(defaultLabel, labels) };
      const destination = suggestDestination(production, info ?? NOTHING_DETECTED, identity, destinations);
      setEntries((previous) => [...previous, { destination, origin: 'suggested' }]);
      return identity.id;
    },
    changeHost: (destination: Destination, host: DestinationHost) => {
      const { siteUrl: previous, ...rest } = destination;
      void previous;
      if (host === 'same' || host === 'custom') {
        const identity = { id: destination.id, label: destination.label };
        const others = destinations.filter((other) => other.id !== destination.id);
        const next = suggestDestination(production, info ?? NOTHING_DETECTED, identity, others, host);
        change({ ...rest, target: next.target, ...(next.siteUrl === undefined ? {} : { siteUrl: next.siteUrl }) });
      } else {
        change({ ...rest, target: { kind: 'host', hosting: emptyOwnHosting(host) } });
      }
    },
  };
}

function refreshed(production: PublishConfig, entries: readonly Entry[], detected: DetectedProject): readonly Entry[] {
  const next = entries.reduce<readonly Entry[]>((done, entry, index) => {
    const { destination, origin } = entry;
    if (origin === 'chosen' && !borrowsAnotherProvider(production, destination.target)) {
      return [...done, entry];
    }
    // What came before has settled, and what comes after still holds its place.
    const others = [...done, ...entries.slice(index + 1)].map((other) => other.destination);
    const identity = { id: destination.id, label: destination.label };
    const suggestion = suggestDestination(production, detected, identity, others);
    const value = origin === 'suggested' ? suggestion : { ...destination, target: suggestion.target };
    return [...done, JSON.stringify(value) === JSON.stringify(destination) ? entry : { destination: value, origin }];
  }, []);
  return next.every((entry, index) => entry === entries[index]) ? entries : next;
}
