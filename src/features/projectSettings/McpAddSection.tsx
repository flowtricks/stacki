// The MCP tab's one add row: a provider dropdown attached to a single input, and an Add button. From a provider: a searchable list of common providers, then a small
// form for what that provider needs (a name, an address variant, and secrets, which are stored by NAME in
// `.env`; `.mcp.json` gets a `${NAME}` reference). From a pasted line: a terminal command, a URL or an `npx`
// line is read as inert text (shared/properties/mcpCommand.ts: nothing is run), shown as a preview of what would
// be added, and written only when the person confirms. The project file is always the target, whatever scope
// the pasted command named.
import { useMemo, useState } from 'react';
import { envValueProblem } from '../../../shared/properties/envFile';
import type { McpListing } from '../../../shared/properties/mcp';
import { isMcpServerName, type McpServerConfig } from '../../../shared/properties/mcpConfig';
import { parseMcpCommand } from '../../../shared/properties/mcpCommand';
import { MCP_PROVIDERS, buildProviderConfig, findMcpProvider, type McpProviderEntry, type McpProviderOptionId } from '../../../shared/properties/mcpProviders';
import { moveLiteralsToSecrets } from '../../../shared/properties/mcpSecrets';
import type { MessageKey } from '../../lib/i18n/localeContext';
import { useTranslate } from '../../lib/i18n/useTranslate';
import Dropdown from '../../ui/Dropdown';
import { ChevronLeftIcon, HideIcon, PreviewIcon } from '../../ui/Icons';
import ProviderLogo from '../../ui/ProviderLogo';
import InfoHint from './InfoHint';
import { addServerWithSecrets, type SecretToStore } from './mcpFlows';
import { PASTE_PROBLEM_KEYS, PROVIDER_PROBLEM_KEYS } from './mcpModel';
import { problemKey } from './secretsModel';

interface AddProps {
  readonly projectPath: string;
  readonly listing: McpListing;
  /** `undefined` when `.env` could not be read: no secret is then known to exist. */
  readonly envNames: ReadonlySet<string> | undefined;
  readonly onAdded: (listing: McpListing) => void;
  readonly onFailure: (messageKey: MessageKey | undefined) => void;
}

const OPTION_LABEL_KEYS: Readonly<Record<McpProviderOptionId, MessageKey>> = {
  url: 'settings.mcp.add.option.url',
  projectRef: 'settings.mcp.add.option.projectRef',
};

/** A server name for a provider: its own name, made valid, and suffixed when the project already has one. */
function nameFor(provider: McpProviderEntry, taken: readonly string[]): string {
  const base = provider.name.replace(/[^A-Za-z0-9_.-]+/g, '-');
  let candidate = base;
  for (let suffix = 2; taken.includes(candidate) && suffix <= taken.length + 2; suffix += 1) {
    candidate = `${base}-${suffix}`;
  }
  return candidate;
}

