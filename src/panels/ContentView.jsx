import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  PlusIcon,
  CloseIcon,
  ChevronRightIcon,
  TrashIcon,
  DragIcon,
  CheckIcon,
  HideIcon,
  HelpCircleIcon,
} from '../ui/Icons.jsx';
import AutoTextarea from '../ui/AutoTextarea.jsx';
import CodeEditor from '../ui/CodeEditor.jsx';
import AssetField from '../ui/AssetField.jsx';
import ExprInput from '../ui/ExprInput.jsx';
import useListReorder from '../ui/useListReorder.js';
import {
  collectionFields,
  describeField,
  editsBetween,
  fieldIssue,
  hintFor,
  labelize,
  memberFor,
} from '../contentSchema.js';

// The editor for an Astro content collection.
//
// Everything it draws comes from the project's own content config: which
// collections exist, what each entry may hold, and which of them can be written
// at all (see electron/contentConfig.js). That is the difference between this
// and the JSON editor next door — there, the shape is guessed from the data,
// and a field is whatever the values look like. Here the schema is the truth,
// so a field can be required, bounded, referenced, one of twelve kinds of
// block, or not editable at all, and the form says so before the build does.
//
// A save writes the fields that changed and nothing else. That rule is worth
// stating plainly because breaking it is invisible: a form that hands back its
// whole state writes every default into every file it touches, and turns a
// one-word edit into a diff nobody can review.

const SAVE_DELAY = 400;
const CHECK_DELAY = 250;

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const cleanMessage = (err) =>
  String(err?.message || err).replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');
const dirOf = (file) => file.split('/').slice(0, -1).join('/');

// The value a new field starts at, taken from the schema so a required field
// starts valid where it can.
function blankFor(field) {
  if (!field) return '';
  if ('default' in field) return field.default;
  switch (field.control) {
    case 'boolean':
      return false;
    case 'number':
      return field.constraints?.min ?? 0;
    case 'enum':
      return field.options?.[0] ?? '';
    case 'tags':
    case 'references':
    case 'list':
      return [];
    case 'record':
      return {};
    case 'object':
      return Object.fromEntries(
        (field.fields || []).filter((f) => f.required).map((f) => [f.key, blankFor(f)])
      );
    case 'union': {
      const member = field.members?.[0];
      if (!member) return {};
      return {
        ...(field.discriminator ? { [field.discriminator]: member.value } : {}),
        ...Object.fromEntries(member.fields.filter((f) => f.required).map((f) => [f.key, blankFor(f)])),
      };
    }
    default:
      return '';
  }
}

// Entries of another collection, for a reference field. Fetched once per
// collection and shared by every picker pointing at it.
const targetCache = new Map();
function useTargets(projectPath, name) {
  const [targets, setTargets] = useState(() => targetCache.get(`${projectPath}:${name}`) || null);
  useEffect(() => {
    if (!name) return undefined;
    const key = `${projectPath}:${name}`;
    if (targetCache.has(key)) {
      setTargets(targetCache.get(key));
      return undefined;
    }
    let alive = true;
    window.avb
      .contentTargets({ projectPath, name })
      .then(({ targets: list }) => {
        targetCache.set(key, list || []);
        if (alive) setTargets(list || []);
      })
      .catch(() => alive && setTargets([]));
    return () => {
      alive = false;
    };
  }, [projectPath, name]);
  return targets;
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

function ReferenceField({ value, field, projectPath, onChange }) {
  const targets = useTargets(projectPath, field.target);
  const known = targets?.some((t) => t.id === value);
  return (
    <div className="content-ref">
      <select
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value === '' ? (field.nullable ? null : undefined) : e.target.value)}
      >
        <option value="">{field.nullable ? 'None' : 'Choose an entry…'}</option>
        {(targets || []).map((t) => (
          <option key={t.id} value={t.id}>
            {t.title === t.id ? t.id : `${t.title} — ${t.id}`}
          </option>
        ))}
        {/* An entry that has been deleted or renamed is still what the file
            says, and hiding it would quietly rewrite the value on next save. */}
        {value && targets && !known && <option value={value}>{value} (missing)</option>}
      </select>
      {value && targets && !known && (
        <div className="content-warn">Nothing in {field.target} has the id “{value}”.</div>
      )}
    </div>
  );
}

