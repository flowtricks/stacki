import { ErrorToast } from '../../ui/ErrorToast';
import { useTranslate, useTranslateDescribed } from '../../lib/i18n/useTranslate';
import type { DescribedTranslator, Translator } from '../../lib/i18n/localeContext';
import { cmsTransport } from '../../ipc/editorEnvironment';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Data } from '../../../shared/core/boundary';
import type { IpcResults, WireValidationIssue } from '../../../shared/ipc/ipcResults';
import { collectionFields, describeField, editsBetween, labelize } from './contentSchema';
import type { FieldDescriptor } from './contentSchema';
import { planContentRename, readContentEntries, renameContentEntry, validateContentEntry, writeContentEntry } from './contentViewBridge';
import type { ContentEntries, ContentEntry } from './contentViewBridge';
import CodeEditor from '../../ui/CodeEditor';
import { CheckIcon, ChevronRightIcon, CloseIcon, HelpCircleIcon, HideIcon } from '../../ui/Icons';
import { FieldRow, UnionField, isPlainObject, issueMessageAt, omitField } from './ContentFields';
import type { FieldContext } from './ContentFields';

const SAVE_DELAY_MS = 400;
const CHECK_DELAY_MS = 250;
const SAVED_DELAY_MS = 1_200;
const RENAME_POINTERS_SHOWN_MAX = 12;

type ToastKind = 'error' | 'success' | 'info';
interface ContentProject {
  readonly path: string;
}
interface ContentViewProps {
  readonly project: ContentProject;
  readonly name: string;
  readonly hidden: boolean;
  readonly showToast?: ((message: string, kind: ToastKind) => void) | undefined;
  readonly onClose?: (() => void) | undefined;
  readonly onSaved?: (() => void) | undefined;
}
interface Draft {
  readonly data: Data;
  readonly body: string | undefined;
}
interface RenameState {
  readonly to: string;
  readonly plan: IpcResults['content:renamePlan'] | undefined;
  readonly error: string | undefined;
}

function directoryOf(file: string): string {
  return file.split('/').slice(0, -1).join('/');
}

export default function ContentView(props: ContentViewProps) {
  const editor = useContentEditor(props);
  const shape = useMemo(() => collectionFields(editor.state?.collection.schema), [editor.state?.collection.schema]);
  const freeformFields = useMemo(() => (shape.freeform ? describeFreeformFields(editor.data) : []), [editor.data, shape.freeform]);
  const context = useFieldContext(props.project.path, editor);
  const formIssues = editor.issues.filter((issue) => issue.path.length === 0 || !shape.fields.some((field) => field.key === issue.path[0]));
  if (!editor.state) {
    return <div className={`cms-view ${props.hidden ? 'hidden' : ''}`} />;
  }
  return (
    <div className={`cms-view content-view ${props.hidden ? 'hidden' : ''}`}>
      <EntryList
        name={props.name}
        entries={editor.state.entries}
        readOnly={editor.state.readOnly}
        selected={editor.selected}
        query={editor.query}
        onQuery={editor.setQuery}
        onSelect={editor.setSelected}
      />
      <EntryDetail {...props} {...editor} state={editor.state} shape={shape} freeformFields={freeformFields} context={context} formIssues={formIssues} />
    </div>
  );
}

function describeFreeformFields(value: Data): readonly FieldDescriptor[] {
  if (!isPlainObject(value)) {
    return [];
  }
  return Object.keys(value).map((key) => describeField(typeof value[key] === 'number' ? { type: 'number' } : { type: 'string' }, key));
}

function useContentEditor(props: ContentViewProps) {
  const [state, setState] = useState<ContentEntries | undefined>(undefined);
  const [selected, setSelected] = useState(0);
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState<Draft | undefined>(undefined);
  const [issues, setIssues] = useState<readonly WireValidationIssue[]>([]);
  const [saved, setSaved] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [rename, setRename] = useState<RenameState | undefined>(undefined);
  const timers = useEditorTimers();
  const load = useContentLoad(props, setState, setSelected);
  useEffect(() => {
    void load();
    return cmsTransport.onCmsChanged(() => void load());
  }, [load]);
  useEffect(() => {
    timers.flush();
    setDraft(undefined);
    setIssues([]);
    setExpanded(new Set());
    setRename(undefined);
    timers.validationGeneration.current += 1;
    clearTimer(timers.check);
  }, [props.name, selected, timers]);
  const entry = state?.entries[selected];
  const dataValue = draft?.data ?? entry?.data;
  const data = dataValue === undefined ? {} : dataValue;
  const body = draft ? draft.body : entry?.body;
  const save = useContentSave(props, entry, setState, setSaved, timers.saved, setDraft);
  const change = useContentChange(props, setDraft, setIssues, timers, save);
  return {
    state,
    selected,
    setSelected,
    query,
    setQuery,
    entry,
    data,
    body,
    issues,
    saved,
    expanded,
    setExpanded,
    rename,
    setRename,
    change,
    load,
  } as const;
}

