// The staging destination in Publish settings. Absent, it is one quiet "Add staging" button. Present, it asks only
// where staging goes, preselected from what the project already declares; everything else waits under More options.
import {
  DESTINATION_LIMITS,
  stagingBuildsLocally,
  stagingWorkerName,
  type Destination,
  type StagingKind,
  type StagingTarget,
} from '../../../shared/properties/publishDestinations';
import { PUBLISH_LIMITS, type PublishConfig } from '../../../shared/properties/publishConfig';
import type { MissingStagingField } from '../../../shared/properties/publishMissing';
import Dropdown from '../../ui/Dropdown';
import { PlusIcon } from '../../ui/Icons';
import { useTranslate } from '../../lib/i18n/useTranslate';
import { FieldLabel, MoreOptions, ScriptDropdown, ScriptListField, TextField } from './publishFields';
import { PublishDeployLinkField } from './PublishDeployLinkField';
import type { CustomHostInfo, LinkDraft } from './useCustomHostInfo';
import type { MessageKey } from '../../../shared/properties/i18n/messageRef';

/** Whether this host can publish to staging, or why the controls are not offered. */
export type StagingAccess = 'supported' | 'desktop-only' | 'unreadable';

interface Props {
  readonly access: StagingAccess;
  readonly production: PublishConfig;
  readonly staging: Destination | undefined;
  readonly add: () => void;
  readonly remove: () => void;
  readonly change: (staging: Destination) => void;
  /** Staging borrows production's host, or moves to one of its own. */
  readonly changeHost: (host: 'same' | 'custom') => void;
  readonly info: CustomHostInfo | undefined;
  readonly draft: LinkDraft;
  readonly changeDraft: (draft: LinkDraft) => void;
  readonly removeLink: () => void;
  readonly invalid: MissingStagingField | undefined;
}

const HINTS = {
  'cloudflare-environment': 'publish.staging.hint.cloudflareEnvironment',
  'cloudflare-worker': 'publish.staging.hint.cloudflareWorker',
  'cloudflare-pages': 'publish.staging.hint.pages',
  vercel: 'publish.staging.hint.vercel',
  netlify: 'publish.staging.hint.netlify',
  'github-branch': 'publish.staging.hint.githubBranch',
  script: 'publish.staging.hint.script',
  link: 'publish.staging.hint.link',
} as const satisfies Record<StagingKind, MessageKey>;

const OWN_HOST_KINDS = ['github-branch', 'script', 'link'] as const;
type OwnHostKind = (typeof OWN_HOST_KINDS)[number];

const OWN_HOST_LABELS = {
  'github-branch': 'publish.staging.mode.githubBranch',
  script: 'publish.custom.mode.script',
  link: 'publish.custom.mode.link',
} as const satisfies Record<OwnHostKind, MessageKey>;

function isOwnHost(kind: StagingKind): kind is OwnHostKind {
  return OWN_HOST_KINDS.some((entry) => entry === kind);
}

export function PublishStaging(props: Props) {
  const translate = useTranslate();
  const { access, staging } = props;
  const title = translate('publish.staging.title');
  if (access !== 'supported') {
    // Where staging cannot be edited, an existing one is still named, so it is never silently missing.
    return access === 'desktop-only' && staging === undefined ? undefined : (
      <section className="publish-settings-section" aria-label={title}>
        <FieldLabel label={title} hint={translate(access === 'unreadable' ? 'publish.staging.unreadable' : 'publish.staging.desktopOnly')} />
      </section>
    );
  }
  if (staging === undefined) {
    return (
      <button type="button" className="publish-add-staging" onClick={props.add}>
        <PlusIcon size={12} />
        {translate('publish.staging.add')}
      </button>
    );
  }
  return (
    <section className="publish-settings-section" aria-label={title}>
      <div className="publish-field-heading">
        <FieldLabel label={title} hint={translate(HINTS[staging.target.kind])} />
        <button type="button" className="publish-refresh" onClick={props.remove}>
          {translate('publish.staging.remove')}
        </button>
      </div>
      <TargetFields {...props} staging={staging} />
      <StagingExtras {...props} staging={staging} />
    </section>
  );
}

type Present = Props & { readonly staging: Destination };

