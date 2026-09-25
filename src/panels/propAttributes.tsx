import React, { useEffect, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import type { Attr } from '../../shared/page-node';
import type { PropValues } from './propRules';
import type { RichContext } from '../ui/RichContent';
import type { SourceContext, FieldPosition, InsertAPI } from './propBindings';
import { assert } from '../../shared/assert';
import { LIMITS } from '../../shared/limits';
import { scopeChips, scopeCompletions } from '../dataSuggest';
import StyleEditor, { collapseDeclarations } from '../ui/StyleEditor';
import AssetField from '../ui/AssetField';
import { looksLikeAssetPath, mediaKindFor } from '../ui/AssetThumb';
import { BindField, BindHandle, FieldDataPicker, ValueCodeEditor } from './propBindings';
import { BracesIcon, PlusIcon, TrashIcon, ElementImageIcon, MaximizeIcon } from '../ui/Icons';

interface AttributeNode {
  readonly id: string;
  readonly props?: PropValues;
}
interface AttributePair {
  readonly name: string;
  readonly value: string;
}
interface ObjectEntry {
  readonly key: string;
  readonly raw: string;
}
interface AttributeEditor extends FieldPosition {
  readonly attr: string | null;
}
interface ObjectEditor extends FieldPosition {
  readonly index: number | null;
}
export type SetProp = (name: string, value: Attr | undefined, immediate?: boolean) => void;
export type SetProps = (nodeId: string, values: PropValues) => void;
interface ContextProps {
  readonly projectPath?: string | null | undefined;
  readonly bindCtx?: RichContext | null | undefined;
}
interface AttributesSectionProps extends ContextProps {
  readonly node: AttributeNode;
  readonly names: readonly string[];
  readonly onSetProp: SetProp;
  readonly onSetProps?: SetProps | undefined;
  readonly onRenameProp: (previous: string, next: string) => void;
}
interface AttrEditorProps extends ContextProps {
  readonly pos: FieldPosition;
  readonly name: string;
  readonly value: string;
  readonly syntax: 'pair' | 'spread';
  readonly isNew: boolean;
  readonly dataCtx?: SourceContext | null | undefined;
  readonly onCommitName: (name: string) => void;
  readonly onCommitPair: (name: string, value: string) => void;
  readonly onCommitMany: (pairs: readonly AttributePair[]) => void;
  readonly onChangeValue: (value: string) => void;
  readonly onClose: () => void;
}
interface ObjectAttrsFieldProps extends ContextProps {
  readonly pill: ReactNode;
  readonly menu: ReactNode;
  readonly entries: readonly ObjectEntry[];
  readonly onCommit: (entries: readonly ObjectEntry[]) => void;
}

const decodeAttr = (v: Attr | null | undefined) =>
  v == null || v.type === 'bare' ? '' : v.type === 'expr' ? `{${v.value}}` : String(v.value);

const attributeDisplayName = (name: string, value: Attr | undefined): string =>
  value?.type === 'spread' ? `{...${value.value}}` : name;

const encodeAttr = (text: string): Attr => {
  if (text === '') {
    return { type: 'bare' };
  }
  const m = text.match(/^\{([\s\S]*)\}$/);
  if (m) {
    return { type: 'expr', value: (m[1] ?? '').trim() };
  }
  return { type: 'string', value: text };
};

export function AttributesSection(props: AttributesSectionProps) {
  const state = useAttributesSection(props);
  const { node, names, onSetProp, editor, setEditor, listRef, openEditor } = state;

  return (
    <div className="props-field" ref={listRef}>
      {/* A label activates its control on any click, including blank space.
          A plain row keeps the add button as the only activation target. */}
      <div className="props-label-row">
        <span className="prop-label">
          <BracesIcon size={12} className="prop-label-icon" />
          Attributes
        </span>
        <button className="ghost" title="Add attribute" onClick={() => openEditor(null)}>
          <PlusIcon size={12} />
        </button>
      </div>

      {names.length > 0 && (
        <div className="attrs-list">
          {names.map((name) => {
            const value = node.props?.[name];
            const syntax = value?.type === 'spread' ? 'spread' : 'pair';
            return (
              <div
                key={name}
                className={`attr-row ${syntax} ${editor?.attr === name ? 'editing' : ''}`}
                onClick={() => openEditor(name)}
              >
                <span className="attr-name">{attributeDisplayName(name, value)}</span>
                {syntax === 'pair' && (
                  <>
                    <span className="attr-eq">=</span>
                    <span className="attr-value">{decodeAttr(value)}</span>
                  </>
                )}
                <button
                  className="row-action"
                  title="Delete attribute"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (editor?.attr === name) {
                      setEditor(null);
                    }
                    onSetProp(name, undefined, true);
                  }}
                >
                  <TrashIcon size={12} />
                </button>
              </div>
            );
          })}
        </div>
      )}

      <AttributesSectionPopup state={state} />
    </div>
  );
}

