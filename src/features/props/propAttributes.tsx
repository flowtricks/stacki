import { useCodeAccess } from '../../ui/CodeAccess';
import { dataPickerPosition } from './dataPickerPosition';
import { useEffect, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import type { Attr } from '../../../shared/page/pageNode';
import type { PropValues } from './propRules';
import type { RichContext } from './RichContent';
import type { SourceContext, FieldPosition, FieldPickerAt, InsertAPI } from './propBindings';
import { assert } from '../../../shared/core/assert';
import { LIMITS } from '../../../shared/core/limits';
import { scopeChips, scopeCompletions } from '../../editor/dataSuggest';
import StyleEditor, { collapseDeclarations } from './StyleEditor';
import AssetField from '../../ui/AssetField';
import { looksLikeAssetPath, mediaKindFor } from '../../ui/AssetThumb';
import { BindField, BindHandle, FieldDataPicker, ValueCodeEditor } from './propBindings';
import { BracesIcon, PlusIcon, TrashIcon, ElementImageIcon, MaximizeIcon } from '../../ui/Icons';
import { AttributesPropControl } from './AttributesPropBinding';
import { CodeInline } from '../../ui/CodeBlock';
import { ConditionalBadge, ConditionalEditor, ConditionalField, useConditionCatalog } from './ConditionalValue';
import { useTranslate, useTranslateDescribed } from '../../lib/i18n/useTranslate';
import { classListOfAttr, conditionalOfAttr, startingConditional, valueLanguageOf } from './conditionalModel';
import { ClassListField } from './ClassListValue';
import { isReferencePath } from '../../editor/conditionalValue';
import { readAttributesBinding } from '../../editor/attributesBinding';
import { attributeNameNote, type AttributeNameContext } from '../../editor/htmlAttributes';
import { visibleAttributeNames } from '../../../shared/core/internalAttributes';
import {
  type AttributePair,
  type ObjectEntry,
  type SpreadName,
  decodeAttr,
  encodeAttr,
  parseAttrPaste,
  decodeRaw,
  encodeRaw,
  spreadOfName,
  typedAttributeName,
} from './attributeText';
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
  /**
   * Writes the whole attribute list in order, for removing a spread: the
   * engine edits a spread only as part of its tag (planner.ts), so taking one
   * out is the tag rewritten without it, one undo step.
   */
  readonly onReplaceAttributes?: ((props: Readonly<Record<string, Attr>>) => void) | undefined;
  readonly onSetFrontmatter?: ((source: string) => void) | undefined;
}
interface AttrEditorProps extends ContextProps {
  readonly tag?: string | undefined;
  readonly reservedNames?: readonly string[] | undefined;
  readonly pos: FieldPosition;
  readonly triggerRootRef: RefObject<HTMLElement>;
  readonly name: string;
  readonly value: string;
  readonly isNew: boolean;
  /** The names the element's other attributes have, which a new or renamed one would duplicate. */
  readonly takenNames: readonly string[];
  readonly dataContext?: SourceContext | undefined;
  readonly onCommitName: (name: string) => void;
  /** Adds a spread of `path` typed into a new attribute's Name; absent where a spread cannot be written. */
  readonly onCommitSpread?: ((path: string) => void) | undefined;
  /** What the spread being edited passes (`rest`), when the attribute is a spread. */
  readonly spreadPath?: string | undefined;
  /** Points the spread being edited at `path`, in its place; absent where a spread cannot be written. */
  readonly onRenameSpread?: ((path: string) => void) | undefined;
  readonly onCommitPair: (name: string, value: string) => void;
  readonly onCommitMany: (pairs: readonly AttributePair[]) => void;
  readonly onChangeValue: (value: string) => void;
  /** Writes a value made whole elsewhere (the Value conditions editor) at once, undefined leaving the attribute out: one undo step. */
  readonly onApplyValue: (value: Attr | undefined) => void;
  readonly onClose: () => void;
}
interface ObjectAttrsFieldProps extends ContextProps {
  readonly pill: ReactNode;
  readonly menu: ReactNode;
  readonly entries: readonly ObjectEntry[];
  readonly onCommit: (entries: readonly ObjectEntry[]) => void;
}

