// One destination in Publish settings. It asks what it is called and where it goes, preselected from what the project
// already declares; its build script, address and hooks wait under More options.
import { DESTINATION_LIMITS, destinationBuildsLocally, destinationProvider, type Destination } from '../../../shared/properties/publishDestinations';
import type { PublishConfig } from '../../../shared/properties/publishConfig';
import type { MissingDestinationField } from '../../../shared/properties/publishMissing';
import { confirmDialog } from '../../ui/ConfirmDialog';
import { ChevronDownIcon, ChevronRightIcon, TrashIcon } from '../../ui/Icons';
import { useTranslate } from '../../lib/i18n/useTranslate';
import { MoreOptions, ScriptDropdown, ScriptListField, TextField } from './publishFields';
import { PublishProviderIcon } from './PublishProviderIcon';
import { DestinationTargetFields } from './PublishDestinationTarget';
import { ManualHosting } from './PublishManualHosting';
import { hostProductName } from './destinationHostName';
import type { DestinationHost } from './useDestinationSettings';
import type { CustomHostInfo, LinkDraft } from './useCustomHostInfo';

interface Props {
  readonly projectPath: string;
  readonly production: PublishConfig;
  readonly destination: Destination;
  readonly collapsible: boolean;
  readonly expanded: boolean;
  readonly toggle: () => void;
  readonly remove: () => void;
  readonly change: (destination: Destination) => void;
  readonly changeHost: (host: DestinationHost) => void;
  readonly info: CustomHostInfo | undefined;
  readonly draft: LinkDraft;
  readonly changeDraft: (draft: LinkDraft) => void;
  readonly removeLink: () => void;
  readonly invalid: MissingDestinationField | 'label' | undefined;
}

export function DestinationCard(props: Props) {
  const translate = useTranslate();
  const { destination, expanded } = props;
  return (
    <section className="publish-destination" aria-label={destination.label}>
      <DestinationHeader {...props} />
      {expanded && (
        <div className="publish-destination-fields">
          <TextField
            label={translate('publish.destination.label')}
            value={destination.label}
            maxLength={DESTINATION_LIMITS.labelCharsMax}
            invalid={props.invalid === 'label'}
            change={(label) => props.change({ ...destination, label })}
          />
          <DestinationTargetFields {...props} />
          <DestinationExtras {...props} />
        </div>
      )}
    </section>
  );
}

function DestinationHeader(props: Props) {
  const translate = useTranslate();
  const { destination, collapsible, expanded } = props;
  const provider = destinationProvider(destination.target);
  const summary = (
    <>
      <PublishProviderIcon provider={provider} />
      <span className="publish-destination-name">{destination.label}</span>
      <span className="publish-destination-host">{provider === 'custom' ? translate('publish.custom.provider') : hostProductName(provider)}</span>
    </>
  );
  const remove = async () => {
    const confirmed = await confirmDialog({
      title: translate('publish.destination.removeTitle', { label: destination.label }),
      body: translate('publish.destination.removeBody'),
      confirmLabel: translate('publish.destination.remove'),
      danger: true,
    });
    if (confirmed === true) {
      props.remove();
    }
  };
  return (
    <div className="publish-destination-header">
      {collapsible ? (
        <button type="button" className="publish-destination-toggle" aria-expanded={expanded} onClick={props.toggle}>
          {expanded ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
          {summary}
        </button>
      ) : (
        <div className="publish-destination-toggle">{summary}</div>
      )}
      <button
        type="button"
        className="publish-destination-remove"
        aria-label={translate('publish.destination.removeNamed', { label: destination.label })}
        title={translate('publish.destination.remove')}
        onClick={() => void remove()}
      >
        <TrashIcon size={13} />
      </button>
    </div>
  );
}

function DestinationExtras(props: Props) {
  const translate = useTranslate();
  const { destination, change } = props;
  const { target } = destination;
  const setAddress = (value: string) => {
    const { siteUrl: previous, ...rest } = destination;
    void previous;
    change(value === '' ? rest : { ...rest, siteUrl: value });
  };
  return (
    <MoreOptions title={translate('publish.destination.more')}>
      {target.kind === 'host' && <ManualHosting hosting={target.hosting} change={(hosting) => changeOwnHosting(props, hosting)} />}
      {destinationBuildsLocally(target) && (
        <ScriptDropdown
          label={translate('publish.settings.advanced.buildScript')}
          value={destination.buildScript}
          scripts={props.info?.scripts}
          placeholder={translate('publish.custom.chooseScript')}
          hint={translate('publish.destination.buildScriptHint', { id: destination.id })}
          change={(buildScript) => change({ ...destination, buildScript })}
        />
      )}
      <TextField
        label={translate('publish.site.label')}
        value={destination.siteUrl ?? ''}
        placeholder="https://example.com"
        maxLength={2048}
        change={(url) => setAddress(url.trim())}
      />
      <ScriptListField
        label={translate('publish.destination.beforePublish')}
        hint={translate('publish.destination.hooksHint')}
        values={destination.beforePublish}
        change={(beforePublish) => change({ ...destination, beforePublish })}
      />
      <ScriptListField
        label={translate('publish.destination.afterPublish')}
        values={destination.afterPublish}
        change={(afterPublish) => change({ ...destination, afterPublish })}
      />
    </MoreOptions>
  );
}

function changeOwnHosting(props: Props, hosting: PublishConfig['hosting']): void {
  if (hosting.provider !== 'none') {
    props.change({ ...props.destination, target: { kind: 'host', hosting } });
  }
}