function useAttributesSection(props: AttributesSectionProps) {
  const { names } = props;
  assert(names.length <= LIMITS.attrsPerNodeMax, 'Attributes: name limit exceeded');
  const [editor, setEditor] = useState<AttributeEditor | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const openEditor = (attr: string | null) => {
    const rect = listRef.current?.getBoundingClientRect();
    setEditor({
      attr,
      top: Math.min((rect?.bottom ?? 200) + 6, window.innerHeight - 150),
      left: rect?.left ?? 0,
      width: rect?.width ?? 240,
    });
  };

  return { ...props, editor, setEditor, listRef, openEditor };
}
type AttributesState = ReturnType<typeof useAttributesSection>;
function AttributesSectionPopup({ state }: { readonly state: AttributesState }) {
  const { node, projectPath, bindCtx, onSetProp, onRenameProp, editor, setEditor } = state;
  if (!editor) {
    return null;
  }
  const value = editor.attr ? node.props?.[editor.attr] : undefined;
  const syntax = value?.type === 'spread' ? 'spread' : 'pair';
  return (
    <AttrEditor
      key={editor.attr ?? '__new'}
      pos={editor}
      projectPath={projectPath ?? null}
      bindCtx={bindCtx}
      dataCtx={bindCtx}
      name={attributeDisplayName(editor.attr ?? '', value)}
      value={syntax === 'pair' ? decodeAttr(value) : ''}
      syntax={syntax}
      isNew={editor.attr === null}
      onCommitName={(newName) => {
        const clean = newName.trim();
        if (editor.attr === null) {
          // New attribute: created once a valid name exists.
          if (clean && !node.props?.[clean]) {
            onSetProp(clean, { type: 'bare' }, true);
            setEditor((current) => (current ? { ...current, attr: clean } : null));
          }
        } else if (clean && clean !== editor.attr) {
          onRenameProp(editor.attr, clean);
          setEditor((current) => (current ? { ...current, attr: clean } : null));
        }
      }}
      onChangeValue={(text) => {
        if (editor.attr) {
          onSetProp(editor.attr, encodeAttr(text));
        }
      }}
      // Pasting `id="hero"` fills both boxes at once — the attribute is
      // created and given its value in one go rather than needing the
      // name committed first.
      onCommitPair={(attrName, text) => {
        const clean = attrName.trim();
        if (!clean) {
          return;
        }
        if (editor.attr && editor.attr !== clean) {
          onRenameProp(editor.attr, clean);
        }
        onSetProp(clean, encodeAttr(text), true);
        setEditor((current) => (current ? { ...current, attr: clean } : null));
      }}
      // Several pairs pasted at once — written together so it is one undo,
      // and the editor closes because there is no single attribute left
      // for it to be editing.
      onCommitMany={(pairs) => attributesCommitMany(state, pairs)}
      onClose={() => setEditor(null)}
    />
  );
}

function attributesCommitMany(state: AttributesState, pairs: readonly AttributePair[]): void {
  const { node, onSetProp, onSetProps, setEditor } = state;

  const patch: Record<string, Attr> = {};
  for (const { name: attrName, value: text } of pairs) {
    const clean = attrName.trim();
    if (clean) {
      patch[clean] = encodeAttr(text);
    }
  }
  if (!Object.keys(patch).length) {
    return;
  }
  if (onSetProps) {
    onSetProps(node.id, patch);
  } else {
    for (const [k, v] of Object.entries(patch)) {
      onSetProp(k, v, true);
    }
  }
  setEditor(null);
}

const ATTR_PASTE_RE =
  /([\w@:.-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|(\{(?:[^{}]|\{[^{}]*\})*\})|([^\s]+)))?/g;

