// The parts of saving the publish settings that concern secrets and destination safety: what is refused before
// anything is written, and keeping each destination's deploy link on this computer.
import { publishingCustomHost } from '../../ipc/publishCustomBridge';
import { parseDeployLink, PRODUCTION_LINK, type DeployLinkDestination } from '../../../shared/properties/publishDeployLink';
import { parsePublishDestinations, otherDestinations, type Destination, type DestinationId } from '../../../shared/properties/publishDestinations';
import { destinationConflict } from '../../../shared/properties/publishDestinationConflicts';
import type { PublishConfig } from '../../../shared/properties/publishConfig';
import { described, type Described } from '../../../shared/properties/i18n/messageRef';
import { EMPTY_LINK_DRAFT, type LinkDraft } from './useCustomHostInfo';
import { normalized, type DestinationSettings } from './useDestinationSettings';

/** What is typed in each deploy link field, by `production` or destination id. */
export type LinkDrafts = Readonly<Record<DeployLinkDestination, LinkDraft>>;

export const NO_LINK_DRAFTS: LinkDrafts = {};

export function linkDraft(drafts: LinkDrafts, destination: DeployLinkDestination): LinkDraft {
  return drafts[destination] ?? EMPTY_LINK_DRAFT;
}

/** The links typed for places that use one; a draft left behind by another choice is not saved. */
function typedLinks(config: PublishConfig, settings: DestinationSettings, drafts: LinkDrafts): readonly (readonly [DeployLinkDestination, string])[] {
  const using = [
    ...(config.customHosting?.deploy === 'link' ? [PRODUCTION_LINK] : []),
    ...(settings.access === 'supported' ? settings.destinations.filter(usesLink).map((destination) => destination.id) : []),
  ];
  return using.flatMap((destination) => {
    const text = linkDraft(drafts, destination).text.trim();
    return text === '' ? [] : [[destination, text] as const];
  });
}

function usesLink(destination: Destination): boolean {
  return destination.target.kind === 'link';
}

export interface Refusal {
  readonly problem: Described;
  /** The destination the problem is in, so the form can open it. */
  readonly destination?: DestinationId;
}

export function settingsRefusal(config: PublishConfig, settings: DestinationSettings, drafts: LinkDrafts): Refusal | undefined {
  if (settings.access === 'supported') {
    // The parser first, so a branch such as `+main` is refused before it is compared.
    const { destinations } = parsePublishDestinations({ version: 1, destinations: settings.destinations.map(normalized) });
    for (const destination of destinations) {
      const conflict = destinationConflict(config, destination, otherDestinations(destinations, destination.id));
      if (!conflict.ok) {
        return { problem: conflict.error, destination: destination.id };
      }
    }
  }
  const links = typedLinks(config, settings, drafts).map(([, link]) => parseDeployLink(link));
  const invalid = links.find((link) => !link.ok);
  if (invalid !== undefined && !invalid.ok) {
    return { problem: invalid.error };
  }
  const values = links.map((link) => (link.ok ? link.value : ''));
  return new Set(values).size === values.length ? undefined : { problem: described('publish.destination.error.sharedLink') };
}

/** The saved destinations whose link is no longer theirs to keep: removed, or no longer deploying by link. */
function forgottenLinks(settings: DestinationSettings): readonly DestinationId[] {
  if (settings.access !== 'supported') {
    return [];
  }
  return settings.stored.flatMap((saved) => {
    const now = settings.destinations.find((destination) => destination.id === saved.id);
    if (now === undefined) {
      return [saved.id];
    }
    return usesLink(saved) && !usesLink(now) ? [saved.id] : [];
  });
}

/** Forgets the links that are no longer used, then keeps the typed ones. Answers the first problem. */
export async function saveDeployLinks(
  projectPath: string,
  config: PublishConfig,
  settings: DestinationSettings,
  drafts: LinkDrafts,
): Promise<Described | undefined> {
  for (const destination of forgottenLinks(settings)) {
    const removed = await publishingCustomHost(projectPath, { action: 'removeLink', destination });
    if (removed.kind === 'failed') {
      return removed;
    }
  }
  for (const [destination, link] of typedLinks(config, settings, drafts)) {
    const result = await publishingCustomHost(projectPath, { action: 'saveLink', destination, link });
    if (result.kind === 'failed') {
      return result;
    }
  }
  return undefined;
}
