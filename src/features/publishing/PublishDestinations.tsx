// The added destinations in Publish settings, below production. With none, it is one quiet "Add destination" button.
// Each destination is a filled card with its label in plain view; with several, a card folds down to its header, which
// names it and its host.
import type { Destination, DestinationId } from '../../../shared/properties/publishDestinations';
import { DESTINATION_LIMITS } from '../../../shared/properties/publishDestinations';
import type { PublishConfig } from '../../../shared/properties/publishConfig';
import type { MissingDestinationField } from '../../../shared/properties/publishMissing';
import { PlusIcon } from '../../ui/Icons';
import { useTranslate } from '../../lib/i18n/useTranslate';
import { FieldLabel } from './publishFields';
import { DestinationCard } from './PublishDestinationCard';
import type { DestinationAccess, DestinationHost } from './useDestinationSettings';
import type { CustomHostInfo, LinkDraft } from './useCustomHostInfo';
import { linkDraft, type LinkDrafts } from './saveDeployLinks';

/** What Save found missing or wrong in one destination. */
export interface InvalidDestination {
  readonly id: DestinationId;
  readonly field: MissingDestinationField | 'label';
}

interface Props {
  readonly projectPath: string;
  readonly access: DestinationAccess;
  readonly production: PublishConfig;
  readonly destinations: readonly Destination[];
  readonly full: boolean;
  readonly expanded: ReadonlySet<DestinationId>;
  readonly toggle: (id: DestinationId) => void;
  readonly add: () => void;
  readonly remove: (id: DestinationId) => void;
  readonly change: (destination: Destination) => void;
  readonly changeHost: (destination: Destination, host: DestinationHost) => void;
  readonly info: CustomHostInfo | undefined;
  readonly drafts: LinkDrafts;
  readonly changeDraft: (id: DestinationId, draft: LinkDraft) => void;
  readonly removeLink: (id: DestinationId) => void;
  readonly invalid: InvalidDestination | undefined;
}

export function PublishDestinations(props: Props) {
  const translate = useTranslate();
  const { access, destinations } = props;
  if (access !== 'supported') {
    // Where destinations cannot be edited, existing ones are still named, so they are never silently missing.
    if (access === 'desktop-only' && destinations.length === 0) {
      return undefined;
    }
    const named = destinations.map((destination) => destination.label).join(', ');
    return (
      <section className="publish-destinations" aria-label={translate('publish.destination.title')}>
        <FieldLabel
          label={named === '' ? translate('publish.destination.title') : named}
          hint={translate(access === 'unreadable' ? 'publish.destination.unreadable' : 'publish.destination.desktopOnly')}
        />
      </section>
    );
  }
  const several = destinations.length > 1;
  return (
    <div className="publish-destinations">
      {destinations.map((destination) => (
        <DestinationCard
          key={destination.id}
          projectPath={props.projectPath}
          production={props.production}
          destination={destination}
          collapsible={several}
          expanded={!several || props.expanded.has(destination.id)}
          toggle={() => props.toggle(destination.id)}
          remove={() => props.remove(destination.id)}
          change={props.change}
          changeHost={(host) => props.changeHost(destination, host)}
          info={props.info}
          draft={linkDraft(props.drafts, destination.id)}
          changeDraft={(draft) => props.changeDraft(destination.id, draft)}
          removeLink={() => props.removeLink(destination.id)}
          invalid={props.invalid?.id === destination.id ? props.invalid.field : undefined}
        />
      ))}
      <span
        className="publish-add-wrap"
        title={props.full ? translate('publish.destination.addLimit', { max: DESTINATION_LIMITS.destinationsMax }) : undefined}
      >
        <button type="button" className="publish-add-destination" disabled={props.full} onClick={props.add}>
          <PlusIcon size={12} />
          {translate('publish.destination.add')}
        </button>
      </span>
    </div>
  );
}