function ProviderForm({
  provider,
  projectPath,
  listing,
  envNames,
  onAdded,
  onFailure,
  onDone,
}: AddProps & { readonly provider: McpProviderEntry; readonly onDone: () => void }) {
  const translate = useTranslate();
  const taken = listing.servers.map((server) => server.name);
  const [name, setName] = useState(() => nameFor(provider, taken));
  const [optionValues, setOptionValues] = useState<Readonly<Partial<Record<McpProviderOptionId, string>>>>({});
  const [secretValues, setSecretValues] = useState<Readonly<Record<string, string>>>({});
  const [shown, setShown] = useState<ReadonlySet<string>>(new Set());
  const [problem, setProblem] = useState<MessageKey | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    if (busy) {
      return;
    }
    if (!isMcpServerName(name)) {
      setProblem('settings.mcp.error.invalidName');
      return;
    }
    if (taken.includes(name)) {
      setProblem('settings.mcp.error.nameTaken');
      return;
    }
    const toStore: SecretToStore[] = [];
    const sent: string[] = [];
    for (const secret of provider.secrets) {
      const typed = secretValues[secret.name] ?? '';
      const inEnv = envNames?.has(secret.name) === true;
      if (typed.length > 0) {
        if (envValueProblem(typed) !== undefined) {
          setProblem(problemKey('invalid-value'));
          return;
        }
        if (!inEnv) {
          toStore.push({ name: secret.name, value: typed });
        }
        sent.push(secret.name);
      } else if (inEnv) {
        sent.push(secret.name);
      } else if (secret.required) {
        setProblem('settings.mcp.add.secret.required');
        return;
      }
    }
    const built = buildProviderConfig(provider, { options: optionValues, optionalSecrets: sent });
    if (!built.ok) {
      setProblem(PROVIDER_PROBLEM_KEYS[built.error]);
      return;
    }
    setProblem(undefined);
    setBusy(true);
    const result = await addServerWithSecrets(projectPath, listing.revision, name, built.value, toStore);
    setBusy(false);
    if (result.ok) {
      onFailure(undefined);
      onAdded(result.listing);
      onDone();
    } else {
      setProblem(result.messageKey);
    }
  };

  return (
    <div className="mcp-form">
      <div className="mcp-form-head">
        <button
          type="button"
          className="ghost mcp-form-back"
          aria-label={translate('settings.mcp.cancel')}
          title={translate('settings.mcp.cancel')}
          onClick={onDone}
        >
          <ChevronLeftIcon size={14} />
        </button>
        <ProviderLogo id={provider.id} name={provider.name} size={20} />
        <strong className="mcp-form-title">{provider.name}</strong>
        <a className="mcp-docs" href={provider.docsUrl} target="_blank" rel="noreferrer">
          {translate('settings.mcp.add.docs', { name: provider.name })}
        </a>
      </div>
      <label className="mcp-field">
        <span>{translate('settings.mcp.add.name')}</span>
        <input className="secrets-input" value={name} spellCheck={false} autoComplete="off" onChange={(event) => setName(event.target.value)} />
      </label>
      {provider.options.map((option) => (
        <label className="mcp-field" key={option.id}>
          <span>{translate(OPTION_LABEL_KEYS[option.id])}</span>
          <input
            className="secrets-input"
            placeholder={option.example}
            value={optionValues[option.id] ?? ''}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => setOptionValues({ ...optionValues, [option.id]: event.target.value })}
          />
        </label>
      ))}
      {provider.secrets.map((secret) => {
        const inEnv = envNames?.has(secret.name) === true;
        const visible = shown.has(secret.name);
        return (
          <div className="mcp-field" key={secret.name}>
            <span>{translate('settings.mcp.add.secret', { name: secret.name })}</span>
            <div className="mcp-pair mcp-pair-secret">
              <input
                className="secrets-input"
                type={visible ? 'text' : 'password'}
                aria-label={translate('settings.mcp.add.secret', { name: secret.name })}
                placeholder={translate(
                  inEnv ? 'settings.mcp.add.secret.saved' : secret.required ? 'settings.mcp.add.secret.placeholder' : 'settings.mcp.add.secret.optional',
                )}
                value={secretValues[secret.name] ?? ''}
                disabled={inEnv}
                spellCheck={false}
                autoComplete="off"
                onChange={(event) => setSecretValues({ ...secretValues, [secret.name]: event.target.value })}
              />
              <button
                type="button"
                className="ghost"
                aria-pressed={visible}
                aria-label={translate(visible ? 'settings.mcp.value.hide' : 'settings.mcp.value.show', { name: secret.name })}
                title={translate(visible ? 'settings.mcp.value.hide' : 'settings.mcp.value.show', { name: secret.name })}
                onClick={() =>
                  setShown((current) => {
                    const next = new Set(current);
                    if (next.has(secret.name)) {
                      next.delete(secret.name);
                    } else {
                      next.add(secret.name);
                    }
                    return next;
                  })
                }
              >
                {visible ? <HideIcon size={14} /> : <PreviewIcon size={14} />}
              </button>
            </div>
            <span className="secrets-hint">{translate('settings.mcp.add.secret.note')}</span>
          </div>
        );
      })}
      {problem !== undefined && (
        <span className="secrets-hint secrets-problem" role="alert">
          {translate(problem)}
        </span>
      )}
      <div className="mcp-form-actions">
        <button type="button" className="primary" disabled={busy} onClick={() => void submit()}>
          {translate('settings.mcp.add.submit')}
        </button>
      </div>
    </div>
  );
}

export function AddServer(props: AddProps) {
  const [providerId, setProviderId] = useState<string | undefined>(undefined);
  const provider = providerId === undefined ? undefined : findMcpProvider(providerId);
  if (provider === undefined) {
    return <PasteRow {...props} onPick={setProviderId} />;
  }
  return <ProviderForm key={provider.id} {...props} provider={provider} onDone={() => setProviderId(undefined)} />;
}