function TargetFields(props: Present) {
  const translate = useTranslate();
  const { staging, change, invalid } = props;
  const { target } = staging;
  const setTarget = (next: StagingTarget) => change({ ...staging, target: next });
  switch (target.kind) {
    case 'cloudflare-environment':
    case 'cloudflare-worker':
      return <WorkerFields {...props} target={target} />;
    case 'cloudflare-pages':
      return (
        <TextField
          label={translate('publish.staging.pagesBranch')}
          value={target.branch}
          maxLength={DESTINATION_LIMITS.branchCharsMax}
          invalid={invalid === 'stagingBranch'}
          change={(branch) => setTarget({ ...target, branch })}
        />
      );
    case 'netlify':
      return (
        <TextField
          label={translate('publish.staging.alias')}
          value={target.alias}
          maxLength={DESTINATION_LIMITS.netlifyAliasCharsMax}
          invalid={invalid === 'stagingAlias'}
          change={(alias) => setTarget({ ...target, alias })}
        />
      );
    case 'vercel':
      return (
        <div className="publish-field">
          <button type="button" className="dd-trigger" disabled>
            <span className="dd-label">{translate('publish.staging.vercelPreview')}</span>
          </button>
        </div>
      );
    case 'github-branch':
    case 'script':
    case 'link':
      return <OwnHostFields {...props} target={target} />;
    default: {
      const exhaustive: never = target;
      return exhaustive;
    }
  }
}

const SEPARATE_WORKER = 'separate';

function WorkerFields(props: Present & { readonly target: Extract<StagingTarget, { kind: 'cloudflare-environment' | 'cloudflare-worker' }> }) {
  const translate = useTranslate();
  const { staging, change, target, production, invalid } = props;
  const detected = props.info?.environments ?? [];
  const chosen = target.kind === 'cloudflare-environment' ? target.environment : undefined;
  const names = detected.map((entry) => entry.name);
  const listed = chosen === undefined || chosen === '' || names.includes(chosen) ? names : [...names, chosen];
  const project = production.hosting.provider === 'cloudflare-workers' ? production.hosting.project : '';
  return (
    <>
      <div className="publish-field">
        <FieldLabel label={translate('publish.staging.environment')} />
        <Dropdown<string>
          ariaLabel={translate('publish.staging.environment')}
          value={target.kind === 'cloudflare-worker' ? SEPARATE_WORKER : `env:${target.environment}`}
          options={[
            ...listed.map((name) => {
              const worker = detected.find((entry) => entry.name === name)?.worker;
              return { value: `env:${name}`, label: name, ...(worker === undefined ? {} : { description: worker }) };
            }),
            { value: SEPARATE_WORKER, label: translate('publish.staging.separateWorker') },
          ]}
          placeholder={props.info === undefined ? translate('publish.common.loading') : ''}
          invalid={invalid === 'stagingEnvironment'}
          menuClassName="publish-dropdown"
          livePreview={false}
          onChange={(value) => {
            if (value === SEPARATE_WORKER) {
              change(withDetectedSite(staging, { kind: 'cloudflare-worker', project: stagingWorkerName(project) }, props.info));
            } else {
              change(withDetectedSite(staging, { kind: 'cloudflare-environment', environment: value.slice('env:'.length) }, props.info));
            }
          }}
        />
      </div>
      {target.kind === 'cloudflare-worker' && (
        <TextField
          label={translate('publish.staging.workerName')}
          value={target.project}
          maxLength={DESTINATION_LIMITS.workerNameCharsMax}
          invalid={invalid === 'stagingWorker'}
          change={(name) => change({ ...staging, target: { ...target, project: name } })}
        />
      )}
    </>
  );
}

// An address that came from the previous environment's domain follows the choice; one the person typed stays.
function withDetectedSite(staging: Destination, target: StagingTarget, info: CustomHostInfo | undefined): Destination {
  const siteOf = (of: StagingTarget) =>
    of.kind === 'cloudflare-environment' ? info?.environments.find((entry) => entry.name === of.environment)?.siteUrl : undefined;
  const { siteUrl, ...rest } = staging;
  const typed = siteUrl !== undefined && siteUrl !== siteOf(staging.target) ? siteUrl : undefined;
  const next = typed ?? siteOf(target);
  return { ...rest, target, ...(next === undefined ? {} : { siteUrl: next }) };
}

