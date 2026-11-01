import Popup from '../../ui/Popup';
import { dataPickerPosition } from './dataPickerPosition';
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { MapNode } from '../../../shared/page/pageNode';
import type { RichContext } from './RichContent';
import type { ExprInputAPI } from '../../ui/ExprInput';
import type { FieldPosition, SourceContext } from './propBindings';
import { assert } from '../../../shared/core/assert';
import { LIMITS } from '../../../shared/core/limits';
import { HTML_TAGS } from '../../editor/elementSchemas';
import { dataTree, listsOnly } from '../../editor/dataSuggest';
import ExprInput from '../../ui/ExprInput';
import { BindHandle, FieldDataPicker, SourceEditButton, referencedName } from './propBindings';
import { VarSourceEditor } from './BindingEditors';
import { useLoopSourceInspection } from './useLoopSourceInspection';
import { elementIcon, astroAssetIcon, LayoutIcon, ElementComponentIcon, CodeIcon, TagIcon } from '../../ui/Icons';

export interface Rename {
  readonly from: string;
  readonly to: string;
}
export type SetText = (value: string, renames?: readonly Rename[]) => void;
interface MapEditorProps {
  readonly node: MapNode;
  readonly loopContext?: RichContext | undefined;
  readonly bindContext?: RichContext | undefined;
  readonly dataContext?: SourceContext | undefined;
  readonly onSetText: SetText;
}
interface MapFields {
  readonly data: string;
  readonly item: string;
  readonly index: string;
}
type MapPatch = Pick<MapFields, 'data'> | Pick<MapFields, 'item'> | Pick<MapFields, 'index'>;
interface MapInsert {
  readonly field: 'data' | 'code';
  readonly pos: FieldPosition;
}
export interface TagOption {
  readonly name: string;
  readonly kind?: string;
}
export interface TagFieldProps {
  readonly tag: string;
  readonly options?: readonly TagOption[] | undefined;
  readonly onChangeTag: (name: string) => void | boolean | Promise<void | boolean>;
}
const noLabelActivation = (event: React.MouseEvent<HTMLLabelElement>) => event.preventDefault();

