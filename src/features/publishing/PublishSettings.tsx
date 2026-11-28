import { usePublishSettingsConfig } from './usePublishSettingsConfig';
import { PublishCustomFields } from './PublishCustomFields';
import { PublishStaging } from './PublishStaging';
import { ScriptListField, TextField } from './publishFields';
import { useCustomHostInfo } from './useCustomHostInfo';
import { readStoredDestinations, useStagingDefaults, useStagingSettings, type StoredDestinations } from './useStagingSettings';
import { NO_LINK_DRAFTS, saveDeployLinks, settingsRefusal, type LinkDrafts } from './saveDeployLinks';
import { findMissingStagingField, type MissingStagingField } from '../../../shared/properties/publishMissing';
import type { Destination } from '../../../shared/properties/publishDestinations';
import { PublishedSiteField } from './PublishedSiteField';
import { PublishWorkflow } from './PublishWorkflow';
import { ErrorToast } from '../../ui/ErrorToast';
import { PublishRepositories } from './PublishRepositories';
import { publishingRepositories } from '../../ipc/publishRepositoryBridge';
import type { RepositoryRequest } from '../../../shared/ipc/publishRepository';
import Popup from '../../ui/Popup';
import Dropdown from '../../ui/Dropdown';
import { PublishProviderIcon } from './PublishProviderIcon';
import { UploadCloudIcon } from '../../ui/Icons';
import { PublishConnections } from './PublishConnections';
import { useEffect, useRef, useState } from 'react';
import { readMetadata, writeMetadata } from '../../ipc/projectMetadataBridge';
import {
  DEFAULT_PUBLISH_CONFIG,
  parsePublishConfig,
  parsePublishSource,
  publishDefaultTarget,
  type PublishConfig,
  type Hosting,
} from '../../../shared/properties/publishConfig';
import { findMissingPublishField, type MissingPublishField } from '../../../shared/properties/publishMissing';
import { PublishInvalidFieldContext } from './publishInvalidField';
import { PublishSettingsRebaseContext } from './setUpWorker';
import { reportErrorToast } from '../../ui/errorNotices';
import { cleanError } from '../../lib/cleanError';
import { useTranslate, useTranslateDescribed } from '../../lib/i18n/useTranslate';
import type { MessageKey, Translator } from '../../../shared/properties/i18n/messageRef';

interface Props {
  readonly projectPath: string;
  readonly close: () => void;
}
type SettingsState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'ready'; readonly base: string | undefined; readonly config: PublishConfig; readonly destinations: StoredDestinations };

export function PublishSettings(props: Props) {
  const translate = useTranslate();
  const [state, setState] = useState<SettingsState>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    void Promise.all([readMetadata(props.projectPath, 'publish'), readStoredDestinations(props.projectPath)])
      .then(([file, destinations]) => {
        const config = parsePublishSource(file.source);
        if (active) {
          setState({ kind: 'ready', base: file.source, config, destinations });
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setState({ kind: 'error', message: cleanError(error) });
        }
      });
    return () => {
      active = false;
    };
  }, [props.projectPath, attempt]);
  return (
    <Popup className="modal publish-settings" label={translate('publish.settings.title')} onClose={props.close} dismissible={true}>
      {({ close }) => (
        <>
          <div className="modal-header" aria-busy={state.kind === 'loading'}>
            {translate('publish.settings.title')}
          </div>
          <span className="publish-settings-loading mini-spinner" role="status" aria-label={translate('publish.settings.loadingLabel')} />
          {state.kind === 'ready' ? (
            <PublishSettingsForm key={props.projectPath} {...props} close={close} stored={state} />
          ) : state.kind === 'loading' ? (
            <PublishSettingsSkeleton close={close} />
          ) : (
            <div className="modal-body publish-fields publish-settings-scroll">
              <ErrorToast message={settingsErrorMessage(state.message, translate)} />
              <button
                onClick={() => {
                  setState({ kind: 'loading' });
                  setAttempt((value) => value + 1);
                }}
              >
                {translate('publish.common.tryAgain')}
              </button>
              <button onClick={close}>{translate('ui.close')}</button>
            </div>
          )}
        </>
      )}
    </Popup>
  );
}

