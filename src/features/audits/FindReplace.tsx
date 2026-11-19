// Find & replace across the site, inside the Audits panel: text, attribute values
// and CMS entries in the open page or every page and component, with case, whole
// word and "include code". Results are grouped by file; each goes to its element.
// Replace shows the change before it writes; Replace all writes every file as one
// undo step, through the same edit path as the audit's fixes. Code (expressions,
// scripts, style blocks, frontmatter) is found only when asked and never rewritten,
// and nothing outside the project's own pages, components and CMS data is read.
import { useState, type KeyboardEvent, type ReactNode } from 'react';
import { useTranslate } from '../../lib/i18n/useTranslate';
import { readPage } from '../../ipc/bridge';
import { cmsTransport } from '../../ipc/editorEnvironment';
import { record } from '../../../shared/core/boundary';
import { parseIpcPayload } from '../../../shared/ipc/ipcPayloads';
import { toArray, toRecord } from '../../../shared/core/record';
import { CodeBlock } from '../../ui/CodeBlock';
import { BracesIcon, CloseIcon, ReplaceIcon, SearchIcon } from '../../ui/Icons';
import { SegmentedTabs } from '../../ui/SegmentedTabs';
import { applyFixes } from './auditFixes';
import type { AuditsPanelProps } from './AuditsPanel';
import {
  MATCHES_MAX,
  countIn,
  findInData,
  findInTree,
  findPattern,
  replacedIn,
  replacedInData,
  replacementFinding,
  type FindOptions,
  type TextMatch,
} from './findText';

type Scope = 'current' | 'site';

interface FileResult {
  readonly file: string;
  readonly matches: readonly TextMatch[];
}

interface DataResult {
  readonly rel: string;
  readonly data: unknown;
  readonly matches: readonly { readonly keys: readonly (string | number)[]; readonly value: string; readonly count: number }[];
}

/** Files one search reads: pages and components, then CMS data files. */
const SEARCH_FILES_MAX = 2_000;