export function parseAttrPaste(text: string): readonly AttributePair[] {
  if (text.length > LIMITS.attrCharsMax) {
    return [];
  }
  const out: AttributePair[] = [];
  ATTR_PASTE_RE.lastIndex = 0;
  let m;
  while ((m = ATTR_PASTE_RE.exec(text)) !== null) {
    if (!m[0].trim()) {
      continue;
    }
    const value = m[2] ?? m[3] ?? m[4] ?? m[5];
    if (out.length === LIMITS.attrsPerNodeMax) {
      return [];
    }
    out.push({ name: m[1] ?? '', value: value === undefined ? '' : value });
  }
  return out;
}

function AttrEditor(props: AttrEditorProps) {
  const state = useAttrEditor(props);
  const { ref, pos, syntax, isStyleValue, assetMode, setAssetMode } = state;

  return (
    <div
      ref={ref}
      className="attr-editor"
      style={{ top: pos.top, left: pos.left, width: pos.width }}
    >
      <AttributeName state={state} />
      {/* The field sits beside its label like the name row, whichever kind it
          is; `top` just stops the label and toggle from centring against a
          tall field. */}
      {syntax === 'pair' && (
        <div className={`attr-editor-row ${isStyleValue || assetMode ? 'top' : ''}`}>
          <span>Value</span>
          <AttributeValue state={state} />
          <AttributePopups state={state} />
          <button
            className={`attr-asset-toggle ${assetMode ? 'on' : ''}`}
            title={assetMode ? 'Edit as a plain value' : 'Choose a file from public/'}
            onClick={() => setAssetMode((v) => !v)}
          >
            <ElementImageIcon size={12} />
          </button>
        </div>
      )}
    </div>
  );
}

