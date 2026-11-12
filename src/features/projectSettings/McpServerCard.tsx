// One MCP server of the project as a card: its mark and name, one line in plain words, a status that only
// says what the files show, the agents it is available to (Claude Code always, since `.mcp.json` is its project
// file; Codex when its own file has the server) and a menu to edit, copy or remove it. While a server is edited
// the card holds the form: a connection kind, an address or command, and the variables or headers the server
// is started with. A value is masked until its eye is pressed, as in the Secrets tab; a `${NAME}` reference is
// not a secret and is always shown.
import { useState } from 'react';
import type { McpCodexState, McpServerItem } from '../../../shared/properties/mcp';
import type { McpTransport } from '../../../shared/properties/mcpConfig';
import { useTranslate } from '../../lib/i18n/useTranslate';
import Dropdown from '../../ui/Dropdown';
import { HideIcon, PlusIcon, PreviewIcon, TrashIcon } from '../../ui/Icons';
import MoreMenu from '../../ui/MoreMenu';
import ProviderLogo from '../../ui/ProviderLogo';
import { McpEditorSkeleton } from './McpSkeleton';
import {
  DRAFT_PAIRS_MAX,
  PROBLEM_KEYS,
  SERVER_STATUS_KEYS,
  codexChipOf,
  isShownAlways,
  missingSecrets,
  serverLine,
  serverStatus,
  type CodexChip,
  type DraftField,
  type ServerDraft,
} from './mcpModel';
import type { McpProblemCode } from '../../../shared/properties/mcpConfig';

export interface ServerEdit {
  /** `undefined` while the server's values are fetched. */
  readonly draft: ServerDraft | undefined;
  readonly problem: { readonly code: McpProblemCode; readonly field: DraftField } | undefined;
}

export default function McpServerCard({
  item,
  envNames,
  codex,
  busy,
  edit,
  logoId,
  onEditStart,
  onEditChange,
  onEditSave,
  onEditCancel,
  onCopy,
  onRemove,
  onToggleCodex,
  onOpenJson,
}: {
  readonly item: McpServerItem;
  readonly envNames: ReadonlySet<string> | undefined;
  readonly codex: McpCodexState | undefined;
  readonly busy: boolean;
  readonly edit: ServerEdit | undefined;
  /** The catalog id this server matches, when it is a known provider (for its mark). */
  readonly logoId: string | undefined;
  readonly onEditStart: () => void;
  readonly onEditChange: (draft: ServerDraft) => void;
  readonly onEditSave: () => void;
  readonly onEditCancel: () => void;
  readonly onCopy: () => void;
  readonly onRemove: () => void;
  readonly onToggleCodex: () => void;
  readonly onOpenJson: () => void;
}) {
  const translate = useTranslate();
  const status = serverStatus(item, envNames);
  const missing = item.status === 'server' ? missingSecrets(item.summary, envNames) : [];
  const secretCount = item.status === 'server' ? item.summary.secretNames.length : 0;
  const chip = codexChipOf(codex, item.name);
  return (
    <div className="mcp-card" role="listitem">
      <div className="mcp-card-head">
        <ProviderLogo id={logoId} name={item.name} />
        <div className="mcp-card-text">
          <span className="mcp-card-name">{item.name}</span>
          <span className="mcp-card-line">{item.status === 'server' ? serverLine(translate, item.summary) : translate('settings.mcp.invalid.line')}</span>
          {secretCount > 0 && (
            <span className="mcp-card-line">
              {missing.length > 0
                ? translate('settings.mcp.secrets.needs', { count: missing.length })
                : translate('settings.mcp.secrets.uses', { count: secretCount })}
            </span>
          )}
        </div>
        <span className={`mcp-status mcp-status-${status}`}>{translate(SERVER_STATUS_KEYS[status])}</span>
        <MoreMenu
          title={translate('settings.mcp.menu.label', { name: item.name })}
          items={[
            item.status === 'server' && { label: translate('settings.mcp.menu.edit'), onSelect: onEditStart },
            item.status === 'server' && { label: translate('settings.mcp.menu.copy'), onSelect: onCopy },
            { label: translate('settings.mcp.menu.remove'), danger: true, onSelect: onRemove },
          ]}
        />
      </div>
      {item.status === 'invalid' && (
        <p className="mcp-card-note">
          {translate(PROBLEM_KEYS[item.problem.code])}{' '}
          <button type="button" className="ghost" onClick={onOpenJson}>
            {translate('settings.mcp.invalid.open')}
          </button>
        </p>
      )}
      {item.status === 'server' && (
        <div className="mcp-agents">
          <span className="mcp-chip">{translate('settings.mcp.agent.claude')}</span>
          <CodexToggle chip={chip} name={item.name} busy={busy} onToggle={onToggleCodex} />
        </div>
      )}
      {edit !== undefined && <ServerForm edit={edit} busy={busy} onChange={onEditChange} onSave={onEditSave} onCancel={onEditCancel} />}
    </div>
  );
}

