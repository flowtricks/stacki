// Where one destination goes: the host first, then only what that choice needs. "Same as production" is the preview,
// branch or environment form of production's host; another provider uses production's own account and project pickers.
import {
  DESTINATION_LIMITS,
  type Destination,
  type DestinationTarget,
  type DestinationKind,
  type OwnHosting,
} from '../../../shared/properties/publishDestinations';
import { destinationSlug, suggestedWorkerName } from '../../../shared/properties/publishDestinationDefaults';
import type { Hosting, PublishConfig } from '../../../shared/properties/publishConfig';
import type { MissingDestinationField } from '../../../shared/properties/publishMissing';
import type { MessageKey, Translator } from '../../../shared/properties/i18n/messageRef';
import Dropdown from '../../ui/Dropdown';
import { useTranslate } from '../../lib/i18n/useTranslate';
import { FieldLabel, ScriptDropdown, TextField } from './publishFields';
import { PublishDeployLinkField } from './PublishDeployLinkField';
import { PublishProviderIcon } from './PublishProviderIcon';
import { PublishConnections } from './PublishConnections';
import { DestinationWorkerField } from './PublishDestinationWorkerField';
import { PublishInvalidFieldContext } from './publishInvalidField';
import { hostProductName } from './destinationHostName';
import { destinationHost, type DestinationHost } from './useDestinationSettings';
import type { CustomHostInfo, LinkDraft } from './useCustomHostInfo';

interface Props {
  readonly projectPath: string;
  readonly production: PublishConfig;
  readonly destination: Destination;
  readonly change: (destination: Destination) => void;
  readonly changeHost: (host: DestinationHost) => void;
  readonly info: CustomHostInfo | undefined;
  readonly draft: LinkDraft;
  readonly changeDraft: (draft: LinkDraft) => void;
  readonly removeLink: () => void;
  readonly invalid: MissingDestinationField | 'label' | undefined;
}

const HINTS = {
  'cloudflare-environment': 'publish.destination.hint.cloudflareEnvironment',
  'cloudflare-worker': 'publish.destination.hint.cloudflareWorker',
  'cloudflare-pages': 'publish.destination.hint.pages',
  vercel: 'publish.destination.hint.vercel',
  netlify: 'publish.destination.hint.netlify',
  host: 'publish.destination.hint.ownProject',
  'github-branch': 'publish.destination.hint.githubBranch',
  script: 'publish.destination.hint.script',
  link: 'publish.destination.hint.link',
} as const satisfies Record<DestinationKind, MessageKey>;

function hint(target: DestinationTarget): MessageKey {
  return target.kind === 'host' && target.hosting.provider === 'cloudflare-workers' ? 'publish.destination.hint.ownWorker' : HINTS[target.kind];
}

export function DestinationTargetFields(props: Props) {
  return (
    <>
      <HostField {...props} />
      <TargetFields {...props} />
    </>
  );
}

function HostField(props: Props) {
  const translate = useTranslate();
  const { destination, production } = props;
  const value = destinationHost(destination.target);
  return (
    <div className="publish-field">
      <FieldLabel label={translate('publish.destination.host')} hint={translate(hint(destination.target))} />
      <Dropdown<DestinationHost>
        ariaLabel={translate('publish.destination.host')}
        value={value}
        options={hostOptions(production, translate)}
        menuClassName="publish-dropdown"
        livePreview={false}
        onChange={(host) => {
          if (host !== value) {
            props.changeHost(host);
          }
        }}
      />
    </div>
  );
}

function hostOptions(production: PublishConfig, translate: Translator) {
  const { provider } = production.hosting;
  // Production on GitHub alone or a custom host has no provider form to share.
  const same =
    provider === 'none'
      ? []
      : [
          {
            value: 'same' as const,
            label: translate('publish.destination.host.same'),
            description: hostProductName(provider),
            icon: <PublishProviderIcon provider={provider} />,
          },
        ];
  return [
    ...same,
    { value: 'cloudflare' as const, label: 'Cloudflare' /* i18n-ignore: product name. */, icon: <PublishProviderIcon provider="cloudflare" /> },
    { value: 'vercel' as const, label: 'Vercel' /* i18n-ignore: product name. */, icon: <PublishProviderIcon provider="vercel" /> },
    { value: 'netlify' as const, label: 'Netlify' /* i18n-ignore: product name. */, icon: <PublishProviderIcon provider="netlify" /> },
    { value: 'custom' as const, label: translate('publish.custom.provider'), icon: <PublishProviderIcon provider="custom" /> },
  ];
}