function useAttrEditor(props: AttrEditorProps) {
  const { name, value, syntax, isNew, bindCtx, onCommitName, onClose } = props;
  const [draftName, setDraftName] = useState(name);
  const [draftValue, setDraftValue] = useState(value);
  const ref = useRef<HTMLDivElement | null>(null);
  // Where the purple dot's picker sits, and the field's own insert-at-the-caret
  // handle — the same pair every schema-driven field uses (see PropField).
  const [insertAt, setInsertAt] = useState<FieldPosition | null>(null);
  // Where the bigger value editor sits, when `=` has asked for one.
  const [bigAt, setBigAt] = useState<FieldPosition | null>(null);
  // What this value can name, for the completions and the chips — the same list
  // the picker beside the field offers.
  const scope = scopeCompletions(bindCtx || {});
  const scopeNames = new Set(scope.map((c) => c.label.split('.')[0] ?? ''));
  const chipsInScope = (text: string) => scopeChips(text, scopeNames);
  const bindApiRef = useRef<InsertAPI | null>(null);

  // Whether the value is an {expression} is settled when the popover opens,
  // so the field can't change shape halfway through typing one. The name is
  // read as typed: renaming style → styles turns the CSS editor back into a
  // plain input right away.
  const [isExpr] = useState(() => /^\{[\s\S]*\}$/.test(value));
  const isStyleName = draftName.trim().toLowerCase() === 'style';

  // The asset picker is always one click away, and starts on when the value
  // already names a file in public/ — that's the case where the plain text
  // field is never what you wanted.
  const [assetMode, setAssetMode] = useState(() => !isStyleName && looksLikeAssetPath(value));

  const isStyleValue = isStyleName && !isExpr && !assetMode;

  // Only the field that mounts with the popover takes focus. Renaming swaps
  // the value field, and a freshly mounted one grabbing focus there would
  // pull the caret out of the name box mid-word.
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
  }, []);
  const focusValue = !isNew && !mounted.current;

  const commitName = () => {
    if (syntax === 'pair') {
      onCommitName(draftName);
    }
  };

  useAttrEditorDismiss(ref, onClose);
  return {
    ...props,
    draftName,
    setDraftName,
    draftValue,
    setDraftValue,
    ref,
    insertAt,
    setInsertAt,
    bigAt,
    setBigAt,
    scope,
    chipsInScope,
    bindApiRef,
    assetMode,
    setAssetMode,
    isStyleValue,
    focusValue,
    commitName,
  };
}
type AttributeState = ReturnType<typeof useAttrEditor>;
function useAttrEditorDismiss(ref: RefObject<HTMLElement>, onClose: () => void) {
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !(e.target instanceof window.Node && ref.current.contains(e.target))) {
        onClose();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose, ref]);
}
function AttributeName({ state }: { readonly state: AttributeState }) {
  const {
    syntax,
    isNew,
    draftName,
    setDraftName,
    setDraftValue,
    onCommitPair,
    onCommitMany,
    commitName,
  } = state;
  return (
    <div className="attr-editor-row">
      <span>Name</span>
      <input
        autoFocus={isNew}
        value={draftName}
        readOnly={syntax === 'spread'}
        placeholder="data-attribute"
        spellCheck={false}
        onPaste={(e) => {
          if (syntax === 'spread') {
            return;
          }
          const text = e.clipboardData.getData('text');
          // Only when it actually looks like markup — a plain name paste
          // must keep behaving like a paste into a text box.
          if (!text || !/=/.test(text)) {
            return;
          }
          const pairs = parseAttrPaste(text);
          if (!pairs.length) {
            return;
          }
          e.preventDefault();
          const pair = pairs[0];
          if (pairs.length === 1 && pair) {
            setDraftName(pair.name);
            setDraftValue(pair.value);
            onCommitPair(pair.name, pair.value);
          } else {
            onCommitMany(pairs);
          }
        }}
        onChange={(e) => setDraftName(e.target.value.replace(/[^\w@:.-]/g, ''))}
        onBlur={commitName}
        onKeyDown={(e) => e.key === 'Enter' && (commitName(), e.currentTarget.blur())}
      />
    </div>
  );
}
function AttributeValue({ state }: { readonly state: AttributeState }) {
  const {
    isStyleValue,
    draftValue,
    focusValue,
    setDraftValue,
    onChangeValue,
    assetMode,
    projectPath,
  } = state;
  return isStyleValue ? (
    // A style attribute is CSS, so edit it as CSS — one declaration per
    // line, highlighted. An {expression} value stays a plain field:
    // it's JavaScript, and the CSS mode would mangle it.
    <StyleEditor
      value={draftValue}
      autoFocus={focusValue}
      onChange={(text) => {
        const flat = collapseDeclarations(text);
        setDraftValue(flat);
        onChangeValue(flat);
      }}
    />
  ) : assetMode ? (
    <div className="attr-asset">
      <AssetField
        value={draftValue}
        initialMode="asset"
        showModeToggle={false}
        mediaKind={mediaKindFor(draftValue)}
        projectPath={projectPath ?? ''}
        onChange={(v) => {
          setDraftValue(v);
          onChangeValue(v);
        }}
      />
    </div>
  ) : (
    // The same field a schema-driven prop gets: text with data in it shown
    // as chips, and real code edited as code — JavaScript, highlighted. A
    // hand-added attribute used to be the one value in the panel typed into
    // a bare box, with `{expression}` as a placeholder and no way to reach
    // the data it would name. The editor round-trips text, so the value
    // object is made on the way in and unmade on the way out.
    <AttributeBinding state={state} />
  );
}
function AttributeBinding({ state }: { readonly state: AttributeState }) {
  const {
    draftValue,
    setDraftValue,
    onChangeValue,
    bindCtx,
    dataCtx,
    bindApiRef,
    insertAt,
    setInsertAt,
    ref,
    setBigAt,
  } = state;
  const valueRef = useRef<HTMLDivElement | null>(null);
  return (
    <>
      <div ref={valueRef} className="attr-value-field">
        <BindField
          // An empty attribute is `{type:'bare'}`, which as a VALUE reads as no
          // value at all rather than an empty one — the field would show the word
          // "undefined". Empty text is an empty string here; encodeAttr still
          // stores it as bare on the way out.
          value={draftValue === '' ? { type: 'string', value: '' } : encodeAttr(draftValue)}
          placeholder="Type, or insert data"
          bindCtx={bindCtx}
          dataCtx={dataCtx}
          wrapCode
          apiRef={bindApiRef}
          onChange={(next) => {
            const text = decodeAttr(next);
            setDraftValue(text);
            onChangeValue(text);
          }}
        />
        {/* The dot belongs to the FIELD, and lives inside its box: hanging it off
                the row put it above the row's own edge, so hovering it left the row —
                which hid it, which put the pointer back on the row, which showed it
                again. A dot that flickers under the pointer. */}
        <BindHandle
          active={!!insertAt}
          onOpen={(host) => {
            if (insertAt) {
              setInsertAt(null);
              return;
            }
            const r = (host || ref.current)?.getBoundingClientRect();
            if (!r) {
              return;
            }
            setInsertAt({
              left: r.left,
              top: Math.min(r.bottom + 4, Math.max(60, window.innerHeight - 340)),
              width: Math.max(r.width, 240),
            });
          }}
        />
      </div>
      <button
        type="button"
        className="attr-expand-toggle"
        title="Expand value"
        aria-label="Expand value"
        onClick={() => {
          const host = valueRef.current;
          if (host) {
            setBigAt(expandedAttributeEditorPosition(host));
          }
        }}
      >
        <MaximizeIcon size={12} />
      </button>
    </>
  );
}