function PublishSettingsSkeleton({ close }: Pick<Props, 'close'>) {
  const translate = useTranslate();
  return (
    <>
      <div className="publish-settings-scroll">
        <fieldset className="modal-body publish-fields" disabled aria-busy="true" data-loading="true">
          {[
            { name: translate('publish.settings.publishButton'), labels: [translate('publish.settings.targetAction')] },
            { name: 'GitHub', labels: [translate('publish.common.githubAccount'), translate('publish.repositories.title')] }, // i18n-ignore: product name.
            { name: translate('publish.settings.hosting'), labels: [translate('publish.settings.provider'), translate('publish.hosting.project')] },
          ].map((section) => (
            <section className="publish-settings-section" aria-label={section.name} key={section.name}>
              {section.labels.map((label) => (
                <div className="publish-field" key={label}>
                  <span className="publish-label">{label}</span>
                  <button className="dd-trigger" aria-label={label} disabled>
                    <span className="dd-label">{translate('publish.common.loading')}</span>
                  </button>
                </div>
              ))}
            </section>
          ))}
          <details className="publish-advanced">
            <summary aria-disabled="true" onClick={(event) => event.preventDefault()}>
              {translate('publish.common.advanced')}
            </summary>
          </details>
        </fieldset>
      </div>
      <div className="modal-footer">
        <button onClick={close}>{translate('ui.cancel')}</button>
        <button className="primary" disabled>
          {translate('publish.common.save')}
        </button>
      </div>
    </>
  );
}

function settingsErrorMessage(message: string, translate: Translator): string {
  if (message.includes('No handler registered')) {
    return translate('publish.settings.reloadNeeded');
  }
  return message;
}
function PublishSettingsForm({
  projectPath,
  close,
  stored,
}: Props & {
  readonly stored: Extract<SettingsState, { kind: 'ready' }>;
}) {
  const translate = useTranslate();
  const { config, changeConfig: setConfig, changeHosting, discoveringHosting } = usePublishSettingsConfig(projectPath, stored);
  const staging = useStagingSettings(stored.destinations);
  const [drafts, setDrafts] = useState<LinkDrafts>(NO_LINK_DRAFTS);
  const { info, removeLink } = useCustomHostInfo(projectPath, {
    needed: config.customHosting !== undefined || staging.staging !== undefined,
  });
  const stagingDefaults = useStagingDefaults(config, staging, info);
  const [repository, setRepository] = useState<Extract<RepositoryRequest, { action: 'connect' }>>();
  const [repositoryBusy, setRepositoryBusy] = useState(false);
  const scroll = useRef<HTMLDivElement>(null);
  const [refused, setRefused] = useState<{ readonly field: MissingSettingsField; readonly attempt: number }>();
  const { error, saving, save, rebase } = usePublishSettingsSave({
    projectPath,
    config,
    base: stored.base,
    repository,
    staging,
    drafts,
    close,
    translate,
    refuse: (field) => setRefused({ field, attempt: (refused?.attempt ?? 0) + 1 }),
  });
  // The mark clears itself: it shows only while the refused field is still the first one missing.
  const missing = findMissingSettingsField(config, staging.staging);
  const invalidField = refused !== undefined && missing === refused.field ? refused.field : undefined;
  useEffect(() => {
    // Each refused Save brings the empty field into view, even when it was already marked.
    if (refused !== undefined) {
      const target = scroll.current?.querySelector<HTMLElement>('[aria-invalid="true"]');
      target?.scrollIntoView({ block: 'center' });
      target?.focus();
    }
  }, [refused]);
  return (
    <PublishInvalidFieldContext.Provider value={isStagingField(invalidField) ? undefined : invalidField}>
      <PublishSettingsRebaseContext.Provider value={rebase}>
        <div className="publish-settings-scroll" ref={scroll}>
          <fieldset className="modal-body publish-fields" disabled={saving || repositoryBusy}>
            <PublishTargetField config={config} setConfig={setConfig} />
            <section className="publish-settings-section" aria-label="GitHub" /* i18n-ignore: product name. */>
              <PublishWorkflow config={config} change={setConfig} />
              <PublishConnections
                projectPath={projectPath}
                provider="github"
                value={config.githubAccount}
                change={(githubAccount) => setConfig({ ...config, githubAccount })}
              >
                {config.githubAccount !== '' && (
                  <PublishRepositories
                    key={config.githubAccount}
                    projectPath={projectPath}
                    account={config.githubAccount}
                    selection={repository}
                    change={setRepository}
                    busy={setRepositoryBusy}
                  />
                )}
              </PublishConnections>
            </section>
            <section className="publish-settings-section" aria-label={translate('publish.settings.hosting')}>
              <HostingFields
                projectPath={projectPath}
                config={config}
                discoveringHosting={discoveringHosting}
                change={changeHosting}
                changeConfig={setConfig}
              />
              {config.customHosting === undefined ? (
                <PublishedSiteField config={config} change={setConfig} />
              ) : (
                <PublishCustomFields
                  config={config}
                  custom={config.customHosting}
                  change={setConfig}
                  info={info}
                  draft={drafts.production}
                  changeDraft={(production) => setDrafts({ ...drafts, production })}
                  removeLink={() => void removeLink('production')}
                />
              )}
            </section>
            <PublishStaging
              projectPath={projectPath}
              access={staging.access}
              production={config}
              staging={staging.staging}
              add={stagingDefaults.add}
              remove={stagingDefaults.remove}
              change={staging.change}
              changeHost={stagingDefaults.changeHost}
              info={info}
              draft={drafts.staging}
              changeDraft={(draft) => setDrafts({ ...drafts, staging: draft })}
              removeLink={() => void removeLink('staging')}
              invalid={isStagingField(invalidField) ? invalidField : undefined}
            />
            {config.customHosting?.deploy !== 'github' && <AdvancedFields config={config} setConfig={setConfig} />}
            {error && <ErrorToast message={error} />}
          </fieldset>
        </div>
        <SettingsFooter busy={saving || repositoryBusy} discoveringHosting={discoveringHosting} saving={saving} close={close} save={save} />
      </PublishSettingsRebaseContext.Provider>
    </PublishInvalidFieldContext.Provider>
  );
}