type TimerRef = React.MutableRefObject<ReturnType<typeof setTimeout> | undefined>;

// Every value here is a React ref, written in place by the editor's handlers.
interface EditorTimers {
  readonly flush: () => void;
  readonly pending: React.MutableRefObject<(() => void) | undefined>;
  readonly save: TimerRef;
  readonly check: TimerRef;
  readonly saved: TimerRef;
  readonly validationGeneration: React.MutableRefObject<number>;
}

function useEditorTimers(): EditorTimers {
  const save = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const check = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const saved = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const validationGeneration = useRef(0);
  const pending = useRef<(() => void) | undefined>(undefined);
  const flush = useCallback(() => {
    clearTimer(save);
    const apply = pending.current;
    pending.current = undefined;
    apply?.();
  }, []);
  const timers = useMemo(() => ({ save, check, saved, validationGeneration, pending, flush }), [flush]);
  useEffect(
    () => () => {
      flush();
      clearTimer(check);
      clearTimer(saved);
      validationGeneration.current += 1;
    },
    [flush],
  );
  return timers;
}

function clearTimer(timerRef: TimerRef): void {
  if (timerRef.current !== undefined) {
    clearTimeout(timerRef.current);
    timerRef.current = undefined;
  }
}

function useContentLoad(
  props: ContentViewProps,
  setState: React.Dispatch<React.SetStateAction<ContentEntries | undefined>>,
  setSelected: React.Dispatch<React.SetStateAction<number>>,
) {
  const generation = useRef(0);
  const { name, showToast } = props;
  const projectPath = props.project.path;
  return useCallback(async (): Promise<void> => {
    const current = ++generation.current;
    const result = await readContentEntries(projectPath, name);
    if (current !== generation.current) {
      return;
    }
    if (!result.ok) {
      showToast?.(result.error, 'error');
      return;
    }
    setState(result.value);
    setSelected((index) => Math.min(index, Math.max(0, result.value.entries.length - 1)));
  }, [name, projectPath, setSelected, setState, showToast]);
}

function useContentSave(
  props: ContentViewProps,
  entry: ContentEntry | undefined,
  setState: React.Dispatch<React.SetStateAction<ContentEntries | undefined>>,
  setSaved: React.Dispatch<React.SetStateAction<boolean>>,
  savedTimer: EditorTimers['saved'],
  setDraft: React.Dispatch<React.SetStateAction<Draft | undefined>>,
) {
  const { onSaved, showToast } = props;
  const projectPath = props.project.path;
  return useCallback(
    async (next: Draft): Promise<void> => {
      if (!entry) {
        return;
      }
      const edits = editsBetween(entry.data, next.data);
      const bodyChanged = next.body !== undefined && next.body !== entry.body;
      if (edits.length === 0 && !bodyChanged) {
        return;
      }
      const result = await writeContentEntry(projectPath, { file: entry.file, locator: entry.locator }, edits, bodyChanged ? next.body : undefined, {
        data: entry.data,
        body: entry.body,
      });
      if (!result.ok) {
        showToast?.(result.error, 'error');
        return;
      }
      showSaved(setSaved, savedTimer);
      onSaved?.();
      setState((current) => updateSavedEntry(current, entry, next));
      setDraft((current) => (current === next ? undefined : current));
    },
    [entry, onSaved, projectPath, savedTimer, setSaved, setState, setDraft, showToast],
  );
}

function showSaved(setSaved: React.Dispatch<React.SetStateAction<boolean>>, timerRef: TimerRef): void {
  clearTimer(timerRef);
  setSaved(true);
  timerRef.current = setTimeout(() => setSaved(false), SAVED_DELAY_MS);
}

function updateSavedEntry(state: ContentEntries | undefined, selected: ContentEntry, next: Draft): ContentEntries | undefined {
  if (!state) {
    return undefined;
  }
  return {
    ...state,
    entries: state.entries.map((entry) => {
      if (entry.file !== selected.file || entry.id !== selected.id) {
        return entry;
      }
      const updated = { ...entry, data: next.data };
      return next.body === undefined ? updated : { ...updated, body: next.body };
    }),
  };
}

