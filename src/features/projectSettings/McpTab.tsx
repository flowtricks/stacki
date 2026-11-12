// The Settings panel's MCP tab: the MCP servers of this project (`.mcp.json`, which Claude Code reads) as cards,
// with the agent each is available to, a way to add a server from a provider list or by pasting a command, and a
// JSON view for people who prefer code. Codex keeps its servers in the person's own `~/.codex/config.toml`,
// shared by every project; a card's Codex chip adds or removes that one server there, after a confirmation that
// says so, and servers that are only in Codex are listed with an Add to project button.
//
// Every change names the revision it was authored against; a file that changed on disk is refused and the person
// reloads. The lists reload when the window regains focus. Nothing here runs a command: pasted text is parsed
// as data (shared/properties/mcpCommand.ts).
import { useState } from 'react';
import { err, ok } from '../../../shared/core/result';
import type { McpCodexState, McpListing, McpServerItem } from '../../../shared/properties/mcp';
import { MCP_PROVIDERS } from '../../../shared/properties/mcpProviders';
import { moveLiteralsToSecrets } from '../../../shared/properties/mcpSecrets';
import type { MessageKey } from '../../lib/i18n/localeContext';
import { useTranslate } from '../../lib/i18n/useTranslate';
import { confirmDialog } from '../../ui/ConfirmDialog';
import { ChevronDownIcon, ChevronRightIcon, CodeIcon, PlugIcon } from '../../ui/Icons';
import ProviderLogo from '../../ui/ProviderLogo';
import { SegmentedTabs } from '../../ui/SegmentedTabs';
import InfoHint from './InfoHint';
import McpJsonView from './McpJsonView';
import { AddServer } from './McpAddSection';
import { McpCardsSkeleton } from './McpSkeleton';
import McpServerCard, { type ServerEdit } from './McpServerCard';
import { applyMcpCodexChange, readMcp, readMcpCodex, revealMcpCodexServer, revealMcpServer } from './mcpBridge';
import { addServerWithSecrets, changeServer, envNamesOf } from './mcpFlows';
import { MCP_ERROR_KEYS, PROBLEM_KEYS, configOfDraft, copyText, draftOf, serverLine, type ServerDraft } from './mcpModel';
import { useProjectChannel } from './useProjectChannel';
import './projectSettings.css';
import './mcp.css';

type View = 'ui' | 'json';

function sameListing(current: McpListing, next: McpListing): boolean {
  return current.revision === next.revision;
}

function sameCodex(current: McpCodexState, next: McpCodexState): boolean {
  return current.state === 'ready' && next.state === 'ready' ? current.revision === next.revision : JSON.stringify(current) === JSON.stringify(next);
}

function sameNames(current: ReadonlySet<string>, next: ReadonlySet<string>): boolean {
  return current.size === next.size && [...current].every((name) => next.has(name));
}