function PublishTargetField({ config, setConfig }: { readonly config: PublishConfig; readonly setConfig: (config: PublishConfig) => void }) {
  const translate = useTranslate();
  return (
    <section className="publish-settings-section" aria-label={translate('publish.settings.publishButton')}>
      <div className="publish-field">
        <span className="publish-label">{translate('publish.settings.targetAction')}</span>
        <div className="publish-target-cards">
          <PublishTargetToggle target="github" config={config} setConfig={setConfig} />
          <PublishTargetToggle target="hosting" config={config} setConfig={setConfig} />
        </div>
      </div>
    </section>
  );
}

function PublishTargetToggle({
  target,
  config,
  setConfig,
}: {
  readonly target: 'github' | 'hosting';
  readonly config: PublishConfig;
  readonly setConfig: (config: PublishConfig) => void;
}) {
  const translate = useTranslate();
  const other = target === 'github' ? 'hosting' : 'github';
  const fromGitHub = config.customHosting?.deploy === 'github';
  const enabled = publishDefaultTarget(config);
  const lastEnabled = enabled === target;
  const why = fromGitHub ? 'publish.custom.targetAuto' : lastEnabled ? 'publish.settings.keepOneDestination' : undefined;
  return (
    <label className="publish-target-card" title={why === undefined ? undefined : translate(why)}>
      {target === 'github' ? <PublishProviderIcon provider="github" /> : <UploadCloudIcon />}
      <span>{target === 'github' ? 'GitHub' /* i18n-ignore: product name. */ : translate('publish.settings.hosting')}</span>
      <input
        className="publish-target-switch"
        type="checkbox"
        role="switch"
        checked={enabled !== other}
        disabled={lastEnabled || fromGitHub}
        onChange={(event) => setConfig({ ...config, defaultTarget: event.currentTarget.checked ? 'all' : other })}
      />
    </label>
  );
}

function usePublishSettingsSave({
  projectPath,
  config,
  base: initialBase,
  repository,
  staging,
  drafts,
  close,
  translate,
  refuse,
}: {
  readonly translate: Translator;
  readonly refuse: (field: MissingSettingsField) => void;
  readonly staging: ReturnType<typeof useStagingSettings>;
  readonly drafts: LinkDrafts;
  readonly projectPath: string;
  readonly config: PublishConfig;
  readonly base: string | undefined;
  readonly repository: Extract<RepositoryRequest, { action: 'connect' }> | undefined;
  readonly close: () => void;
}) {
  const translateDescribed = useTranslateDescribed();
  const [base, setBase] = useState(initialBase);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  async function save() {
    const missing = findMissingSettingsField(config, staging.staging);
    if (missing !== undefined) {
      // Said as a toast (never a paragraph) that names the field; the form marks it and takes the person to it.
      reportErrorToast(translate(MISSING_FIELD_MESSAGES[missing]));
      refuse(missing);
      return;
    }
    setSaving(true);
    try {
      const validated = validateSettings(config);
      // Everything that can be refused is refused before anything is written.
      const refusal = settingsRefusal(validated, staging, drafts);
      if (refusal !== undefined) {
        reportErrorToast(translateDescribed(refusal));
        return;
      }
      await staging.save(projectPath);
      const written = await writeMetadata(projectPath, {
        kind: 'publish',
        source: JSON.stringify(validated, undefined, 2) + '\n',
        ...(base === undefined ? {} : { base }),
      });
      setBase(written.source);
      if (repository?.account === config.githubAccount) {
        const result = await publishingRepositories(projectPath, repository);
        if (!result.ok) {
          setError(translate('publish.settings.savedWithError', { message: translateDescribed({ message: result.error, messageRef: result.errorRef }) }));
          return;
        }
      }
      // Last, because a link is bound to the repository connected above.
      const linkProblem = await saveDeployLinks(projectPath, validated, staging, drafts);
      if (linkProblem !== undefined) {
        setError(translate('publish.settings.savedWithError', { message: translateDescribed(linkProblem) }));
        return;
      }
      close();
    } catch (failure: unknown) {
      setError(cleanError(failure));
    } finally {
      setSaving(false);
    }
  }
  return { error, saving, save, rebase: setBase };
}