function useContentChange(
  props: ContentViewProps,
  setDraft: React.Dispatch<React.SetStateAction<Draft | undefined>>,
  setIssues: React.Dispatch<React.SetStateAction<readonly WireValidationIssue[]>>,
  timers: EditorTimers,
  save: (draft: Draft) => Promise<void>,
) {
  return useCallback(
    (next: Draft): void => {
      const { save: saveTimerRef, check: checkTimerRef, validationGeneration: generationRef } = timers;
      setDraft(next);
      clearTimer(saveTimerRef);
      const { pending } = timers;
      pending.current = () => void save(next);
      saveTimerRef.current = setTimeout(timers.flush, SAVE_DELAY_MS);
      clearTimer(checkTimerRef);
      generationRef.current += 1;
      const generation = generationRef.current;
      checkTimerRef.current = setTimeout(() => void checkContent(props, next, generation, timers, setIssues), CHECK_DELAY_MS);
    },
    [props, save, setDraft, setIssues, timers],
  );
}

async function checkContent(
  props: ContentViewProps,
  next: Draft,
  generation: number,
  timers: EditorTimers,
  setIssues: React.Dispatch<React.SetStateAction<readonly WireValidationIssue[]>>,
): Promise<void> {
  const result = await validateContentEntry(props.project.path, props.name, next.data);
  if (generation !== timers.validationGeneration.current) {
    return;
  }
  if (result.ok) {
    setIssues(result.value.issues);
  } else {
    props.showToast?.(result.error, 'error');
  }
}

function useFieldContext(projectPath: string, editor: ReturnType<typeof useContentEditor>) {
  const { entry, expanded, issues, setExpanded, state } = editor;
  const translateDescribed = useTranslateDescribed();
  const parserNote = state?.parserNote === undefined ? undefined : translateDescribed({ message: state.parserNote, messageRef: state.parserNoteRef });
  return useMemo<FieldContext>(
    () => ({
      projectPath,
      baseDir: entry ? directoryOf(entry.file) : '',
      parsed: Boolean(state?.parsed),
      parserNote,
      expanded,
      expand: (key) => setExpanded((current) => new Set(current).add(key)),
      inFile: (path) => dataHasPath(entry?.data, path),
      issueAt: (path) => issueMessageAt(issues, path),
    }),
    [entry, expanded, issues, parserNote, projectPath, setExpanded, state?.parsed],
  );
}

function dataHasPath(value: Data, path: readonly (string | number)[]): boolean {
  let current = value;
  for (const part of path) {
    if (typeof part === 'number') {
      if (!Array.isArray(current) || current[part] === undefined) {
        return false;
      }
      current = current[part];
    } else if (isPlainObject(current) && Object.hasOwn(current, part)) {
      current = current[part];
    } else {
      return false;
    }
  }
  return true;
}

interface EntryListProps {
  readonly name: string;
  readonly entries: readonly ContentEntry[];
  readonly readOnly: boolean;
  readonly selected: number;
  readonly query: string;
  readonly onQuery: (query: string) => void;
  readonly onSelect: (index: number) => void;
}

function EntryList(props: EntryListProps) {
  const translate = useTranslate();
  const filtered = useMemo(() => {
    const query = props.query.trim().toLowerCase();
    return props.entries.map((entry, index) => ({ entry, index })).filter(({ entry }) => !query || `${entry.title} ${entry.id}`.toLowerCase().includes(query));
  }, [props.entries, props.query]);
  return (
    <div className="cms-items">
      <div className="cms-items-head">
        <span className="cms-items-title">{labelize(props.name)}</span>
        <span className="content-count">{props.entries.length}</span>
      </div>
      {props.entries.length > 7 && (
        <div className="cms-search">
          <input value={props.query} placeholder={translate('contentUi.entry.search')} onChange={(event) => props.onQuery(event.target.value)} />
        </div>
      )}
      <div className="cms-item-list">
        {filtered.map(({ entry, index }) => (
          <div key={entry.id} className={`cms-item ${index === props.selected ? 'on' : ''}`} onClick={() => props.onSelect(index)}>
            <span className="cms-item-title">{entry.title}</span>
            <ChevronRightIcon size={10} />
          </div>
        ))}
        {props.entries.length === 0 && (
          <div className="props-empty">{props.readOnly ? translate('contentUi.entry.builtOnly') : translate('contentUi.entry.noneYet')}</div>
        )}
      </div>
    </div>
  );
}

