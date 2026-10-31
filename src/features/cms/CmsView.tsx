import { ErrorToast } from '../../ui/ErrorToast';
import { cmsTransport } from '../../ipc/editorEnvironment';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { PickedAsset } from '../../ui/AssetField';
import type { CmsUndo } from './cmsWriter';
import type { CmsSnapshot } from './cmsReader';
import type { DeclaredTypes } from './cmsTypes';
import { assert } from '../../../shared/core/assert';
import { BOUNDARY_LIMITS } from '../../../shared/core/boundary';
import { toRecord } from '../../../shared/core/record';
import { importCmsAsset, writeCmsMeta } from './cmsBridge';
import { confirmDialog } from '../../ui/ConfirmDialog';
import {
  PlusIcon,
  CloseIcon,
  FileIcon,
  ChevronRightIcon,
  CopyIcon,
  TrashIcon,
  DragIcon,
  CheckIcon,
} from '../../ui/Icons';
import useListReorder from '../../ui/useListReorder';
import {
  contentFieldsOf,
  titleOf,
  blankItem,
  duplicateItem,
  inferType,
  isPlainObject,
} from './cmsSchema';
import CmsSettings from './CmsSettings';
import FieldRow from './CmsField';
import { bestType, withDeclaredTypes } from './cmsTypes';
import { createCmsWriter } from './cmsWriter';
import { createCmsReader, cmsCollection } from './cmsReader';
import { createCmsSchemaOperations } from './cmsOperations';

export interface CmsViewProps {
  readonly project: { readonly path: string };
  readonly rel: string;
  readonly hidden?: boolean;
  readonly settings?: boolean;
  readonly showToast: (message: string, kind: 'error') => void;
  readonly onSaved?: (() => void) | undefined;
  readonly onCloseSettings?: (() => void) | undefined;
  readonly onDeleted?: (() => void) | undefined;
  readonly onClose?: (() => void) | undefined;
  readonly onRecordUndo?: ((command: CmsUndo) => void) | undefined;
}
type DocumentState =
  { readonly kind: 'loading' } | { readonly kind: 'ready'; readonly snapshot: CmsSnapshot };