export function FindReplace(props: Pick<AuditsPanelProps, 'project' | 'fixDeps' | 'onReveal' | 'showToast' | 'sources'> & { readonly onClose: () => void }) {
  const translate = useTranslate();
  const [query, setQuery] = useState('');
  const [replacement, setReplacement] = useState('');
  const [options, setOptions] = useState<Omit<FindOptions, 'query'>>({ caseSensitive: false, wholeWord: false, includeCode: false });
  const [scope, setScope] = useState<Scope>('site');
  const [results, setResults] = useState<{ readonly files: readonly FileResult[]; readonly data: readonly DataResult[] } | undefined>(undefined);
  const [previewing, setPreviewing] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const find: FindOptions = { query, ...options };
  const pattern = findPattern(find);
  const search = async (): Promise<void> => {
    if (pattern === undefined) {
      return;
    }
    setBusy(true);
    const sources = props.sources();
    const targets = (scope === 'current' ? (sources.current === undefined ? [] : [sources.current]) : sources.all).slice(0, SEARCH_FILES_MAX);
    const files: FileResult[] = [];
    let total = 0;
    for (const target of targets) {
      if (total >= MATCHES_MAX) {
        break;
      }
      const read = await readPage(target.path).catch(() => undefined);
      if (read?.editable !== true) {
        continue;
      }
      const matches = findInTree(read.model.nodes, find);
      if (matches.length > 0) {
        files.push({ file: target.file, matches });
        total += matches.length;
      }
    }
    const data = scope === 'site' ? await searchData(props.project.path, find) : [];
    setResults({ files, data });
    setBusy(false);
  };
  const replaceFiles = async (files: readonly FileResult[], label: string): Promise<void> => {
    if (pattern === undefined) {
      return;
    }
    const findings = files.flatMap((result) => result.matches.flatMap((match) => replacementFinding(result.file, match, pattern, replacement) ?? []));
    if (findings.length === 0) {
      props.showToast(translate('auditsUi.find.onlyCode'), 'info');
      return;
    }
    setBusy(true);
    const outcome = await applyFixes(findings, props.fixDeps(), label);
    setBusy(false);
    const [failure] = outcome.failures;
    props.showToast(
      failure === undefined ? translate('auditsUi.find.replacedFiles', { count: outcome.files }) : `${failure.file}: ${failure.message}`,
      failure === undefined ? 'success' : 'error',
    );
    await search();
  };
  const replaceData = async (entries: readonly DataResult[]): Promise<void> => {
    if (pattern === undefined || entries.length === 0) {
      return;
    }
    const writes = entries.map((entry) => ({ rel: entry.rel, before: entry.data, after: replacedInData(entry.data, pattern, replacement) }));
    const write = async (side: 'before' | 'after'): Promise<void> => {
      for (const entry of writes) {
        await cmsTransport.writeCms(parseIpcPayload('cms:write', { projectPath: props.project.path, rel: entry.rel, data: entry[side] }));
      }
    };
    await write('after');
    props.fixDeps().pushCommand({ label: translate('auditsUi.find.replaceCmsLabel'), undo: () => write('before'), redo: () => write('after') });
    props.showToast(translate('auditsUi.find.replacedCmsFiles', { count: writes.length }), 'success');
    await search();
  };
  const count =
    (results?.files ?? []).reduce((total, file) => total + file.matches.reduce((sum, match) => sum + match.count, 0), 0) +
    (results?.data ?? []).reduce((total, entry) => total + entry.matches.length, 0);
  const fileCount = (results?.files.length ?? 0) + (results?.data.length ?? 0);
  const status = busy
    ? translate('auditsUi.find.searching')
    : results === undefined
      ? ''
      : count === 0
        ? translate('auditsUi.find.none')
        : `${translate('auditsUi.find.matches', { count })} ${translate('auditsUi.find.inFiles', { count: fileCount })}`;
  // Enter finds from either field; Escape closes the card, as it closes every other panel's search.
  const onFieldKey = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void search();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      props.onClose();
    }
  };
  const toggle = (name: keyof Omit<FindOptions, 'query'>) => (): void => setOptions((current) => ({ ...current, [name]: !current[name] }));
  return (
    <div className="audits-find">
      <div className="audits-find-header">
        <h3 className="audits-find-title">{translate('auditsUi.find.title')}</h3>
        <button className="ghost audits-icon-button" aria-label={translate('ui.close')} title={translate('ui.close')} onClick={props.onClose}>
          <CloseIcon size={14} />
        </button>
      </div>
      <label className="audits-find-field">
        <SearchIcon size={14} className="audits-find-icon" />
        <input
          type="text"
          aria-label={translate('auditsUi.find.find')}
          placeholder={translate('auditsUi.find.find')}
          value={query}
          spellCheck={false}
          autoFocus
          onChange={(event) => setQuery(event.currentTarget.value)}
          onKeyDown={onFieldKey}
        />
        <span className="audits-find-toggles">
          <Toggle title={translate('auditsUi.find.matchCase')} on={options.caseSensitive} onToggle={toggle('caseSensitive')}>
            <span aria-hidden="true">Aa</span>
          </Toggle>
          <Toggle title={translate('auditsUi.find.wholeWord')} on={options.wholeWord} onToggle={toggle('wholeWord')}>
            <span aria-hidden="true">W</span>
          </Toggle>
          <Toggle title={translate('auditsUi.find.includeCode')} on={options.includeCode} onToggle={toggle('includeCode')}>
            <BracesIcon size={14} />
          </Toggle>
        </span>
      </label>
      <label className="audits-find-field">
        <ReplaceIcon size={14} className="audits-find-icon" />
        <input
          type="text"
          aria-label={translate('auditsUi.find.replaceWith')}
          placeholder={translate('auditsUi.find.replaceWith')}
          value={replacement}
          spellCheck={false}
          onChange={(event) => setReplacement(event.currentTarget.value)}
          onKeyDown={onFieldKey}
        />
      </label>
      <SegmentedTabs<Scope>
        label={translate('auditsUi.find.where')}
        layout="equal"
        value={scope}
        tabs={[
          { value: 'current', label: translate('auditsUi.scope.page') },
          { value: 'site', label: translate('auditsUi.scope.site') },
        ]}
        onPick={setScope}
      />
      <div className="audits-find-foot">
        <span className="audits-find-status" role="status" title={status}>
          {status}
        </span>
        <button className="audits-secondary" disabled={pattern === undefined || busy} onClick={() => void search()}>
          {translate('auditsUi.find.find')}
        </button>
        <button
          className="audits-apply"
          disabled={busy || results === undefined || count === 0}
          onClick={() =>
            results !== undefined && void replaceFiles(results.files, translate('auditsUi.find.replaceLabel', { query })).then(() => replaceData(results.data))
          }
        >
          {translate('auditsUi.find.replaceAll')}
        </button>
      </div>
      {results?.files.map((result) => (
        <div key={result.file} className="audits-find-file">
          <div className="audits-find-name">{result.file}</div>
          {result.matches.map((match) => {
            const key = `${result.file}|${match.path.join('.')}|${match.place.kind === 'attribute' ? match.place.name : match.place.kind}`;
            const after = pattern === undefined ? match.value : replacedIn(match.value, pattern, replacement);
            return (
              <div key={key}>
                <div
                  className="list-item audits-row audits-occurrence-row"
                  role="button"
                  tabIndex={0}
                  title={match.value}
                  onClick={() => props.onReveal(result.file, match.path, undefined)}
                >
                  <span className="label audits-title">{snippet(match.value, query)}</span>
                  <span className="audits-tag">
                    {match.place.kind === 'attribute'
                      ? match.place.name
                      : match.place.kind === 'code'
                        ? translate('auditsUi.find.placeCode')
                        : translate('auditsUi.find.placeText')}
                  </span>
                  {match.place.kind !== 'code' && (
                    <span className="audits-hover-actions" onClick={(event) => event.stopPropagation()}>
                      <button className="audits-link" onClick={() => setPreviewing(previewing === key ? undefined : key)}>
                        {translate('auditsUi.find.replace')}
                      </button>
                    </span>
                  )}
                </div>
                {previewing === key && (
                  <div className="audits-inset">
                    <CodeBlock text={match.value} language="html" className="audits-code audits-before" label={translate('auditsUi.before')} />
                    <CodeBlock text={after} language="html" className="audits-code" label={translate('auditsUi.after')} />
                    <div className="audits-actions">
                      <button
                        className="audits-link"
                        disabled={busy}
                        onClick={() =>
                          void replaceFiles([{ file: result.file, matches: [match] }], translate('auditsUi.find.replaceLabel', { query })).then(() =>
                            setPreviewing(undefined),
                          )
                        }
                      >
                        {translate('auditsUi.find.replace')}
                      </button>
                      <button className="audits-link muted" onClick={() => setPreviewing(undefined)}>
                        {translate('ui.cancel')}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ))}
      {results?.data.map((entry) => (
        <div key={entry.rel} className="audits-find-file">
          <div className="audits-find-name">{entry.rel}</div>
          {entry.matches.map((match) => (
            <div
              key={match.keys.join('.')}
              className="list-item audits-row audits-occurrence-row"
              title={match.value}
              onClick={() => props.onReveal(entry.rel, undefined, undefined)}
            >
              <span className="label audits-title">{snippet(match.value, query)}</span>
              <span className="audits-tag">{match.keys.join('.')}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function Toggle(props: { readonly title: string; readonly on: boolean; readonly onToggle: () => void; readonly children: ReactNode }) {
  return (
    <button
      type="button"
      className={`audits-toggle ${props.on ? 'on' : ''}`}
      aria-pressed={props.on}
      aria-label={props.title}
      title={props.title}
      onClick={props.onToggle}
    >
      {props.children}
    </button>
  );
}

/** The words around the first match, so a long value shows where it matched. */
function snippet(value: string, query: string): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  const at = flat.toLowerCase().indexOf(query.toLowerCase());
  if (at <= 30) {
    return flat.slice(0, 90);
  }
  return `…${flat.slice(at - 30, at + 60)}`;
}

// CMS data files, searched value by value.
async function searchData(projectPath: string, find: FindOptions): Promise<readonly DataResult[]> {
  const pattern = findPattern(find);
  if (pattern === undefined) {
    return [];
  }
  let listed: unknown;
  try {
    listed = await cmsTransport.listCms(projectPath);
  } catch {
    return []; // No CMS folder: nothing to search.
  }
  const files = toArray(record(listed)['files']) ?? [];
  const found: DataResult[] = [];
  for (const raw of files.slice(0, SEARCH_FILES_MAX)) {
    const file = toRecord(raw);
    const rel = file?.['rel'];
    if (typeof rel !== 'string' || file === undefined || file['data'] === undefined) {
      continue;
    }
    const matches = findInData(file['data'], pattern);
    if (matches.length > 0 && countIn(JSON.stringify(file['data']), pattern) > 0) {
      found.push({ rel, data: file['data'], matches });
    }
  }
  return found;
}