function ReferenceList({ value, field, projectPath, onChange }) {
  const targets = useTargets(projectPath, field.target);
  const list = Array.isArray(value) ? value : [];
  const remaining = (targets || []).filter((t) => !list.includes(t.id));
  return (
    <div className="content-reflist">
      {list.map((id, index) => {
        const target = (targets || []).find((t) => t.id === id);
        return (
          <div key={`${id}-${index}`} className="content-chip">
            <span className={target ? '' : 'missing'}>{target ? target.title : `${id} (missing)`}</span>
            <button className="ghost" title="Remove" onClick={() => onChange(list.filter((_, i) => i !== index))}>
              <CloseIcon size={9} />
            </button>
          </div>
        );
      })}
      <select
        value=""
        onChange={(e) => e.target.value && onChange([...list, e.target.value])}
        disabled={!remaining.length}
      >
        <option value="">{remaining.length ? 'Add…' : 'Nothing left to add'}</option>
        {remaining.map((t) => (
          <option key={t.id} value={t.id}>
            {t.title === t.id ? t.id : `${t.title} — ${t.id}`}
          </option>
        ))}
      </select>
    </div>
  );
}

function TagsField({ value, onChange }) {
  const list = Array.isArray(value) ? value : [];
  const [draft, setDraft] = useState('');
  const add = () => {
    const next = draft.trim();
    if (!next) return;
    onChange([...list, next]);
    setDraft('');
  };
  return (
    <div className="content-tags">
      {list.map((tag, index) => (
        <span key={`${tag}-${index}`} className="content-chip">
          {tag}
          <button className="ghost" title="Remove" onClick={() => onChange(list.filter((_, i) => i !== index))}>
            <CloseIcon size={9} />
          </button>
        </span>
      ))}
      <input
        value={draft}
        placeholder="Add…"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={add}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            add();
          }
          if (e.key === 'Backspace' && !draft && list.length) onChange(list.slice(0, -1));
        }}
      />
    </div>
  );
}

// An object whose keys the user names: feature flags, add-ons.
function RecordField({ value, field, ctx, path, onChange }) {
  const record = isPlainObject(value) ? value : {};
  const [adding, setAdding] = useState('');
  return (
    <div className="cms-group-box">
      {Object.entries(record).map(([key, entry]) => (
        <div key={key} className="content-record-row">
          <div className="content-record-head">
            <input
              className="content-key"
              value={key}
              onChange={(e) => {
                const next = {};
                for (const [k, v] of Object.entries(record)) next[k === key ? e.target.value : k] = v;
                onChange(next);
              }}
            />
            <button className="ghost danger" title="Remove" onClick={() => {
              const next = { ...record };
              delete next[key];
              onChange(next);
            }}>
              <TrashIcon size={11} />
            </button>
          </div>
          <FieldControl
            field={{ ...field.value, key }}
            value={entry}
            ctx={ctx}
            path={[...path, key]}
            onChange={(v) => onChange({ ...record, [key]: v })}
          />
        </div>
      ))}
      <div className="content-record-add">
        <input
          value={adding}
          placeholder="New key…"
          onChange={(e) => setAdding(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || !adding.trim()) return;
            onChange({ ...record, [adding.trim()]: blankFor(field.value) });
            setAdding('');
          }}
        />
        <button
          className="cms-add"
          disabled={!adding.trim()}
          onClick={() => {
            onChange({ ...record, [adding.trim()]: blankFor(field.value) });
            setAdding('');
          }}
        >
          <PlusIcon size={11} /> Add
        </button>
      </div>
    </div>
  );
}