// Parses a loop head like `service.tags.map((tag) => (` or
// `items.filter(i => i.on).map((item, index) => (` into friendly fields.
// The data part is any expression, so filtered/sorted collections still fit;
// the single parameter may be bare — `items.map(item => (` — the way a
// one-argument arrow is often written. Only destructured params or non-arrow
// callbacks fall back to code.
export function parseMapHead(head: string) {
  assert(head.length <= LIMITS.nodeValueCharsMax, 'MapEditor: head limit exceeded');
  const match = String(head)
    .trim()
    .match(/^([\s\S]+?)\.map\(\s*(?:\(\s*([\w$]+)\s*(?:,\s*([\w$]+)\s*)?\)|([\w$]+))\s*=>\s*\($/);
  if (!match?.[1]) {
    return undefined;
  }
  const item = match[2] || match[4];
  if (!item) {
    return undefined;
  }
  return { data: match[1].trim(), item, index: match[3] || '' };
}

// The leading name in an expression — what the value is a list OF, before
// anything is done to it. `posts.filter(p => p.draft)[0]` is `posts`; a lone
// `Astro.props.items` is all of it.
const SOURCE_RE = /^\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/;

export function sourceChip(value: string) {
  assert(value.length <= LIMITS.nodeValueCharsMax, 'MapEditor: source limit exceeded');
  const text = String(value || '').trim();
  if (!text || text === NO_SOURCE) {
    return '';
  }
  const match = SOURCE_RE.exec(text);
  if (!match?.[1]) {
    return '';
  }
  let name = match[1];
  // A segment that is called is not part of the path: `posts.filter(…)` is
  // `posts`, done to — and a call on the whole thing (`getPosts()`) names a
  // function, which is not a source anything can be swapped for.
  while (text[name.length] === '(') {
    // Each pass removes a segment, so the source length bounds traversal.
    const at = name.lastIndexOf('.');
    if (at < 0) {
      return '';
    }
    name = name.slice(0, at);
  }
  return name;
}

// The same expression with a different source: what follows the old one is
// kept, so choosing another list does not throw away the code around it.
export function withSource(value: string, path: string) {
  assert(path.length <= LIMITS.nodeValueCharsMax, 'MapEditor: path limit exceeded');
  const current = sourceChip(value);
  if (!current) {
    return path;
  }
  const text = String(value);
  const at = text.indexOf(current);
  return text.slice(0, at) + path + text.slice(at + current.length);
}

const IDENT_RE = /^[A-Za-z_$][\w$]*$/;

// "No source yet" has to be written as real code, since the head is what
// lands in the page. An empty literal is valid, renders nothing, and — unlike
// a placeholder name like `items` — can't throw "items is not defined" and
// take the whole preview down before the user has picked anything.
const NO_SOURCE = '[]';
const DEFAULT_ITEM = 'item'; // a value no expression can collide with

function useMapModel({ node, onSetText }: MapEditorProps) {
  // General callbacks can declare and shadow names between markup roots.
  // Their header stays a code field until rename analysis covers those scopes.
  const parsed = node.bodyParts === undefined ? parseMapHead(node.head) : undefined;
  const [fields, setFields] = useState(parsed || { data: '', item: '', index: '' });
  const lastBuiltRef = useRef(node.head);

  // External changes (undo, file reload, code edits below) re-sync fields.
  useEffect(() => {
    if (node.head !== lastBuiltRef.current) {
      const parsed = node.bodyParts === undefined ? parseMapHead(node.head) : undefined;
      if (parsed) {
        setFields(parsed);
      }
      lastBuiltRef.current = node.head;
    }
  }, [node.head, node.bodyParts]);

  // Typing only updates local state; the head is written on blur/Enter/pick
  // so half-typed values never run in the preview.
  const update = (patch: MapPatch) => setFields((previous) => ({ ...previous, ...patch }));
  const commit = (next: MapFields) => {
    setFields(next);
    const itemOk = IDENT_RE.test(next.item);
    const indexOk = !next.index || IDENT_RE.test(next.index);
    if (!next.data.trim() || !itemOk || !indexOk) {
      return;
    } // incomplete — don't write broken code
    const parameters = next.item + (next.index ? `, ${next.index}` : '');
    const head = `${next.data.trim()}.map((${parameters}) => (`;
    if (head.length > LIMITS.nodeValueCharsMax) {
      return;
    }
    if (head === node.head) {
      return;
    }
    // Renaming the item or index has to carry into the children that
    // reference it. Only a rename counts — adding or removing an index
    // leaves nothing to point the old name at.
    const renames = mapRenames(node.head, next);
    lastBuiltRef.current = head;
    onSetText(head, renames);
  };
  const commitOnEnter = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      commit(fields);
    }
  };

  // Changing the source changes what the item *is*, so a name describing the
  // old data ("service" for a list of projects) is worse than none. Back to
  // the default; the rename above carries the children with it.
  const commitSource = (data: string) => {
    // The source, not the whole expression: `.slice(0, 3)` typed after a list
    // — or a value dropped into it — leaves the item exactly what it was, and
    // only picking a different list makes the old name wrong.
    const changed = sourceChip(parseMapHead(node.head)?.data || '') !== sourceChip(data);
    commit({ ...fields, data, item: changed ? DEFAULT_ITEM : fields.item });
  };

  return { fields, update, commit, commitOnEnter, commitSource };
}
function useMapEditor(props: MapEditorProps) {
  const { node, loopContext, bindContext, dataContext, onSetText } = props;
  const { fields, update, commit, commitOnEnter, commitSource } = useMapModel(props);
  // Anchors the source popup under the Data row.
  const dataRef = useRef<HTMLDivElement>(null);
  const codeRef = useRef<HTMLDivElement>(null);
  const [sourceMenu, setSourceMenu] = useState<FieldPosition | undefined>(undefined);
  // The bind handle's picker, and the way into whichever field it belongs to.
  // The source picker chooses what is being looped over; this drops a value
  // into the expression around it — `posts.slice(0, count)` needs `count` from
  // somewhere, and there was no way to reach it from here.
  const [insertAt, setInsertAt] = useState<MapInsert | undefined>(undefined); // {pos, field}
  const dataApiRef = useRef<ExprInputAPI | undefined>(undefined);
  const codeApiRef = useRef<ExprInputAPI | undefined>(undefined);
  const openInsert = (field: 'data' | 'code', ref: React.RefObject<HTMLElement>) => {
    if (insertAt) {
      setInsertAt(undefined);
      return;
    }
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) {
      return;
    }
    setInsertAt({
      field,
      pos: dataPickerPosition(rect),
    });
  };
  const openSourceMenu = () => {
    const rect = dataRef.current?.getBoundingClientRect();
    if (!rect) {
      return;
    }
    setSourceMenu(dataPickerPosition(rect, { heightPxMax: 564 }));
  };

  const parseableNow = node.bodyParts === undefined && !!parseMapHead(node.head);
  const isNoSource = !fields.data.trim() || fields.data.trim() === NO_SOURCE;
  const itemBad = fields.item !== '' && !IDENT_RE.test(fields.item);
  const indexBad = fields.index !== '' && !IDENT_RE.test(fields.index);

  return {
    node,
    loopContext,
    bindContext,
    dataContext,
    onSetText,
    fields,
    update,
    commit,
    commitOnEnter,
    commitSource,
    dataRef,
    codeRef,
    sourceMenu,
    setSourceMenu,
    insertAt,
    setInsertAt,
    dataApiRef,
    codeApiRef,
    openInsert,
    openSourceMenu,
    parseableNow,
    isNoSource,
    itemBad,
    indexBad,
  };
}

