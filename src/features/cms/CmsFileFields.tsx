// A data file's settings (`src/consts.ts`, the open page's frontmatter), in the
// main view, opened from the gear on its row in the CMS panel as a collection's
// are, and drawn with a content collection's settings classes
// (RemoteCollectionSettings.tsx): its plain variables as field rows, and "Add
// field", which opens the new-field editor below them. The new variable is
// written by main in the file's own style, after its last constant
// (electron/parse/constantFields.ts); the preview is the same statement, made by
// the same serializer (shared/properties/cmsConstants.ts), so what is shown is
// what is written. Every add and delete is one undo step, which puts the file's
// previous text back only while the file still holds what the edit left.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { assert } from '../../../shared/core/assert';
import { data, type Data } from '../../../shared/core/boundary';
import {
  CMS_CONSTANT_LIMITS,
  CONSTANT_TYPES,
  constantIdentifier,
  constantNameProblem,
  constantStatement,
  movedNames,
  type ConstantField,
  type ConstantListing,
  type ConstantRefusal,
  type ConstantSummary,
  type ConstantType,
} from '../../../shared/properties/cmsConstants';
import type { SettingsFieldKind } from '../../../shared/properties/collectionSettings';
import type { MessageKey } from '../../../shared/properties/i18n/messageRef';
import { cmsTransport } from '../../ipc/editorEnvironment';
import { useLocale, useTranslate } from '../../lib/i18n/useTranslate';
import type { Translator } from '../../lib/i18n/localeContext';
import { CodeBlock, CodeInline } from '../../ui/CodeBlock';
import { confirmDialog } from '../../ui/ConfirmDialog';
import Dropdown from '../../ui/Dropdown';
import { ErrorToast } from '../../ui/ErrorToast';
import ExprInput from '../../ui/ExprInput';
import { ChevronLeftIcon, DragIcon, PlusIcon, TrashIcon } from '../../ui/Icons';
import useListReorder from '../../ui/useListReorder';
import { SkeletonRows } from '../../ui/Skeleton';
import { editCmsConstants, readCmsConstants, type ConstantAnswer } from './cmsConstantsBridge';
import type { CmsUndo } from './cmsWriter';
import { nameInSentence } from './remoteFieldTypes';
import { KIND_LABELS } from './settingsKindLabels';
import { KindIcon, kindOptions } from './settingsKindIcons';
import './remoteCms.css';
import './cmsFileFields.css';

export interface CmsFileFieldsProps {
  readonly projectPath: string;
  /** The file under src/: `consts.ts`, `pages/about.astro`. */
  readonly fileRel: string;
  readonly label: string;
  /** Kept mounted while another left panel shows, as the CMS's other views are. */
  readonly hidden: boolean;
  /** The page open in the editor; moving to another closes these settings. */
  readonly currentPage: string | undefined;
  readonly onClose: () => void;
  readonly onRecordUndo?: ((command: CmsUndo) => void) | undefined;
  readonly showToast: (message: string, kind: 'error') => void;
}

type ListingState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'refused'; readonly refusal: ConstantRefusal }
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'ready'; readonly listing: ConstantListing };

export default function CmsFileFields(props: CmsFileFieldsProps) {
  const translate = useTranslate();
  const { state, reload } = useConstantListing(props.projectPath, props.fileRel);
  const edit = useConstantEdits(props, reload);
  useCloseOnPageChange(props.currentPage, props.onClose);
  return (
    <div className={`cms-view remote-cms-view ${props.hidden ? 'hidden' : ''}`}>
      <div className="cms-detail remote-cms-settings">
        <div className="cms-detail-head remote-cms-toolbar">
          <button className="ghost cms-back" title={translate('cms.fileFields.back')} onClick={props.onClose}>
            <ChevronLeftIcon size={13} />
          </button>
          <span className="cms-detail-title" title={`src/${props.fileRel}`}>
            {translate('cmsRemote.settings.title', { collection: props.label })}
          </span>
        </div>
        <div className="cms-detail-body">
          <div className="remote-cms-settings-body cms-file-fields-body">
            <FileFieldsBody state={state} fileRel={props.fileRel} onAdd={edit.add} onRemove={edit.remove} onReorder={edit.reorder} />
          </div>
        </div>
      </div>
    </div>
  );
}