// A value that can be one of several shapes. Switching kind keeps whatever the
// new shape also has, and remembers the rest: picking the wrong kind by
// accident should not be how an entry loses its content.
function UnionField({ field, value, ctx, path, onChange }) {
  const member = memberFor(field, value);
  const stash = useRef(new Map());
  const key = field.discriminator;
  const current = isPlainObject(value) ? value : {};

  const switchTo = (next) => {
    const target = field.members.find((m) => String(m.value) === String(next));
    if (!target) return;
    stash.current.set(String(current[key]), current);
    const remembered = stash.current.get(String(target.value)) || {};
    const keep = {};
    for (const f of target.fields) {
      if (f.key in remembered) keep[f.key] = remembered[f.key];
      else if (f.key in current) keep[f.key] = current[f.key];
      else if (f.required) keep[f.key] = blankFor(f);
    }
    onChange({ ...(key ? { [key]: target.value } : {}), ...keep });
  };

  return (
    <div className="content-union">
      {key && (
        <div className="content-union-head">
          <label>{labelize(key)}</label>
          <select value={String(current[key] ?? '')} onChange={(e) => switchTo(e.target.value)}>
            {field.members.map((m) => (
              <option key={String(m.value)} value={String(m.value)}>
                {m.label}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="cms-group-box">
        {(member?.fields || []).map((f) => (
          <FieldRow
            key={f.key}
            field={f}
            value={current[f.key]}
            ctx={ctx}
            path={[...path, f.key]}
            onChange={(v) =>
              onChange(v === undefined ? omit(current, f.key) : { ...current, [f.key]: v })
            }
          />
        ))}
      </div>
    </div>
  );
}

const omit = (object, key) => {
  const next = { ...object };
  delete next[key];
  return next;
};

// A repeatable list: blocks on a landing page, steps in a recipe, responses on
// an endpoint. Item bounds come from the schema, so "add" stops at the maximum
// and the last item cannot be removed below the minimum.
function ListField({ field, value, ctx, path, onChange }) {
  const list = Array.isArray(value) ? value : [];
  const [openIndex, setOpenIndex] = useState(null);
  const item = field.item || {};
  const min = field.constraints?.minItems ?? 0;
  const max = field.constraints?.maxItems ?? Infinity;
  const complex = ['object', 'union'].includes(item.control);

  const move = (from, to) => {
    if (from == null || to == null || from === to) return;
    const next = [...list];
    const [moved] = next.splice(from, 1);
    next.splice(to > from ? to - 1 : to, 0, moved);
    onChange(next);
  };
  const reorder = useListReorder({ count: list.length, onMove: move });

  const titleOf = (entry, index) => {
    if (!isPlainObject(entry)) return String(entry ?? `Item ${index + 1}`);
    if (item.control === 'union' && item.discriminator) {
      const member = item.members.find((m) => m.value === entry[item.discriminator]);
      const label = member?.label || entry[item.discriminator];
      const name = entry.heading || entry.title || entry.label || entry.id;
      return name ? `${label} — ${name}` : label;
    }
    for (const key of ['title', 'name', 'label', 'heading', 'question', 'status']) {
      if (entry[key]) return String(entry[key]);
    }
    return `Item ${index + 1}`;
  };

  if (!complex) {
    return (
      <div className="content-simple-list">
        {list.map((entry, index) => (
          <div key={index} className="content-simple-row">
            <FieldControl
              field={item}
              value={entry}
              ctx={ctx}
              path={[...path, index]}
              onChange={(v) => onChange(list.map((old, i) => (i === index ? v : old)))}
            />
            <button
              className="ghost danger"
              title="Remove"
              disabled={list.length <= min}
              onClick={() => onChange(list.filter((_, i) => i !== index))}
            >
              <TrashIcon size={11} />
            </button>
          </div>
        ))}
        <button className="cms-add" disabled={list.length >= max} onClick={() => onChange([...list, blankFor(item)])}>
          <PlusIcon size={11} /> Add
        </button>
      </div>
    );
  }

  return (
    <div className="cms-repeater">
      {list.map((entry, index) => (
        <div
          key={index}
          className={`cms-repeat-row ${reorder.rowClass(index)}`}
          {...reorder.rowProps(index)}
          onClick={() => setOpenIndex(index === openIndex ? null : index)}
        >
          <span className="cms-repeat-grip">
            <DragIcon size={11} />
          </span>
          <span className="cms-repeat-title">{titleOf(entry, index)}</span>
          <button
            className="ghost"
            title="Remove"
            disabled={list.length <= min}
            onClick={(e) => {
              e.stopPropagation();
              onChange(list.filter((_, i) => i !== index));
              setOpenIndex(null);
            }}
          >
            <CloseIcon size={10} />
          </button>
          <ChevronRightIcon size={10} />
        </div>
      ))}
      {openIndex != null && list[openIndex] !== undefined && (
        <div className="content-open-item">
          <FieldControl
            field={item}
            value={list[openIndex]}
            ctx={ctx}
            path={[...path, openIndex]}
            onChange={(v) => onChange(list.map((old, i) => (i === openIndex ? v : old)))}
          />
        </div>
      )}
      <button
        className="cms-add"
        disabled={list.length >= max}
        onClick={() => {
          onChange([...list, blankFor(item)]);
          setOpenIndex(list.length);
        }}
      >
        <PlusIcon size={11} /> Add {field.label ? field.label.replace(/s$/, '').toLowerCase() : 'item'}
      </button>
    </div>
  );
}

function FieldControl({ field, value, ctx, path, onChange }) {
  const set = (v) => onChange(v);

  switch (field.control) {
    case 'boolean':
      return (
        <button type="button" className={`cms-toggle ${value ? 'on' : ''}`} onClick={() => set(!value)}>
          <span className="cms-toggle-knob" />
          <span className="cms-toggle-label">{value ? 'On' : 'Off'}</span>
        </button>
      );
    case 'number':
      return (
        <input
          type="number"
          step={field.constraints?.integer ? 1 : 'any'}
          min={field.constraints?.min}
          max={field.constraints?.max}
          value={value ?? ''}
          placeholder={'default' in field ? String(field.default) : ''}
          onChange={(e) => set(e.target.value === '' ? undefined : Number(e.target.value))}
        />
      );
    case 'enum':
      return (
        <select value={value ?? ''} onChange={(e) => set(e.target.value || undefined)}>
          {!field.required && <option value="">Not set</option>}
          {(field.options || []).map((option) => (
            <option key={String(option)} value={String(option)}>
              {labelize(String(option))}
            </option>
          ))}
        </select>
      );
    case 'date':
      return (
        <input
          type={String(value || '').includes('T') ? 'text' : 'date'}
          value={value == null ? '' : String(value)}
          onChange={(e) => set(e.target.value || undefined)}
        />
      );
    case 'image':
      return (
        <AssetField
          value={value ?? ''}
          mediaKind="image"
          projectPath={ctx.projectPath}
          // The path is written relative to the entry's own file, which is how
          // Astro follows it back into src/ — and why the same image is spelled
          // differently in two entries at different depths.
          baseDir={ctx.baseDir}
          onChange={(v) => set(v || undefined)}
        />
      );
    case 'reference':
      return <ReferenceField field={field} value={value} projectPath={ctx.projectPath} onChange={set} />;
    case 'references':
      return <ReferenceList field={field} value={value} projectPath={ctx.projectPath} onChange={set} />;
    case 'tags':
      return <TagsField value={value} onChange={set} />;
    case 'markdown':
      return <AutoTextarea value={value ?? ''} minRows={3} onChange={(e) => set(e.target.value)} />;
    case 'longtext':
      return <AutoTextarea value={value ?? ''} minRows={2} onChange={(e) => set(e.target.value)} />;
    case 'code':
      return (
        <ExprInput
          value={value ?? ''}
          syncValue={value ?? ''}
          onChange={set}
          onCommit={(v) => v !== value && set(v)}
        />
      );
    case 'object':
      return (
        <div className="cms-group-box">
          {(field.fields || []).map((f) => (
            <FieldRow
              key={f.key}
              field={f}
              value={isPlainObject(value) ? value[f.key] : undefined}
              ctx={ctx}
              path={[...path, f.key]}
              onChange={(v) => {
                const base = isPlainObject(value) ? value : {};
                set(v === undefined ? omit(base, f.key) : { ...base, [f.key]: v });
              }}
            />
          ))}
        </div>
      );
    case 'record':
      return <RecordField field={field} value={value} ctx={ctx} path={path} onChange={set} />;
    case 'union':
      return <UnionField field={field} value={value} ctx={ctx} path={path} onChange={set} />;
    case 'list':
      return <ListField field={field} value={value} ctx={ctx} path={path} onChange={set} />;
    case 'const':
      return <input value={String(field.const)} readOnly />;
    case 'url':
    case 'email':
    case 'text':
    default:
      return (
        <input
          value={value == null ? '' : String(value)}
          placeholder={'default' in field ? String(field.default) : ''}
          spellCheck={field.control !== 'text'}
          onChange={(e) => set(e.target.value === '' ? undefined : e.target.value)}
        />
      );
  }
}

function FieldRow({ field, value, ctx, path, onChange }) {
  const present = value !== undefined;
  const issue = ctx.issueAt(path) || (present ? fieldIssue(field, value) : field.required ? 'Required' : null);
  const hint = hintFor(field);
  // A field the file's own parser invented — it is in the entry but not in the
  // file, so there is nowhere to write it back to.
  const synthesized = ctx.parsed && !ctx.inFile(path);

  // An optional field that is not in the file is offered rather than shown: an
  // empty box would be written as an empty value, and absence is a different
  // thing from empty.
  if (!present && !field.required && !ctx.expanded.has(path.join('.'))) {
    return (
      <div className="content-add-field">
        <button className="ghost" onClick={() => ctx.expand(path.join('.'))}>
          <PlusIcon size={10} /> {field.label}
        </button>
        {'default' in field && <span className="content-default">defaults to {JSON.stringify(field.default)}</span>}
      </div>
    );
  }

  return (
    <div className={`cms-field ${field.control} ${issue ? 'has-issue' : ''}`}>
      <div className="cms-field-head">
        <label>
          {field.label}
          {field.required && <span className="content-required" title="Required"> *</span>}
        </label>
        {field.nullable && (
          <button
            className={`content-none ${value === null ? 'on' : ''}`}
            title="Write null — the key stays, with no value"
            onClick={() => onChange(value === null ? blankFor(field) : null)}
          >
            None
          </button>
        )}
        {!field.required && present && (
          <button className="ghost content-clear" title="Remove this field" onClick={() => onChange(undefined)}>
            <CloseIcon size={9} />
          </button>
        )}
        {synthesized && (
          <span className="content-note" title={ctx.parserNote}>
            <HideIcon size={10} /> from the parser
          </span>
        )}
      </div>
      {value === null ? (
        <div className="content-null">None</div>
      ) : (
        <FieldControl field={field} value={value} ctx={ctx} path={path} onChange={onChange} />
      )}
      {issue ? <div className="content-issue">{issue}</div> : hint ? <div className="content-hint">{hint}</div> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

export default function ContentView({ project, name, hidden, showToast, onClose, onSaved }) {
  const [state, setState] = useState(null); // { collection, entries, ... }
  const [sel, setSel] = useState(0);
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState(null); // { data, body } being edited
  const [issues, setIssues] = useState([]);
  const [saved, setSaved] = useState(false);
  const [expanded, setExpanded] = useState(new Set());
  const saveTimer = useRef(null);
  const checkTimer = useRef(null);
  // A rename is shown before it is done: the id is what other entries point at,
  // so the plan says how many of them this touches (see electron/contentRefs.js).
  const [rename, setRename] = useState(null); // { to } while typing, then { plan }

  const load = useCallback(async () => {
    const result = await window.avb.contentEntries({ projectPath: project.path, name });
    setState(result);
    setSel((s) => Math.min(s, Math.max(0, (result.entries?.length || 1) - 1)));
  }, [project.path, name]);

  useEffect(() => {
    load();
    return window.avb.onCmsChanged(load);
  }, [load]);

  useEffect(() => {
    setDraft(null);
    setIssues([]);
    setExpanded(new Set());
  }, [name, sel]);

  const entries = state?.entries || [];
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return entries.map((entry, index) => ({ entry, index }));
    return entries
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => `${entry.title} ${entry.id}`.toLowerCase().includes(q));
  }, [entries, query]);

  const entry = entries[sel];
  const data = draft ? draft.data : entry?.data;
  const body = draft && draft.body !== undefined ? draft.body : entry?.body;

  const schema = state?.collection?.schema || null;
  const shape = useMemo(() => collectionFields(schema), [schema]);

  // Fields for an entry that has no schema at all: whatever the file holds.
  const freeformFields = useMemo(() => {
    if (!shape.freeform || !isPlainObject(data)) return [];
    return Object.keys(data).map((key) =>
      describeField(typeof data[key] === 'number' ? { type: 'number' } : { type: 'string' }, key, {})
    );
  }, [shape.freeform, data]);

  const save = useCallback(
    async (next) => {
      if (!entry) return;
      const edits = editsBetween(entry.data, next.data);
      const bodyChanged = next.body !== undefined && next.body !== entry.body;
      if (!edits.length && !bodyChanged) return;
      try {
        await window.avb.writeContentEntry({
          projectPath: project.path,
          entry: { file: entry.file, locator: entry.locator },
          edits,
          body: bodyChanged ? next.body : undefined,
        });
        setSaved(true);
        setTimeout(() => setSaved(false), 1200);
        onSaved?.();
        // What is on disk is now what is on screen, so the next save compares
        // against it rather than against the file as it was opened.
        setState((s) =>
          s && {
            ...s,
            entries: s.entries.map((e, i) =>
              i === sel ? { ...e, data: next.data, body: next.body ?? e.body } : e
            ),
          }
        );
      } catch (err) {
        showToast?.(String(err?.message || err).replace(/^Error invoking remote method '[^']+':\s*/, ''), 'error');
      }
    },
    [entry, project.path, sel, onSaved, showToast]
  );

  const change = useCallback(
    (next) => {
      setDraft(next);
      clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => save(next), SAVE_DELAY);
      clearTimeout(checkTimer.current);
      checkTimer.current = setTimeout(async () => {
        const result = await window.avb.validateContentEntry({
          projectPath: project.path,
          collection: name,
          data: next.data,
        });
        setIssues(result?.issues || []);
      }, CHECK_DELAY);
    },
    [save, project.path, name]
  );

  useEffect(() => () => clearTimeout(saveTimer.current), []);

  const ctx = useMemo(
    () => ({
      projectPath: project.path,
      baseDir: entry ? dirOf(entry.file) : '',
      parsed: !!state?.parsed,
      parserNote: state?.parserNote,
      expanded,
      expand: (key) => setExpanded((s) => new Set(s).add(key)),
      // Whether a path exists in the record the file holds, which is how a
      // field invented by a parser is told apart from one that is simply empty.
      inFile: (path) => {
        let node = entry?.data;
        for (const key of path) {
          if (!node || typeof node !== 'object' || !(key in node)) return false;
          node = node[key];
        }
        return true;
      },
      issueAt: (path) => {
        const found = issues.find((i) => i.path.length === path.length && i.path.every((p, x) => String(p) === String(path[x])));
        return found ? found.message : null;
      },
    }),
    [project.path, entry, state, expanded, issues]
  );

  const formIssues = issues.filter(
    (issue) => !issue.path.length || !(shape.fields || []).some((f) => f.key === issue.path[0])
  );

  if (!state) return <div className={`cms-view ${hidden ? 'hidden' : ''}`} />;

  const readOnly = state.readOnly;

  return (
    <div className={`cms-view content-view ${hidden ? 'hidden' : ''}`}>
      <div className="cms-items">
        <div className="cms-items-head">
          <span className="cms-items-title">{labelize(name)}</span>
          <span className="content-count">{entries.length}</span>
        </div>
        {entries.length > 7 && (
          <div className="cms-search">
            <input value={query} placeholder="Search entries" onChange={(e) => setQuery(e.target.value)} />
          </div>
        )}
        <div className="cms-item-list">
          {filtered.map(({ entry: row, index }) => (
            <div
              key={row.id}
              className={`cms-item ${index === sel ? 'on' : ''}`}
              onClick={() => setSel(index)}
            >
              <span className="cms-item-title">{row.title}</span>
              <ChevronRightIcon size={10} />
            </div>
          ))}
          {!entries.length && (
            <div className="props-empty">
              {readOnly ? 'Nothing to show — this collection is built, not stored.' : 'No entries yet.'}
            </div>
          )}
        </div>
      </div>

      <div className="cms-detail">
        <div className="cms-detail-head">
          <button className="ghost cms-back" title="Close" onClick={onClose}>
            <CloseIcon size={13} />
          </button>
          <span className="cms-detail-title">{entry ? entry.title : labelize(name)}</span>
          <span className={`cms-saved ${saved ? 'on' : ''}`}>
            <CheckIcon size={11} /> Saved
          </span>
          {entry && !readOnly && (
            <button
              className="ghost content-id"
              title="The id other entries point at"
              onClick={() => setRename({ to: entry.id, plan: null, error: null })}
            >
              {entry.id}
            </button>
          )}
          <span className="cms-detail-path">{entry ? entry.file : state.collection?.loader?.file || ''}</span>
        </div>

        <div className="cms-detail-body">
          {readOnly && (
            <div className="content-banner">
              <HideIcon size={12} />
              <span>{state.reason}</span>
            </div>
          )}
          {state.parserNote && (
            <div className="content-banner soft">
              <HelpCircleIcon size={12} />
              <span>{state.parserNote}</span>
            </div>
          )}
          {state.idNote && (
            <div className="content-banner soft">
              <HelpCircleIcon size={12} />
              <span>{state.idNote}</span>
            </div>
          )}
          {state.collection?.error && <div className="cms-error">{state.collection.error}</div>}

          {rename && entry && (
            <div className="content-rename">
              <div className="content-rename-row">
                <label>Id</label>
                <input
                  autoFocus
                  value={rename.to}
                  spellCheck={false}
                  onChange={(e) => setRename({ ...rename, to: e.target.value, plan: null, error: null })}
                />
                <button
                  className="ghost"
                  disabled={!rename.to.trim() || rename.to === entry.id}
                  onClick={async () => {
                    try {
                      const plan = await window.avb.contentRenamePlan({
                        projectPath: project.path,
                        name,
                        from: entry.id,
                        to: rename.to.trim(),
                      });
                      setRename({ ...rename, plan, error: null });
                    } catch (err) {
                      setRename({ ...rename, plan: null, error: cleanMessage(err) });
                    }
                  }}
                >
                  Check
                </button>
                <button className="ghost" onClick={() => setRename(null)}>
                  Cancel
                </button>
              </div>
              {rename.error && <div className="content-issue">{rename.error}</div>}
              {rename.plan && (
                <div className="content-rename-plan">
                  <div>
                    {rename.plan.move.kind === 'file'
                      ? `The file becomes ${rename.plan.move.to}.`
                      : rename.plan.move.kind === 'generated'
                        ? rename.plan.move.note
                        : 'The id is written inside its data file.'}
                  </div>
                  <div>
                    {rename.plan.pointers.length === 0
                      ? 'Nothing else points at this entry.'
                      : `${rename.plan.pointers.length} reference${rename.plan.pointers.length === 1 ? '' : 's'} will be updated:`}
                  </div>
                  {rename.plan.pointers.slice(0, 12).map((p, i) => (
                    <div key={i} className="content-pointer">
                      {p.collection} › {p.entryTitle} › {p.path.join('.')}
                    </div>
                  ))}
                  {rename.plan.pointers.length > 12 && (
                    <div className="content-pointer">and {rename.plan.pointers.length - 12} more</div>
                  )}
                  {!!rename.plan.imageEdits?.length && (
                    <div>
                      {rename.plan.imageEdits.length} image path
                      {rename.plan.imageEdits.length === 1 ? '' : 's'} rewritten for the new folder.
                    </div>
                  )}
                  <button
                    className="primary"
                    onClick={async () => {
                      try {
                        await window.avb.renameContentEntry({
                          projectPath: project.path,
                          name,
                          from: entry.id,
                          to: rename.to.trim(),
                        });
                        setRename(null);
                        await load();
                        onSaved?.();
                      } catch (err) {
                        setRename({ ...rename, error: cleanMessage(err) });
                      }
                    }}
                  >
                    Rename and update {rename.plan.pointers.length} pointer
                    {rename.plan.pointers.length === 1 ? '' : 's'}
                  </button>
                </div>
              )}
            </div>
          )}

          {formIssues.length > 0 && (
            <div className="cms-error">
              {formIssues.map((issue, i) => (
                <div key={i}>
                  {issue.path.length ? `${issue.path.join(' › ')}: ` : ''}
                  {issue.message}
                </div>
              ))}
            </div>
          )}

          {entry && (
            <div className="cms-card">
              <h3>{shape.freeform ? 'Frontmatter' : 'Fields'}</h3>
              {shape.union ? (
                <UnionField
                  field={shape.union}
                  value={data}
                  ctx={ctx}
                  path={[]}
                  onChange={(v) => change({ data: v, body })}
                />
              ) : (
                (shape.freeform ? freeformFields : shape.fields).map((field) => (
                  <FieldRow
                    key={field.key}
                    field={field}
                    value={isPlainObject(data) ? data[field.key] : undefined}
                    ctx={ctx}
                    path={[field.key]}
                    onChange={(v) =>
                      change({
                        data: v === undefined ? omit(data || {}, field.key) : { ...(data || {}), [field.key]: v },
                        body,
                      })
                    }
                  />
                ))
              )}
              {!shape.union && !shape.fields.length && !freeformFields.length && (
                <div className="props-empty">This collection has no fields.</div>
              )}
            </div>
          )}

          {entry?.hasBody && (
            <div className="cms-card">
              <h3>Body</h3>
              <div className="content-body-note">
                Markdown, written to the file exactly as it is typed here.
              </div>
              {/* The body is the one field that is a document rather than a
                  value: headings, fences, links, and in an .mdx file a run of
                  imports and components. Keyed by entry so switching one does
                  not carry the previous body's undo history over. */}
              <div className="content-body-editor">
                <CodeEditor
                  key={entry.rel || entry.id}
                  language="markdown"
                  value={body ?? ''}
                  onChange={(text) => change({ data, body: text })}
                />
              </div>
            </div>
          )}

          {!entry && !readOnly && <div className="props-empty">Select an entry to edit it.</div>}
        </div>
      </div>
    </div>
  );
}