function HostingFields({
  projectPath,
  config,
  discoveringHosting,
  change,
  changeConfig,
}: {
  readonly projectPath: string;
  readonly config: PublishConfig;
  readonly discoveringHosting: boolean;
  readonly change: (value: Hosting) => void;
  readonly changeConfig: (config: PublishConfig) => void;
}) {
  const translate = useTranslate();
  const { hosting } = config;
  const custom = config.customHosting !== undefined;
  return (
    <>
      <div className="publish-field" aria-busy={discoveringHosting}>
        <span className="publish-label">{translate('publish.settings.provider')}</span>
        <Dropdown<Hosting['provider'] | 'custom' | undefined>
          ariaLabel={translate('publish.settings.provider')}
          placeholder={translate('publish.settings.providerChecking')}
          options={[
            {
              value: 'none',
              label: translate('publish.settings.noneGitHubOnly'),
              icon: <PublishProviderIcon provider="none" />,
            },
            {
              value: 'cloudflare',
              label: 'Cloudflare', // i18n-ignore: product name.
              icon: <PublishProviderIcon provider="cloudflare" />,
            },
            { value: 'vercel', label: 'Vercel' /* i18n-ignore: product name. */, icon: <PublishProviderIcon provider="vercel" /> },
            { value: 'netlify', label: 'Netlify' /* i18n-ignore: product name. */, icon: <PublishProviderIcon provider="netlify" /> },
            { value: 'custom', label: translate('publish.custom.provider'), icon: <PublishProviderIcon provider="custom" /> },
          ]}
          menuClassName="publish-dropdown"
          livePreview={false}
          value={discoveringHosting ? undefined : custom ? 'custom' : hosting.provider === 'cloudflare-workers' ? 'cloudflare' : hosting.provider}
          onChange={(provider) => {
            if (provider === 'custom') {
              if (!custom) {
                // A new hosting object also ends any hosting discovery still running.
                changeConfig({ ...config, hosting: { provider: 'none' }, customHosting: { deploy: 'github' } });
              }
            } else if (provider !== undefined) {
              change(emptyHosting(provider));
            }
          }}
        />
      </div>
      {custom || hosting.provider === 'none' ? undefined : (
        <PublishConnections
          key={hosting.provider === 'cloudflare-workers' ? 'cloudflare' : hosting.provider}
          projectPath={projectPath}
          provider={hosting.provider === 'cloudflare-workers' ? 'cloudflare' : hosting.provider}
          value={hosting}
          change={change}
        />
      )}
    </>
  );
}

function AdvancedFields({ config, setConfig }: { readonly config: PublishConfig; readonly setConfig: (config: PublishConfig) => void }) {
  const translate = useTranslate();
  return (
    <details className="publish-advanced">
      <summary>{translate('publish.common.advanced')}</summary>
      <div className="publish-advanced-fields">
        <ManualHosting hosting={config.hosting} change={(hosting) => setConfig({ ...config, hosting })} />
        {config.customHosting?.deploy !== 'link' && (
          // A deploy link's host does its own build, so there is no local build to name.
          <TextField
            label={translate('publish.settings.advanced.buildScript')}
            value={config.buildScript}
            change={(buildScript) => setConfig({ ...config, buildScript })}
          />
        )}
        <ScriptListField
          label={translate('publish.settings.advanced.beforePublish')}
          values={config.beforePublish}
          change={(beforePublish) => setConfig({ ...config, beforePublish })}
        />
        <ScriptListField
          label={translate('publish.settings.advanced.afterPublish')}
          values={config.afterPublish}
          change={(afterPublish) => setConfig({ ...config, afterPublish })}
        />
        <p className="hint-text">{translate('publish.settings.advanced.scriptsHint')}</p>
      </div>
    </details>
  );
}

