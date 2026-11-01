import Popup from '../../ui/Popup';
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ImportDecl, MapNode } from '../../../shared/page/pageNode';
import type { LoopTarget } from '../../editor/loopQueryPlan';
import type { LoopReadInput } from '../../editor/loopQueryRead';
import type { TreeNode } from '../../editor/dataSuggest';
import LoopSettings, { type LoopApplyResult, type LoopListOption } from './LoopSettings';
import type { RichContext } from './RichContent';
import type { FieldPosition, SourceContext } from './propBindings';
import { assert } from '../../../shared/core/assert';
import { LIMITS } from '../../../shared/core/limits';
import { HTML_TAGS } from '../../editor/elementSchemas';
import { dataTree, listsOnly } from '../../editor/dataSuggest';
import ExprInput from '../../ui/ExprInput';
import { SourceEditButton } from './propBindings';
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
  /** The file's imports, which say where a loop's list comes from. */
  readonly imports?: readonly ImportDecl[] | undefined;
  readonly projectPath?: string | undefined;
  readonly onSetLoopSource?: ((target: LoopTarget, sanityClient: 'available' | 'unavailable') => LoopApplyResult) | undefined;
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

// The renames a new head makes: the item or index renamed with the list kept,
// carried into every binding inside the loop so none is left pointing at a
// name the loop no longer declares. Adding or removing an index renames nothing.
export function headRenames(before: string, after: string): readonly Rename[] {
  assert(before.length <= LIMITS.nodeValueCharsMax, 'MapEditor: head limit exceeded');
  assert(after.length <= LIMITS.nodeValueCharsMax, 'MapEditor: head limit exceeded');
  const previous = parseMapHead(before);
  const next = parseMapHead(after);
  if (!previous || !next) {
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

// A loop's settings: what it loops over (LoopSettings.tsx) and its head as one
// line of code — the list, the item's name and the index's — where a rename
// is carried into the bindings inside. A head the editor does not split (a
// destructured item, a statement body) is edited as code only.
export function MapEditor(props: MapEditorProps) {
  const { node, onSetText } = props;
  const codeRef = useRef<HTMLDivElement>(null);
  const splittable = node.bodyParts === undefined && parseMapHead(node.head) !== undefined;
  const commitCode = (value: string): void => {
    if (value !== node.head) {
      onSetText(value, node.bodyParts === undefined ? headRenames(node.head, value) : []);
    }
  };
  return (
    <>
      {splittable ? (
        <MapListSettings props={props} anchorRef={codeRef} />
      ) : (
        <div className="props-field" style={{ marginTop: 8, fontSize: 11, color: 'var(--text-faint)' }}>
          Custom loop code — edit it below.
        </div>
      )}
      <div className="props-field loop-settings-row" ref={codeRef}>
        <label onClick={noLabelActivation}>
          <span className="prop-label">
            <CodeIcon size={12} className="prop-label-icon" />
            Code
          </span>
        </label>
        <ExprInput value={node.head} syncValue={node.head} onCommit={commitCode} />
      </div>
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

// The list settings, when the app can write them.
function MapListSettings({ props, anchorRef }: { readonly props: MapEditorProps; readonly anchorRef: React.RefObject<HTMLDivElement> }) {
  const { node, dataContext, imports, projectPath, onSetLoopSource, bindContext, loopContext } = props;
  const data = parseMapHead(node.head)?.data ?? '';
  const frontmatter = dataContext?.frontmatter ?? '';
  const input = useMemo<Omit<LoopReadInput, 'fieldKind'>>(() => ({ frontmatter, imports: imports ?? [], data }), [frontmatter, imports, data]);
  const lists = useMemo(() => pageLists(dataTree(bindContext || loopContext || {})), [bindContext, loopContext]);
  if (onSetLoopSource === undefined) {
    return undefined;
  }
  return (
    <LoopSettings
      input={input}
      projectPath={projectPath}
      filePath={dataContext?.filePath}
      lists={lists}
      onApply={onSetLoopSource}
      sourceButton={(name) => <SourceEditButton name={name} dataContext={dataContext} anchorRef={anchorRef} />}
    />
  );
}

// Lists the page already holds — props, constants, an outer loop item's lists
// — for the Source menu. Collections are offered by the catalog instead.
const PAGE_LISTS_MAX = 100;

export function pageLists(tree: readonly TreeNode[]): readonly LoopListOption[] {
  const out: LoopListOption[] = [];
  // Children of a pickable node are pickable nodes too (listsOnly marks the
  // whole tree), but are typed as plain tree nodes; `pickable` is read as a key.
  const pending: TreeNode[] = [...listsOnly(tree)].reverse();
  for (let count = 0; pending.length > 0 && out.length < PAGE_LISTS_MAX && count < LIMITS.treeNodesMax; count++) {
    const node = pending.pop();
    if (node === undefined || node.section === 'collections' || node.query !== undefined) {
      continue;
    }
    if ('pickable' in node && node.pickable === true) {
      out.push({ path: node.path, label: node.path, hint: node.preview || node.section || '' });
    }
    for (const child of [...(node.children ?? [])].reverse()) {
      pending.push(child);
    }
  }
  return out;
}