export default function CmsView(props: CmsViewProps) {
  // A file owns its pending edits and cleanup. Switching files remounts this
  // owner, flushing the previous file through its original writer and path.
  return <CmsDocument key={`${props.project.path}\0${props.rel}`} {...props} />;
}
function CmsDocument(props: CmsViewProps) {
  const model = useCmsDocument(props);
  if (model.state.kind === 'loading') {
    return <div className={`cms-view ${props.hidden ? 'hidden' : ''}`} />;
  }
  return <CmsContent model={model} snapshot={model.state.snapshot} />;
}
function useCmsSaved(onSaved: CmsViewProps['onSaved']) {
  const [saved, setSaved] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>();
  const live = useRef(true);
  const callback = useRef(onSaved);
  callback.current = onSaved;
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      clearTimeout(timer.current);
    };
  }, []);
  const markSaved = () => {
    if (live.current) {
      clearTimeout(timer.current);
      setSaved(true);
      timer.current = setTimeout(() => {
        setSaved(false);
        timer.current = undefined;
      }, 1200);
    }
    callback.current?.();
  };
  return { saved, markSaved };
}
function useCmsDocument(props: CmsViewProps) {
  const [state, setState] = useState<DocumentState>({ kind: 'loading' });
  const [selection, setSelection] = useState(0);
  const [query, setQuery] = useState('');
  const { saved, markSaved } = useCmsSaved(props.onSaved);
  const callbacks = useRef({ props, markSaved });
  callbacks.current = { props, markSaved };
  const reload = useRef<() => Promise<void>>(() => Promise.resolve());
  const [writer] = useState(() =>
    createCmsWriter({
      projectPath: props.project.path,
      rel: props.rel,
      report: (message) => callbacks.current.props.showToast(message, 'error'),
      refresh: () => reload.current(),
      saved: () => callbacks.current.markSaved(),
      record: (command) => callbacks.current.props.onRecordUndo?.(command),
    }),
  );
  useCmsReload({ props, writer, callbacks, reloadRef: reload, setState, setSelection });
  const commit = (items: readonly unknown[]) => {
    writer.queue(items);
    setState((previous) => {
      assert(previous.kind === 'ready', 'CMS edit: document must be loaded');
      return { kind: 'ready', snapshot: { ...previous.snapshot, items } };
    });
  };
  const saveDeclared = async (declared: DeclaredTypes) => {
    setState((previous) => {
      assert(previous.kind === 'ready', 'CMS metadata: document must be loaded');
      return { kind: 'ready', snapshot: { ...previous.snapshot, declared } };
    });
    const result = await writeCmsMeta(props.project.path, props.rel, declared);
    if (!result.ok) {
      props.showToast(result.error, 'error');
    }
  };
  const pickAsset = async (picked: PickedAsset) => {
    const result = await importCmsAsset(props.project.path, props.rel, picked.rel);
    if (!result.ok) {
      props.showToast(result.error, 'error');
    }
    return result;
  };
  return {
    ...props,
    state,
    selection,
    setSelection,
    query,
    setQuery,
    saved,
    commit,
    saveDeclared,
    pickAsset,
  };
}
interface ReloadOptions {
  readonly props: CmsViewProps;
  readonly writer: ReturnType<typeof createCmsWriter>;
  readonly callbacks: React.MutableRefObject<{ props: CmsViewProps; markSaved: () => void }>;
  readonly reloadRef: React.MutableRefObject<() => Promise<void>>;
  readonly setState: React.Dispatch<React.SetStateAction<DocumentState>>;
  readonly setSelection: React.Dispatch<React.SetStateAction<number>>;
}
function useCmsReload({
  props,
  writer,
  callbacks,
  reloadRef,
  setState,
  setSelection,
}: ReloadOptions) {
  useEffect(() => {
    const reader = createCmsReader({
      projectPath: props.project.path,
      rel: props.rel,
      writer,
      report: (message) => callbacks.current.props.showToast(message, 'error'),
      publish: (result) => {
        const detail = result.ok ? '' : result.error.replace(/^(Syntax)?Error:\s*/, '');
        const snapshot = result.ok
          ? result.value
          : {
              collection: cmsCollection(
                props.rel,
                undefined,
                `This file can't be read as content — ${detail}`,
              ),
              items: [],
              declared: {},
            };
        setState({ kind: 'ready', snapshot });
        setSelection((index) => Math.min(index, Math.max(0, snapshot.items.length - 1)));
      },
    });
    reloadRef.current = () => reader.refresh();
    void reader.refresh();
    const unsubscribe = cmsTransport.onCmsChanged(() => {
      void reader.refresh();
    });
    return () => {
      unsubscribe();
      reader.dispose();
      void writer.flush();
    };
  }, [props.project.path, props.rel, writer, callbacks, reloadRef, setState, setSelection]);
}
type CmsModel = ReturnType<typeof useCmsDocument>;
interface ContentProps {
  readonly model: CmsModel;
  readonly snapshot: CmsSnapshot;
}
function CmsContent({ model, snapshot }: ContentProps) {
  const actions = useCmsItems(model, snapshot);
  const schema = createCmsSchemaOperations({
    items: snapshot.items,
    declared: snapshot.declared,
    commit: model.commit,
    saveDeclared: model.saveDeclared,
    report: (message) => model.showToast(message, 'error'),
  });
  if (model.settings) {
    return (
      <div className={`cms-view ${model.hidden ? 'hidden' : ''}`}>
        <CmsSettings
          {...schema}
          collection={snapshot.collection}
          items={snapshot.items}
          declared={snapshot.declared}
          saved={model.saved}
          project={model.project}
          showToast={model.showToast}
          onDeleted={model.onDeleted}
          onDone={model.onCloseSettings}
        />
      </div>
    );
  }
  return (
    <div className={`cms-view ${model.hidden ? 'hidden' : ''}`}>
      {/* One object (not a list) has nothing to choose between: its fields fill the view. */}
      {!snapshot.collection.single && (
        <CmsItems model={model} snapshot={snapshot} actions={actions} />
      )}
      <div className="cms-detail">
        <CmsDetailHead model={model} snapshot={snapshot} actions={actions} />
        <CmsDetailBody model={model} snapshot={snapshot} />
      </div>
    </div>
  );
}
function useCmsItems(model: CmsModel, snapshot: CmsSnapshot) {
  const { items, collection } = snapshot;
  const { selection, setSelection, query, setQuery, commit } = model;
  const item = items[selection];
  const addItem = () => {
    assert(collection.error === undefined, 'CMS edit: unreadable collection cannot be edited');
    assert(items.length < BOUNDARY_LIMITS.itemsMax, 'CMS edit: item limit exceeded');
    const next = [...items, blankItem(items)];
    commit(next);
    setSelection(next.length - 1);
    setQuery('');
  };
  const duplicate = () => {
    assert(item !== undefined, 'CMS duplicate: selection is required');
    assert(items.length < BOUNDARY_LIMITS.itemsMax, 'CMS edit: item limit exceeded');
    const next = [...items];
    next.splice(selection + 1, 0, duplicateItem(item));
    commit(next);
    setSelection(selection + 1);
  };
  const removeItem = async () => {
    if (
      !(await confirmDialog({
        title: `Delete “${titleOf(item, selection)}”?`,
        body: 'It’s removed from this collection.',
        confirmLabel: 'Delete',
        danger: true,
      }))
    ) {
      return;
    }
    const next = items.filter((_, index) => index !== selection);
    commit(next);
    setSelection(Math.max(0, Math.min(selection, next.length - 1)));
  };
  const move = (from: number, to: number) => {
    if (from === to) {
      return;
    }
    assert(from >= 0, 'CMS move: source must be nonnegative');
    assert(from < items.length, 'CMS move: source exceeds item count');
    assert(to >= 0, 'CMS move: target must be nonnegative');
    assert(to <= items.length, 'CMS move: target exceeds item count');
    const next = [...items];
    const [moved] = next.splice(from, 1);
    next.splice(to > from ? to - 1 : to, 0, moved);
    commit(next);
    setSelection(next.indexOf(moved));
  };
  const reorder = useListReorder({ count: items.length, onMove: move, disabled: Boolean(query) });
  const filtered = useMemo(() => {
    const text = query.trim().toLowerCase();
    return items
      .map((item, index) => ({ item, index }))
      .filter(({ item, index }) => !text || titleOf(item, index).toLowerCase().includes(text));
  }, [items, query]);
  return { addItem, duplicate, removeItem, reorder, filtered };
}
type ItemActions = ReturnType<typeof useCmsItems>;
interface ItemProps extends ContentProps {
  readonly actions: ItemActions;
}
function CmsItems({ model, snapshot, actions }: ItemProps) {
  const { collection, items } = snapshot;
  return (
    <div className="cms-items">
      <div className="cms-items-head">
        <span className="cms-items-title">{collection.label}</span>
        {!collection.single && !collection.error && (
          <button className="ghost" title="New item" onClick={actions.addItem}>
            <PlusIcon size={14} />
          </button>
        )}
      </div>
      {!collection.single && items.length > 7 && (
        <div className="cms-search">
          <input
            value={model.query}
            placeholder="Search items"
            maxLength={BOUNDARY_LIMITS.textLengthMax}
            onChange={(event) => model.setQuery(event.target.value)}
          />
        </div>
      )}
      <div className="cms-item-list">
        {actions.filtered.map(({ item, index }) => (
          <div
            key={index}
            className={[
              'cms-item',
              index === model.selection ? 'on' : '',
              actions.reorder.rowClass(index),
            ].join(' ')}
            {...actions.reorder.rowProps(index)}
            onClick={() => model.setSelection(index)}
          >
            <span className="cms-item-grip">
              <DragIcon size={12} />
            </span>
            <span className="cms-item-title">{titleOf(item, index)}</span>
            <ChevronRightIcon size={10} />
          </div>
        ))}
        {items.length === 0 && !collection.error && (
          <div className="props-empty">
            Nothing here yet.
            <div style={{ marginTop: 10 }}>
              <button className="primary" onClick={actions.addItem}>
                Add the first item
              </button>
            </div>
          </div>
        )}
        {items.length > 0 && actions.filtered.length === 0 && (
          <div className="props-empty">No items match “{model.query}”.</div>
        )}
      </div>
    </div>
  );
}
function CmsDetailHead({ model, snapshot, actions }: ItemProps) {
  const { collection, items } = snapshot;
  const item = items[model.selection];
  return (
    <div className="cms-detail-head">
      <button className="ghost cms-back" title="Close the CMS" onClick={model.onClose}>
        <CloseIcon size={13} />
      </button>
      {collection.single && (
        <span className="cms-detail-icon">
          <FileIcon size={14} />
        </span>
      )}
      <span className="cms-detail-title">
        {item !== undefined && !collection.single
          ? titleOf(item, model.selection)
          : collection.label}
      </span>
      <span className={`cms-saved ${model.saved ? 'on' : ''}`}>
        <CheckIcon size={11} /> Saved
      </span>
      <span className="cms-detail-path">src/{filePath(collection.rel)}</span>
      {item !== undefined && !collection.single && (
        <>
          <button className="ghost" title="Duplicate item" onClick={actions.duplicate}>
            <CopyIcon size={13} />
          </button>
          <button
            className="ghost danger"
            title="Delete item"
            onClick={() => {
              // The confirm dialog answers; it never rejects, and a refusal changes nothing.
              void actions.removeItem();
            }}
          >
            <TrashIcon size={13} />
          </button>
        </>
      )}
    </div>
  );
}
// A file's single values are addressed `consts.ts#*general`; the file is what it is.
function filePath(rel: string): string {
  return rel.endsWith('#*general') ? rel.slice(0, -'#*general'.length) : rel;
}
function CmsDetailBody({ model, snapshot }: ContentProps) {
  const { collection, items, declared } = snapshot;
  const item = items[model.selection];
  const fields = withDeclaredTypes(contentFieldsOf(items), declared, []);
  const context = {
    projectPath: model.project.path,
    baseDir: `src/${model.rel}`.replace(/\/[^/]*$/, ''),
    pickAsset: model.rel.includes('#') ? model.pickAsset : undefined,
  };
  const setItemValue = (key: string, value: unknown) => {
    const object = toRecord(item);
    assert(object !== undefined, 'CMS field: selected item must be an object');
    model.commit(
      items.map((entry, index) =>
        index === model.selection ? { ...object, [key]: value } : entry,
      ),
    );
  };
  return (
    <div className="cms-detail-body">
      {collection.error && <ErrorToast message={collection.error} />}
      {item !== undefined && !isPlainObject(item) && (
        <div className="cms-card">
          {!collection.single && <h3>Basic info</h3>}
          <FieldRow
            {...context}
            label="Value"
            type={inferType(item)}
            value={item}
            onChange={(value) =>
              model.commit(items.map((entry, index) => (index === model.selection ? value : entry)))
            }
          />
        </div>
      )}
      {isPlainObject(item) && (
        <div className="cms-card">
          {/* One object is the whole view: its title already names it. */}
          {!collection.single && <h3>Basic info</h3>}
          {fields.map((field) => (
            <FieldRow
              key={field.key}
              {...context}
              label={field.label}
              type={
                item[field.key] === undefined ? field.type : bestType(field.type, item[field.key])
              }
              value={item[field.key]}
              onChange={(value) => setItemValue(field.key, value)}
            />
          ))}
          {fields.length === 0 && (
            <div className="props-empty">
              This collection has no fields yet — add them in its settings.
            </div>
          )}
        </div>
      )}
      {item === undefined && !collection.error && (
        <div className="props-empty">Select an item to edit it.</div>
      )}
    </div>
  );
}
