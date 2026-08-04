import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  PlusIcon,
  CloseIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  TrashIcon,
  DragIcon,
  CheckIcon,
  VariableTextSizeIcon,
  ParagraphIcon,
  FieldNumberIcon,
  SwitchIcon,
  ElementImageIcon,
  CalendarIcon,
  ElementLinkIcon,
  MailIcon,
  PhoneCallIcon,
  DropletIcon,
  ElementListDefaultIcon,
  BracesIcon,
  RepeatIcon,
} from '../ui/Icons.jsx';
import AutoTextarea from '../ui/AutoTextarea.jsx';
import AssetField from '../ui/AssetField.jsx';
import {
  applyToItems,
  collectionOf,
  dropKey,
  fieldsAt,
  fieldsOf,
  labelize,
  orderKeys,
  putKey,
  renameKey,
  titleOf,
  blankItem,
  duplicateItem,
  emptyValueFor,
  inferType,
  keyFor,
  isPlainObject,
  reassemble,
} from '../cmsSchema.js';

const SAVE_DELAY = 400;

// The field types a collection can hold, each mapping onto a JSON shape.
// A field's type is fixed once it exists: it's inferred from the data, so
// changing it would mean rewriting every item's value.
const FIELD_TYPES = [
  { value: 'text', label: 'Text', Icon: VariableTextSizeIcon, hint: 'A short line' },
  { value: 'longtext', label: 'Long text', Icon: ParagraphIcon, hint: 'A paragraph' },
  { value: 'number', label: 'Number', Icon: FieldNumberIcon, hint: 'A figure' },
  { value: 'boolean', label: 'Toggle', Icon: SwitchIcon, hint: 'On or off' },
  { value: 'image', label: 'Image', Icon: ElementImageIcon, hint: 'From your assets' },
  { value: 'date', label: 'Date', Icon: CalendarIcon, hint: 'A calendar date' },
  { value: 'link', label: 'Link', Icon: ElementLinkIcon, hint: 'A web address' },
  { value: 'email', label: 'Email', Icon: MailIcon, hint: 'An address' },
  { value: 'phone', label: 'Phone', Icon: PhoneCallIcon, hint: 'A number to call' },
  { value: 'color', label: 'Color', Icon: DropletIcon, hint: 'A hex value' },
  { value: 'list', label: 'List of text', Icon: ElementListDefaultIcon, hint: 'Tags, bullets' },
  { value: 'object', label: 'Group', Icon: BracesIcon, hint: 'Fields kept together' },
  { value: 'objects', label: 'Repeating items', Icon: RepeatIcon, hint: 'A list of entries' },
];

const typeInfo = (type) =>
  FIELD_TYPES.find((t) => t.value === type) || FIELD_TYPES[0];

// Reordering by drag, done the way the Navigator does it: the gate on
// `dragover` reads dataTransfer.types, which is there the moment the drag
// starts. Gating on React state instead can miss — a native drag runs its own
// event loop, so a state update from `dragstart` isn't guaranteed to have
// committed by the first `dragover`, and without preventDefault() the browser
// refuses the drop and the row silently springs back.
const dragging = (e, kind) => e.dataTransfer.types.includes(`avb/${kind}`);

// Before or after the row under the pointer, by which half it's over.
const edgeIndex = (e, index) => {
  const box = e.currentTarget.getBoundingClientRect();
  return e.clientY < box.top + box.height / 2 ? index : index + 1;
};