// Another page opened while these settings show takes the person elsewhere: the settings close.
function useCloseOnPageChange(currentPage: string | undefined, onClose: () => void): void {
  const [openedOn] = useState(currentPage);
  useEffect(() => {
    if (currentPage !== openedOn) {
      onClose();
    }
  }, [currentPage, openedOn, onClose]);
}

function FileFieldsBody(props: {
  readonly state: ListingState;
  readonly fileRel: string;
  readonly onAdd: (field: ConstantField) => Promise<ConstantRefusal | undefined>;
  readonly onRemove: (name: string) => void;
  readonly onReorder: (order: readonly string[]) => Promise<boolean>;
}) {
  const translate = useTranslate();
  switch (props.state.kind) {
    case 'loading':
      return (
        <div className="remote-cms-note">
          <SkeletonRows count={4} />
        </div>
      );
    case 'refused':
      return <ErrorToast message={refusalText(props.state.refusal, '', translate)} />;
    case 'failed':
      return <ErrorToast message={props.state.message} />;
    case 'unavailable':
      return <ErrorToast message={translate('cms.fileFields.unavailable')} />;
    case 'ready':
      return <FieldList listing={props.state.listing} fileRel={props.fileRel} onAdd={props.onAdd} onRemove={props.onRemove} onReorder={props.onReorder} />;
    default: {
      const exhaustive: never = props.state;
      return exhaustive;
    }
  }
}

// The listing, read on open and again whenever the project's data changes (an
// edit here, an undo, a save in code), so the list never shows a stale file.
function useConstantListing(projectPath: string, fileRel: string): { readonly state: ListingState; readonly reload: () => Promise<void> } {
  const [state, setState] = useState<ListingState>({ kind: 'loading' });
  const reload = useCallback(async () => {
    const answer = await readCmsConstants(projectPath, fileRel);
    setState(listingStateOf(answer));
  }, [projectPath, fileRel]);
  useEffect(() => {
    let active = true;
    const read = () => {
      void readCmsConstants(projectPath, fileRel).then((answer) => {
        if (active) {
          setState(listingStateOf(answer));
        }
      });
    };
    read();
    const unsubscribe = cmsTransport.onCmsChanged(read);
    return () => {
      active = false;
      unsubscribe();
    };
  }, [projectPath, fileRel]);
  return { state, reload };
}

function listingStateOf(answer: ConstantAnswer<ConstantListing>): ListingState {
  switch (answer.kind) {
    case 'done':
      return { kind: 'ready', listing: answer.value };
    case 'refused':
      return { kind: 'refused', refusal: answer.refusal };
    case 'failed':
      return { kind: 'failed', message: answer.message };
    case 'unavailable':
      return { kind: 'unavailable' };
    default: {
      const exhaustive: never = answer;
      return exhaustive;
    }
  }
}