type Editor = ReturnType<typeof useContentEditor>;
type Shape = ReturnType<typeof collectionFields>;
interface EntryDetailProps extends ContentViewProps, Editor {
  readonly state: ContentEntries;
  readonly shape: Shape;
  readonly freeformFields: readonly FieldDescriptor[];
  readonly context: FieldContext;
  readonly formIssues: readonly WireValidationIssue[];
}

function EntryDetail(props: EntryDetailProps) {
  const translate = useTranslate();
  return (
    <div className="cms-detail">
      <DetailHeader {...props} />
      <div className="cms-detail-body">
        <EntryBanners state={props.state} />
        {props.rename && props.entry && <RenameEditor {...props} entry={props.entry} />}
        <FormIssues issues={props.formIssues} />
        {props.entry && <EntryForm {...props} entry={props.entry} />}
        {props.entry?.hasBody && <BodyEditor {...props} entry={props.entry} />}
        {!props.entry && !props.state.readOnly && <div className="props-empty">{translate('contentUi.entry.select')}</div>}
      </div>
    </div>
  );
}

function DetailHeader(props: EntryDetailProps) {
  const translate = useTranslate();
  return (
    <div className="cms-detail-head">
      <button className="ghost cms-back" title={translate('ui.close')} onClick={props.onClose}>
        <CloseIcon size={13} />
      </button>
      <span className="cms-detail-title">{props.entry ? props.entry.title : labelize(props.name)}</span>
      <span className={`cms-saved ${props.saved ? 'on' : ''}`}>
        <CheckIcon size={11} /> {translate('contentUi.entry.saved')}
      </span>
      {props.entry && !props.state.readOnly && (
        <button
          className="ghost content-id"
          title={translate('contentUi.entry.idTitle')}
          onClick={() => props.setRename({ to: props.entry?.id ?? '', plan: undefined, error: undefined })}
        >
          {props.entry.id}
        </button>
      )}
      <span className="cms-detail-path">{props.entry ? props.entry.file : (props.state.collection.loader?.file ?? '')}</span>
    </div>
  );
}

function EntryBanners({ state }: { readonly state: ContentEntries }) {
  const translateDescribed = useTranslateDescribed();
  return (
    <>
      {state.readOnly && (
        <div className="content-banner">
          <HideIcon size={12} />
          <span>{translateDescribed({ message: state.reason ?? '', messageRef: state.reasonRef })}</span>
        </div>
      )}
      {state.parserNote && (
        <div className="content-banner soft">
          <HelpCircleIcon size={12} />
          <span>{translateDescribed({ message: state.parserNote, messageRef: state.parserNoteRef })}</span>
        </div>
      )}
      {state.idNote && (
        <div className="content-banner soft">
          <HelpCircleIcon size={12} />
          <span>{translateDescribed({ message: state.idNote, messageRef: state.idNoteRef })}</span>
        </div>
      )}
      {state.collection.error && <ErrorToast message={state.collection.error} />}
    </>
  );
}

function FormIssues({ issues }: { readonly issues: readonly WireValidationIssue[] }) {
  if (issues.length === 0) {
    return undefined;
  }
  return <ErrorToast message={issues.map((issue) => `${issue.path.length ? `${issue.path.join(' › ')}: ` : ''}${issue.message}`).join('\n')} />;
}

function EntryForm(props: EntryDetailProps & { readonly entry: ContentEntry }) {
  const translate = useTranslate();
  const fields = props.shape.freeform ? props.freeformFields : props.shape.fields;
  return (
    <div className="cms-card">
      <h3>{props.shape.freeform ? translate('contentUi.form.frontmatter') : translate('contentUi.form.fields')}</h3>
      {props.shape.union ? (
        <UnionField
          field={props.shape.union}
          value={props.data}
          context={props.context}
          path={[]}
          onChange={(data) => props.change({ data, body: props.body })}
        />
      ) : (
        fields.map((field) => <RootField key={field.key} {...props} field={field} />)
      )}
      {!props.shape.union && fields.length === 0 && <div className="props-empty">{translate('contentUi.collection.noFields')}</div>}
    </div>
  );
}

function RootField(props: EntryDetailProps & { readonly field: FieldDescriptor }) {
  const key = props.field.key;
  if (typeof key !== 'string') {
    throw new Error('Root content field requires a key');
  }
  const values = isPlainObject(props.data) ? props.data : {};
  return (
    <FieldRow
      field={props.field}
      value={values[key]}
      context={props.context}
      path={[key]}
      onChange={(value) =>
        props.change({
          data: value === undefined ? omitField(values, key) : { ...values, [key]: value },
          body: props.body,
        })
      }
    />
  );
}