// The CMS editor, shown over the canvas while the CMS panel is open: items on
// the left, the selected item's fields on the right. Everything writes back to
// the JSON file it came from, matching its original shape.
export default function CmsView({
  project,
  rel,
  hidden,
  settings,
  showToast,
  onSaved,
  onCloseSettings,
  onDeleted,
  onClose,
  onRecordUndo,
}) {
  const [collection, setCollection] = useState(null);
  const [items, setItems] = useState([]);
  const [sel, setSel] = useState(0);
  const [query, setQuery] = useState('');
  const [saved, setSaved] = useState(false);
  const [dragIndex, setDragIndex] = useState(null);
  const [dropIndex, setDropIndex] = useState(null);
  // Types the user picked when creating a field, keyed by dotted field path.
  // Inference can't tell a phone number from a line of text, and an empty
  // field tells it nothing at all, so these are remembered on disk.
  const [declared, setDeclared] = useState({});

  const saveTimer = useRef(null);
  const pending = useRef(null); // items waiting to be written
  // The data currently on disk, so a save can record what it replaced for undo.
  const onDiskRef = useRef(null);
  const dragFrom = useRef(null); // row being dragged, readable mid-drag

  const load = useCallback(async () => {
    try {
      const [{ data }, { meta }] = await Promise.all([
        window.avb.readCms({ projectPath: project.path, rel }),
        window.avb.cmsMeta(project.path),
      ]);
      onDiskRef.current = data;
      setDeclared(meta?.[rel] || {});
      const name = rel.slice(rel.lastIndexOf('/') + 1);
      const c = collectionOf({ rel, name, dir: rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '', data });
      setCollection(c);
      setItems(c.items);
      setSel((s) => Math.min(s, Math.max(0, c.items.length - 1)));
    } catch (err) {
      const detail = String(err?.message || err)
        .replace(/^Error invoking remote method '[^']+':\s*/, '')
        .replace(/^(Syntax)?Error:\s*/, '');
      setCollection({
        rel,
        label: rel.slice(rel.lastIndexOf('/') + 1),
        items: [],
        error: `This file can't be read as content — ${detail}`,
      });
      setItems([]);
    }
  }, [project.path, rel]);

  useEffect(() => {
    setSel(0);
    setQuery('');
    load();
  }, [load]);

  // External edits (an editor, a git checkout) refresh the view. Our own
  // writes don't come back — the watcher ignores them, so an unsaved edit
  // still in the debounce window is written out before reloading.
  useEffect(
    () => window.avb.onCmsChanged(() => (pending.current ? flushRef.current().then(load) : load())),
    [load]
  );

  const flush = useCallback(async () => {
    clearTimeout(saveTimer.current);
    const next = pending.current;
    pending.current = null;
    if (!next || !collection) return;
    try {
      const before = onDiskRef.current;
      const after = reassemble(collection, next);
      await window.avb.writeCms({ projectPath: project.path, rel, data: after });
      onDiskRef.current = after;
      // Content edits don't touch the page model, so they need their own undo
      // entry. One step per burst of typing in the same collection.
      if (before !== undefined && onRecordUndo) {
        const put = async (data) => {
          await window.avb.writeCms({ projectPath: project.path, rel, data });
          onDiskRef.current = data;
          await load();
          onSaved?.();
        };
        onRecordUndo({
          label: 'content edit',
          coalesceKey: `cms:${rel}`,
          undo: () => put(before),
          redo: () => put(after),
        });
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 1200);
      onSaved?.(); // the panel's item counts came from before this write
    } catch (err) {
      const message = String(err?.message || err).replace(
        /^Error invoking remote method '[^']+':\s*(Error:\s*)?/,
        ''
      );
      // The collection was deleted while this edit was in flight — the delete
      // was deliberate, so there's nothing to report.
      if (/no longer exists/.test(message)) return;
      showToast(message, 'error');
    }
  }, [collection, project.path, rel, showToast, onSaved, onRecordUndo, load]);

  const flushRef = useRef(flush);
  flushRef.current = flush;

  // Write the last edit out when leaving, so a quick change followed by a
  // panel switch isn't lost.
  useEffect(() => () => { if (pending.current) flushRef.current(); }, []);

  const commit = (next) => {
    setItems(next);
    pending.current = next;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(flush, SAVE_DELAY);
  };

  const fields = useMemo(
    () => withDeclaredTypes(fieldsOf(items), declared, []),
    [items, declared]
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items
      .map((item, index) => ({ item, index }))
      .filter(({ item, index }) => !q || titleOf(item, index).toLowerCase().includes(q));
  }, [items, query]);

  if (!collection) return <div className={`cms-view ${hidden ? 'hidden' : ''}`} />;

  const single = collection.single;
  const item = items[sel];

  // --- item operations -------------------------------------------------

  const addItem = () => {
    const next = [...items, blankItem(items)];
    commit(next);
    setSel(next.length - 1);
    setQuery('');
  };

  const duplicate = () => {
    const next = [...items];
    next.splice(sel + 1, 0, duplicateItem(item));
    commit(next);
    setSel(sel + 1);
  };

  const removeItem = () => {
    if (!window.confirm(`Delete “${titleOf(item, sel)}”?`)) return;
    const next = items.filter((_, i) => i !== sel);
    commit(next);
    setSel(Math.max(0, Math.min(sel, next.length - 1)));
  };

  const move = (from, to) => {
    if (from === to || to == null) return;
    const next = [...items];
    const [moved] = next.splice(from, 1);
    next.splice(to > from ? to - 1 : to, 0, moved);
    commit(next);
    setSel(next.indexOf(moved));
  };

  const setItemValue = (key, value) => {
    const next = items.map((it, i) => (i === sel ? { ...it, [key]: value } : it));
    commit(next);
  };

  // --- schema operations, from the settings pane -------------------------
  //
  // A field belongs to the collection, not to one item, so each of these
  // rewrites every item at that level.

  const saveDeclared = (next) => {
    setDeclared(next);
    window.avb
      .setCmsMeta({ projectPath: project.path, rel, fields: next })
      .catch(() => {
        /* the types just fall back to inference */
      });
  };

  const addFieldAt = (path, key, type) => {
    if (!key) return;
    if (fieldsAt(items, path).some((f) => f.key === key)) return;
    saveDeclared({ ...declared, [[...path, key].join('.')]: type });
    commit(applyToItems(items, path, putKey(key, type)));
  };

  // Returns false when the name can't be used, so the row can put the old
  // one back rather than showing a name the data doesn't have.
  const renameFieldAt = (path, from, to) => {
    if (!to || to === from) return false;
    if (fieldsAt(items, path).some((f) => f.key === to)) {
      showToast(`This level already has a “${labelize(to)}” field.`, 'error');
      return false;
    }
    const fromPath = [...path, from].join('.');
    const toPath = [...path, to].join('.');
    if (declared[fromPath] || Object.keys(declared).some((k) => k.startsWith(fromPath + '.'))) {
      const next = {};
      for (const [k, v] of Object.entries(declared)) {
        next[k === fromPath || k.startsWith(fromPath + '.') ? toPath + k.slice(fromPath.length) : k] = v;
      }
      saveDeclared(next);
    }
    commit(applyToItems(items, path, renameKey(from, to)));
    return true;
  };

  const removeFieldAt = (path, key) => {
    const gone = [...path, key].join('.');
    if (declared[gone] || Object.keys(declared).some((k) => k.startsWith(gone + '.'))) {
      const next = {};
      for (const [k, v] of Object.entries(declared)) {
        if (k !== gone && !k.startsWith(gone + '.')) next[k] = v;
      }
      saveDeclared(next);
    }
    commit(applyToItems(items, path, dropKey(key)));
  };

  const reorderFieldsAt = (path, keys) => {
    commit(applyToItems(items, path, orderKeys(keys)));
  };

  if (settings) {
    return (
      <div className={`cms-view ${hidden ? 'hidden' : ''}`}>
        <CmsSettings
          collection={collection}
          items={items}
          declared={declared}
          saved={saved}
          project={project}
          showToast={showToast}
          onDeleted={onDeleted}
          onAddField={addFieldAt}
          onRenameField={renameFieldAt}
          onRemoveField={removeFieldAt}
          onReorderFields={reorderFieldsAt}
          onDone={onCloseSettings}
        />
      </div>
    );
  }

  return (
    <div className={`cms-view ${hidden ? 'hidden' : ''}`}>
      <div className="cms-items">
        <div className="cms-items-head">
          <span className="cms-items-title">{collection.label}</span>
          {!single && (
            <button className="ghost" title="New item" onClick={addItem}>
              <PlusIcon size={14} />
            </button>
          )}
        </div>

        {!single && items.length > 7 && (
          <div className="cms-search">
            <input
              value={query}
              placeholder="Search items"
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        )}

        {/* Dropping in the space under the last row moves an item to the end,
            which is otherwise a fiddly target. */}
        <div
          className="cms-item-list"
          onDragOver={(e) => {
            if (!dragging(e, 'cms-item') || e.target !== e.currentTarget) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            setDropIndex(items.length);
          }}
          onDrop={(e) => {
            if (!dragging(e, 'cms-item') || e.target !== e.currentTarget) return;
            e.preventDefault();
            const from = dragFrom.current ?? Number(e.dataTransfer.getData('avb/cms-item'));
            move(from, items.length);
            dragFrom.current = null;
            setDragIndex(null);
            setDropIndex(null);
          }}
        >
          {filtered.map(({ item: row, index }) => (
            <div
              key={index}
              className={`cms-item ${index === sel ? 'on' : ''} ${
                dropIndex === index ? 'drop-before' : ''
              } ${dropIndex === items.length && index === items.length - 1 ? 'drop-after' : ''}`}
              draggable={!query}
              onDragStart={(e) => {
                dragFrom.current = index;
                setDragIndex(index);
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('avb/cms-item', String(index));
              }}
              onDragOver={(e) => {
                if (!dragging(e, 'cms-item')) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                setDropIndex(edgeIndex(e, index));
              }}
              onDragEnd={() => {
                dragFrom.current = null;
                setDragIndex(null);
                setDropIndex(null);
              }}
              onDrop={(e) => {
                if (!dragging(e, 'cms-item')) return;
                e.preventDefault();
                const from = dragFrom.current ?? Number(e.dataTransfer.getData('avb/cms-item'));
                move(from, edgeIndex(e, index));
                dragFrom.current = null;
                setDragIndex(null);
                setDropIndex(null);
              }}
              onClick={() => setSel(index)}
            >
              <span className="cms-item-grip">
                <DragIcon size={12} />
              </span>
              <span className="cms-item-title">{titleOf(row, index)}</span>
              <ChevronRightIcon size={10} />
            </div>
          ))}

          {items.length === 0 && (
            <div className="props-empty">
              Nothing here yet.
              <div style={{ marginTop: 10 }}>
                <button className="primary" onClick={addItem}>
                  Add the first item
                </button>
              </div>
            </div>
          )}
          {items.length > 0 && filtered.length === 0 && (
            <div className="props-empty">No items match “{query}”.</div>
          )}
        </div>
      </div>

      <div className="cms-detail">
        <div className="cms-detail-head">
          <button className="ghost cms-back" title="Close the CMS" onClick={onClose}>
            <CloseIcon size={13} />
          </button>
          <span className="cms-detail-title">
            {item ? titleOf(item, sel) : collection.label}
          </span>
          <span className={`cms-saved ${saved ? 'on' : ''}`}>
            <CheckIcon size={11} /> Saved
          </span>
          <span className="cms-detail-path">src/{collection.rel}</span>
          {item && !single && (
            <>
              <button className="ghost" title="Duplicate item" onClick={duplicate}>
                <CopyIcon size={13} />
              </button>
              <button className="ghost danger" title="Delete item" onClick={removeItem}>
                <TrashIcon size={13} />
              </button>
            </>
          )}
        </div>

        <div className="cms-detail-body">
          {collection.error && <div className="cms-error">{collection.error}</div>}

          {item !== undefined && !isPlainObject(item) && (
            <div className="cms-card">
              <h3>{single ? collection.label : 'Basic info'}</h3>
              <FieldRow
                label="Value"
                type={inferType(item)}
                value={item}
                projectPath={project.path}
                onChange={(v) => commit(items.map((it, i) => (i === sel ? v : it)))}
              />
            </div>
          )}

          {item && isPlainObject(item) && (
            <div className="cms-card">
              <h3>{single ? collection.label : 'Basic info'}</h3>
              {fields.map((field) => (
                <FieldRow
                  key={field.key}
                  label={field.label}
                  type={
                    item[field.key] === undefined
                      ? field.type
                      : bestType(field.type, item[field.key])
                  }
                  value={item[field.key]}
                  projectPath={project.path}
                  onChange={(v) => setItemValue(field.key, v)}
                />
              ))}
              {fields.length === 0 && (
                <div className="props-empty">
                  This collection has no fields yet — add them in its settings.
                </div>
              )}
            </div>
          )}

          {!item && !collection.error && (
            <div className="props-empty">Select an item to edit it.</div>
          )}
        </div>
      </div>
    </div>
  );
}