// Adds and deletes, each recorded as one undo step that restores the other side's text.
function useConstantEdits(props: CmsFileFieldsProps, reload: () => Promise<void>) {
  const translate = useTranslate();
  const { projectPath, fileRel, onRecordUndo, showToast } = props;
  const restore = useCallback(
    async (text: string, expected: string) => {
      const answer = await editCmsConstants(projectPath, fileRel, { kind: 'restore', text, expected });
      const problem = answerProblem(answer, '', translate);
      if (problem !== undefined) {
        showToast(problem, 'error');
      }
      await reload();
    },
    [projectPath, fileRel, reload, showToast, translate],
  );
  const record = useCallback(
    (label: MessageKey, before: string, after: string) => {
      assert(before !== after, 'CmsFileFields: a recorded edit changed the file');
      onRecordUndo?.({
        label: translate(label),
        // Each edit is its own step: two adds in a row are two undos.
        coalesceKey: `cms-constants:${fileRel}:${crypto.randomUUID()}`,
        undo: () => restore(before, after),
        redo: () => restore(after, before),
      });
    },
    [fileRel, onRecordUndo, restore, translate],
  );
  const add = useCallback(
    async (field: ConstantField): Promise<ConstantRefusal | undefined> => {
      const answer = await editCmsConstants(projectPath, fileRel, { kind: 'add', field });
      if (answer.kind === 'refused') {
        return answer.refusal;
      }
      if (answer.kind !== 'done') {
        showToast(answerProblem(answer, field.name, translate) ?? '', 'error');
        return undefined;
      }
      record('cms.fileFields.undoAdd', answer.value.before, answer.value.after);
      await reload();
      return undefined;
    },
    [projectPath, fileRel, record, reload, showToast, translate],
  );
  const remove = useCallback(
    (name: string) => {
      void (async () => {
        const confirmed = await confirmDialog({
          title: translate('cms.fileFields.deleteTitle', { name }),
          body: translate('cms.fileFields.deleteBody', { path: `src/${fileRel}` }),
          confirmLabel: translate('cms.fileFields.delete'),
          danger: true,
        });
        if (!confirmed) {
          return;
        }
        const answer = await editCmsConstants(projectPath, fileRel, { kind: 'remove', name });
        if (answer.kind !== 'done') {
          showToast(answerProblem(answer, name, translate) ?? '', 'error');
        } else {
          record('cms.fileFields.undoRemove', answer.value.before, answer.value.after);
          await reload();
        }
      })();
    },
    [projectPath, fileRel, record, reload, showToast, translate],
  );
  // A drop rewrites the declaration order as one step; the answer says whether it went through.
  const reorder = useCallback(
    async (order: readonly string[]): Promise<boolean> => {
      const answer = await editCmsConstants(projectPath, fileRel, { kind: 'reorder', order });
      if (answer.kind !== 'done') {
        showToast(answerProblem(answer, '', translate) ?? '', 'error');
        return false;
      }
      if (answer.value.before !== answer.value.after) {
        record('cms.fileFields.undoReorder', answer.value.before, answer.value.after);
      }
      await reload();
      return true;
    },
    [projectPath, fileRel, record, reload, showToast, translate],
  );
  return { add, remove, reorder };
}

// What to tell the person about an answer that is not done; undefined when it is.
function answerProblem<Value>(answer: ConstantAnswer<Value>, name: string, translate: Translator): string | undefined {
  switch (answer.kind) {
    case 'done':
      return undefined;
    case 'refused':
      return refusalText(answer.refusal, name, translate);
    case 'failed':
      return answer.message;
    case 'unavailable':
      return translate('cms.fileFields.unavailable');
    default: {
      const exhaustive: never = answer;
      return exhaustive;
    }
  }
}

function FieldList(props: {
  readonly listing: ConstantListing;
  readonly fileRel: string;
  readonly onAdd: (field: ConstantField) => Promise<ConstantRefusal | undefined>;
  readonly onRemove: (name: string) => void;
  readonly onReorder: (order: readonly string[]) => Promise<boolean>;
}) {
  const translate = useTranslate();
  const [adding, setAdding] = useState(false);
  const language = languageOf(props.listing);
  // A dropped order shows at once, until the file is read back (or the move is refused).
  const [shownOrder, setShownOrder] = useState<readonly string[] | undefined>(undefined);
  useEffect(() => setShownOrder(undefined), [props.listing]);
  const fields = shownOrder === undefined ? props.listing.fields : orderedFields(props.listing.fields, shownOrder);
  const { onReorder } = props;
  const reorder = useListReorder({
    count: fields.length,
    disabled: adding,
    onMove: (from, to) => {
      const order = movedNames(
        fields.map((field) => field.name),
        from,
        to,
      );
      setShownOrder(order);
      void onReorder(order).then((moved) => {
        if (!moved) {
          setShownOrder(undefined);
        }
      });
    },
  });
  return (
    <section className="remote-cms-settings-section">
      <h3 className="remote-cms-settings-label">{translate('cmsRemote.settings.fields')}</h3>
      <p className="remote-cms-settings-hint">{translate('cms.fileFields.fieldsNote', { path: `src/${props.fileRel}` })}</p>
      <div className="remote-cms-settings-fields">
        {props.listing.fields.length === 0 && <p className="remote-cms-settings-hint">{translate('cms.fileFields.noFields')}</p>}
        {fields.map((field, index) => (
          <FieldRow
            key={field.name}
            field={field}
            language={language}
            rowClass={reorder.rowClass(index)}
            rowProps={reorder.rowProps(index)}
            onRemove={props.onRemove}
          />
        ))}
      </div>
      {adding ? (
        <NewFieldEditor listing={props.listing} onAdd={props.onAdd} onClose={() => setAdding(false)} />
      ) : (
        <button className="remote-cms-settings-add" onClick={() => setAdding(true)}>
          <PlusIcon size={12} /> {translate('cmsRemote.settings.addField')}
        </button>
      )}
    </section>
  );
}