function BodyEditor(props: EntryDetailProps & { readonly entry: ContentEntry }) {
  const translate = useTranslate();
  return (
    <div className="cms-card">
      <h3>{translate('contentUi.body.title')}</h3>
      <div className="content-body-note">{translate('contentUi.body.note')}</div>
      <div className="content-body-editor">
        <CodeEditor key={props.entry.id} language="markdown" value={props.body ?? ''} onChange={(body: string) => props.change({ data: props.data, body })} />
      </div>
    </div>
  );
}

function RenameEditor(props: EntryDetailProps & { readonly entry: ContentEntry }) {
  const translate = useTranslate();
  const rename = props.rename;
  if (!rename) {
    return undefined;
  }
  const check = (): void => {
    void checkRename(props, rename, props.entry);
  };
  const execute = (): void => {
    void executeRename(props, rename, props.entry);
  };
  return (
    <div className="content-rename">
      <div className="content-rename-row">
        <label>{translate('contentUi.entry.id')}</label>
        <input
          autoFocus
          value={rename.to}
          spellCheck={false}
          onChange={(event) => props.setRename({ to: event.target.value, plan: undefined, error: undefined })}
        />
        <button className="ghost" disabled={!rename.to.trim() || rename.to === props.entry.id} onClick={check}>
          {translate('contentUi.entry.rename.check')}
        </button>
        <button className="ghost" onClick={() => props.setRename(undefined)}>
          {translate('ui.cancel')}
        </button>
      </div>
      {rename.error && <ErrorToast message={rename.error} />}
      {rename.plan && <RenamePlan plan={rename.plan} onRename={execute} />}
    </div>
  );
}

async function checkRename(props: EntryDetailProps, rename: RenameState, entry: ContentEntry): Promise<void> {
  const result = await planContentRename(props.project.path, props.name, entry.id, rename.to.trim());
  props.setRename(result.ok ? { ...rename, plan: result.value, error: undefined } : { ...rename, plan: undefined, error: result.error });
}

async function executeRename(props: EntryDetailProps, rename: RenameState, entry: ContentEntry): Promise<void> {
  const result = await renameContentEntry(props.project.path, props.name, entry.id, rename.to.trim());
  if (!result.ok) {
    props.setRename({ ...rename, error: result.error });
    return;
  }
  props.setRename(undefined);
  await props.load();
  props.onSaved?.();
}

function RenamePlan({ plan, onRename }: { readonly plan: IpcResults['content:renamePlan']; readonly onRename: () => void }) {
  const translate = useTranslate();
  const translateDescribed = useTranslateDescribed();
  return (
    <div className="content-rename-plan">
      <div>{moveDescription(plan.move, translate, translateDescribed)}</div>
      <div>{pointerDescription(plan.pointers.length, translate)}</div>
      {plan.pointers.slice(0, RENAME_POINTERS_SHOWN_MAX).map((pointer, index) => (
        <div key={index} className="content-pointer">
          {pointer.collection} › {pointer.entryTitle} › {pointer.path.join('.')}
        </div>
      ))}
      {plan.pointers.length > RENAME_POINTERS_SHOWN_MAX && (
        <div className="content-pointer">{translate('contentUi.entry.rename.pointersMore', { count: plan.pointers.length - RENAME_POINTERS_SHOWN_MAX })}</div>
      )}
      {plan.imageEdits.length > 0 && <div>{translate('contentUi.entry.rename.imagePaths', { count: plan.imageEdits.length })}</div>}
      <button className="primary" onClick={onRename}>
        {translate('contentUi.entry.rename.submit', { count: plan.pointers.length })}
      </button>
    </div>
  );
}

function moveDescription(move: IpcResults['content:renamePlan']['move'], translate: Translator, translateDescribed: DescribedTranslator): string {
  switch (move.kind) {
    case 'file':
      return translate('contentUi.entry.rename.moveFile', { path: move.to });
    case 'generated':
    case 'unknown':
      return translateDescribed({ message: move.note, messageRef: move.noteRef });
    case 'key':
    case 'field':
      return translate('contentUi.entry.rename.moveInData');
  }
}

function pointerDescription(count: number, translate: Translator): string {
  return count === 0 ? translate('contentUi.entry.rename.pointersNone') : translate('contentUi.entry.rename.pointers', { count });
}