function CloudflareFields({
  hosting,
  change,
}: {
  readonly hosting: Extract<Hosting, { provider: 'cloudflare' }>;
  readonly change: (hosting: Hosting) => void;
}) {
  const translate = useTranslate();
  return (
    <>
      <TextField label={translate('publish.settings.advanced.pagesProject')} value={hosting.project} change={(project) => change({ ...hosting, project })} />
      <TextField label={translate('publish.settings.advanced.productionBranch')} value={hosting.branch} change={(branch) => change({ ...hosting, branch })} />
      <TextField
        label={translate('publish.settings.advanced.outputDirectory')}
        value={hosting.directory}
        change={(directory) => change({ ...hosting, directory })}
      />
    </>
  );
}

function ManualHosting({ hosting, change }: { readonly hosting: Hosting; readonly change: (hosting: Hosting) => void }) {
  const translate = useTranslate();
  return (
    <>
      {hosting.provider === 'cloudflare' && <CloudflareFields hosting={hosting} change={change} />}
      {hosting.provider === 'netlify' && (
        <TextField label={translate('publish.settings.advanced.netlifySite')} value={hosting.siteId} change={(siteId) => change({ ...hosting, siteId })} />
      )}
      {hosting.provider === 'vercel' && (
        <>
          <TextField
            label={translate('publish.settings.advanced.vercelOrganization')}
            value={hosting.organizationId}
            change={(organizationId) => change({ ...hosting, organizationId })}
          />
          <TextField
            label={translate('publish.settings.advanced.vercelProject')}
            value={hosting.projectId}
            change={(projectId) => change({ ...hosting, projectId })}
          />
        </>
      )}
    </>
  );
}

function SettingsFooter({
  busy,
  discoveringHosting,
  saving,
  close,
  save,
}: {
  readonly busy: boolean;
  readonly discoveringHosting: boolean;
  readonly saving: boolean;
  readonly close: () => void;
  readonly save: () => Promise<void>;
}) {
  const translate = useTranslate();
  return (
    <div className="modal-footer">
      <button disabled={busy} onClick={close}>
        {translate('ui.cancel')}
      </button>
      <button className="primary" disabled={busy || discoveringHosting} onClick={() => void save()}>
        {saving ? translate('publish.common.saving') : translate('publish.common.save')}
      </button>
    </div>
  );
}

function emptyHosting(provider: Hosting['provider']): Hosting {
  switch (provider) {
    case 'none':
      return DEFAULT_PUBLISH_CONFIG.hosting;
    case 'cloudflare':
      return { provider, accountId: '', project: '', branch: 'main', directory: 'dist' };
    case 'cloudflare-workers':
      return { provider, accountId: '', project: '' };
    case 'vercel':
      return { provider, organizationId: '', projectId: '' };
    case 'netlify':
      return { provider, siteId: '' };
  }
}

const MISSING_FIELD_MESSAGES = {
  cloudflareAccount: 'publish.settings.missing.cloudflareAccount',
  hostingProject: 'publish.settings.missing.hostingProject',
  vercelOrganization: 'publish.settings.missing.vercelOrganization',
  deployScript: 'publish.settings.missing.deployScript',
  buildScript: 'publish.settings.missing.buildScript',
  stagingEnvironment: 'publish.staging.missing.environment',
  stagingWorker: 'publish.staging.missing.worker',
  stagingBranch: 'publish.staging.missing.branch',
  stagingAlias: 'publish.staging.missing.alias',
  stagingScript: 'publish.staging.missing.script',
} as const satisfies Record<MissingSettingsField, MessageKey>;

type MissingSettingsField = MissingPublishField | MissingStagingField;

function findMissingSettingsField(config: PublishConfig, staging: Destination | undefined): MissingSettingsField | undefined {
  const production = findMissingPublishField(config);
  if (!production.ok) {
    return production.error.field;
  }
  const other = staging === undefined ? undefined : findMissingStagingField(staging);
  return other === undefined || other.ok ? undefined : other.error.field;
}

function isStagingField(field: MissingSettingsField | undefined): field is MissingStagingField {
  return field?.startsWith('staging') === true;
}

function validateSettings(config: PublishConfig): PublishConfig {
  const saved = config.publishedSite;
  const trimmed = (url: string) => url.trim().replace(/\/$/, '');
  const custom = config.customHosting;
  return parsePublishConfig({
    ...config,
    ...(saved === undefined ? {} : { publishedSite: { ...saved, url: trimmed(saved.url) } }),
    ...(custom?.siteUrl === undefined ? {} : { customHosting: { ...custom, siteUrl: trimmed(custom.siteUrl) } }),
  });
}