function PasteRow({ projectPath, listing, envNames, onAdded, onFailure, onPick }: AddProps & { readonly onPick: (providerId: string | undefined) => void }) {
  const translate = useTranslate();
  const [pasted, setPasted] = useState('');
  const [nameOverride, setNameOverride] = useState<string | undefined>(undefined);
  const [problem, setProblem] = useState<MessageKey | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const parsed = useMemo(() => (pasted.trim().length === 0 ? undefined : parseMcpCommand(pasted)), [pasted]);
  const name = nameOverride ?? (parsed?.ok === true ? parsed.value.name : '');
  const taken = listing.servers.map((server) => server.name);
  const plan = useMemo(
    () => (parsed?.ok === true ? moveLiteralsToSecrets(name.length > 0 ? name : 'server', parsed.value.config, envNames ?? new Set()) : undefined),
    [parsed, name, envNames],
  );

  const confirm = async (): Promise<void> => {
    if (parsed?.ok !== true || plan === undefined || busy) {
      return;
    }
    if (!isMcpServerName(name)) {
      setProblem('settings.mcp.error.invalidName');
      return;
    }
    if (taken.includes(name)) {
      setProblem('settings.mcp.error.nameTaken');
      return;
    }
    setProblem(undefined);
    setBusy(true);
    const result = await addServerWithSecrets(projectPath, listing.revision, name, plan.config, plan.secrets);
    setBusy(false);
    if (result.ok) {
      onFailure(undefined);
      onAdded(result.listing);
      setPasted('');
      setNameOverride(undefined);
    } else {
      setProblem(result.messageKey);
    }
  };

  const options = useMemo(
    () =>
      MCP_PROVIDERS.map((entry) => ({
        value: entry.id,
        label: entry.name,
        icon: <ProviderLogo id={entry.id} name={entry.name} size={18} />,
        keywords: `${entry.transport} ${entry.id}`,
      })),
    [],
  );
  return (
    <div className="mcp-add-block">
      <div className="mcp-add" role="group" aria-label={translate('settings.mcp.add.title')}>
        <Dropdown<string | undefined>
          className="mcp-add-provider"
          ariaLabel={translate('settings.mcp.add.provider.label')}
          value={undefined}
          placeholder={translate('settings.mcp.add.provider.placeholder')}
          searchable
          searchPlaceholder={translate('settings.mcp.add.provider.search')}
          options={options}
          onChange={(next) => {
            onPick(next);
            onFailure(undefined);
          }}
        />
        <input
          id="mcp-paste"
          className="mcp-add-input"
          aria-label={translate('settings.mcp.custom.label')}
          placeholder={translate('settings.mcp.add.paste.placeholder')}
          value={pasted}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => {
            setPasted(event.target.value);
            setNameOverride(undefined);
            setProblem(undefined);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              void confirm();
            }
          }}
        />
        <InfoHint text={translate('settings.mcp.custom.hint')} />
        <button type="button" className="primary mcp-add-button" disabled={busy || parsed?.ok !== true} onClick={() => void confirm()}>
          {translate('settings.mcp.add.submit')}
        </button>
      </div>
      {parsed?.ok === false && (
        <span className="secrets-hint secrets-problem" role="alert">
          {translate(PASTE_PROBLEM_KEYS[parsed.error.code], { detail: parsed.error.detail ?? '' })}
        </span>
      )}
      {parsed?.ok === true && plan !== undefined && (
        <div className="mcp-preview">
          <ProviderLogo id={MCP_PROVIDERS.find((entry) => entry.id === name.toLowerCase())?.id} name={name.length > 0 ? name : '?'} size={20} />
          <p className="mcp-preview-line">
            {translate('settings.mcp.custom.preview', {
              name: name.length > 0 ? name : '…',
              kind: kindWords(translate, parsed.value.config),
              target: targetOf(parsed.value.config),
            })}
          </p>
          <label className="mcp-field">
            <span>{translate('settings.mcp.custom.name')}</span>
            <input className="secrets-input" value={name} spellCheck={false} autoComplete="off" onChange={(event) => setNameOverride(event.target.value)} />
          </label>
          {parsed.value.scope !== undefined && parsed.value.scope !== 'project' && (
            <p className="secrets-hint">{translate(parsed.value.scope === 'user' ? 'settings.mcp.custom.scopeUser' : 'settings.mcp.custom.scopeLocal')}</p>
          )}
          {plan.secrets.length > 0 && (
            <p className="secrets-hint">{translate('settings.mcp.custom.moves', { names: plan.secrets.map((secret) => secret.name).join(', ') })}</p>
          )}
          {plan.leftLiteral.length > 0 && (
            <p className="secrets-hint">{translate('settings.mcp.custom.leftLiteral', { names: plan.leftLiteral.join(', ') })}</p>
          )}
          {problem !== undefined && (
            <span className="secrets-hint secrets-problem" role="alert">
              {translate(problem)}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function kindWords(translate: ReturnType<typeof useTranslate>, config: McpServerConfig): string {
  if (config.transport === 'stdio') {
    return translate('settings.mcp.kind.command');
  }
  return translate(config.transport === 'sse' ? 'settings.mcp.kind.remoteSse' : 'settings.mcp.kind.remote');
}

// The address or command line as pasted, minus any header or variable values, which the preview never prints.
function targetOf(config: McpServerConfig): string {
  return config.transport === 'stdio' ? [config.command, ...config.args].join(' ') : config.url;
}