function CodexToggle({
  chip,
  name,
  busy,
  onToggle,
}: {
  readonly chip: CodexChip;
  readonly name: string;
  readonly busy: boolean;
  readonly onToggle: () => void;
}) {
  const translate = useTranslate();
  if (chip.kind === 'on' || chip.kind === 'off') {
    const on = chip.kind === 'on';
    return (
      <button
        type="button"
        className={`mcp-chip mcp-chip-button${on ? ' on' : ''}`}
        aria-pressed={on}
        aria-label={translate(on ? 'settings.mcp.codex.removeAction' : 'settings.mcp.codex.addAction', { name })}
        disabled={busy}
        onClick={onToggle}
      >
        {translate(on ? 'settings.mcp.codex.on' : 'settings.mcp.codex.off')}
      </button>
    );
  }
  const text =
    chip.kind === 'missing' ? 'settings.mcp.codex.missing' : chip.kind === 'unsupported' ? 'settings.mcp.codex.unsupported' : 'settings.mcp.codex.unreadable';
  return <span className="mcp-chip mcp-chip-muted">{translate(text)}</span>;
}

function ServerForm({
  edit,
  busy,
  onChange,
  onSave,
  onCancel,
}: {
  readonly edit: ServerEdit;
  readonly busy: boolean;
  readonly onChange: (draft: ServerDraft) => void;
  readonly onSave: () => void;
  readonly onCancel: () => void;
}) {
  const translate = useTranslate();
  const [shown, setShown] = useState<ReadonlySet<number>>(new Set());
  const { draft, problem } = edit;
  if (draft === undefined) {
    return <McpEditorSkeleton />;
  }
  const stdio = draft.transport === 'stdio';
  const problemText = (field: DraftField): string | undefined => (problem?.field === field ? translate(PROBLEM_KEYS[problem.code]) : undefined);
  const setPair = (at: number, patch: { readonly name?: string; readonly value?: string }): void => {
    onChange({ ...draft, pairs: draft.pairs.map((pair, index) => (index === at ? { ...pair, ...patch } : pair)) });
  };
  const toggle = (at: number): void => {
    setShown((current) => {
      const next = new Set(current);
      if (next.has(at)) {
        next.delete(at);
      } else {
        next.add(at);
      }
      return next;
    });
  };
  return (
    <div className="mcp-form">
      <label className="mcp-field">
        <span>{translate('settings.mcp.edit.transport')}</span>
        <Dropdown<McpTransport>
          ariaLabel={translate('settings.mcp.edit.transport')}
          value={draft.transport}
          options={[
            { value: 'http', label: translate('settings.mcp.edit.transport.http') },
            { value: 'sse', label: translate('settings.mcp.edit.transport.sse') },
            { value: 'stdio', label: translate('settings.mcp.edit.transport.stdio') },
          ]}
          onChange={(transport) => onChange({ ...draft, transport })}
        />
      </label>
      {stdio ? (
        <>
          <label className="mcp-field">
            <span>{translate('settings.mcp.edit.command')}</span>
            <input
              className="secrets-input"
              value={draft.command}
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => onChange({ ...draft, command: event.target.value })}
            />
            {problemText('command') !== undefined && <span className="secrets-hint secrets-problem">{problemText('command')}</span>}
          </label>
          <label className="mcp-field">
            <span>{translate('settings.mcp.edit.args')}</span>
            <textarea
              className="secrets-input mcp-args"
              rows={3}
              value={draft.args}
              spellCheck={false}
              onChange={(event) => onChange({ ...draft, args: event.target.value })}
            />
            {problemText('args') !== undefined && <span className="secrets-hint secrets-problem">{problemText('args')}</span>}
          </label>
        </>
      ) : (
        <label className="mcp-field">
          <span>{translate('settings.mcp.edit.url')}</span>
          <input
            className="secrets-input"
            value={draft.url}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => onChange({ ...draft, url: event.target.value })}
          />
          {problemText('url') !== undefined && <span className="secrets-hint secrets-problem">{problemText('url')}</span>}
        </label>
      )}
      <div className="mcp-field">
        <span>{translate(stdio ? 'settings.mcp.edit.env' : 'settings.mcp.edit.headers')}</span>
        {draft.pairs.map((pair, at) => {
          const visible = shown.has(at) || isShownAlways(pair);
          return (
            <div className="mcp-pair" key={at}>
              <input
                className="secrets-input"
                aria-label={translate('settings.mcp.edit.pairName')}
                placeholder={translate('settings.mcp.edit.pairName')}
                value={pair.name}
                spellCheck={false}
                autoComplete="off"
                onChange={(event) => setPair(at, { name: event.target.value })}
              />
              <input
                className="secrets-input"
                type={visible ? 'text' : 'password'}
                aria-label={translate('settings.mcp.edit.pairValue')}
                placeholder={translate('settings.mcp.edit.pairValue')}
                value={pair.value}
                spellCheck={false}
                autoComplete="off"
                onChange={(event) => setPair(at, { value: event.target.value })}
              />
              <button
                type="button"
                className="ghost"
                aria-pressed={visible}
                aria-label={translate(visible ? 'settings.mcp.value.hide' : 'settings.mcp.value.show', { name: pair.name })}
                title={translate(visible ? 'settings.mcp.value.hide' : 'settings.mcp.value.show', { name: pair.name })}
                disabled={isShownAlways(pair)}
                onClick={() => toggle(at)}
              >
                {visible ? <HideIcon size={14} /> : <PreviewIcon size={14} />}
              </button>
              <button
                type="button"
                className="ghost danger"
                aria-label={translate('settings.mcp.edit.removePair', { name: pair.name })}
                title={translate('settings.mcp.edit.removePair', { name: pair.name })}
                onClick={() => onChange({ ...draft, pairs: draft.pairs.filter((_, index) => index !== at) })}
              >
                <TrashIcon size={14} />
              </button>
            </div>
          );
        })}
        {problemText('pairs') !== undefined && <span className="secrets-hint secrets-problem">{problemText('pairs')}</span>}
        <button
          type="button"
          className="ghost mcp-add-pair"
          disabled={draft.pairs.length >= DRAFT_PAIRS_MAX}
          onClick={() => onChange({ ...draft, pairs: [...draft.pairs, { name: '', value: '' }] })}
        >
          <PlusIcon size={12} />
          {translate('settings.mcp.edit.addPair')}
        </button>
      </div>
      {problemText('server') !== undefined && <span className="secrets-hint secrets-problem">{problemText('server')}</span>}
      <div className="mcp-form-actions">
        <button type="button" className="ghost" onClick={onCancel}>
          {translate('settings.mcp.cancel')}
        </button>
        <button type="button" className="primary" disabled={busy} onClick={onSave}>
          {translate('settings.mcp.edit.save')}
        </button>
      </div>
    </div>
  );
}