// The fields in a shown order; one the order does not name (just read back) keeps its place at the end.
function orderedFields(fields: readonly ConstantSummary[], order: readonly string[]): readonly ConstantSummary[] {
  const named = order.flatMap((name) => fields.filter((field) => field.name === name));
  const rest = fields.filter((field) => !order.includes(field.name));
  assert(named.length + rest.length === fields.length, 'orderedFields: every field is shown once');
  return [...named, ...rest];
}

function languageOf(listing: ConstantListing): 'javascript' | 'typescript' {
  return listing.style.script === 'js' || listing.style.script === 'jsx' ? 'javascript' : 'typescript';
}

// A variable's row, laid out as a collection field's: icon, name, kind in parentheses, then its value and delete.
function FieldRow(props: {
  readonly field: ConstantSummary;
  readonly language: 'javascript' | 'typescript';
  readonly rowClass: string;
  readonly rowProps: ReturnType<ReturnType<typeof useListReorder>['rowProps']>;
  readonly onRemove: (name: string) => void;
}) {
  const translate = useTranslate();
  const kind = KIND_OF[props.field.type];
  return (
    <div className={`remote-cms-settings-field cms-file-field ${props.rowClass}`} {...props.rowProps}>
      <span className="remote-cms-grip">
        <DragIcon size={12} />
      </span>
      <KindIcon kind={kind} />
      <span className="remote-cms-settings-name">{props.field.name}</span>
      <span className="remote-cms-settings-kind">({translate(KIND_LABELS[kind])})</span>
      <CodeInline className="cms-file-field-value" text={props.field.preview} language={props.language} />
      <button
        className="ghost remote-cms-settings-tool cms-file-field-delete"
        title={translate('cms.fileFields.delete')}
        onClick={() => props.onRemove(props.field.name)}
      >
        <TrashIcon size={13} />
      </button>
    </div>
  );
}

// The form's draft: what is typed, before it is a value. Arrays and objects are typed as JSON.
interface Draft {
  readonly name: string;
  readonly type: ConstantType;
  readonly text: string;
  readonly flag: boolean;
  readonly description: string;
}

/** One input's change to the draft; a type change also resets the typed value. */
type DraftChange = Pick<Draft, 'name'> | Pick<Draft, 'type' | 'text'> | Pick<Draft, 'text'> | Pick<Draft, 'flag'> | Pick<Draft, 'description'>;

const EMPTY_DRAFT: Draft = { name: '', type: 'string', text: '', flag: true, description: '' };

/** The draft as a field to write, or what is wrong with it (shown under the form). */
type DraftCheck =
  { readonly kind: 'field'; readonly field: ConstantField } | { readonly kind: 'problem'; readonly message: string } | { readonly kind: 'empty' };

