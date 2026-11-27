// The parts of saving the publish settings that concern secrets and staging safety: what is refused before anything
// is written, and keeping each destination's deploy link on this computer.
import { publishingCustomHost } from '../../ipc/publishCustomBridge';
import { parseDeployLink, type DeployLinkDestination } from '../../../shared/properties/publishDeployLink';
import { parsePublishDestinations, stagingConflict, withStaging, NO_DESTINATIONS } from '../../../shared/properties/publishDestinations';
import type { PublishConfig } from '../../../shared/properties/publishConfig';
import { described, type Described } from '../../../shared/properties/i18n/messageRef';
import { EMPTY_LINK_DRAFT, type LinkDraft } from './useCustomHostInfo';
import { normalized, type useStagingSettings } from './useStagingSettings';

export type LinkDrafts = Readonly<Record<DeployLinkDestination, LinkDraft>>;

export const NO_LINK_DRAFTS: LinkDrafts = { production: EMPTY_LINK_DRAFT, staging: EMPTY_LINK_DRAFT };

type Staging = ReturnType<typeof useStagingSettings>;

/** The links typed for destinations that use one; a draft left behind by another choice is not saved. */
function typedLinks(config: PublishConfig, staging: Staging, drafts: LinkDrafts): readonly (readonly [DeployLinkDestination, string])[] {
  const uses = { production: config.customHosting?.deploy === 'link', staging: staging.staging?.target.kind === 'link' };
  return (['production', 'staging'] as const).flatMap((destination) => {
    const text = drafts[destination].text.trim();
    return uses[destination] && text !== '' ? [[destination, text] as const] : [];
  });
}

export function settingsRefusal(config: PublishConfig, staging: Staging, drafts: LinkDrafts): Described | undefined {
  if (staging.access === 'supported' && staging.staging !== undefined) {
    // The parser first, so a branch such as `+main` is refused before it is compared.
    const destinations = parsePublishDestinations(withStaging(NO_DESTINATIONS, normalized(staging.staging)));
    const [destination] = destinations.destinations;
    const conflict = destination === undefined ? undefined : stagingConflict(config, destination);
    if (conflict !== undefined && !conflict.ok) {
      return conflict.error;
    }
  }
  const links = typedLinks(config, staging, drafts).map(([, link]) => parseDeployLink(link));
  const invalid = links.find((link) => !link.ok);
  if (invalid !== undefined && !invalid.ok) {
    return invalid.error;
  }
  const values = links.map((link) => (link.ok ? link.value : ''));
  return new Set(values).size === values.length ? undefined : described('publish.staging.error.productionLink');
}

/** Keeps the typed links, and forgets the link of a staging destination that was removed. Answers the first problem. */
export async function saveDeployLinks(projectPath: string, config: PublishConfig, staging: Staging, drafts: LinkDrafts): Promise<Described | undefined> {
  if (staging.access === 'supported' && staging.stored?.target.kind === 'link' && staging.staging === undefined) {
    const removed = await publishingCustomHost(projectPath, { action: 'removeLink', destination: 'staging' });
    if (removed.kind === 'failed') {
      return removed;
    }
  }
  for (const [destination, link] of typedLinks(config, staging, drafts)) {
    const result = await publishingCustomHost(projectPath, { action: 'saveLink', destination, link });
    if (result.kind === 'failed') {
      return result;
    }
  }
  return undefined;
}