// Collection settings — the shape of the data rather than its content. Adding,
// renaming, retyping and reordering a field here rewrites every item at once,
// which is why none of it is reachable from the item editor.
function CmsSettings({
  collection,
  items,
  declared,
  saved,
  project,
  showToast,
  onDeleted,
  onAddField,
  onRenameField,
  onRemoveField,
  onReorderFields,
  onDone,
}) {
  return (
    <div className="cms-settings">
      <div className="cms-detail-head">
        <button className="ghost cms-back" title="Back to items" onClick={onDone}>
          <ChevronLeftIcon size={14} />
        </button>
        <span className="cms-detail-title">{collection.label} Settings</span>
        <span className={`cms-saved ${saved ? 'on' : ''}`}>
          <CheckIcon size={11} /> Saved
        </span>
        <span className="cms-detail-path">src/{collection.rel}</span>
        <button className="primary" onClick={onDone}>
          Done
        </button>
      </div>

      <div className="cms-detail-body">
        <div className="cms-card">
          <h3>Collection fields</h3>
          <p className="cms-note">
            {collection.single
              ? 'This file holds one set of fields.'
              : `Shared by all ${items.length} ${items.length === 1 ? 'item' : 'items'}.`}
          </p>
          <FieldSchema
            items={items}
            declared={declared}
            path={[]}
            onAddField={onAddField}
            onRenameField={onRenameField}
            onRemoveField={onRemoveField}
            onReorderFields={onReorderFields}
          />
        </div>

        <div className="cms-card cms-danger">
          <h3>Delete collection</h3>
          <p className="cms-note">
            Moves src/{collection.rel} to the Trash. Pages that import it keep working — they
            switch to an empty list.
          </p>
          <button className="ghost danger" onClick={() => deleteCollection(collection, project, showToast, onDeleted)}>
            <TrashIcon size={12} /> Delete {collection.label}
          </button>
        </div>
      </div>
    </div>
  );
}