export function MapEditor(props: MapEditorProps) {
  const state = useMapEditor(props);
  return <MapEditorView state={state} />;
}

function MapEditorView({ state }: { readonly state: ReturnType<typeof useMapEditor> }) {
  const { parseableNow } = state;
  return (
    <>
      {parseableNow ? (
        <>
          <MapDataField state={state} />
          <MapNames state={state} />
        </>
      ) : (
        <div className="props-field" style={{ marginTop: 8, fontSize: 11, color: 'var(--text-faint)' }}>
          Custom loop code — edit it below.
        </div>
      )}
      <MapCodeField state={state} />
      <MapInsertPicker state={state} />
    </>
  );
}

// Tag switcher for plain elements: free text with a suggestion list of
// standard HTML tags. Committing renames the element — the navigator icon
// follows the tag, and attributes invalid for the new tag are dropped.
// The glyph an option wears in the tag list — the same ones the insert
// palette uses, so a component reads as a component in both places.
function tagOptionIcon(option: TagOption) {
  if (option.kind === 'astroAsset') {
    return astroAssetIcon(option.name, 13);
  }
  if (option.kind === 'layout') {
    return <LayoutIcon size={13} style={{ color: '#79e09c' }} />;
  }
  if (option.kind === 'component') {
    return <ElementComponentIcon size={13} style={{ color: '#79e09c' }} />;
  }
  return elementIcon(option.name, 13);
}