export function AttributesSection(props: AttributesSectionProps) {
  const translate = useTranslate();
  const state = useAttributesSection(props);
  const { node, onSetProp, editor, setEditor, listRef, openEditor, tag, onReplaceProps, bindContext } = state;
  // Connected to the component's attributes prop: the defaults before the
  // spread are the prop's, edited from its settings; the spread itself and
  // the rows after it are the element's own markup, in source order.
  const restLocal = bindContext?.newProp?.restLocal;
  const binding = restLocal === undefined ? undefined : readAttributesBinding(node.props, restLocal);
  // Stacki's own attributes stay on the node and are never a row: no edit here
  // can reach them, so every write below carries them through untouched.
  const ownNames = visibleAttributeNames(state.names);
  const names = binding === undefined ? ownNames : ownNames.filter((name) => !binding.defaults.some((entry) => entry.name === name));

  return (
    <div className="props-field" ref={listRef}>
      {/* A label activates its control on any click, including blank space.
          A plain row keeps the add button as the only activation target. */}
      <div className="props-label-row">
        <span className="prop-label">
          <BracesIcon size={12} className="prop-label-icon" />
          {translate('props.attributes.title')}
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
        <button className="ghost" title={translate('props.attributes.add')} data-attribute-editor-trigger onClick={() => openEditor(undefined)}>
          <PlusIcon size={12} />
        </button>
      </div>

      {names.length > 0 && (
        <div className="attrs-list">
          {names.map((name) => {
            const value = node.props?.[name];
            if (value?.type === 'spread') {
              return <SpreadRow key={name} name={name} spread={value.value} state={state} />;
            }
            return (
              <div
                key={name}
                className={`attr-row pair ${editor?.attr === name ? 'editing' : ''}`}
                data-attribute-editor-trigger
                onClick={() => openEditor(name)}
              >
                <span className="attr-name">{name}</span>
                <span className="attr-eq">=</span>
                <AttributeRowValue name={name} value={value} />
                <button
                  className="row-action"
                  title={translate('props.attributes.delete')}
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

      <AttributesSectionPopup state={state} />
    </div>
  );
}

// A pair's value as its row previews it: a conditional or a class list as its
// chip, anything else as written.
function AttributeRowValue({ name, value }: { readonly name: string; readonly value: Attr | undefined }) {
  const translate = useTranslate();
  if (conditionalOfAttr(value) !== undefined) {
    return (
      <span className="attr-value">
        <ConditionalBadge />
      </span>
    );
  }
  if (name === 'class:list' && classListOfAttr(value) !== undefined) {
    return (
      <span className="attr-value">
        <ConditionalBadge label={translate('props.classList.title')} />
      </span>
    );
  }
  return <span className="attr-value">{decodeAttr(value)}</span>;
}

// A spread (`{...rest}`, `{...Astro.props}`) as the code it is: no name to
// rename and no value to edit, only where it sits, which decides whether the
// attributes beside it override it or are overridden. Removing it rewrites
// the tag without it and leaves every other attribute where it was.
function SpreadRow({ name, spread, state }: { readonly name: string; readonly spread: string; readonly state: AttributesState }) {
  const translate = useTranslate();
  const { node, onReplaceAttributes, editor, openEditor } = state;
  assert(name.startsWith('...'), 'SpreadRow: a spread is keyed by its source');
  return (
    <div
      className={`attr-row spread ${editor?.attr === name ? 'editing' : ''}`}
      title={translate('props.attributes.spreadTitle')}
      data-attribute-editor-trigger
      onClick={() => openEditor(name)}
    >
      <span className="attr-name">
        <CodeInline text={`{...${spread}}`} language="javascript" />
      </span>
      {onReplaceAttributes !== undefined && (
        <button
          className="row-action"
          title={translate('props.attributes.deleteSpread')}
          aria-label={translate('props.attributes.deleteSpreadNamed', { spread: `{...${spread}}` })}
          onClick={(event) => {
            event.stopPropagation();
            if (editor?.attr === name) {
              state.setEditor(undefined);
            }
            onReplaceAttributes(withoutAttribute(node.props, name));
          }}
        >
          <TrashIcon size={12} />
        </button>
      )}
    </div>
  );
}

/** The attributes in order with a spread of `path` last, where a new attribute goes; one already there stays where it is. */
export function withSpreadAdded(props: PropValues | undefined, path: string): Readonly<Record<string, Attr>> {
  const key = `...${path}`;
  const out: Record<string, Attr> = {};
  for (const [name, value] of Object.entries(props ?? {})) {
    if (value !== undefined) {
      Object.defineProperty(out, name, { value, enumerable: true, writable: true, configurable: true });
    }
  }
  if (!Object.hasOwn(out, key)) {
    Object.defineProperty(out, key, { value: { type: 'spread', value: path }, enumerable: true, writable: true, configurable: true });
  }
  assert(out[key]?.type === 'spread', 'withSpreadAdded: the spread is there');
  assert(Object.keys(out).length <= LIMITS.attrsPerNodeMax + 1, 'withSpreadAdded: attribute limit exceeded');
  return out;
}

/** The attributes in order with the spread keyed `from` now spreading `path`, in the same place. */
export function withSpreadRenamed(props: PropValues | undefined, from: string, path: string): Readonly<Record<string, Attr>> {
  const key = `...${path}`;
  assert(Object.hasOwn(props ?? {}, from), 'withSpreadRenamed: the spread is there');
  const out: Record<string, Attr> = {};
  for (const [name, value] of Object.entries(props ?? {})) {
    const [slot, entry]: readonly [string, Attr | undefined] = name === from ? [key, { type: 'spread', value: path }] : [name, value];
    if (entry !== undefined) {
      Object.defineProperty(out, slot, { value: entry, enumerable: true, writable: true, configurable: true });
    }
  }
  assert(Object.keys(out).indexOf(key) === Object.keys(props ?? {}).indexOf(from), 'withSpreadRenamed: the spread keeps its place');
  return out;
}

/** The attributes in order without `name`, Stacki's own included. */
export function withoutAttribute(props: PropValues | undefined, name: string): Readonly<Record<string, Attr>> {
  const out: Record<string, Attr> = {};
  const entries = Object.entries(props ?? {});
  assert(entries.length <= LIMITS.attrsPerNodeMax, 'withoutAttribute: attribute limit exceeded');
  for (const [key, value] of entries) {
    if (key !== name && value !== undefined) {
      Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
    }
  }
  assert(!Object.hasOwn(out, name), 'withoutAttribute: the attribute is gone');
  return out;
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
  // A spread opens the editor on its code: a Name of `{...rest}` and no value.
  const spreadPath = value?.type === 'spread' ? value.value : undefined;
  const onReplaceAttributes = state.onReplaceAttributes;
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
      name={spreadPath === undefined ? (editor.attr ?? '') : `{...${spreadPath}}`}
      value={spreadPath === undefined ? decodeAttr(value) : ''}
      spreadPath={spreadPath}
      onRenameSpread={
        onReplaceAttributes === undefined || editor.attr === undefined
          ? undefined
          : (path) => {
              const from = editor.attr;
              if (from === undefined) {
                return;
              }
              onReplaceAttributes(withSpreadRenamed(node.props, from, path));
              setEditor((current) => (current ? { ...current, attr: `...${path}` } : undefined));
            }
      }
      isNew={editor.attr === undefined}
      takenNames={Object.keys(node.props ?? {}).filter((key) => key !== editor.attr)}
      onCommitSpread={
        onReplaceAttributes === undefined
          ? undefined
          : (path) => {
              setEditor(undefined);
              onReplaceAttributes(withSpreadAdded(node.props, path));
            }
      }
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
      onApplyValue={(next) => {
        if (editor.attr) {
          onSetProp(editor.attr, next, true);
          if (next === undefined) {
            setEditor(undefined); // No value left the attribute out: there is no row to edit.
          }
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
  const translate = useTranslate();
  const state = useAttrEditor(props);
  const { ref, pos: position, isStyleValue, assetMode, setAssetMode, spreadName } = state;

  return (
    <div ref={ref} className="attr-editor" style={{ top: position.top, left: position.left, width: position.width }}>
      <AttributeName state={state} />
      {spreadName.kind === 'none' && state.spreadPath === undefined && (
        <AttributeNameNote
          name={state.draftName}
          context={{ tag: state.tag, reserved: state.reservedNames ?? [], own: state.isNew ? undefined : state.name, taken: state.takenNames }}
        />
      )}
      {spreadName.kind === 'none' && state.spreadPath !== undefined && (
        <div className="attr-name-note" role="alert">
          {translate('props.attributes.spreadName')}
        </div>
      )}
      {spreadName.kind !== 'none' && (
        <SpreadNameNote
          spread={spreadName}
          // An existing spread always says what it does; a new one only where one can be written.
          available={state.spreadPath !== undefined || state.onCommitSpread !== undefined}
        />
      )}
      {/* The field sits beside its label like the name row, whichever kind it
          is; `top` just stops the label and toggle from centring against a
          tall field. A spread has no value. */}
      {spreadName.kind === 'none' && state.spreadPath === undefined && (
        <div className={`attr-editor-row ${isStyleValue || assetMode ? 'top' : ''}`} ref={state.valueRowRef}>
          <span>{translate('props.attributes.value')}</span>
          <AttributeValue state={state} />
          <AttributePopups state={state} />
          <button
            className={`attr-asset-toggle ${assetMode ? 'on' : ''}`}
            title={assetMode ? translate('props.attributes.plainValue') : translate('props.attributes.chooseFile')}
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
  const { value, isNew, bindContext, onCommitName, onCommitSpread, onClose, triggerRootRef } = props;
  const { name } = props;
  const [draftName, setDraftName] = useState(name);
  const [draftValue, setDraftValue] = useState(value);
  const ref = useRef<HTMLDivElement>(null);
  // Where the purple dot's picker sits, and the field's own insert-at-the-caret
  // handle — the same pair every schema-driven field uses (see PropField).
  const [insertAt, setInsertAt] = useState<FieldPickerAt | undefined>(undefined);
  // Where the bigger value editor sits, when `=` has asked for one.
  const [bigAt, setBigAt] = useState<FieldPosition | undefined>(undefined);
  // What this value can name, for the completions and the chips — the same list
  // the picker beside the field offers.
  const scope = scopeCompletions(bindContext || {});
  const scopeNames = new Set(scope.map((completion) => completion.label.split('.')[0] ?? ''));
  const chipsInScope = (text: string) => scopeChips(text, scopeNames);
  const bindApiRef = useRef<InsertAPI | undefined>(undefined);
  // The Value row, which the Value conditions editor opens beside, and whether it is open.
  const valueRowRef = useRef<HTMLDivElement>(null);
  const [conditionalOpen, setConditionalOpen] = useState(false);

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

  // A spread typed into a new attribute's Name is the whole attribute: it is
  // added in place and the editor closes, as it has nothing more to edit.
  const spreadName = spreadOfName(draftName);
  const commitSpread = (path: string): void => {
    if (props.takenNames.includes(`...${path}`)) {
      return;
    }
    if (isNew && onCommitSpread !== undefined) {
      onCommitSpread(path);
    } else if (props.spreadPath !== undefined && props.spreadPath !== path && props.onRenameSpread !== undefined) {
      props.onRenameSpread(path);
    }
  };
  const commitName = () => {
    switch (spreadName.kind) {
      case 'none':
        // A spread stays a spread: its Name is its code, and an attribute is added on its own.
        if (props.spreadPath === undefined) {
          onCommitName(draftName);
        }
        return;
      case 'spread':
        commitSpread(spreadName.path);
        return;
      case 'invalid':
        return; // The note under the Name says why; nothing is written.
      default: {
        const exhaustive: never = spreadName;
        return exhaustive;
      }
    }
  };

  useAttrEditorDismiss(ref, triggerRootRef, onClose);
  return {
    ...props,
    name,
    spreadName,
    commitSpread,
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
    valueRowRef,
    conditionalOpen,
    setConditionalOpen,
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
      // A press in a pop-up this editor opened (a menu, the Value conditions
      // editor) is inside the editor as far as the person is concerned.
      if (target instanceof window.Element && target.closest('[data-popup-phase]') !== null) {
        return;
      }
      const trigger = target instanceof window.Element ? target.closest('[data-attribute-editor-trigger]') : undefined;
      if (trigger && triggerRootRef.current?.contains(trigger)) {
        return;
      }
      onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      // A pop-up open over the editor (a menu, the Value conditions editor)
      // takes Escape for itself; the next Escape closes the editor.
      if (event.key === 'Escape' && document.querySelector('[data-popup-phase]') === null) {
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
export function AttributeNameNote(props: { readonly name: string; readonly context: AttributeNameContext }) {
  const translate = useTranslate();
  const note = attributeNameNote(props.name, props.context, translate);
  return note === undefined ? undefined : (
    <div className="attr-name-note" role="note">
      {note}
    </div>
  );
}
// What a spread typed into the Name does, shown as it is typed: the code it
// writes, highlighted, and what it passes; or why it cannot be written.
function SpreadNameNote({ spread, available }: { readonly spread: Exclude<SpreadName, { readonly kind: 'none' }>; readonly available: boolean }) {
  const translate = useTranslate();
  const translateDescribed = useTranslateDescribed();
  if (spread.kind === 'invalid') {
    return (
      <div className="attr-name-note" role="alert">
        {translateDescribed(spread)}
      </div>
    );
  }
  if (!available) {
    return (
      <div className="attr-name-note" role="note">
        {translate('props.attributes.spreadAdded')}
      </div>
    );
  }
  return (
    <div className="attr-name-note attr-spread-note" role="note">
      <CodeInline text={`{...${spread.path}}`} language="javascript" />
      {translate('props.attributes.spreadPasses', { path: spread.path })}
    </div>
  );
}
function AttributeName({ state }: { readonly state: AttributeState }) {
  const translate = useTranslate();
  const { isNew, draftName, setDraftName, setDraftValue, onCommitPair, onCommitMany, commitName } = state;
  const nameRef = useRef<HTMLDivElement>(null);
  const [picker, setPicker] = useState<FieldPosition | undefined>(undefined);
  // A spread's Name takes data like a value does: the dot picks what it spreads.
  const spreading = state.spreadPath !== undefined || state.spreadName.kind !== 'none';
  return (
    <div className="attr-editor-row">
      <span>{translate('props.attributes.name')}</span>
      <div className="attr-name-field" ref={nameRef}>
        <input
          autoFocus={isNew}
          value={draftName}
          placeholder="data-attribute"
          spellCheck={false}
          onPaste={(event) => {
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
          onChange={(event) => setDraftName(typedAttributeName(event.target.value))}
          onBlur={commitName}
          onKeyDown={(event) => event.key === 'Enter' && (commitName(), event.currentTarget.blur())}
        />
        {spreading && (
          <BindHandle
            active={picker !== undefined}
            onOpen={() => {
              const bounds = nameRef.current?.getBoundingClientRect();
              setPicker(picker !== undefined || bounds === undefined ? undefined : dataPickerPosition(bounds));
            }}
          />
        )}
      </div>
      {picker !== undefined && (
        <FieldDataPicker
          pos={picker}
          bindContext={state.bindContext}
          current={state.spreadName.kind === 'spread' ? state.spreadName.path : undefined}
          onPick={(path) => {
            setPicker(undefined);
            // What it spreads is a name in scope: a prop, a frontmatter object.
            if (isReferencePath(path)) {
              setDraftName(`{...${path}}`);
              state.commitSpread(path);
            }
          }}
          onClose={() => setPicker(undefined)}
        />
      )}
    </div>
  );
}
function AttributeValue({ state }: { readonly state: AttributeState }) {
  const { isStyleValue, draftValue, focusValue, setDraftValue, onChangeValue, assetMode, projectPath } = state;
  // Code the Value conditions editor can draw is drawn by it; any other code keeps the code editor.
  const conditional = conditionalOfAttr(encodeAttr(draftValue));
  // A `class:list` in the shape the class-list editor draws is drawn by it.
  const classList = state.draftName === 'class:list' ? classListOfAttr(encodeAttr(draftValue)) : undefined;
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
  ) : classList !== undefined ? (
    <ClassListField model={classList} value={encodeAttr(draftValue)} bindContext={state.bindContext} onApply={(next) => applyValue(state, next)} />
  ) : conditional !== undefined ? (
    <ConditionalField
      model={conditional}
      value={encodeAttr(draftValue)}
      bindContext={state.bindContext}
      language={valueLanguageOf(state.draftName)}
      onApply={(next) => applyValue(state, next)}
    />
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
  const translate = useTranslate();
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
          placeholder={translate('props.attributes.typeOrInsert')}
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
          onOpen={(host, focus) => {
            if (insertAt) {
              setInsertAt(undefined);
              return;
            }
            const rect = (host || ref.current)?.getBoundingClientRect();
            if (!rect) {
              return;
            }
            setInsertAt({ ...dataPickerPosition(rect), focus });
          }}
        />
      </div>
      {allowCode && (
        <button
          type="button"
          className="attr-expand-toggle"
          title={translate('props.attributes.expand')}
          aria-label={translate('props.attributes.expand')}
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
  const catalog = useConditionCatalog(bindContext);
  // Only in a component, which has props to test, and only for a value a branch can hold.
  const start = bindContext?.newProp === undefined ? undefined : startingConditional(encodeAttr(draftValue), catalog);
  return (
    <>
      {state.conditionalOpen && start !== undefined && (
        <ConditionalEditor
          anchorRef={state.valueRowRef}
          start={start}
          model={undefined}
          value={encodeAttr(draftValue)}
          bindContext={bindContext}
          language={valueLanguageOf(draftName)}
          onApply={(next) => applyValue(state, next)}
          onClose={() => state.setConditionalOpen(false)}
        />
      )}
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
            // At the caret while the value is being typed, so a chip lands
            // beside what is already there; the dot pressed outside the field
            // connects the whole value (fieldFocus.ts).
            if (insertAt.focus.kind === 'focused' && bindApiRef.current?.insert) {
              bindApiRef.current.insert(path);
              return;
            }
            const text = `{${path}}`;
            setDraftValue(text);
            onChangeValue(text);
          }}
          onConditional={
            start === undefined
              ? undefined
              : () => {
                  setInsertAt(undefined);
                  state.setConditionalOpen(true);
                }
          }
          onClose={() => setInsertAt(undefined)}
        />
      ) : undefined}
    </>
  );
}

// A whole value from the Value conditions editor: shown at once, written at once.
function applyValue(state: AttributeState, next: Attr | undefined): void {
  state.setDraftValue(decodeAttr(next));
  state.onApplyValue(next);
}

export function ObjectAttrsField(props: ObjectAttrsFieldProps) {
  const translate = useTranslate();
  const state = useObjectAttrsField(props);
  const { pill, menu, entries, onCommit, editor, setEditor, listRef, openEditor } = state;

  return (
    <div className="props-field" ref={listRef}>
      <div className="props-label-row">
        {pill}
        <button className="ghost" title={translate('props.attributes.add')} data-attribute-editor-trigger onClick={() => openEditor(undefined)}>
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
                title={translate('props.attributes.delete')}
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
      takenNames={entries.filter((_, index) => index !== editor.index).map((entry) => entry.key)}
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
      onApplyValue={(next) => {
        if (editor.index === undefined) {
          return;
        }
        if (next === undefined) {
          onCommit(entries.filter((_, i) => i !== editor.index));
          setEditor(undefined);
          return;
        }
        const text = decodeAttr(next);
        onCommit(entries.map((en, i) => (i === editor.index ? { ...en, raw: encodeRaw(text) } : en)));
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