// Names the pages that import the collection before it goes, since they're
// rewritten as part of the delete.
async function deleteCollection(collection, project, showToast, onDeleted) {
  const fail = (err) =>
    showToast(
      String(err?.message || err).replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, ''),
      'error'
    );
  let used;
  try {
    used = (await window.avb.cmsUsage({ projectPath: project.path, rel: collection.rel })).files || [];
  } catch (err) {
    fail(err);
    return;
  }
  const where =
    used.length === 0
      ? 'No page uses it.'
      : `${used.length === 1 ? '1 page uses' : `${used.length} pages use`} it (${used
          .slice(0, 3)
          .join(', ')}${used.length > 3 ? `, +${used.length - 3} more` : ''}). ` +
        'They will keep working, showing nothing, until you point them at other data.';
  if (!window.confirm(`Delete the ${collection.label} collection?\n\n${where}`)) return;
  try {
    await window.avb.deleteCms({ projectPath: project.path, rel: collection.rel });
    onDeleted?.();
  } catch (err) {
    fail(err);
  }
}

// The fields defined at one level, with the nested levels folded underneath.
function FieldSchema({ items, declared, path, ...ops }) {
  const fields = withDeclaredTypes(fieldsAt(items, path), declared, path);
  const [expanded, setExpanded] = useState(() => new Set());
  const [dragKey, setDragKey] = useState(null);
  const [dropKeyAt, setDropKeyAt] = useState(null);
  const dragFrom = useRef(null);
  // A nested level's fields must not answer a drag from the level above it.
  const dragType = `avb/cms-field-${path.join('.') || 'root'}`;

  const drop = (source, target) => {
    if (!source || !target || source === target) return;
    if (!fields.some((f) => f.key === source)) return;
    const keys = fields.map((f) => f.key).filter((k) => k !== source);
    const at = keys.indexOf(target);
    keys.splice(at < 0 ? keys.length : at, 0, source);
    ops.onReorderFields(path, keys);
  };

  return (
    <div className="cms-schema">
      {fields.map((field) => {
        const nested = field.type === 'objects' || field.type === 'object';
        const open = expanded.has(field.key);
        const info = typeInfo(field.type === 'empty' ? 'text' : field.type);
        const Icon = info.Icon;
        return (
          <div key={field.key} className="cms-schema-group">
            <div
              className={`cms-schema-row ${dropKeyAt === field.key ? 'drop-before' : ''}`}
              draggable
              onDragStart={(e) => {
                dragFrom.current = field.key;
                setDragKey(field.key);
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData(dragType, field.key);
              }}
              onDragOver={(e) => {
                if (!e.dataTransfer.types.includes(dragType)) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                setDropKeyAt(field.key);
              }}
              onDragEnd={() => {
                dragFrom.current = null;
                setDragKey(null);
                setDropKeyAt(null);
              }}
              onDrop={(e) => {
                if (!e.dataTransfer.types.includes(dragType)) return;
                e.preventDefault();
                e.stopPropagation();
                drop(dragFrom.current ?? e.dataTransfer.getData(dragType), field.key);
                dragFrom.current = null;
                setDragKey(null);
                setDropKeyAt(null);
              }}
            >
              <span className="cms-schema-grip">
                <DragIcon size={11} />
              </span>
              {nested ? (
                <button
                  className="ghost cms-schema-expand"
                  title={open ? 'Hide its fields' : 'Show its fields'}
                  onClick={() =>
                    setExpanded((prev) => {
                      const next = new Set(prev);
                      next.has(field.key) ? next.delete(field.key) : next.add(field.key);
                      return next;
                    })
                  }
                >
                  <ChevronRightIcon size={10} className={open ? 'rotated' : ''} />
                </button>
              ) : (
                <span className="cms-schema-expand" />
              )}
              <input
                key={field.key}
                className="cms-schema-name"
                defaultValue={field.label}
                spellCheck={false}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur();
                  if (e.key === 'Escape') {
                    e.currentTarget.value = field.label;
                    e.currentTarget.blur();
                  }
                }}
                onBlur={(e) => {
                  const next = keyFor(e.target.value);
                  if (!next || !ops.onRenameField(path, field.key, next)) {
                    e.target.value = field.label;
                  }
                }}
              />
              <span className="cms-schema-type" title="A field's type is set when it's created">
                <Icon size={13} />
                {info.label}
              </span>
              <button
                className="ghost danger"
                title="Delete field"
                onClick={() => {
                  if (
                    window.confirm(
                      `Delete the “${field.label}” field? Its content is removed from every item.`
                    )
                  ) {
                    ops.onRemoveField(path, field.key);
                  }
                }}
              >
                <TrashIcon size={12} />
              </button>
            </div>

            {nested && open && (
              <div className="cms-schema-nested">
                <FieldSchema
                  items={items}
                  declared={declared}
                  path={[...path, field.key]}
                  {...ops}
                />
              </div>
            )}
          </div>
        );
      })}

      {fields.length === 0 && <div className="cms-empty-inline">No fields yet.</div>}

      <AddFieldRow compact={path.length > 0} onAdd={(key, type) => ops.onAddField(path, key, type)} />
    </div>
  );
}