function expandedAttributeEditorPosition(host: HTMLElement): FieldPosition {
  const rectangle = host.getBoundingClientRect();
  const viewportWidth = Math.max(window.innerWidth, 32);
  const width = Math.min(Math.max(rectangle.width, 760), viewportWidth - 16);
  return {
    left: Math.max(8, Math.min(rectangle.left, viewportWidth - width - 8)),
    top: Math.max(8, Math.min(rectangle.top, window.innerHeight - 320)),
    width,
  };
}
function AttributePopups({ state }: { readonly state: AttributeState }) {
  const {
    bigAt,
    draftName,
    draftValue,
    scope,
    chipsInScope,
    bindCtx,
    setDraftValue,
    onChangeValue,
    setBigAt,
    insertAt,
    setInsertAt,
    bindApiRef,
  } = state;
  return (
    <>
      {bigAt ? (
        <ValueCodeEditor
          pos={bigAt}
          name={draftName || 'value'}
          value={draftValue}
          scope={scope}
          chipsOf={chipsInScope}
          bindCtx={bindCtx}
          onChange={(text) => {
            setDraftValue(text);
            onChangeValue(text);
          }}
          onClose={() => setBigAt(null)}
        />
      ) : null}
      {insertAt ? (
        <FieldDataPicker
          pos={insertAt}
          bindCtx={bindCtx}
          onPick={(path) => {
            setInsertAt(null);
            // Into the caret when the field has one, so a chip lands beside
            // what is already typed; otherwise this is the value's first
            // binding and it becomes the whole of it.
            if (bindApiRef.current?.insert) {
              bindApiRef.current.insert(path);
              return;
            }
            const text = `{${path}}`;
            setDraftValue(text);
            onChangeValue(text);
          }}
          onClose={() => setInsertAt(null)}
        />
      ) : null}
    </>
  );
}

export function parseObjectLiteral(src: unknown): readonly ObjectEntry[] | null {
  const t = String(src ?? '').trim();
  if (t.length > LIMITS.attrCharsMax) {
    return null;
  }
  const m = t.match(/^\{([\s\S]*)\}$/);
  if (!m) {
    return t === '' ? [] : null;
  }
  const inner = (m[1] ?? '').trim();
  if (!inner) {
    return [];
  }
  if (/[{}]|\.\.\./.test(inner)) {
    return null;
  }
  const entries = [];
  const re = new RegExp(
    /\s*(?:"([^"]*)"|'([^']*)'|([\w$@:.-]+))\s*:\s*/.source +
      /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|[^,]+?)\s*(?:,|$)/.source,
    'y',
  );
  let pos = 0;
  while (pos < inner.length) {
    re.lastIndex = pos;
    const em = re.exec(inner);
    if (!em) {
      return null;
    }
    if (entries.length === LIMITS.attrsPerNodeMax) {
      return null;
    }
    entries.push({ key: em[1] ?? em[2] ?? em[3] ?? '', raw: (em[4] ?? '').trim() });
    pos = re.lastIndex;
  }
  return entries;
}

export function serializeObjectLiteral(entries: readonly ObjectEntry[]) {
  assert(entries.length <= LIMITS.attrsPerNodeMax, 'Object attributes: entry limit exceeded');
  const body = entries
    .map((e) => `${/^[A-Za-z_$][\w$]*$/.test(e.key) ? e.key : JSON.stringify(e.key)}: ${e.raw}`)
    .join(', ');
  const text = `{ ${body} }`;
  assert(text.length <= LIMITS.attrCharsMax, 'Object attributes: output limit exceeded');
  return text;
}

const decodeRaw = (raw: string) => {
  const m = String(raw).match(/^"((?:[^"\\]|\\.)*)"$|^'((?:[^'\\]|\\.)*)'$/);
  if (m) {
    return (m[1] ?? m[2] ?? '').replace(/\\(.)/g, '$1');
  }
  return raw === 'true' ? '' : `{${raw}}`;
};