// The new-field editor, as a collection's opens below its fields: a head with
// what is being added and its actions, then the inputs and the line to be written.
function NewFieldEditor(props: {
  readonly listing: ConstantListing;
  readonly onAdd: (field: ConstantField) => Promise<ConstantRefusal | undefined>;
  readonly onClose: () => void;
}) {
  const translate = useTranslate();
  const { locale } = useLocale();
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [refusal, setRefusal] = useState<{ readonly refusal: ConstantRefusal; readonly name: string } | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const check = useMemo(() => checkDraft(draft, props.listing, translate), [draft, props.listing, translate]);
  const statement = check.kind === 'field' ? constantStatement(check.field, props.listing.style) : undefined;
  const kind = KIND_OF[draft.type];
  const change = (next: DraftChange) => {
    setRefusal(undefined);
    setDraft((current) => ({ ...current, ...next }));
  };
  const submit = () => {
    if (check.kind !== 'field' || busy) {
      return;
    }
    setBusy(true);
    void props.onAdd(check.field).then((answer) => {
      setBusy(false);
      if (answer === undefined) {
        props.onClose();
      } else {
        setRefusal({ refusal: answer, name: check.field.name });
      }
    });
  };
  const message = refusal !== undefined ? refusalText(refusal.refusal, refusal.name, translate) : check.kind === 'problem' ? check.message : undefined;
  return (
    <div className="remote-cms-settings-editor">
      <div className="remote-cms-settings-editor-head">
        <KindIcon kind={kind} />
        <span className="remote-cms-settings-name">
          {translate('cmsRemote.settings.newField', { kind: nameInSentence(translate(KIND_LABELS[kind]), locale) })}
        </span>
        <span className="remote-cms-settings-spacer" />
        <button onClick={props.onClose}>{translate('ui.cancel')}</button>
        <button className="primary" disabled={check.kind !== 'field' || busy} onClick={submit}>
          {translate('cmsRemote.settings.addField')}
        </button>
      </div>
      <label className="remote-cms-settings-label">
        {translate('cms.fileFields.name')}
        <input
          autoFocus
          value={draft.name}
          maxLength={CMS_CONSTANT_LIMITS.nameCharsMax}
          spellCheck={false}
          placeholder={translate('cms.fileFields.namePlaceholder')}
          onChange={(event) => change({ name: event.target.value })}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              submit();
            }
          }}
        />
      </label>
      <div className="remote-cms-settings-label">
        {translate('cms.fileFields.type')}
        <Dropdown
          ariaLabel={translate('cms.fileFields.type')}
          value={kind}
          livePreview={false}
          options={kindOptions(
            CONSTANT_TYPES.map((type) => KIND_OF[type]),
            translate,
          )}
          onChange={(picked) => {
            const type = typeOfKind(picked);
            change({ type, text: defaultTextOf(type) });
          }}
        />
      </div>
      <ValueInput draft={draft} onChange={change} onSubmit={submit} />
      {props.listing.style.descriptionComments && (
        <label className="remote-cms-settings-label">
          {translate('cms.fileFields.description')}
          <input
            value={draft.description}
            maxLength={CMS_CONSTANT_LIMITS.descriptionCharsMax}
            placeholder={translate('cms.fileFields.descriptionPlaceholder')}
            onChange={(event) => change({ description: event.target.value })}
          />
        </label>
      )}
      {statement !== undefined && (
        <div className="remote-cms-settings-label">
          {translate('cms.fileFields.preview')}
          <CodeBlock className="cms-file-fields-preview" text={statement} language={languageOf(props.listing)} />
        </div>
      )}
      {message !== undefined && <p className="cms-file-fields-error">{message}</p>}
    </div>
  );
}

function ValueInput(props: { readonly draft: Draft; readonly onChange: (next: DraftChange) => void; readonly onSubmit: () => void }) {
  const translate = useTranslate();
  const { draft } = props;
  switch (draft.type) {
    case 'boolean':
      return (
        <div className="remote-cms-settings-label">
          {translate('cms.fileFields.value')}
          <Dropdown
            ariaLabel={translate('cms.fileFields.value')}
            value={draft.flag}
            options={[
              { value: true, label: translate('cms.fileFields.valueTrue') },
              { value: false, label: translate('cms.fileFields.valueFalse') },
            ]}
            onChange={(flag) => props.onChange({ flag })}
          />
        </div>
      );
    case 'array':
    case 'object':
      return (
        <div className="remote-cms-settings-label">
          {translate('cms.fileFields.value')}
          <ExprInput
            key={draft.type}
            className="cms-file-fields-code"
            ariaLabel={translate('cms.fileFields.value')}
            value={draft.text}
            syncValue={draft.text}
            multiline={true}
            language="javascript"
            onChange={(text) => props.onChange({ text })}
          />
        </div>
      );
    case 'string':
    case 'number':
      return (
        <label className="remote-cms-settings-label">
          {translate('cms.fileFields.value')}
          <input
            value={draft.text}
            inputMode={draft.type === 'number' ? 'decimal' : 'text'}
            onChange={(event) => props.onChange({ text: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                props.onSubmit();
              }
            }}
          />
        </label>
      );
    default: {
      const exhaustive: never = draft.type;
      return exhaustive;
    }
  }
}

