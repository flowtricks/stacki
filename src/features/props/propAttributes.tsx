import { useCodeAccess } from '../../ui/CodeAccess';
import { dataPickerPosition } from './dataPickerPosition';
import { useEffect, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import type { Attr } from '../../../shared/page/pageNode';
import type { PropValues } from './propRules';
import type { RichContext } from './RichContent';
import type { SourceContext, FieldPosition, InsertAPI } from './propBindings';
import { assert } from '../../../shared/core/assert';
import { LIMITS } from '../../../shared/core/limits';
import { scopeChips, scopeCompletions } from '../../editor/dataSuggest';
import StyleEditor, { collapseDeclarations } from './StyleEditor';
import AssetField from '../../ui/AssetField';
import { looksLikeAssetPath, mediaKindFor } from '../../ui/AssetThumb';
import { BindField, BindHandle, FieldDataPicker, ValueCodeEditor } from './propBindings';
import { BracesIcon, PlusIcon, TrashIcon, ElementImageIcon, MaximizeIcon } from '../../ui/Icons';
import { AttributesPropControl, AttributesPropNote } from './AttributesPropBinding';
import { readAttributesBinding, spreadKey } from '../../editor/attributesBinding';
import { attributeNameNote } from '../../editor/htmlAttributes';
import { type AttributePair, type ObjectEntry, decodeAttr, attributeDisplayName, encodeAttr, parseAttrPaste, decodeRaw, encodeRaw } from './attributeText';
export { parseAttrPaste, parseObjectLiteral, serializeObjectLiteral } from './attributeText';

interface AttributeNode {
  readonly id: string;
  readonly props?: PropValues;
}
interface AttributeEditor extends FieldPosition {
  readonly attr: string | undefined;
}
interface ObjectEditor extends FieldPosition {
  readonly index: number | undefined;
}
export type SetProp = (name: string, value: Attr | undefined, immediate?: boolean) => void;
export type SetProps = (nodeId: string, values: PropValues) => void;
interface ContextProps {
  readonly projectPath?: string | undefined;
  readonly bindContext?: RichContext | undefined;
}
interface AttributesSectionProps extends ContextProps {
  readonly node: AttributeNode;
  readonly names: readonly string[];
  readonly onSetProp: SetProp;
  readonly onSetProps?: SetProps | undefined;
  readonly onRenameProp: (previous: string, next: string) => void;
  /** The element's tag, when it is an HTML element: its attributes prop is typed by it, and names are checked against it. */
  readonly tag?: string | undefined;
  /** The names an attribute here would collide with: an instance's component props. */
  readonly reservedNames?: readonly string[] | undefined;
  /** Writes the whole attribute list in order, for connecting it to an attributes prop. */
  readonly onReplaceProps?: ((props: Readonly<Record<string, Attr>>) => void) | undefined;
  readonly onSetFrontmatter?: ((source: string) => void) | undefined;
}
interface AttrEditorProps extends ContextProps {
  readonly tag?: string | undefined;
  readonly reservedNames?: readonly string[] | undefined;
  readonly pos: FieldPosition;
  readonly triggerRootRef: RefObject<HTMLElement>;
  readonly name: string;
  readonly value: string;
  readonly syntax: 'pair' | 'spread';
  readonly isNew: boolean;
  readonly dataContext?: SourceContext | undefined;
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

export function AttributesSection(props: AttributesSectionProps) {
  const state = useAttributesSection(props);
  const { node, onSetProp, editor, setEditor, listRef, openEditor, tag, onReplaceProps, bindContext } = state;
  // Connected to the component's attributes prop: the spread and the defaults
  // before it are the prop's, edited from its settings; the rows are the
  // element's own.
  const restLocal = bindContext?.newProp?.restLocal;
  const binding = restLocal === undefined ? undefined : readAttributesBinding(node.props, restLocal);
  const names =
    binding === undefined || restLocal === undefined
      ? state.names
      : state.names.filter((name) => name !== spreadKey(restLocal) && !binding.defaults.some((entry) => entry.name === name));

  return (
    <div className="props-field" ref={listRef}>
      {/* A label activates its control on any click, including blank space.
          A plain row keeps the add button as the only activation target. */}
      <div className="props-label-row">
        <span className="prop-label">
          <BracesIcon size={12} className="prop-label-icon" />
          Attributes
        </span>
        {tag !== undefined && onReplaceProps !== undefined && (
          <AttributesPropControl
            props={node.props}
            tag={tag}
            bindContext={bindContext}
            onReplaceProps={onReplaceProps}
            onSetFrontmatter={state.onSetFrontmatter}
          />
        )}
        <button className="ghost" title="Add attribute" data-attribute-editor-trigger onClick={() => openEditor(undefined)}>
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
                data-attribute-editor-trigger
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
                  onClick={(event) => {
                    event.stopPropagation();
                    if (editor?.attr === name) {
                      setEditor(undefined);
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

      {binding !== undefined && restLocal !== undefined && <AttributesPropNote local={restLocal} />}
      <AttributesSectionPopup state={state} />
    </div>
  );
}

function useAttributesSection(props: AttributesSectionProps) {
  const { names } = props;
  assert(names.length <= LIMITS.attrsPerNodeMax, 'Attributes: name limit exceeded');
  const [editor, setEditor] = useState<AttributeEditor | undefined>(undefined);
  const listRef = useRef<HTMLDivElement>(null);

  const openEditor = (attr: string | undefined) => {
    const rect = listRef.current?.getBoundingClientRect();
    setEditor((current) =>
      current !== undefined && current.attr === attr
        ? undefined
        : {
            attr,
            top: Math.min((rect?.bottom ?? 200) + 6, window.innerHeight - 150),
            left: rect?.left ?? 0,
            width: rect?.width ?? 240,
          },
    );
  };

  return { ...props, editor, setEditor, listRef, openEditor };
}
type AttributesState = ReturnType<typeof useAttributesSection>;
function AttributesSectionPopup({ state }: { readonly state: AttributesState }) {
  const { node, projectPath, bindContext, onSetProp, onRenameProp, editor, setEditor } = state;
  if (!editor) {
    return undefined;
  }
  const value = editor.attr ? node.props?.[editor.attr] : undefined;
  const syntax = value?.type === 'spread' ? 'spread' : 'pair';
  return (
    <AttrEditor
      key={editor.attr ?? '__new'}
      pos={editor}
      triggerRootRef={state.listRef}
      projectPath={projectPath ?? undefined}
      bindContext={bindContext}
      dataContext={bindContext}
      tag={state.tag}
      reservedNames={state.reservedNames}
      name={attributeDisplayName(editor.attr ?? '', value)}
      value={syntax === 'pair' ? decodeAttr(value) : ''}
      syntax={syntax}
      isNew={editor.attr === undefined}
      onCommitName={(newName) => {
        const clean = newName.trim();
        if (editor.attr === undefined) {
          // New attribute: created once a valid name exists.
          if (clean && !node.props?.[clean]) {
            onSetProp(clean, { type: 'bare' }, true);
            setEditor((current) => (current ? { ...current, attr: clean } : undefined));
          }
        } else if (clean && clean !== editor.attr) {
          onRenameProp(editor.attr, clean);
          setEditor((current) => (current ? { ...current, attr: clean } : undefined));
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
        setEditor((current) => (current ? { ...current, attr: clean } : undefined));
      }}
      // Several pairs pasted at once — written together so it is one undo,
      // and the editor closes because there is no single attribute left
      // for it to be editing.
      onCommitMany={(pairs) => attributesCommitMany(state, pairs)}
      onClose={() => setEditor(undefined)}
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
    for (const [key, value] of Object.entries(patch)) {
      onSetProp(key, value, true);
    }
  }
  setEditor(undefined);
}

function AttrEditor(props: AttrEditorProps) {
  const state = useAttrEditor(props);
  const { ref, pos: position, syntax, isStyleValue, assetMode, setAssetMode } = state;

  return (
    <div ref={ref} className="attr-editor" style={{ top: position.top, left: position.left, width: position.width }}>
      <AttributeName state={state} />
      <AttributeNameNote name={state.draftName} tag={state.tag} reserved={state.reservedNames ?? []} syntax={state.syntax} />
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
            onClick={() => setAssetMode((previous) => !previous)}
          >
            <ElementImageIcon size={12} />
          </button>
        </div>
      )}
    </div>
  );
}

function useAttrEditor(props: AttrEditorProps) {
  const { name, value, syntax, isNew, bindContext, onCommitName, onClose, triggerRootRef } = props;
  const [draftName, setDraftName] = useState(name);
  const [draftValue, setDraftValue] = useState(value);
  const ref = useRef<HTMLDivElement>(null);
  // Where the purple dot's picker sits, and the field's own insert-at-the-caret
  // handle — the same pair every schema-driven field uses (see PropField).
  const [insertAt, setInsertAt] = useState<FieldPosition | undefined>(undefined);
  // Where the bigger value editor sits, when `=` has asked for one.
  const [bigAt, setBigAt] = useState<FieldPosition | undefined>(undefined);
  // What this value can name, for the completions and the chips — the same list
  // the picker beside the field offers.
  const scope = scopeCompletions(bindContext || {});
  const scopeNames = new Set(scope.map((completion) => completion.label.split('.')[0] ?? ''));
  const chipsInScope = (text: string) => scopeChips(text, scopeNames);
  const bindApiRef = useRef<InsertAPI | undefined>(undefined);

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

  useAttrEditorDismiss(ref, triggerRootRef, onClose);
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
function useAttrEditorDismiss(ref: RefObject<HTMLElement>, triggerRootRef: RefObject<HTMLElement>, onClose: () => void) {
  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof window.Node)) {
        return;
      }
      if (ref.current?.contains(target)) {
        return;
      }
      const trigger = target instanceof window.Element ? target.closest('[data-attribute-editor-trigger]') : undefined;
      if (trigger && triggerRootRef.current?.contains(trigger)) {
        return;
      }
      onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose, ref, triggerRootRef]);
}
// Advice under the Name, never a refusal: a name this tag does not take, or
// one the component already means something by, still saves (htmlAttributes.ts).
export function AttributeNameNote(props: {
  readonly name: string;
  readonly tag: string | undefined;
  readonly reserved: readonly string[];
  readonly syntax: 'pair' | 'spread';
}) {
  const note = props.syntax === 'spread' ? undefined : attributeNameNote(props.name, props.tag, props.reserved);
  return note === undefined ? undefined : (
    <div className="attr-name-note" role="note">
      {note}
    </div>
  );
}
function AttributeName({ state }: { readonly state: AttributeState }) {
  const { syntax, isNew, draftName, setDraftName, setDraftValue, onCommitPair, onCommitMany, commitName } = state;
  return (
    <div className="attr-editor-row">
      <span>Name</span>
      <input
        autoFocus={isNew}
        value={draftName}
        readOnly={syntax === 'spread'}
        placeholder="data-attribute"
        spellCheck={false}
        onPaste={(event) => {
          if (syntax === 'spread') {
            return;
          }
          const text = event.clipboardData.getData('text');
          // Only when it actually looks like markup — a plain name paste
          // must keep behaving like a paste into a text box.
          if (!text || !/=/.test(text)) {
            return;
          }
          const pairs = parseAttrPaste(text);
          if (!pairs.length) {
            return;
          }
          event.preventDefault();
          const pair = pairs[0];
          if (pairs.length === 1 && pair) {
            setDraftName(pair.name);
            setDraftValue(pair.value);
            onCommitPair(pair.name, pair.value);
          } else {
            onCommitMany(pairs);
          }
        }}
        onChange={(event) => setDraftName(event.target.value.replace(/[^\w@:.-]/g, ''))}
        onBlur={commitName}
        onKeyDown={(event) => event.key === 'Enter' && (commitName(), event.currentTarget.blur())}
      />
    </div>
  );
}
function AttributeValue({ state }: { readonly state: AttributeState }) {
  const { isStyleValue, draftValue, focusValue, setDraftValue, onChangeValue, assetMode, projectPath } = state;
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
        onChange={(value) => {
          setDraftValue(value);
          onChangeValue(value);
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
  const allowCode = useCodeAccess();
  const { draftValue, setDraftValue, onChangeValue, bindContext, dataContext, bindApiRef, insertAt, setInsertAt, ref, setBigAt } = state;
  const valueRef = useRef<HTMLDivElement>(null);
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
          bindContext={bindContext}
          dataContext={dataContext}
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
              setInsertAt(undefined);
              return;
            }
            const rect = (host || ref.current)?.getBoundingClientRect();
            if (!rect) {
              return;
            }
            setInsertAt(dataPickerPosition(rect));
          }}
        />
      </div>
      {allowCode && (
        <button
          type="button"
          className="attr-expand-toggle"
          title="Expand value"
          aria-label="Expand value"
          onClick={() => openExpandedAttribute(valueRef.current ?? undefined, setBigAt)}
        >
          <MaximizeIcon size={12} />
        </button>
      )}
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
  const { bigAt, draftName, draftValue, scope, chipsInScope, bindContext, setDraftValue, onChangeValue, setBigAt, insertAt, setInsertAt, bindApiRef } = state;
  return (
    <>
      {bigAt ? (
        <ValueCodeEditor
          pos={bigAt}
          name={draftName || 'value'}
          value={draftValue}
          scope={scope}
          chipsOf={chipsInScope}
          bindContext={bindContext}
          onChange={(text) => {
            setDraftValue(text);
            onChangeValue(text);
          }}
          onClose={() => setBigAt(undefined)}
        />
      ) : undefined}
      {insertAt ? (
        <FieldDataPicker
          pos={insertAt}
          bindContext={bindContext}
          seed={{ fit: 'text', label: draftName || 'value', value: draftValue.startsWith('{') ? '' : draftValue }}
          onBindNew={(path) => {
            setInsertAt(undefined);
            setDraftValue(`{${path}}`);
            onChangeValue(`{${path}}`);
          }}
          onPick={(path) => {
            setInsertAt(undefined);
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
          onClose={() => setInsertAt(undefined)}
        />
      ) : undefined}
    </>
  );
}

export function ObjectAttrsField(props: ObjectAttrsFieldProps) {
  const state = useObjectAttrsField(props);
  const { pill, menu, entries, onCommit, editor, setEditor, listRef, openEditor } = state;

  return (
    <div className="props-field" ref={listRef}>
      <div className="props-label-row">
        {pill}
        <button className="ghost" title="Add attribute" data-attribute-editor-trigger onClick={() => openEditor(undefined)}>
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
              data-attribute-editor-trigger
              onClick={() => openEditor(i)}
            >
              <span className="attr-name">{en.key}</span>
              <span className="attr-eq">=</span>
              <span className="attr-value">{decodeRaw(en.raw)}</span>
              <button
                className="row-action"
                title="Delete attribute"
                onClick={(event) => {
                  event.stopPropagation();
                  if (editor?.index === i) {
                    setEditor(undefined);
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
  const [editor, setEditor] = useState<ObjectEditor | undefined>(undefined);
  const listRef = useRef<HTMLDivElement>(null);

  const openEditor = (index: number | undefined) => {
    const rect = listRef.current?.getBoundingClientRect();
    setEditor((current) =>
      current !== undefined && current.index === index
        ? undefined
        : {
            index,
            top: Math.min((rect?.bottom ?? 200) + 6, window.innerHeight - 150),
            left: rect?.left ?? 0,
            width: rect?.width ?? 240,
          },
    );
  };

  return { ...props, editor, setEditor, listRef, openEditor };
}
type ObjectAttributesState = ReturnType<typeof useObjectAttrsField>;
function ObjectAttrsFieldPopup({ state }: { readonly state: ObjectAttributesState }) {
  const { entries, bindContext, projectPath, onCommit, editor, setEditor } = state;
  if (!editor) {
    return undefined;
  }
  return (
    <AttrEditor
      key={editor.index ?? '__new'}
      pos={editor}
      triggerRootRef={state.listRef}
      projectPath={projectPath ?? undefined}
      bindContext={bindContext}
      dataContext={bindContext}
      name={editor.index !== undefined ? (entries[editor.index]?.key ?? '') : ''}
      value={editor.index !== undefined ? decodeRaw(entries[editor.index]?.raw ?? '') : ''}
      syntax="pair"
      isNew={editor.index === undefined}
      onCommitName={(newName) => {
        const clean = newName.trim();
        if (!clean) {
          return;
        }
        if (editor.index === undefined) {
          if (entries.some((en) => en.key === clean)) {
            return;
          }
          onCommit([...entries, { key: clean, raw: 'true' }]);
          setEditor((current) => (current ? { ...current, index: entries.length } : undefined));
        } else if (clean !== entries[editor.index]?.key) {
          onCommit(entries.map((en, i) => (i === editor.index ? { ...en, key: clean } : en)));
        }
      }}
      onChangeValue={(text) => {
        if (editor.index !== undefined) {
          onCommit(entries.map((en, i) => (i === editor.index ? { ...en, raw: encodeRaw(text) } : en)));
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
        setEditor((current) => (current ? { ...current, index } : undefined));
      }}
      onCommitMany={(pairs) => {
        const replacements = new Map(entries.map((entry) => [entry.key, entry]));
        for (const pair of pairs) {
          replacements.set(pair.name, { key: pair.name, raw: encodeRaw(pair.value) });
        }
        onCommit([...replacements.values()]);
        setEditor(undefined);
      }}
      onClose={() => setEditor(undefined)}
    />
  );
}

function openExpandedAttribute(host: HTMLElement | undefined, open: (position: FieldPosition) => void): void {
  if (host) {
    open(expandedAttributeEditorPosition(host));
  }
}
