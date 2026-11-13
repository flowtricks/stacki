// The MCP tab's JSON view: the whole `.mcp.json` in the app's syntax-highlighted editor, for people who
// would rather manage servers as code. The text is checked as it is typed (a syntax error with its line and
// column, then each server's problems by path), and Save, also Cmd+S, stays off until the text is valid and changed; a valid text shows no status line, only a problem does. A file
// that changed on disk while there are unsaved edits is not overwritten: the view says so and offers Reload.
// Revert drops the edits. The text of the file reaches this view through `readMcpText` only, and a save is
// checked again in main.
import { useMemo, useState, type KeyboardEvent } from 'react';
import type { McpListing, McpText } from '../../../shared/properties/mcp';
import { mcpJsonIssues } from '../../../shared/properties/mcpJson';
import type { Result } from '../../../shared/core/result';
import type { MessageKey } from '../../lib/i18n/localeContext';
import { useTranslate } from '../../lib/i18n/useTranslate';
import CodeEditor from '../../ui/CodeEditor';
import { readMcpText, saveMcpText } from './mcpBridge';
import { ISSUE_KEYS, MCP_ERROR_KEYS } from './mcpModel';
import { McpEditorSkeleton } from './McpSkeleton';
import { useProjectChannel } from './useProjectChannel';

/** The issues listed at once; the editor shows the rest as the first are fixed. */
const ISSUES_SHOWN_MAX = 5;

/** What an empty or missing file starts as, offered as an unsaved draft so Save is one click. */
const STARTER_TEXT = '{\n  "mcpServers": {}\n}\n';

interface Draft {
  readonly text: string;
  /** The revision of the file this text began from: if the file has moved on, saving would overwrite it. */
  readonly from: string;
}

export default function McpJsonView({
  projectPath,
  onDirtyChange,
  onSaved,
}: {
  readonly projectPath: string;
  readonly onDirtyChange: (dirty: boolean) => void;
  readonly onSaved: (listing: McpListing) => void;
}) {
  const translate = useTranslate();
  const { state, reload } = useProjectChannel<McpText, undefined>(
    projectPath,
    async (path) => {
      const read = await readMcpText(path);
      return read.ok ? read : { ok: false, error: undefined };
    },
    (current, next) => current.revision === next.revision,
  );
  const [draft, setDraft] = useState<Draft | undefined>(undefined);
  const [failure, setFailure] = useState<MessageKey | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const base = state.kind === 'ready' ? state.value : undefined;
  const blank = base !== undefined && base.text.trim().length === 0;
  const shown = draft?.text ?? (blank ? STARTER_TEXT : (base?.text ?? ''));
  const issues = useMemo(() => mcpJsonIssues(shown), [shown]);
  const dirty = base !== undefined && shown !== base.text;
  const conflict = base !== undefined && draft !== undefined && draft.from !== base.revision && dirty;

  const edit = (text: string): void => {
    if (base === undefined) {
      return;
    }
    const next = { text, from: draft?.from ?? base.revision };
    setDraft(next);
    onDirtyChange(text !== base.text);
  };
  const discard = (): void => {
    setDraft(undefined);
    setFailure(undefined);
    onDirtyChange(false);
  };
  const save = async (): Promise<void> => {
    if (base === undefined || busy || !dirty || conflict || issues.length > 0) {
      return;
    }
    setBusy(true);
    const saved: Result<McpListing, { readonly code: keyof typeof MCP_ERROR_KEYS }> = await saveMcpText(projectPath, base.revision, shown);
    setBusy(false);
    if (saved.ok) {
      discard();
      onSaved(saved.value);
      reload();
    } else {
      setFailure(MCP_ERROR_KEYS[saved.error.code]);
      if (saved.error.code === 'changed') {
        reload();
      }
    }
  };
  const keys = (event: KeyboardEvent): void => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      void save();
    }
  };

  if (state.kind === 'loading') {
    return <McpEditorSkeleton />;
  }
  if (state.kind === 'unavailable') {
    return (
      <p className="secrets-note" role="alert">
        {translate('settings.mcp.unavailable')}
      </p>
    );
  }
  if (base === undefined) {
    return (
      <div className="secrets-note" role="alert">
        <p>{translate('settings.mcp.error.unreadable')}</p>
        <button type="button" className="ghost" onClick={reload}>
          {translate('settings.mcp.reload')}
        </button>
      </div>
    );
  }
  return (
    <div className="mcp-json" onKeyDown={keys}>
      {!base.exists && draft === undefined && <p className="secrets-hint">{translate('settings.mcp.json.empty')}</p>}
      <div className="mcp-json-editor" aria-label={translate('settings.mcp.json.label')}>
        <CodeEditor language="json" indentation="spaces" value={shown} onChange={edit} />
      </div>
      {conflict && (
        <div className="secrets-warning secrets-failure" role="alert">
          <span>{translate('settings.mcp.json.conflict')}</span>
          <button type="button" className="ghost" onClick={discard}>
            {translate('settings.mcp.json.reload')}
          </button>
        </div>
      )}
      {failure !== undefined && (
        <div className="secrets-warning secrets-failure" role="alert">
          <span>{translate(failure)}</span>
        </div>
      )}
      {issues.length > 0 && (
        <ul className="mcp-issues" role="alert">
          {issues.slice(0, ISSUES_SHOWN_MAX).map((issue) => (
            <li key={`${issue.line}:${issue.column}:${issue.code}`}>
              {translate(issue.path.length > 0 ? 'settings.mcp.json.issuePath' : 'settings.mcp.json.issue', {
                line: issue.line,
                column: issue.column,
                path: issue.path,
                message: translate(ISSUE_KEYS[issue.code]),
              })}
            </li>
          ))}
        </ul>
      )}
      <div className="mcp-form-actions">
        <button type="button" className="ghost" disabled={!dirty} onClick={discard}>
          {translate('settings.mcp.json.revert')}
        </button>
        <button type="button" className="primary" disabled={!dirty || issues.length > 0 || conflict || busy} onClick={() => void save()}>
          {translate('settings.mcp.json.save')}
        </button>
      </div>
    </div>
  );
}