function defaultTextOf(type: ConstantType): string {
  switch (type) {
    case 'array':
      return '[]';
    case 'object':
      return '{}';
    case 'string':
    case 'number':
    case 'boolean':
      return '';
    default: {
      const exhaustive: never = type;
      return exhaustive;
    }
  }
}

// The draft checked as it is typed: the identifier the name becomes in this
// file's naming, the name rules against what the file binds, and the value.
function checkDraft(draft: Draft, listing: ConstantListing, translate: Translator): DraftCheck {
  if (draft.name.trim().length === 0) {
    return { kind: 'empty' };
  }
  const name = constantIdentifier(draft.name, listing.style.naming);
  const problem = constantNameProblem(name, listing.taken);
  if (problem !== undefined) {
    return { kind: 'problem', message: refusalText(problem, name, translate) };
  }
  const value = valueOf(draft);
  if (value === undefined) {
    return { kind: 'problem', message: valueProblemText(draft.type, translate) };
  }
  const description = draft.description.trim();
  const field: ConstantField = description.length === 0 ? { name, value } : { name, value, description };
  return { kind: 'field', field };
}

function valueOf(draft: Draft): Data | undefined {
  switch (draft.type) {
    case 'string':
      return draft.text;
    case 'number': {
      const trimmed = draft.text.trim();
      const number = Number(trimmed);
      return trimmed.length > 0 && Number.isFinite(number) ? number : undefined;
    }
    case 'boolean':
      return draft.flag;
    case 'array':
    case 'object': {
      const parsed = jsonOf(draft.text);
      if (parsed === undefined) {
        return undefined;
      }
      if (draft.type === 'array') {
        return Array.isArray(parsed) ? parsed : undefined;
      }
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : undefined;
    }
    default: {
      const exhaustive: never = draft.type;
      return exhaustive;
    }
  }
}

// Typed JSON is user input: parsed to unknown, then held to the boundary's bounds.
function jsonOf(text: string): Data | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return data(parsed);
  } catch {
    return undefined;
  }
}

function valueProblemText(type: ConstantType, translate: Translator): string {
  switch (type) {
    case 'number':
      return translate('cms.fileFields.invalidNumber');
    case 'array':
      // i18n-ignore: a JSON example is code, the same in every language.
      return translate('cms.fileFields.invalidList', { example: '["one", "two"]' });
    case 'object':
      // i18n-ignore: a JSON example is code, the same in every language.
      return translate('cms.fileFields.invalidGroup', { example: '{"name": "Ada"}' });
    case 'string':
    case 'boolean':
      return translate('cms.fileFields.refusal.invalidValue');
    default: {
      const exhaustive: never = type;
      return exhaustive;
    }
  }
}

function refusalText(refusal: ConstantRefusal, name: string, translate: Translator): string {
  switch (refusal) {
    case 'syntax':
      return translate('cms.fileFields.refusal.syntax');
    case 'fence':
      return translate('cms.fileFields.refusal.fence');
    case 'invalidName':
      return translate('cms.fileFields.refusal.invalidName');
    case 'reservedName':
      return translate('cms.fileFields.refusal.reservedName', { name });
    case 'duplicateName':
      return translate('cms.fileFields.refusal.duplicateName', { name });
    case 'missing':
      return translate('cms.fileFields.refusal.missing');
    case 'inUse':
      return translate('cms.fileFields.refusal.inUse', { name });
    case 'compound':
      return translate('cms.fileFields.refusal.compound', { name });
    case 'changed':
      return translate('cms.fileFields.refusal.changed');
    case 'invalidValue':
      return translate('cms.fileFields.refusal.invalidValue');
    case 'dependency':
      return translate('cms.fileFields.refusal.dependency');
    default: {
      const exhaustive: never = refusal;
      return exhaustive;
    }
  }
}

// The collection field kind each variable type looks like, for its icon and its name.
const KIND_OF: Readonly<Record<ConstantSummary['type'], SettingsFieldKind>> = {
  string: 'text',
  number: 'number',
  boolean: 'switch',
  array: 'list',
  object: 'group',
  code: 'other',
};

function typeOfKind(kind: SettingsFieldKind): ConstantType {
  const found = CONSTANT_TYPES.find((type) => KIND_OF[type] === kind);
  assert(found !== undefined, 'CmsFileFields: the type menu offers only the kinds of variable types');
  return found;
}