// A declared type wins over the inferred one — that's the point of declaring
// it. The exception is a shape inference is sure about (a list, a group, a
// number): if the data really holds one of those, the control has to match.
const STRUCTURAL = ['object', 'objects', 'list', 'boolean', 'number'];

function withDeclaredTypes(fields, declared, path) {
  if (!declared) return fields;
  return fields.map((field) => {
    const chosen = declared[[...path, field.key].join('.')];
    if (!chosen || STRUCTURAL.includes(field.type)) return field;
    return { ...field, type: chosen };
  });
}

// The collection-wide type wins unless this item's own value disagrees about
// its shape (a field that's a list here and a string there).
function bestType(collectionType, value) {
  const own = inferType(value);
  if (own === 'empty') return collectionType;
  const structural = ['object', 'objects', 'list', 'boolean', 'number'];
  if (structural.includes(own) || structural.includes(collectionType)) return own;
  // A logo the sniffer can't recognise ("/logo", "/img?id=2") is still the
  // collection's image field — keep the picker rather than dropping to a
  // bare text box for one odd value.
  if (collectionType === 'image' || collectionType === 'date') return collectionType;
  return collectionType === 'longtext' ? 'longtext' : own;
}

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

function FieldRow({ label, type, value, onChange, projectPath, depth = 0 }) {
  // Typing an 81st character turns a text field into a paragraph one, and
  // swapping <input> for <textarea> mid-word would take the caret with it.
  // The control only changes shape while the field is idle.
  const [focused, setFocused] = useState(false);
  const shown = useRef(type);
  if (!focused) shown.current = type;

  return (
    <div
      className={`cms-field ${shown.current}`}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
    >
      <div className="cms-field-head">
        <label>{label}</label>
      </div>
      <FieldControl
        type={shown.current}
        value={value}
        onChange={onChange}
        projectPath={projectPath}
        depth={depth}
      />
    </div>
  );
}