function useTagModel({ tag, options }: TagFieldProps) {
  const [draft, setDraft] = useState(tag);
  const [focused, setFocused] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [popupPosition, setPopupPosition] = useState<FieldPosition | undefined>(undefined);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Two refs, because picking from the list commits and then blurs in the same
  // tick — before React has re-rendered with either new value:
  //   committedRef — what the field has already asked for. `tag` doesn't catch
  //     up until the app re-renders, so it can't answer "did I just do this?".
  //   draftRef — the live text. The blur handler closes over the `draft` of the
  //     render it was created in, which is still the half-typed "bu" when a
  //     pick blurs the input; committing that put "bu" on the element and left
  //     the picked name sitting in the box.
  const committedRef = useRef(tag);
  const draftRef = useRef(tag);
  const updateDraft = (value: string) => {
    draftRef.current = value;
    setDraft(value);
  };
  useEffect(() => {
    committedRef.current = tag;
    draftRef.current = tag;
    setDraft(tag);
  }, [tag]);

  // Components as well as tags: Astro tells them apart by case, and so does
  // this list — typing a capital narrows to what the page can actually
  // provide (a project component, an astro:assets one, or something the
  // frontmatter already imports).
  assert(tag.length <= LIMITS.tagNameCharsMax, 'TagField: tag limit exceeded');
  assert((options?.length ?? 0) <= LIMITS.scanEntriesMax, 'TagField: option limit exceeded');
  const pool = options && options.length ? options : HTML_TAGS.map((name) => ({ name, kind: 'element' }));
  const query = draft.trim();
  const ql = query.toLowerCase();
  const matches =
    focused && query && query !== tag
      ? pool
          .filter((option) => option.name.toLowerCase().includes(ql))
          .sort((left, right) => {
            const ap = left.name.toLowerCase().startsWith(ql) ? 0 : 1;
            const bp = right.name.toLowerCase().startsWith(ql) ? 0 : 1;
            return ap - bp || left.name.length - right.name.length;
          })
          .slice(0, 12)
      : [];

  useLayoutEffect(() => {
    if (!matches.length || !wrapRef.current) {
      setPopupPosition(undefined);
      return;
    }
    const rect = wrapRef.current.getBoundingClientRect();
    setPopupPosition({ left: rect.left, top: rect.bottom + 4, width: rect.width });
  }, [matches.length, draft]);

  return {
    draft,
    setFocused,
    highlight,
    setHighlight,
    popupPos: popupPosition,
    wrapRef,
    inputRef,
    committedRef,
    draftRef,
    updateDraft,
    matches,
  };
}
function useTagField(props: TagFieldProps) {
  const { tag, onChangeTag } = props;
  const model = useTagModel(props);
  const {
    highlight,
    setHighlight,

    inputRef,
    committedRef,
    draftRef,
    updateDraft,
    matches,
  } = model;
  // Ask for a name, and put the old one back if the caller says nothing
  // provides it — a component that isn't imported anywhere, a layout name
  // that isn't a layout file.
  const apply = (name: string) => {
    committedRef.current = name;
    updateDraft(name);
    const revert = () => {
      committedRef.current = tag;
      updateDraft(tag);
    };
    Promise.resolve(onChangeTag(name)).then(
      (ok) => {
        if (ok === false) {
          revert();
        }
      },
      (error: unknown) => {
        // A rename that failed leaves the element as it was, so the field says so too.
        console.error('Tag field: rename failed', error);
        revert();
      },
    );
  };

  const commit = (text: string) => {
    const raw = String(text).trim();
    if (raw.length > LIMITS.tagNameCharsMax) {
      return updateDraft(committedRef.current);
    }
    if (raw === committedRef.current) {
      return updateDraft(committedRef.current);
    }
    // A capital means a component — passed through with its case intact, and
    // it's the caller that decides whether anything provides that name.
    if (/^[A-Z][\w$]*$/.test(raw)) {
      return apply(raw);
    }
    const clean = raw.toLowerCase();
    // Not `slot` either: switching into one here would be a one-way door —
    // insert a slot from the palette instead.
    if (/^[a-z][a-z0-9-]*$/.test(clean) && clean !== committedRef.current && clean !== 'slot') {
      apply(clean);
    } else {
      updateDraft(committedRef.current);
    }
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' && matches.length) {
      event.preventDefault();
      setHighlight((current) => Math.min(current + 1, matches.length - 1));
    } else if (event.key === 'ArrowUp' && matches.length) {
      event.preventDefault();
      setHighlight((current) => Math.max(current - 1, 0));
    } else if (event.key === 'Enter' || (event.key === 'Tab' && matches.length)) {
      event.preventDefault();
      const picked = matches[Math.min(highlight, matches.length - 1)];
      commit(picked ? picked.name : draftRef.current);
      inputRef.current?.blur();
    } else if (event.key === 'Escape') {
      // Put the text back before blurring, or the blur below would commit
      // whatever was being typed — the opposite of what Escape means.
      updateDraft(committedRef.current);
      inputRef.current?.blur();
    }
  };

  return { ...model, commit, onKeyDown };
}

export function TagField(props: TagFieldProps) {
  const state = useTagField(props);
  return <TagFieldView state={state} />;
}