function TargetFields(props: Props) {
  const translate = useTranslate();
  const { destination, change, invalid } = props;
  const { target } = destination;
  const setTarget = (next: DestinationTarget) => change({ ...destination, target: next });
  switch (target.kind) {
    case 'cloudflare-environment':
    case 'cloudflare-worker':
      return <WorkerFields {...props} target={target} />;
    case 'cloudflare-pages':
      return (
        <TextField
          label={translate('publish.destination.pagesBranch')}
          value={target.branch}
          maxLength={DESTINATION_LIMITS.branchCharsMax}
          invalid={invalid === 'branch'}
          change={(branch) => setTarget({ ...target, branch })}
        />
      );
    case 'netlify':
      return (
        <TextField
          label={translate('publish.destination.alias')}
          value={target.alias}
          maxLength={DESTINATION_LIMITS.netlifyAliasCharsMax}
          invalid={invalid === 'alias'}
          change={(alias) => setTarget({ ...target, alias })}
        />
      );
    case 'vercel':
      return (
        <div className="publish-field">
          <button type="button" className="dd-trigger" disabled>
            <span className="dd-label">{translate('publish.destination.vercelPreview')}</span>
          </button>
        </div>
      );
    case 'host':
      return <OwnProviderFields {...props} hosting={target.hosting} />;
    case 'github-branch':
    case 'script':
    case 'link':
      return <CustomFields {...props} target={target} />;
    default: {
      const exhaustive: never = target;
      return exhaustive;
    }
  }
}

/** Production's own pickers: the project is asked for only once there is an account, and a sign-in hides both lists. */
function OwnProviderFields(props: Props & { readonly hosting: OwnHosting }) {
  const { destination, hosting, invalid } = props;
  const provider = hosting.provider === 'cloudflare-workers' ? 'cloudflare' : hosting.provider;
  const marked = invalid === 'cloudflareAccount' || invalid === 'hostingProject' || invalid === 'vercelOrganization' ? invalid : undefined;
  const change = (next: Hosting) => {
    if (next.provider !== 'none') {
      props.change({ ...destination, target: { kind: 'host', hosting: next } });
    }
  };
  return (
    <PublishInvalidFieldContext.Provider value={marked}>
      <PublishConnections key={provider} projectPath={props.projectPath} provider={provider} value={hosting} change={change} workerSetup="on-first-deploy" />
    </PublishInvalidFieldContext.Provider>
  );
}

const SEPARATE_WORKER = 'separate';

function WorkerFields(props: Props & { readonly target: Extract<DestinationTarget, { kind: 'cloudflare-environment' | 'cloudflare-worker' }> }) {
  const translate = useTranslate();
  const { destination, change, target, production, invalid } = props;
  const detected = props.info?.environments ?? [];
  const chosen = target.kind === 'cloudflare-environment' ? target.environment : undefined;
  const names = detected.map((entry) => entry.name);
  const listed = chosen === undefined || chosen === '' || names.includes(chosen) ? names : [...names, chosen];
  const project = production.hosting.provider === 'cloudflare-workers' ? production.hosting.project : '';
  return (
    <>
      <div className="publish-field">
        <FieldLabel label={translate('publish.destination.environment')} />
        <Dropdown<string>
          ariaLabel={translate('publish.destination.environment')}
          value={target.kind === 'cloudflare-worker' ? SEPARATE_WORKER : `env:${target.environment}`}
          options={[
            ...listed.map((name) => {
              const worker = detected.find((entry) => entry.name === name)?.worker;
              return { value: `env:${name}`, label: name, ...(worker === undefined ? {} : { description: worker }) };
            }),
            { value: SEPARATE_WORKER, label: translate('publish.destination.separateWorker') },
          ]}
          placeholder={props.info === undefined ? translate('publish.common.loading') : ''}
          invalid={invalid === 'environment'}
          menuClassName="publish-dropdown"
          livePreview={false}
          onChange={(value) => {
            const next: DestinationTarget =
              value === SEPARATE_WORKER
                ? { kind: 'cloudflare-worker', project: suggestedWorkerName(project, destinationSlug(destination.label)) }
                : { kind: 'cloudflare-environment', environment: value.slice('env:'.length) };
            change(withDetectedSite(destination, next, props.info));
          }}
        />
      </div>
      {target.kind === 'cloudflare-worker' && production.hosting.provider === 'cloudflare-workers' && production.hosting.accountId !== '' && (
        <DestinationWorkerField
          projectPath={props.projectPath}
          accountId={production.hosting.accountId}
          productionWorker={project}
          value={target.project}
          invalid={invalid === 'worker'}
          change={(name) => change({ ...destination, target: { ...target, project: name } })}
        />
      )}
    </>
  );
}