function FieldControl({ type, value, onChange, projectPath, depth }) {
  if (type === 'boolean') {
    return (
      <button
        type="button"
        className={`cms-toggle ${value ? 'on' : ''}`}
        onClick={() => onChange(!value)}
      >
        <span className="cms-toggle-knob" />
        <span className="cms-toggle-label">{value ? 'On' : 'Off'}</span>
      </button>
    );
  }

  if (type === 'number') {
    return (
      <input
        type="number"
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
      />
    );
  }

  if (type === 'image') {
    return (
      <AssetField
        value={value ?? ''}
        onChange={onChange}
        mediaKind="image"
        projectPath={projectPath}
        showModeToggle={false}
      />
    );
  }

  if (type === 'date') {
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value || '');
    return dateOnly || !value ? (
      <input type="date" value={value ?? ''} onChange={(e) => onChange(e.target.value)} />
    ) : (
      <input value={value ?? ''} onChange={(e) => onChange(e.target.value)} />
    );
  }

  if (type === 'link' || type === 'email' || type === 'phone') {
    return (
      <input
        type={type === 'link' ? 'url' : type === 'email' ? 'email' : 'tel'}
        value={value ?? ''}
        placeholder={type === 'link' ? 'https://' : type === 'email' ? 'name@site.com' : ''}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }

  if (type === 'color') {
    return (
      <div className="cms-color">
        <input
          type="color"
          value={/^#[0-9a-f]{6}$/i.test(value || '') ? value : '#000000'}
          onChange={(e) => onChange(e.target.value)}
        />
        <input
          value={value ?? ''}
          placeholder="#000000"
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
    );
  }

  if (type === 'longtext') {
    return (
      <AutoTextarea
        value={value ?? ''}
        minRows={3}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }

  if (type === 'list') {
    return <ListEditor value={Array.isArray(value) ? value : []} onChange={onChange} />;
  }

  if (type === 'object') {
    return (
      <GroupEditor
        value={isPlainObject(value) ? value : {}}
        onChange={onChange}
        projectPath={projectPath}
        depth={depth + 1}
      />
    );
  }

  if (type === 'objects') {
    return (
      <RepeaterEditor
        value={Array.isArray(value) ? value : []}
        onChange={onChange}
        projectPath={projectPath}
        depth={depth + 1}
      />
    );
  }

  return <input value={value ?? ''} onChange={(e) => onChange(e.target.value)} />;
}

// Array of plain values — tags, bullet points, feature lines.
function ListEditor({ value, onChange }) {
  return (
    <div className="cms-list">
      {value.map((entry, i) => (
        <div key={i} className="cms-list-row">
          <input
            value={entry ?? ''}
            onChange={(e) => {
              const next = [...value];
              next[i] = typeof entry === 'number' ? Number(e.target.value) : e.target.value;
              onChange(next);
            }}
          />
          <button
            className="ghost"
            title="Remove"
            onClick={() => onChange(value.filter((_, j) => j !== i))}
          >
            <CloseIcon size={10} />
          </button>
        </div>
      ))}
      <button className="cms-add" onClick={() => onChange([...value, ''])}>
        <PlusIcon size={11} /> Add
      </button>
    </div>
  );
}

// A nested object: its keys become fields one level in.
function GroupEditor({ value, onChange, projectPath, depth }) {
  const fields = fieldsOf([value]);
  return (
    <div className="cms-group-box">
      {fields.map((field) => (
        <FieldRow
          key={field.key}
          label={field.label}
          type={field.type}
          value={value[field.key]}
          projectPath={projectPath}
          depth={depth}
          onChange={(v) => onChange({ ...value, [field.key]: v })}
        />
      ))}
      {fields.length === 0 && <div className="cms-empty-inline">Empty group.</div>}
    </div>
  );
}

// Array of objects — a list inside an item (nav links, stats, steps). Each
// entry is one row showing its name; the fields behind it open in a dialog,
// so a long item doesn't push the rest of the form off the screen.
function RepeaterEditor({ value, onChange, projectPath, depth }) {
  const [openIndex, setOpenIndex] = useState(null);
  const [dragIndex, setDragIndex] = useState(null);
  const [dropIndex, setDropIndex] = useState(null);
  const dragFrom = useRef(null);

  const removeAt = (i) => {
    onChange(value.filter((_, j) => j !== i));
    if (openIndex === i) setOpenIndex(null);
    else if (openIndex != null && openIndex > i) setOpenIndex(openIndex - 1);
  };

  const move = (from, to) => {
    if (from == null || to == null || from === to) return;
    const next = [...value];
    const [moved] = next.splice(from, 1);
    next.splice(to > from ? to - 1 : to, 0, moved);
    onChange(next);
  };

  const add = () => {
    const next = [...value, blankItem(value)];
    onChange(next);
    setOpenIndex(next.length - 1); // straight into the new entry's fields
  };

  return (
    <div className="cms-repeater">
      {value.map((entry, i) => (
        <div
          key={i}
          className={`cms-repeat-row ${dropIndex === i ? 'drop-before' : ''}`}
          draggable
          onDragStart={(e) => {
            dragFrom.current = i;
            setDragIndex(i);
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('avb/cms-entry', String(i));
          }}
          onDragOver={(e) => {
            if (!dragging(e, 'cms-entry')) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            setDropIndex(edgeIndex(e, i));
          }}
          onDragEnd={() => {
            dragFrom.current = null;
            setDragIndex(null);
            setDropIndex(null);
          }}
          onDrop={(e) => {
            if (!dragging(e, 'cms-entry')) return;
            e.preventDefault();
            const from = dragFrom.current ?? Number(e.dataTransfer.getData('avb/cms-entry'));
            move(from, edgeIndex(e, i));
            dragFrom.current = null;
            setDragIndex(null);
            setDropIndex(null);
          }}
          onClick={() => setOpenIndex(i)}
        >
          <span className="cms-repeat-grip">
            <DragIcon size={11} />
          </span>
          <span className="cms-repeat-title">{titleOf(entry, i)}</span>
          <button
            className="ghost"
            title="Remove"
            onClick={(e) => {
              e.stopPropagation();
              removeAt(i);
            }}
          >
            <CloseIcon size={10} />
          </button>
          <ChevronRightIcon size={10} />
        </div>
      ))}

      <button className="cms-add" onClick={add}>
        <PlusIcon size={11} /> Add item
      </button>

      {openIndex != null && value[openIndex] !== undefined && (
        <NestedItemDialog
          entry={value[openIndex]}
          title={titleOf(value[openIndex], openIndex)}
          projectPath={projectPath}
          depth={depth}
          onChange={(next) => {
            const copy = [...value];
            copy[openIndex] = next;
            onChange(copy);
          }}
          onDelete={() => removeAt(openIndex)}
          onClose={() => setOpenIndex(null)}
        />
      )}
    </div>
  );
}

// One entry of a repeater, in a dialog. Edits apply as they're typed — the
// buttons are for leaving and removing, not for committing.
function NestedItemDialog({ entry, title, projectPath, depth, onChange, onDelete, onClose }) {
  const overlayRef = useRef(null);
  const fields = fieldsOf([entry]);

  // Escape closes the innermost dialog only: an entry can itself hold a
  // repeater, so these stack.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      const open = document.querySelectorAll('.cms-modal-overlay');
      if (open[open.length - 1] !== overlayRef.current) return;
      e.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      ref={overlayRef}
      className="modal-overlay cms-modal-overlay"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="modal cms-modal">
        <div className="modal-header cms-modal-header">
          <span>{title}</span>
          <button className="ghost" title="Close" onClick={onClose}>
            <CloseIcon size={12} />
          </button>
        </div>
        <div className="modal-body cms-modal-body">
          {fields.map((field) => (
            <FieldRow
              key={field.key}
              label={field.label}
              type={field.type}
              value={entry[field.key]}
              projectPath={projectPath}
              depth={depth}
              onChange={(v) => onChange({ ...entry, [field.key]: v })}
            />
          ))}
          {fields.length === 0 && (
            <div className="cms-empty-inline">
              These items have no fields yet — add them in the collection's settings.
            </div>
          )}
        </div>
        <div className="modal-footer cms-modal-footer">
          <button className="ghost danger" onClick={onDelete}>
            <TrashIcon size={12} /> Delete
          </button>
          <button className="primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

function AddFieldRow({ onAdd, compact }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className={`cms-add ${compact ? 'compact' : ''}`} onClick={() => setOpen(true)}>
        <PlusIcon size={11} /> Add field
      </button>
      {open && (
        <NewFieldDialog
          onAdd={(key, type) => {
            onAdd(key, type);
            setOpen(false);
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

// Pick the type first — it decides what the field can hold, and it can't be
// changed afterwards — then name it.
function NewFieldDialog({ onAdd, onClose }) {
  const [type, setType] = useState(null);
  const [name, setName] = useState('');
  const overlayRef = useRef(null);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      const open = document.querySelectorAll('.cms-modal-overlay');
      if (open[open.length - 1] !== overlayRef.current) return;
      e.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const info = type ? typeInfo(type) : null;
  const submit = () => {
    const key = keyFor(name);
    if (key) onAdd(key, type);
  };

  return (
    <div
      ref={overlayRef}
      className="modal-overlay cms-modal-overlay"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="modal cms-modal cms-type-modal">
        <div className="modal-header cms-modal-header">
          {type && (
            <button className="ghost" title="Back to field types" onClick={() => setType(null)}>
              <ChevronLeftIcon size={13} />
            </button>
          )}
          <span>{type ? `New ${info.label} field` : 'Choose a field type'}</span>
          <button className="ghost" title="Close" onClick={onClose}>
            <CloseIcon size={12} />
          </button>
        </div>

        {!type ? (
          <div className="cms-type-grid">
            {FIELD_TYPES.map(({ value, label, Icon, hint }) => (
              <button key={value} className="cms-type-tile" onClick={() => setType(value)}>
                <Icon size={18} />
                <span className="cms-type-name">{label}</span>
                <span className="cms-type-hint">{hint}</span>
              </button>
            ))}
          </div>
        ) : (
          <>
            <div className="modal-body">
              <div>
                <label>Name</label>
                <input
                  autoFocus
                  value={name}
                  placeholder={`e.g. ${info.label === 'Text' ? 'Subtitle' : info.label}`}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') submit();
                  }}
                />
              </div>
              {keyFor(name) && (
                <div className="cms-note" style={{ margin: 0 }}>
                  Your code reads this as <code>{keyFor(name)}</code>.
                </div>
              )}
            </div>
            <div className="modal-footer">
              <button className="ghost" onClick={onClose}>
                Cancel
              </button>
              <button className="primary" onClick={submit} disabled={!keyFor(name)}>
                Add field
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
