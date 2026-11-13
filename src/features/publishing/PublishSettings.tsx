import { usePublishSettingsConfig } from './usePublishSettingsConfig';
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
import { useEffect, useState } from 'react';
import { readMetadata, writeMetadata } from '../../ipc/projectMetadataBridge';
import { DEFAULT_PUBLISH_CONFIG, parsePublishConfig, parsePublishSource, type PublishConfig, type Hosting } from '../../../shared/properties/publishConfig';
import { cleanError } from '../../lib/cleanError';
import { useTranslate, useTranslateDescribed } from '../../lib/i18n/useTranslate';
import type { Translator } from '../../../shared/properties/i18n/messageRef';

interface Props {
  readonly projectPath: string;
  readonly close: () => void;
}
type SettingsState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'ready'; readonly base: string | undefined; readonly config: PublishConfig };

export function PublishSettings(props: Props) {
  const translate = useTranslate();
  const [state, setState] = useState<SettingsState>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    void readMetadata(props.projectPath, 'publish')
      .then((file) => {
        const config = parsePublishSource(file.source);
        if (active) {
          setState({ kind: 'ready', base: file.source, config });
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
  const [repository, setRepository] = useState<Extract<RepositoryRequest, { action: 'connect' }>>();
  const [repositoryBusy, setRepositoryBusy] = useState(false);
  const { error, saving, save } = usePublishSettingsSave({
    projectPath,
    config,
    base: stored.base,
    repository,
    close,
    translate,
  });
  return (
    <>
      <div className="publish-settings-scroll">
        <fieldset className="modal-body publish-fields" disabled={saving || repositoryBusy}>
          <PublishTargetField config={config} setConfig={setConfig} />
          <section className="publish-settings-section" aria-label="GitHub" /* i18n-ignore: product name. */>
            <PublishWorkflow config={config} change={setConfig} />
            <PublishConnections
              projectPath={projectPath}
              provider="github"
              value={config.githubAccount}
              change={(githubAccount) => setConfig({ ...config, githubAccount })}
            />
            <PublishRepositories
              key={config.githubAccount}
              projectPath={projectPath}
              account={config.githubAccount}
              selection={repository}
              change={setRepository}
              busy={setRepositoryBusy}
            />
          </section>
          <section className="publish-settings-section" aria-label={translate('publish.settings.hosting')}>
            <HostingFields projectPath={projectPath} hosting={config.hosting} discoveringHosting={discoveringHosting} change={changeHosting} />
            <PublishedSiteField config={config} change={setConfig} />
          </section>
          <AdvancedFields config={config} setConfig={setConfig} />
          {error && <ErrorToast message={error} />}
        </fieldset>
      </div>
      <SettingsFooter busy={saving || repositoryBusy} discoveringHosting={discoveringHosting} saving={saving} close={close} save={save} />
    </>
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
  const lastEnabled = config.defaultTarget === target;
  return (
    <label className="publish-target-card" title={lastEnabled ? translate('publish.settings.keepOneDestination') : undefined}>
      {target === 'github' ? <PublishProviderIcon provider="github" /> : <UploadCloudIcon />}
      <span>{target === 'github' ? 'GitHub' /* i18n-ignore: product name. */ : translate('publish.settings.hosting')}</span>
      <input
        className="publish-target-switch"
        type="checkbox"
        role="switch"
        checked={config.defaultTarget !== other}
        disabled={lastEnabled}
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
  close,
  translate,
}: {
  readonly translate: Translator;
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
    setSaving(true);
    try {
      const validated = validateSettings(config, translate);
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
      close();
    } catch (failure: unknown) {
      setError(cleanError(failure));
    } finally {
      setSaving(false);
    }
  }
  return { error, saving, save };
}

function HostingFields({
  projectPath,
  hosting,
  discoveringHosting,
  change,
}: {
  readonly projectPath: string;
  readonly hosting: Hosting;
  readonly discoveringHosting: boolean;
  readonly change: (value: Hosting) => void;
}) {
  const translate = useTranslate();
  return (
    <>
      <div className="publish-field" aria-busy={discoveringHosting}>
        <span className="publish-label">{translate('publish.settings.provider')}</span>
        <Dropdown<Hosting['provider'] | undefined>
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
          ]}
          menuClassName="publish-dropdown"
          livePreview={false}
          value={discoveringHosting ? undefined : hosting.provider === 'cloudflare-workers' ? 'cloudflare' : hosting.provider}
          onChange={(provider) => {
            if (provider !== undefined) {
              change(emptyHosting(provider));
            }
          }}
        />
      </div>
      {hosting.provider === 'none' ? (
        <div className="publish-field">
          <span className="publish-label">{translate('publish.hosting.project')}</span>
          <button className="dd-trigger" aria-label={translate('publish.hosting.project')} disabled>
            <span className="dd-label dim">{translate('publish.settings.chooseProviderFirst')}</span>
          </button>
        </div>
      ) : (
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

function TextField({ label, value, change }: { readonly label: string; readonly value: string; readonly change: (value: string) => void }) {
  return (
    <label>
      {label}
      <input value={value} maxLength={256} onChange={(event) => change(event.target.value)} />
    </label>
  );
}

function ScriptField({
  label,
  values,
  change,
}: {
  readonly label: string;
  readonly values: readonly string[];
  readonly change: (values: readonly string[]) => void;
}) {
  const [draft, setDraft] = useState(values.join(', '));
  return (
    <label>
      {label}
      <input
        value={draft}
        maxLength={808}
        onChange={(event) => {
          const value = event.target.value;
          setDraft(value);
          change(
            value
              .split(',')
              .map((entry) => entry.trim())
              .filter(Boolean),
          );
        }}
      />
    </label>
  );
}

function AdvancedFields({ config, setConfig }: { readonly config: PublishConfig; readonly setConfig: (config: PublishConfig) => void }) {
  const translate = useTranslate();
  return (
    <details className="publish-advanced">
      <summary>{translate('publish.common.advanced')}</summary>
      <div className="publish-advanced-fields">
        <ManualHosting hosting={config.hosting} change={(hosting) => setConfig({ ...config, hosting })} />
        <TextField
          label={translate('publish.settings.advanced.buildScript')}
          value={config.buildScript}
          change={(buildScript) => setConfig({ ...config, buildScript })}
        />
        <ScriptField
          label={translate('publish.settings.advanced.beforePublish')}
          values={config.beforePublish}
          change={(beforePublish) => setConfig({ ...config, beforePublish })}
        />
        <ScriptField
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
  }
}

function validateSettings(config: PublishConfig, translate: Translator): PublishConfig {
  if (config.hosting.provider === 'cloudflare-workers' && !config.hosting.accountId) {
    throw new Error(translate('publish.settings.chooseWorker'));
  }
  const saved = config.publishedSite;
  return parsePublishConfig(saved === undefined ? config : { ...config, publishedSite: { ...saved, url: saved.url.trim().replace(/\/$/, '') } });
}