// An address that came from the previous environment's domain follows the choice; one the person typed stays.
function withDetectedSite(destination: Destination, target: DestinationTarget, info: CustomHostInfo | undefined): Destination {
  const siteOf = (of: DestinationTarget) =>
    of.kind === 'cloudflare-environment' ? info?.environments.find((entry) => entry.name === of.environment)?.siteUrl : undefined;
  const { siteUrl, ...rest } = destination;
  const typed = siteUrl !== undefined && siteUrl !== siteOf(destination.target) ? siteUrl : undefined;
  const next = typed ?? siteOf(target);
  return { ...rest, target, ...(next === undefined ? {} : { siteUrl: next }) };
}

const CUSTOM_KINDS = ['github-branch', 'script', 'link'] as const;
type CustomKind = (typeof CUSTOM_KINDS)[number];

const CUSTOM_LABELS = {
  'github-branch': 'publish.destination.mode.githubBranch',
  script: 'publish.custom.mode.script',
  link: 'publish.custom.mode.link',
} as const satisfies Record<CustomKind, MessageKey>;

function CustomFields(props: Props & { readonly target: Extract<DestinationTarget, { kind: CustomKind }> }) {
  const translate = useTranslate();
  const { destination, change, target, invalid, info } = props;
  const link = info === undefined ? undefined : (info.links.destinations[destination.id] ?? info.links.unsaved);
  return (
    <>
      <div className="publish-field">
        <FieldLabel label={translate('publish.destination.mode')} />
        <Dropdown<CustomKind>
          ariaLabel={translate('publish.destination.mode')}
          value={target.kind}
          options={CUSTOM_KINDS.map((kind) => ({ value: kind, label: translate(CUSTOM_LABELS[kind]) }))}
          menuClassName="publish-dropdown"
          livePreview={false}
          onChange={(kind) => change({ ...destination, target: customTarget(kind, target, destination, info?.scripts ?? []) })}
        />
      </div>
      {target.kind === 'script' ? (
        <ScriptDropdown
          label={translate('publish.custom.script')}
          value={target.script}
          scripts={info?.scripts}
          placeholder={translate('publish.custom.chooseScript')}
          invalid={invalid === 'script'}
          change={(script) => change({ ...destination, target: { kind: 'script', script } })}
        />
      ) : (
        <TextField
          label={translate('publish.destination.branch')}
          value={target.branch}
          maxLength={DESTINATION_LIMITS.branchCharsMax}
          invalid={invalid === 'branch'}
          change={(branch) => change({ ...destination, target: { ...target, branch } })}
        />
      )}
      {target.kind === 'link' && <PublishDeployLinkField state={link} draft={props.draft} change={props.changeDraft} remove={props.removeLink} />}
    </>
  );
}

/** A script is preselected only when one is named for this destination. A branch carries over. */
function customTarget(kind: CustomKind, previous: DestinationTarget, destination: Destination, scripts: readonly string[]): DestinationTarget {
  const slug = destinationSlug(destination.label);
  if (kind === 'script') {
    const named = `deploy:${slug}`;
    return { kind, script: scripts.includes(named) ? named : '' };
  }
  const branch = previous.kind === 'github-branch' || previous.kind === 'link' ? previous.branch : slug;
  return { kind, branch };
}