export default function McpTab({ projectPath }: { readonly projectPath: string }) {
  const translate = useTranslate();
  const listing = useProjectChannel(projectPath, readMcp, sameListing);
  const codex = useProjectChannel<McpCodexState, undefined>(projectPath, async (path) => ok(await readMcpCodex(path)), sameCodex);
  const env = useProjectChannel<ReadonlySet<string>, undefined>(
    projectPath,
    async (path) => {
      const names = await envNamesOf(path);
      return names === undefined ? err(undefined) : ok(names);
    },
    sameNames,
  );
  const [view, setView] = useState<View>('ui');
  const [jsonDirty, setJsonDirty] = useState(false);
  const [edit, setEdit] = useState<(ServerEdit & { readonly name: string }) | undefined>(undefined);
  const [failure, setFailure] = useState<MessageKey | undefined>(undefined);
  const [notice, setNotice] = useState<MessageKey | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [codexOpen, setCodexOpen] = useState(false);

  if (listing.state.kind === 'loading') {
    return <McpCardsSkeleton />;
  }
  if (listing.state.kind === 'unavailable') {
    // The running app predates the channels: only a restart helps, so no reload is offered.
    return (
      <p className="secrets-note" role="alert">
        {translate('settings.mcp.unavailable')}
      </p>
    );
  }
  const envNames = env.state.kind === 'ready' ? env.state.value : undefined;
  const codexState = codex.state.kind === 'ready' ? codex.state.value : undefined;

  const pick = async (next: View): Promise<void> => {
    if (next === view) {
      return;
    }
    if (view === 'json' && jsonDirty) {
      const confirmed = await confirmDialog({
        title: translate('settings.mcp.json.discard.title'),
        body: translate('settings.mcp.json.discard.body'),
        confirmLabel: translate('settings.mcp.json.discard.confirm'),
        cancelLabel: translate('settings.mcp.json.discard.keep'),
        danger: true,
      });
      if (confirmed !== true) {
        return;
      }
      setJsonDirty(false);
    }
    setFailure(undefined);
    setNotice(undefined);
    setView(next);
  };

  const header = (
    <div className="secrets-head">
      <div className="secrets-heading">
        <h3>
          {translate('settings.mcp.title')}
          <InfoHint text={translate('settings.mcp.info')} />
        </h3>
        <p>{translate('settings.mcp.intro')}</p>
      </div>
      <SegmentedTabs<View>
        label={translate('settings.mcp.view.label')}
        value={view}
        tabs={[
          { value: 'ui', label: translate('settings.mcp.view.ui'), icon: <PlugIcon size={12} /> },
          { value: 'json', label: translate('settings.mcp.view.json'), icon: <CodeIcon size={12} /> },
        ]}
        onPick={(next) => void pick(next)}
      />
    </div>
  );

  if (view === 'json') {
    return (
      <div className="secrets mcp">
        {header}
        <McpJsonView
          projectPath={projectPath}
          onDirtyChange={setJsonDirty}
          onSaved={(saved) => {
            listing.replace(saved);
            env.reload();
          }}
        />
      </div>
    );
  }

  if (listing.state.kind === 'failed') {
    const code = listing.state.error?.code;
    return (
      <div className="secrets mcp">
        {header}
        <div className="secrets-note" role="alert">
          <p>{translate(code === undefined ? 'settings.mcp.error.unreadable' : MCP_ERROR_KEYS[code])}</p>
          <button type="button" className="ghost" onClick={listing.reload}>
            {translate('settings.mcp.reload')}
          </button>
          {code === 'unreadable' && (
            <button type="button" className="ghost" onClick={() => void pick('json')}>
              {translate('settings.mcp.invalid.open')}
            </button>
          )}
        </div>
      </div>
    );
  }
  const { value: current } = listing.state;

  const applied = (next: McpListing): void => {
    listing.replace(next);
    env.reload();
    setNotice(undefined);
  };
  const reveal = async (name: string) => {
    const read = await revealMcpServer(projectPath, current.revision, name);
    if (!read.ok) {
      setFailure(MCP_ERROR_KEYS[read.error.code]);
    }
    return read.ok ? read.value : undefined;
  };

  const startEdit = async (name: string): Promise<void> => {
    setFailure(undefined);
    setEdit({ name, draft: undefined, problem: undefined });
    const config = await reveal(name);
    setEdit(config === undefined ? undefined : { name, draft: draftOf(config), problem: undefined });
  };
  const changeDraft = (draft: ServerDraft): void => setEdit((existing) => (existing === undefined ? existing : { ...existing, draft, problem: undefined }));
  const saveEdit = async (): Promise<void> => {
    if (edit?.draft === undefined || busy) {
      return;
    }
    const built = configOfDraft(edit.draft);
    if (!built.ok) {
      setEdit({ ...edit, problem: { code: built.code, field: built.field } });
      return;
    }
    setBusy(true);
    const result = await changeServer(projectPath, current.revision, { kind: 'update', name: edit.name, config: built.value }, { secretsSaved: false });
    setBusy(false);
    if (result.ok) {
      applied(result.listing);
      setEdit(undefined);
    } else {
      setFailure(result.messageKey);
    }
  };

  const remove = async (name: string): Promise<void> => {
    const confirmed = await confirmDialog({
      title: translate('settings.mcp.remove.title', { name }),
      body: translate('settings.mcp.remove.body'),
      confirmLabel: translate('settings.mcp.remove.confirm'),
      cancelLabel: translate('settings.mcp.cancel'),
      danger: true,
    });
    if (confirmed !== true) {
      return;
    }
    setBusy(true);
    const result = await changeServer(projectPath, current.revision, { kind: 'remove', name }, { secretsSaved: false });
    setBusy(false);
    if (result.ok) {
      applied(result.listing);
    } else {
      setFailure(result.messageKey);
    }
  };

  const copy = async (name: string): Promise<void> => {
    const config = await reveal(name);
    if (config === undefined) {
      return;
    }
    try {
      await navigator.clipboard.writeText(copyText(name, config));
      setNotice('settings.mcp.copied');
    } catch {
      setFailure('settings.mcp.error.copy');
    }
  };

  const toggleCodex = async (name: string): Promise<void> => {
    if (codexState?.state !== 'ready') {
      return;
    }
    const adding = !codexState.servers.some((server) => server.name === name);
    const confirmed = await confirmDialog({
      title: translate(adding ? 'settings.mcp.codex.add.title' : 'settings.mcp.codex.remove.title', { name }),
      body: translate(adding ? 'settings.mcp.codex.add.body' : 'settings.mcp.codex.remove.body'),
      confirmLabel: translate(adding ? 'settings.mcp.codex.add.confirm' : 'settings.mcp.codex.remove.confirm'),
      cancelLabel: translate('settings.mcp.cancel'),
      danger: !adding,
    });
    if (confirmed !== true) {
      return;
    }
    setBusy(true);
    setFailure(undefined);
    const result = await applyMcpCodexChange(projectPath, codexState.revision, current.revision, { kind: adding ? 'put' : 'remove', name });
    setBusy(false);
    if (result.ok) {
      codex.replace(result.value);
    } else {
      setFailure(MCP_ERROR_KEYS[result.error.code]);
    }
  };

  const addFromCodex = async (name: string): Promise<void> => {
    if (codexState?.state !== 'ready') {
      return;
    }
    const confirmed = await confirmDialog({
      title: translate('settings.mcp.codexOnly.confirm.title', { name }),
      body: translate('settings.mcp.codexOnly.confirm.body'),
      confirmLabel: translate('settings.mcp.codexOnly.add'),
      cancelLabel: translate('settings.mcp.cancel'),
    });
    if (confirmed !== true) {
      return;
    }
    setBusy(true);
    setFailure(undefined);
    const read = await revealMcpCodexServer(projectPath, codexState.revision, name);
    if (!read.ok) {
      setBusy(false);
      setFailure(MCP_ERROR_KEYS[read.error.code]);
      return;
    }
    const moved = moveLiteralsToSecrets(name, read.value, envNames ?? new Set());
    const result = await addServerWithSecrets(projectPath, current.revision, name, moved.config, moved.secrets);
    setBusy(false);
    if (result.ok) {
      applied(result.listing);
    } else {
      setFailure(result.messageKey);
    }
  };

  const onlyInCodex: readonly McpServerItem[] =
    codexState?.state === 'ready' ? codexState.servers.filter((server) => !current.servers.some((own) => own.name === server.name)) : [];
  const stale = failure === 'settings.mcp.error.changed' || failure === 'settings.mcp.error.notFound';
  const addProps = { projectPath, listing: current, envNames, onAdded: applied, onFailure: setFailure };

  return (
    <div className="secrets mcp">
      {header}
      {failure !== undefined && (
        <div className="secrets-warning secrets-failure" role="alert">
          <span>{translate(failure)}</span>
          {stale && (
            <button
              type="button"
              className="ghost"
              onClick={() => {
                setFailure(undefined);
                setEdit(undefined);
                listing.reload();
                codex.reload();
              }}
            >
              {translate('settings.mcp.reload')}
            </button>
          )}
        </div>
      )}
      {notice !== undefined && (
        <div className="secrets-warning" role="status">
          <span>{translate(notice)}</span>
        </div>
      )}
      <section className="mcp-section" aria-label={translate('settings.mcp.connected.title')}>
        <h4>{translate('settings.mcp.connected.title')}</h4>
        {current.servers.length === 0 ? (
          <div className="secrets-empty">
            <PlugIcon size={20} />
            <strong>{translate('settings.mcp.connected.empty.title')}</strong>
            <span>{translate('settings.mcp.connected.empty.body')}</span>
          </div>
        ) : (
          <div className="mcp-list" role="list">
            {current.servers.map((item) => (
              <McpServerCard
                key={item.name}
                item={item}
                envNames={envNames}
                codex={codexState}
                busy={busy}
                edit={edit?.name === item.name ? edit : undefined}
                logoId={MCP_PROVIDERS.find((provider) => provider.id === item.name.toLowerCase())?.id}
                onEditStart={() => void startEdit(item.name)}
                onEditChange={changeDraft}
                onEditSave={() => void saveEdit()}
                onEditCancel={() => setEdit(undefined)}
                onCopy={() => void copy(item.name)}
                onRemove={() => void remove(item.name)}
                onToggleCodex={() => void toggleCodex(item.name)}
                onOpenJson={() => void pick('json')}
              />
            ))}
          </div>
        )}
      </section>
      <section className="mcp-section" aria-label={translate('settings.mcp.add.title')}>
        <AddServer {...addProps} />
      </section>
      {onlyInCodex.length > 0 && (
        <section className="mcp-section" aria-label={translate('settings.mcp.codexOnly.title')}>
          <div className="mcp-disclosure-row">
            <button type="button" className="mcp-disclosure" aria-expanded={codexOpen} onClick={() => setCodexOpen(!codexOpen)}>
              {codexOpen ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
              <span>{translate('settings.mcp.codexOnly.title')}</span>
              <span className="mcp-count">{onlyInCodex.length}</span>
            </button>
            <InfoHint text={translate('settings.mcp.codexOnly.body')} />
          </div>
          {codexOpen && (
            <div className="mcp-list" role="list">
              {onlyInCodex.map((item) => (
                <div className="mcp-card" role="listitem" key={item.name}>
                  <div className="mcp-card-head">
                    <ProviderLogo id={MCP_PROVIDERS.find((provider) => provider.id === item.name.toLowerCase())?.id} name={item.name} />
                    <div className="mcp-card-text">
                      <span className="mcp-card-name">{item.name}</span>
                      <span className="mcp-card-line">
                        {item.status === 'server' ? serverLine(translate, item.summary) : translate('settings.mcp.codexOnly.unreadable')}
                      </span>
                    </div>
                    {item.status === 'server' ? (
                      <button type="button" className="mcp-small-button" disabled={busy} onClick={() => void addFromCodex(item.name)}>
                        {translate('settings.mcp.codexOnly.add')}
                      </button>
                    ) : (
                      <span className="mcp-chip mcp-chip-muted">{translate(PROBLEM_KEYS[item.problem.code])}</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