function TagFieldView({ state }: { readonly state: ReturnType<typeof useTagField> }) {
  const { draft, setFocused, highlight, setHighlight, popupPos: popupPosition, wrapRef, inputRef, draftRef, updateDraft, matches, commit, onKeyDown } = state;
  return (
    <div className="props-field" ref={wrapRef}>
      <label onClick={noLabelActivation}>
        <span className="prop-label">
          <TagIcon size={12} className="prop-label-icon" />
          Tag
        </span>
      </label>
      <input
        maxLength={LIMITS.tagNameCharsMax}
        ref={inputRef}
        value={draft}
        spellCheck={false}
        onChange={(event) => {
          updateDraft(event.target.value);
          setHighlight(0);
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          // The ref, not `draft`: a pick blurs the input in the same tick it
          // sets the text, so the state this handler closed over is stale.
          commit(draftRef.current);
        }}
        onKeyDown={onKeyDown}
      />
      {popupPosition && (
        <Popup
          mode="popover"
          portal={false}
          onClose={() => setFocused(false)}
          className="dd-popup class-suggest"
          style={{ left: popupPosition.left, top: popupPosition.top, width: popupPosition.width }}
        >
          {matches.map((option, i) => (
            <div
              key={option.name}
              className={`dd-option ${i === highlight ? 'highlight' : ''}`}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setHighlight(i)}
              onClick={() => {
                commit(option.name);
                inputRef.current?.blur();
              }}
            >
              <span className="dd-option-icon">{tagOptionIcon(option)}</span>
              <span className="dd-option-label">{option.name}</span>
            </div>
          ))}
        </Popup>
      )}
    </div>
  );
}

function MapSourcePicker({ state }: { readonly state: ReturnType<typeof useMapEditor> }) {
  const {
    loopContext,
    bindContext,
    dataContext,
    fields,
    update,

    commitSource,

    sourceMenu,
    setSourceMenu,

    isNoSource,
  } = state;
  const path = isNoSource ? '' : sourceChip(fields.data);
  const source = useLoopSourceInspection(dataContext, path, { open: sourceMenu !== undefined });
  const [sourceEditor, setSourceEditor] = useState<FieldPosition | undefined>(undefined);
  const tree = dataTree(bindContext || loopContext || {}).map((node) =>
    node.path === source.root && source.inspection?.tree ? { ...source.inspection.tree, ...(node.section ? { section: node.section } : {}) } : node,
  );
  const editSource = () => {
    if (source.local && sourceMenu) {
      setSourceEditor(sourceMenu);
    } else if (source.imported) {
      dataContext?.onOpenSymbol?.(source.root);
    }
    setSourceMenu(undefined);
  };
  return (
    <>
      {sourceMenu && (
        <FieldDataPicker
          pos={sourceMenu}
          bindContext={bindContext || loopContext}
          tree={listsOnly(tree)}
          sourceInspection={source.inspection}
          onEditSource={source.local || source.imported ? editSource : undefined}
          current={isNoSource ? undefined : sourceChip(fields.data) || fields.data.trim()}
          onPick={(path) => {
            setSourceMenu(undefined);
            // Picking swaps the source and keeps the code after it: a
            // list chosen again is still `.filter(…)`-ed the same way.
            commitSource(withSource(fields.data, path));
          }}
          onWrite={() => {
            setSourceMenu(undefined);
            if (isNoSource) {
              update({ data: '' });
            }
          }}
          onClose={() => setSourceMenu(undefined)}
        />
      )}
      {sourceEditor && (
        <VarSourceEditor
          pos={sourceEditor}
          name={source.root}
          code={dataContext?.frontmatter ?? ''}
          onChangeCode={dataContext?.onSetFrontmatter}
          onClose={() => setSourceEditor(undefined)}
        />
      )}
    </>
  );
}

function MapDataField({ state }: { readonly state: ReturnType<typeof useMapEditor> }) {
  const {
    dataContext,

    fields,
    update,

    commitSource,
    dataRef,

    sourceMenu,
    setSourceMenu,
    insertAt,

    dataApiRef,

    openInsert,
    openSourceMenu,

    isNoSource,
  } = state;
  return (
    <div className="props-field" style={{ marginTop: 8 }} ref={dataRef}>
      <label onClick={noLabelActivation}>
        <span className="prop-label">Data</span>
        <BindHandle active={insertAt?.field === 'data'} onOpen={() => openInsert('data', dataRef)} />
      </label>
      {/* One field, holding one expression. What names the source is
                drawn as a chip inside it — the same purple a binding wears
                everywhere else — and everything after it is ordinary code, so
                `.filter(…)` or `[1]` is typed where it reads. The chip IS the
                way to another list: it is the thing on screen that names the
                one in use, so pressing it opens the picker, and the chevron
                that used to sit beside it was a second button for the job the
                chip was already doing. The pencil goes to where the list is
                declared, which is usually another file. */}
      <div className="prop-expr-row">
        <ExprInput
          value={isNoSource ? '' : fields.data}
          syncValue={isNoSource ? '' : fields.data}
          placeholder="Choose or write a list…"
          chip={sourceChip(fields.data)}
          apiRef={dataApiRef}
          onChipClick={() => (sourceMenu ? setSourceMenu(undefined) : openSourceMenu())}
          onChange={(value) => update({ data: value })}
          onCommit={(value) => commitSource(value.trim() || NO_SOURCE)}
        />
        <SourceEditButton name={referencedName(fields.data)} dataContext={dataContext} anchorRef={dataRef} />
      </div>
      <MapSourcePicker state={state} />
    </div>
  );
}