const encodeRaw = (text: string) => {
  if (text === '') {
    return 'true';
  }
  const m = text.match(/^\{([\s\S]*)\}$/);
  if (m) {
    return (m[1] ?? '').trim() || 'true';
  }
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
};

export function ObjectAttrsField(props: ObjectAttrsFieldProps) {
  const state = useObjectAttrsField(props);
  const { pill, menu, entries, onCommit, editor, setEditor, listRef, openEditor } = state;

  return (
    <div className="props-field" ref={listRef}>
      <div className="props-label-row">
        {pill}
        <button className="ghost" title="Add attribute" onClick={() => openEditor(null)}>
          <PlusIcon size={12} />
        </button>
        {menu}
      </div>

      {entries.length > 0 && (
        <div className="attrs-list">
          {entries.map((en, i) => (
            <div
              key={`${en.key}-${i}`}
              className={`attr-row ${editor?.index === i ? 'editing' : ''}`}
              onClick={() => openEditor(i)}
            >
              <span className="attr-name">{en.key}</span>
              <span className="attr-eq">=</span>
              <span className="attr-value">{decodeRaw(en.raw)}</span>
              <button
                className="row-action"
                title="Delete attribute"
                onClick={(e) => {
                  e.stopPropagation();
                  if (editor?.index === i) {
                    setEditor(null);
                  }
                  onCommit(entries.filter((_, j) => j !== i));
                }}
              >
                <TrashIcon size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      <ObjectAttrsFieldPopup state={state} />
    </div>
  );
}

function useObjectAttrsField(props: ObjectAttrsFieldProps) {
  const { entries } = props;
  assert(entries.length <= LIMITS.attrsPerNodeMax, 'Object attributes: entry limit exceeded');
  const [editor, setEditor] = useState<ObjectEditor | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const openEditor = (index: number | null) => {
    const rect = listRef.current?.getBoundingClientRect();
    setEditor({
      index,
      top: Math.min((rect?.bottom ?? 200) + 6, window.innerHeight - 150),
      left: rect?.left ?? 0,
      width: rect?.width ?? 240,
    });
  };

  return { ...props, editor, setEditor, listRef, openEditor };
}
type ObjectAttributesState = ReturnType<typeof useObjectAttrsField>;
function ObjectAttrsFieldPopup({ state }: { readonly state: ObjectAttributesState }) {
  const { entries, bindCtx, projectPath, onCommit, editor, setEditor } = state;
  if (!editor) {
    return null;
  }
  return (
    <AttrEditor
      key={editor.index ?? '__new'}
      pos={editor}
      projectPath={projectPath ?? null}
      bindCtx={bindCtx}
      dataCtx={bindCtx}
      name={editor.index != null ? (entries[editor.index]?.key ?? '') : ''}
      value={editor.index != null ? decodeRaw(entries[editor.index]?.raw ?? '') : ''}
      syntax="pair"
      isNew={editor.index == null}
      onCommitName={(newName) => {
        const clean = newName.trim();
        if (!clean) {
          return;
        }
        if (editor.index == null) {
          if (entries.some((en) => en.key === clean)) {
            return;
          }
          onCommit([...entries, { key: clean, raw: 'true' }]);
          setEditor((current) => (current ? { ...current, index: entries.length } : null));
        } else if (clean !== entries[editor.index]?.key) {
          onCommit(entries.map((en, i) => (i === editor.index ? { ...en, key: clean } : en)));
        }
      }}
      onChangeValue={(text) => {
        if (editor.index != null) {
          onCommit(
            entries.map((en, i) => (i === editor.index ? { ...en, raw: encodeRaw(text) } : en)),
          );
        }
      }}
      onCommitPair={(name, value) => {
        const entry = { key: name.trim(), raw: encodeRaw(value) };
        if (!entry.key) {
          return;
        }
        const index = editor.index ?? entries.length;
        const next = entries.map((current, at) => (at === index ? entry : current));
        if (index === entries.length) {
          next.push(entry);
        }
        onCommit(next);
        setEditor((current) => (current ? { ...current, index } : null));
      }}
      onCommitMany={(pairs) => {
        const replacements = new Map(entries.map((entry) => [entry.key, entry]));
        for (const pair of pairs) {
          replacements.set(pair.name, { key: pair.name, raw: encodeRaw(pair.value) });
        }
        onCommit([...replacements.values()]);
        setEditor(null);
      }}
      onClose={() => setEditor(null)}
    />
  );
}