function OwnHostFields(props: Present & { readonly target: Extract<StagingTarget, { kind: OwnHostKind }> }) {
  const translate = useTranslate();
  const { staging, change, target, invalid, info } = props;
  const linksUnsupported = info?.links.staging.kind === 'unsupported';
  return (
    <>
      <div className="publish-field">
        <FieldLabel label={translate('publish.staging.mode')} />
        <Dropdown<OwnHostKind>
          ariaLabel={translate('publish.staging.mode')}
          value={target.kind}
          options={OWN_HOST_KINDS.map((kind) => ({
            value: kind,
            label: translate(OWN_HOST_LABELS[kind]),
            ...(kind === 'link' && linksUnsupported ? { disabled: true, description: translate('publish.custom.link.desktopOnly') } : {}),
          }))}
          menuClassName="publish-dropdown"
          livePreview={false}
          onChange={(kind) => change({ ...staging, target: ownHostTarget(kind, target, info?.scripts ?? []) })}
        />
      </div>
      {target.kind === 'script' ? (
        <ScriptDropdown
          label={translate('publish.custom.script')}
          value={target.script}
          scripts={info?.scripts}
          placeholder={translate('publish.custom.chooseScript')}
          invalid={invalid === 'stagingScript'}
          change={(script) => change({ ...staging, target: { kind: 'script', script } })}
        />
      ) : (
        <TextField
          label={translate('publish.staging.branch')}
          value={target.branch}
          maxLength={DESTINATION_LIMITS.branchCharsMax}
          invalid={invalid === 'stagingBranch'}
          change={(branch) => change({ ...staging, target: { ...target, branch } })}
        />
      )}
      {target.kind === 'link' && (
        <PublishDeployLinkField state={info?.links.staging} draft={props.draft} change={props.changeDraft} remove={props.removeLink} />
      )}
    </>
  );
}

function ownHostTarget(kind: OwnHostKind, previous: StagingTarget, scripts: readonly string[]): StagingTarget {
  if (kind === 'script') {
    return { kind, script: scripts.includes('deploy:staging') ? 'deploy:staging' : '' };
  }
  const branch = previous.kind === 'github-branch' || previous.kind === 'link' ? previous.branch : 'staging';
  return { kind, branch };
}

function StagingExtras(props: Present) {
  const translate = useTranslate();
  const { staging, change, production } = props;
  const set = (key: 'name' | 'siteUrl', value: string) => {
    const { [key]: previous, ...rest } = staging;
    void previous;
    change(value === '' ? rest : { ...rest, [key]: value });
  };
  return (
    <MoreOptions title={translate('publish.staging.more')}>
      {production.hosting.provider !== 'none' && <StagingHost {...props} />}
      <TextField
        label={translate('publish.staging.name')}
        value={staging.name ?? ''}
        placeholder={translate('publish.staging.title')}
        maxLength={PUBLISH_LIMITS.hostNameCharsMax}
        change={(name) => set('name', name)}
      />
      {stagingBuildsLocally(staging.target.kind) && (
        <ScriptDropdown
          label={translate('publish.settings.advanced.buildScript')}
          value={staging.buildScript}
          scripts={props.info?.scripts}
          placeholder={translate('publish.custom.chooseScript')}
          hint={translate('publish.staging.buildScriptHint')}
          change={(buildScript) => change({ ...staging, buildScript })}
        />
      )}
      <TextField
        label={translate('publish.site.label')}
        value={staging.siteUrl ?? ''}
        placeholder="https://example.com"
        maxLength={2048}
        change={(url) => set('siteUrl', url.trim())}
      />
      <ScriptListField
        label={translate('publish.staging.beforePublish')}
        hint={translate('publish.staging.hooksHint')}
        values={staging.beforePublish}
        change={(beforePublish) => change({ ...staging, beforePublish })}
      />
      <ScriptListField
        label={translate('publish.staging.afterPublish')}
        values={staging.afterPublish}
        change={(afterPublish) => change({ ...staging, afterPublish })}
      />
    </MoreOptions>
  );
}

/** Staging uses production's provider and account unless it is moved to a host of its own. */
function StagingHost(props: Present) {
  const translate = useTranslate();
  const { staging } = props;
  const own = isOwnHost(staging.target.kind);
  return (
    <div className="publish-field">
      <FieldLabel label={translate('publish.staging.host')} />
      <Dropdown<'same' | 'custom'>
        ariaLabel={translate('publish.staging.host')}
        value={own ? 'custom' : 'same'}
        options={[
          { value: 'same', label: translate('publish.staging.host.same') },
          { value: 'custom', label: translate('publish.custom.provider') },
        ]}
        menuClassName="publish-dropdown"
        livePreview={false}
        onChange={(host) => {
          if ((host === 'custom') !== own) {
            props.changeHost(host);
          }
        }}
      />
    </div>
  );
}