function MapNames({ state }: { readonly state: ReturnType<typeof useMapEditor> }) {
  const {
    fields,
    update,
    commit,
    commitOnEnter,

    itemBad,
    indexBad,
  } = state;
  return (
    <>
      <div className="props-field">
        <label onClick={noLabelActivation}>
          <span className="prop-label">Item name</span>
        </label>
        <input
          value={fields.item}
          placeholder="e.g. service"
          spellCheck={false}
          style={itemBad ? { borderColor: 'var(--red)' } : undefined}
          onChange={(event) => update({ item: event.target.value })}
          onBlur={() => commit(fields)}
          onKeyDown={commitOnEnter}
        />
      </div>
      <div className="props-field">
        <label onClick={noLabelActivation}>
          <span className="prop-label">Index name</span>
          <span className="type-tag">optional</span>
        </label>
        <input
          value={fields.index}
          placeholder="e.g. index"
          spellCheck={false}
          style={indexBad ? { borderColor: 'var(--red)' } : undefined}
          onChange={(event) => update({ index: event.target.value })}
          onBlur={() => commit(fields)}
          onKeyDown={commitOnEnter}
        />
      </div>
    </>
  );
}

function MapCodeField({ state }: { readonly state: ReturnType<typeof useMapEditor> }) {
  const {
    node,

    onSetText,

    codeRef,

    insertAt,

    codeApiRef,
    openInsert,

    parseableNow,
  } = state;
  return (
    <div className="props-field" style={{ marginTop: parseableNow ? 2 : 0 }} ref={codeRef}>
      <label onClick={noLabelActivation}>
        <span className="prop-label">
          <CodeIcon size={12} className="prop-label-icon" />
          Code
        </span>
        <BindHandle active={insertAt?.field === 'code'} onOpen={() => openInsert('code', codeRef)} />
      </label>
      <ExprInput value={node.head} syncValue={node.head} apiRef={codeApiRef} onCommit={(value) => value !== node.head && onSetText(value)} />
    </div>
  );
}

function MapInsertPicker({ state }: { readonly state: ReturnType<typeof useMapEditor> }) {
  const {
    node,
    loopContext,
    bindContext,

    onSetText,

    commitSource,

    insertAt,
    setInsertAt,
    dataApiRef,
    codeApiRef,
  } = state;
  return (
    <>
      {insertAt && (
        <FieldDataPicker
          pos={insertAt.pos}
          bindContext={bindContext || loopContext}
          current={undefined}
          onPick={(path) => {
            const field = insertAt.field;
            setInsertAt(undefined);
            const next = field === 'data' ? dataApiRef.current?.insert(path) : codeApiRef.current?.insert(path);
            if (next === undefined) {
              return;
            }
            if (field === 'data') {
              commitSource(next.trim() || NO_SOURCE);
            } else if (next !== node.head) {
              onSetText(next);
            }
          }}
          onClose={() => setInsertAt(undefined)}
        />
      )}
    </>
  );
}

function mapRenames(head: string, next: MapFields): readonly Rename[] {
  const previous = parseMapHead(head);
  if (!previous) {
    return [];
  }
  const renames: Rename[] = [];
  for (const key of ['item', 'index'] as const) {
    if (previous[key] && next[key] && previous[key] !== next[key]) {
      renames.push({ from: previous[key], to: next[key] });
    }
  }
  assert(renames.length <= 2, 'MapEditor: rename count exceeded');
  return renames;
}
