import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { HTML_TAGS, VOID_TAGS } from '../elementSchemas.js';
import { elementIcon } from '../ui/Icons.jsx';
import Dropdown from '../ui/Dropdown.jsx';
import AutoTextarea from '../ui/AutoTextarea.jsx';
import ClassInput from '../ui/ClassInput.jsx';
import CodeEditor from '../ui/CodeEditor.jsx';
import StyleEditor, { collapseDeclarations } from '../ui/StyleEditor.jsx';
import ExprInput from '../ui/ExprInput.jsx';
import RichContent, { isInlineOnly } from '../ui/RichContent.jsx';
import AssetField from '../ui/AssetField.jsx';
import { looksLikeAssetPath, mediaKindFor } from '../ui/AssetThumb.jsx';
import { dataSuggestions, exprSuggestions, findDeclaration } from '../dataSuggest.js';
import LinkField from '../ui/LinkField.jsx';
import {

  ResetIcon,
  FieldNumberIcon,
  ComponentPropertiesIcon,
  VariableTextSizeIcon,
  ElementComponentIcon,
  ElementSlotIcon,
  CommentIcon,
  CodeIcon,
  PlusIcon,
  TrashIcon,
  BracesIcon,
  TagIcon,
  ElementImageIcon,
  PencilIcon,
  CloseIcon,
} from '../ui/Icons.jsx';

// Edits the props of the selected node. Fields come from the component's
// prop schema (interface Props / Astro.props destructure), plus any props
// already set on the node that aren't in the schema.
export default function PropsPanel({
  node,
  isLayout,
  layouts,
  currentLayoutName,
  onChangeLayout,
  schema,
  slotOptions,
  projectClasses,
  allowAttrs,
  comment,
  onSetComment,
  loopContext,
  linkContext,
  onSetProp,
  onRenameProp,
  onChangeTag,
  onSetText,
  onSetContent,
  onSetInline,
  onOpenCode,
  onSetFrontmatter,
  projectPath,
}) {
  if (!node) {
    return (
      <div className="panel-section grow" style={{ flex: '1 1 50%' }}>
        <div className="panel-header">
          <h2>Settings</h2>
        </div>
        <div className="props-empty">Select a component to edit its props.</div>
      </div>
    );
  }

  // The page frontmatter (imports, consts, data) opens in a floating editor.
  if (node.kind === 'frontmatter') {
    return (
      <div className="panel-section grow" style={{ flex: '1 1 50%', overflow: 'hidden' }}>
        <div className="props-title">
          <CodeIcon size={14} className="props-title-icon" />
          Frontmatter
        </div>
        <div className="props-field" style={{ marginTop: 4 }}>
          <button className="primary" style={{ width: '100%' }} onClick={onOpenCode}>
            <CodeIcon size={13} /> Edit code
          </button>
          <div style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 8, lineHeight: 1.5 }}>
            Imports, constants, and data for this page. Opens in a floating
            editor you can move and resize while working with the canvas.
          </div>
        </div>
      </div>
    );
  }

  // Expression nodes ({items.map(...)}) get a raw code editor.
  if (node.kind === 'expr') {
    return (
      <div className="panel-section grow" style={{ flex: '1 1 50%', overflow: 'hidden' }}>
        <div className="panel-header">
          <h2>Expression</h2>
        </div>
        <div className="props-field" style={{ marginTop: 8 }}>
          <label>
            <span className="prop-label">Code</span>
          </label>
          <ExprInput
            key={node.id}
            value={node.value}
            syncValue={node.value}
            onCommit={(v) => v !== node.value && onSetText(v)}
          />
        </div>
      </div>
    );
  }

  // Map/loop nodes: friendly Data/Item/Index fields when the head fits the
  // simple `data.map((item[, index]) => (` shape; raw code otherwise.
  if (node.kind === 'map') {
    return (
      <div className="panel-section grow" style={{ flex: '1 1 50%', overflow: 'hidden' }}>
        <div className="panel-header">
          <h2>Loop</h2>
        </div>
        <MapEditor key={node.id} node={node} loopContext={loopContext} onSetText={onSetText} />
      </div>
    );
  }

  // Comment nodes get a single text editor.
  if (node.kind === 'comment') {
    return (
      <div className="panel-section grow" style={{ flex: '1 1 50%', overflow: 'hidden' }}>
        <div className="panel-header">
          <h2>Comment</h2>
        </div>
        <div className="props-field" style={{ marginTop: 8 }}>
          <label>
            <span className="prop-label">
              <CommentIcon size={12} className="prop-label-icon" />
              Comment
            </span>
          </label>
          <AutoTextarea
            minRows={3}
            value={node.value}
            onChange={(e) => onSetText(e.target.value)}
          />
        </div>
      </div>
    );
  }

  // <style>/<script> nodes get their content in a CodeMirror editor, with
  // any attributes (is:global, type, …) editable above it.
  if (node.kind === 'raw') {
    const language = node.name === 'style' ? 'css' : 'javascript';
    const attrs = Object.keys(node.props || {});
    return (
      <div className="panel-section grow" style={{ flex: '1 1 50%', overflow: 'hidden' }}>
        <div className="props-title">
          <CodeIcon size={14} className="props-title-icon" />
          {`<${node.name}>`}
        </div>
        {attrs.length > 0 && (
          <div style={{ flexShrink: 0 }}>
            {attrs.map((name) => (
              <PropField
                key={name}
                field={{ name, type: 'other' }}
                value={node.props[name]}
                onChange={(v, immediate) => onSetProp(name, v, immediate)}
              />
            ))}
          </div>
        )}
        <div className="props-field" style={{ marginTop: 4 }}>
          <button className="primary" style={{ width: '100%' }} onClick={onOpenCode}>
            <CodeIcon size={13} /> Edit code
          </button>
          <div style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 8, lineHeight: 1.5 }}>
            Opens the {language} in a floating editor you can move and resize
            while working with the canvas.
          </div>
        </div>
      </div>
    );
  }

  // Text nodes get a single content editor.
  if (node.kind === 'text') {
    return (
      <div className="panel-section grow" style={{ flex: '1 1 50%', overflow: 'hidden' }}>
        <div className="panel-header">
          <h2>Text</h2>
        </div>
        <div className="props-field" style={{ marginTop: 8 }}>
          <label>
            <span className="prop-label">
              <VariableTextSizeIcon size={12} className="prop-label-icon" />
              Content
            </span>
          </label>
          <AutoTextarea
            minRows={3}
            value={node.value}
            onChange={(e) => onSetText(e.target.value)}
          />
        </div>
      </div>
    );
  }

  const schemaNames = new Set(schema.map((s) => s.name));

  // The slot field renders in one stable spot whether or not the attribute
  // is currently set — hover-previewing a value must not remount the field
  // (that would close the dropdown mid-hover).
  const showSlotField =
    Array.isArray(slotOptions) &&
    slotOptions.some((s) => s !== 'default') &&
    !schemaNames.has('slot');
  let extraProps = Object.keys(node.props || {}).filter(
    (k) => !schemaNames.has(k) && !(showSlotField && k === 'slot')
  );
  // With a free-form Attributes section, unknown attrs live there instead of
  // as individual fields — except class, which keeps its dedicated field.
  let attrNames = [];
  if (allowAttrs) {
    attrNames = extraProps.filter((k) => k !== 'class' && k !== 'slot');
    extraProps = extraProps.filter((k) => k === 'class' || k === 'slot');
  }

  // Content field: shown when the children are inline-only (text plus simple
  // tags like <strong>/<em>), edited with the rich inline editor. An element
  // that's still empty — a just-inserted <h1> or <p> — has no inline children
  // to detect, so offer the editor there too; otherwise there'd be no way to
  // type its first words. Void tags can't hold content at all.
  const isEmpty = !Array.isArray(node.children) || node.children.length === 0;
  const canHoldText =
    node.kind === 'element' && !VOID_TAGS.has(String(node.name).toLowerCase());
  const showContentField = isInlineOnly(node.children) || (isEmpty && canHoldText);
  // <slot> does take children, but they're the fallback Astro renders only
  // when the caller passes nothing — labelling it "Content" reads as if it
  // were what shows on the page.
  const isSlot = node.kind === 'element' && node.name === 'slot';

  // Where a prop's {expression} can be pointing, and how to write that source
  // back — lets an expression field edit the declaration behind it.
  const dataCtx = { frontmatter: loopContext?.frontmatter || '', onSetFrontmatter };

  return (
    <div className="panel-section grow" style={{ flex: '1 1 50%', overflow: 'hidden' }}>
      <div className="props-title">
        {node.kind === 'element' ? (
          elementIcon(node.name, 16, 'props-title-icon')
        ) : (
          <ElementComponentIcon size={16} className="props-title-icon" />
        )}
        {isLayout ? currentLayoutName || node.name : node.name}
        {isLayout && <span className="badge">layout</span>}
      </div>
      <div className="panel-body" style={{ padding: 0 }}>
        {node.kind === 'element' && onChangeTag && (
          <TagField key="tag" tag={node.name} onChangeTag={onChangeTag} />
        )}
        {isLayout && Array.isArray(layouts) && layouts.length > 0 && (
          <div className="props-field" key="layout">
            <label>
              <span className="prop-label">
                <ComponentPropertiesIcon size={12} className="prop-label-icon" />
                Layout
              </span>
            </label>
            <Dropdown
              value={currentLayoutName}
              options={[
                // Keep an unresolvable wrapper (not one of the scanned layout
                // files) selectable rather than showing an empty trigger.
                ...(currentLayoutName && !layouts.some((l) => l.name === currentLayoutName)
                  ? [{ value: currentLayoutName, label: currentLayoutName }]
                  : []),
                ...layouts.map((l) => ({ value: l.name, label: l.name })),
              ]}
              onChange={(v) => onChangeLayout(v)}
            />
          </div>
        )}
        {showContentField && (
          <div className="props-field" key="content">
            <label>
              <span className="prop-label">
                <VariableTextSizeIcon size={12} className="prop-label-icon" />
                {isSlot ? 'Fallback' : 'Content'}
              </span>
            </label>
            <RichContent
            key={node.id}
            nodes={node.children}
            exprOptions={exprSuggestions(loopContext || {})}
            onChange={onSetInline}
          />
            {isSlot && (
              <div style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 6, lineHeight: 1.5 }}>
                Shown only when whatever uses this component passes nothing for
                the slot.
              </div>
            )}
          </div>
        )}
        {schema.map((field) => (
          <PropField
            key={field.name}
            field={field}
            value={node.props[field.name]}
            slotOptions={slotOptions}
            projectClasses={projectClasses}
            assetCtx={{ projectPath, nodeName: node.name }}
            linkContext={linkContext}
            dataCtx={dataCtx}
            onChange={(v, immediate) => onSetProp(field.name, v, immediate)}
          />
        ))}
        {extraProps.map((name) => (
          <PropField
            key={name}
            field={{ name, type: 'other' }}
            value={node.props[name]}
            slotOptions={slotOptions}
            projectClasses={projectClasses}
            assetCtx={{ projectPath, nodeName: node.name }}
            linkContext={linkContext}
            dataCtx={dataCtx}
            onChange={(v, immediate) => onSetProp(name, v, immediate)}
          />
        ))}
        {showSlotField && (
          <PropField
            key="slot"
            field={{ name: 'slot', type: 'slot' }}
            value={node.props?.slot}
            slotOptions={slotOptions}
            onChange={(v, immediate) => onSetProp('slot', v, immediate)}
          />
        )}
        {allowAttrs && (
          <AttributesSection
            key="attrs"
            node={node}
            names={attrNames}
            projectPath={projectPath}
            onSetProp={onSetProp}
            onRenameProp={onRenameProp}
          />
        )}
        {onSetComment && (node.kind === 'element' || node.kind === 'component') && (
          <CommentField key="comment" value={comment} onCommit={onSetComment} />
        )}
        {!isLayout &&
          !allowAttrs &&
          schema.length === 0 &&
          extraProps.length === 0 &&
          !showContentField && (
            <div className="props-empty">
              {node.kind === 'element'
                ? 'This HTML element has no attributes set.'
                : 'This component declares no props (add an interface Props or an Astro.props destructure to expose some).'}
            </div>
          )}
      </div>
    </div>
  );
}

// The HTML comment directly above this node — the note the navigator shows
// beside its name. Committed on blur (not per keystroke): every edit rewrites
// the page, and a comment isn't worth a save per character. Clearing the field
// removes the comment node.
function CommentField({ value, onCommit }) {
  const [draft, setDraft] = useState(value ?? '');
  // Re-sync when the model changes underneath (undo, external edit) — but not
  // while typing, or the caret would jump.
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(value ?? '');
  }, [value]);
  const commit = () => {
    const next = draft.trim();
    if (next !== (value ?? '').trim()) onCommit(next);
  };
  return (
    <div className="props-field props-comment">
      <label>
        <span className="prop-label">
          <CommentIcon size={12} className="prop-label-icon" />
          Comment
        </span>
      </label>
      <AutoTextarea
        minRows={1}
        placeholder="Note above this element…"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={() => { focused.current = true; }}
        onBlur={() => { focused.current = false; commit(); }}
      />
    </div>
  );
}

// Displayable text for an attribute value; '' means a bare attribute.
const decodeAttr = (v) =>
  v == null || v.type === 'bare' ? '' : v.type === 'expr' ? `{${v.value}}` : String(v.value);
// Inverse: '' → bare, "{...}" → expression, anything else → string.
const encodeAttr = (text) => {
  if (text === '') return { type: 'bare' };
  const m = text.match(/^\{([\s\S]*)\}$/);
  if (m) return { type: 'expr', value: m[1].trim() };
  return { type: 'string', value: text };
};

// Free-form attribute list for elements and ...rest components: + adds,
// hover-trash deletes, clicking a row opens a name/value editor.
function AttributesSection({ node, names, projectPath, onSetProp, onRenameProp }) {
  const [editor, setEditor] = useState(null); // {attr: string|null, top}
  const listRef = useRef(null);

  const openEditor = (attr) => {
    const rect = listRef.current?.getBoundingClientRect();
    setEditor({
      attr,
      top: Math.min((rect?.bottom ?? 200) + 6, window.innerHeight - 150),
      left: rect?.left ?? 0,
      width: rect?.width ?? 240,
    });
  };

  return (
    <div className="props-field" ref={listRef}>
      <label style={{ display: 'flex', alignItems: 'center' }}>
        <span className="prop-label">
          <BracesIcon size={12} className="prop-label-icon" />
          Attributes
        </span>
        <span style={{ flex: 1 }} />
        <button className="ghost" title="Add attribute" onClick={() => openEditor(null)}>
          <PlusIcon size={12} />
        </button>
      </label>

      {names.length > 0 && (
        <div className="attrs-list">
          {names.map((name) => (
            <div
              key={name}
              className={`attr-row ${editor?.attr === name ? 'editing' : ''}`}
              onClick={() => openEditor(name)}
            >
              <span className="attr-name">{name}</span>
              <span className="attr-eq">=</span>
              <span className="attr-value">{decodeAttr(node.props[name])}</span>
              <button
                className="row-action"
                title="Delete attribute"
                onClick={(e) => {
                  e.stopPropagation();
                  if (editor?.attr === name) setEditor(null);
                  onSetProp(name, undefined, true);
                }}
              >
                <TrashIcon size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      {editor && (
        <AttrEditor
          key={editor.attr ?? '__new'}
          pos={editor}
          projectPath={projectPath}
          name={editor.attr ?? ''}
          value={editor.attr ? decodeAttr(node.props[editor.attr]) : ''}
          isNew={editor.attr === null}
          existingNames={names}
          onCommitName={(newName) => {
            const clean = newName.trim();
            if (editor.attr === null) {
              // New attribute: created once a valid name exists.
              if (clean && !node.props?.[clean]) {
                onSetProp(clean, { type: 'bare' }, true);
                setEditor((e) => ({ ...e, attr: clean }));
              }
            } else if (clean && clean !== editor.attr) {
              onRenameProp(editor.attr, clean);
              setEditor((e) => ({ ...e, attr: clean }));
            }
          }}
          onChangeValue={(text) => {
            if (editor.attr) onSetProp(editor.attr, encodeAttr(text));
          }}
          onClose={() => setEditor(null)}
        />
      )}
    </div>
  );
}

// Floating name/value editor for one attribute.
function AttrEditor({ pos, name, value, isNew, projectPath, onCommitName, onChangeValue, onClose }) {
  const [draftName, setDraftName] = useState(name);
  const [draftValue, setDraftValue] = useState(value);
  const ref = useRef(null);

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

  useEffect(() => {
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const commitName = () => onCommitName(draftName);

  return (
    <div
      ref={ref}
      className="attr-editor"
      style={{ top: pos.top, left: pos.left, width: pos.width }}
    >
      <div className="attr-editor-row">
        <span>Name</span>
        <input
          autoFocus={isNew}
          value={draftName}
          placeholder="data-attribute"
          spellCheck={false}
          onChange={(e) => setDraftName(e.target.value.replace(/[^\w@:.-]/g, ''))}
          onBlur={commitName}
          onKeyDown={(e) => e.key === 'Enter' && (commitName(), e.currentTarget.blur())}
        />
      </div>
      {/* The field sits beside its label like the name row, whichever kind it
          is; `top` just stops the label and toggle from centring against a
          tall field. */}
      <div className={`attr-editor-row ${isStyleValue || assetMode ? 'top' : ''}`}>
        <span>Value</span>
        {isStyleValue ? (
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
              projectPath={projectPath}
              onChange={(v) => {
                setDraftValue(v);
                onChangeValue(v);
              }}
            />
          </div>
        ) : (
          <input
            autoFocus={focusValue}
            value={draftValue}
            placeholder="value or {expression}"
            spellCheck={false}
            onChange={(e) => {
              setDraftValue(e.target.value);
              onChangeValue(e.target.value);
            }}
            onKeyDown={(e) => e.key === 'Enter' && onClose()}
          />
        )}
        <button
          className={`attr-asset-toggle ${assetMode ? 'on' : ''}`}
          title={assetMode ? 'Edit as a plain value' : 'Choose a file from public/'}
          onClick={() => setAssetMode((v) => !v)}
        >
          <ElementImageIcon size={12} />
        </button>
      </div>
    </div>
  );
}

// Shallow object literal ({ id: "x", tabindex: 3 }) ↔ ordered entries.
// Returns null for nesting/spreads the row editor can't represent (the
// caller falls back to the generic expression field).
function parseObjectLiteral(src) {
  const t = String(src ?? '').trim();
  const m = t.match(/^\{([\s\S]*)\}$/);
  if (!m) return t === '' ? [] : null;
  const inner = m[1].trim();
  if (!inner) return [];
  if (/[{}]|\.\.\./.test(inner)) return null;
  const entries = [];
  const re =
    /\s*(?:"([^"]*)"|'([^']*)'|([\w$@:.-]+))\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|[^,]+?)\s*(?:,|$)/y;
  let pos = 0;
  while (pos < inner.length) {
    re.lastIndex = pos;
    const em = re.exec(inner);
    if (!em) return null;
    entries.push({ key: em[1] ?? em[2] ?? em[3], raw: em[4].trim() });
    pos = re.lastIndex;
  }
  return entries;
}

function serializeObjectLiteral(entries) {
  const body = entries
    .map((e) => `${/^[A-Za-z_$][\w$]*$/.test(e.key) ? e.key : JSON.stringify(e.key)}: ${e.raw}`)
    .join(', ');
  return `{ ${body} }`;
}

// Row display/edit encoding: quoted strings edit as plain text, anything
// else as {expression}; an empty value means `true`.
const decodeRaw = (raw) => {
  const m = String(raw).match(/^"((?:[^"\\]|\\.)*)"$|^'((?:[^'\\]|\\.)*)'$/);
  if (m) return (m[1] ?? m[2]).replace(/\\(.)/g, '$1');
  return raw === 'true' ? '' : `{${raw}}`;
};
const encodeRaw = (text) => {
  if (text === '') return 'true';
  const m = text.match(/^\{([\s\S]*)\}$/);
  if (m) return m[1].trim() || 'true';
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
};

// Attributes-object props (containerAttrs = {} etc.): entries edit like
// element attributes and serialize back to a shallow { key: value } literal.
// Removing the last row resets the prop to its default.
function ObjectAttrsField({ pill, menu, entries, onCommit }) {
  const [editor, setEditor] = useState(null); // {index: number|null, top, left, width}
  const listRef = useRef(null);

  const openEditor = (index) => {
    const rect = listRef.current?.getBoundingClientRect();
    setEditor({
      index,
      top: Math.min((rect?.bottom ?? 200) + 6, window.innerHeight - 150),
      left: rect?.left ?? 0,
      width: rect?.width ?? 240,
    });
  };

  return (
    <div className="props-field" ref={listRef}>
      <label style={{ display: 'flex', alignItems: 'center' }}>
        {pill}
        <span style={{ flex: 1 }} />
        <button className="ghost" title="Add attribute" onClick={() => openEditor(null)}>
          <PlusIcon size={12} />
        </button>
        {menu}
      </label>

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
                  if (editor?.index === i) setEditor(null);
                  onCommit(entries.filter((_, j) => j !== i));
                }}
              >
                <TrashIcon size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      {editor && (
        <AttrEditor
          key={editor.index ?? '__new'}
          pos={editor}
          projectPath={projectPath}
          name={editor.index != null ? entries[editor.index]?.key ?? '' : ''}
          value={editor.index != null ? decodeRaw(entries[editor.index]?.raw ?? '') : ''}
          isNew={editor.index == null}
          onCommitName={(newName) => {
            const clean = newName.trim();
            if (!clean) return;
            if (editor.index == null) {
              if (entries.some((en) => en.key === clean)) return;
              onCommit([...entries, { key: clean, raw: 'true' }]);
              setEditor((ed) => ({ ...ed, index: entries.length }));
            } else if (clean !== entries[editor.index].key) {
              onCommit(entries.map((en, i) => (i === editor.index ? { ...en, key: clean } : en)));
            }
          }}
          onChangeValue={(text) => {
            if (editor.index != null) {
              onCommit(
                entries.map((en, i) => (i === editor.index ? { ...en, raw: encodeRaw(text) } : en))
              );
            }
          }}
          onClose={() => setEditor(null)}
        />
      )}
    </div>
  );
}

// Parses a loop head like `service.tags.map((tag) => (` or
// `items.filter(i => i.on).map((item, index) => (` into friendly fields.
// The data part is any expression, so filtered/sorted collections still fit;
// only destructured params or non-arrow callbacks fall back to code.
function parseMapHead(head) {
  const m = String(head)
    .trim()
    .match(/^([\s\S]+?)\.map\(\s*\(\s*([\w$]+)\s*(?:,\s*([\w$]+)\s*)?\)\s*=>\s*\($/);
  return m ? { data: m[1].trim(), item: m[2], index: m[3] || '' } : null;
}

const IDENT_RE = /^[A-Za-z_$][\w$]*$/;

// "No source yet" has to be written as real code, since the head is what
// lands in the page. An empty literal is valid, renders nothing, and — unlike
// a placeholder name like `items` — can't throw "items is not defined" and
// take the whole preview down before the user has picked anything.
const NO_SOURCE = '[]';
const CUSTOM_SOURCE = '__custom__'; // not a valid expression, so it can't collide
const DEFAULT_ITEM = 'item'; // a value no expression can collide with

function MapEditor({ node, loopContext, onSetText }) {
  const parsed = parseMapHead(node.head);
  const [fields, setFields] = useState(parsed || { data: '', item: '', index: '' });
  const lastBuiltRef = useRef(node.head);

  // Everything on the page that can actually be looped: frontmatter lists,
  // imports, the items of enclosing loops.
  const sources = React.useMemo(
    () => dataSuggestions(loopContext || {}, ''),
    // loopContext is rebuilt per render in App, so key on its contents.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [JSON.stringify(loopContext || {})]
  );
  const isCustomData = (data) => {
    const d = (data || '').trim();
    return !!d && d !== NO_SOURCE && !sources.some((s) => s.insert === d);
  };
  const [custom, setCustom] = useState(() => isCustomData(fields.data));

  // External changes (undo, file reload, code edits below) re-sync fields.
  useEffect(() => {
    if (node.head !== lastBuiltRef.current) {
      const p = parseMapHead(node.head);
      if (p) {
        setFields(p);
        setCustom(isCustomData(p.data));
      }
      lastBuiltRef.current = node.head;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.head]);

  // Typing only updates local state; the head is written on blur/Enter/pick
  // so half-typed values never run in the preview.
  const update = (patch) => setFields((f) => ({ ...f, ...patch }));
  const commit = (next) => {
    setFields(next);
    const itemOk = IDENT_RE.test(next.item);
    const indexOk = !next.index || IDENT_RE.test(next.index);
    if (!next.data.trim() || !itemOk || !indexOk) return; // incomplete — don't write broken code
    const head = `${next.data.trim()}.map((${next.item}${next.index ? `, ${next.index}` : ''}) => (`;
    if (head === node.head) return;
    // Renaming the item or index has to carry into the children that
    // reference it. Only a rename counts — adding or removing an index
    // leaves nothing to point the old name at.
    const prev = parseMapHead(node.head);
    const renames = [];
    if (prev) {
      if (prev.item && next.item && prev.item !== next.item) {
        renames.push({ from: prev.item, to: next.item });
      }
      if (prev.index && next.index && prev.index !== next.index) {
        renames.push({ from: prev.index, to: next.index });
      }
    }
    lastBuiltRef.current = head;
    onSetText(head, renames);
  };
  const commitOnEnter = (e) => {
    if (e.key === 'Enter') commit(fields);
  };

  // Changing the source changes what the item *is*, so a name describing the
  // old data ("service" for a list of projects) is worse than none. Back to
  // the default; the rename above carries the children with it.
  const commitSource = (data) => {
    const changed = (parseMapHead(node.head)?.data || '') !== data.trim();
    commit({ ...fields, data, item: changed ? DEFAULT_ITEM : fields.item });
  };

  const parseableNow = !!parseMapHead(node.head);
  const isNoSource = !fields.data.trim() || fields.data.trim() === NO_SOURCE;
  const itemBad = fields.item !== '' && !IDENT_RE.test(fields.item);
  const indexBad = fields.index !== '' && !IDENT_RE.test(fields.index);

  return (
    <>
      {parseableNow ? (
        <>
          <div className="props-field" style={{ marginTop: 8 }}>
            <label>
              <span className="prop-label">Data</span>
            </label>
            <Dropdown
              livePreview={false}
              className={`dd-source ${custom || !isNoSource ? 'on' : ''}`}
              value={custom ? CUSTOM_SOURCE : isNoSource ? '' : fields.data.trim()}
              options={[
                { value: '', label: 'None' },
                ...sources.map((s) => ({ value: s.insert, label: s.insert })),
                { value: CUSTOM_SOURCE, label: 'Custom…' },
              ]}
              onChange={(v) => {
                if (v === CUSTOM_SOURCE) {
                  // Start the field empty rather than showing the `[]` that
                  // stands for "none" — that's an implementation detail.
                  setCustom(true);
                  if (!isCustomData(fields.data)) update({ data: '' });
                  return;
                }
                setCustom(false);
                commitSource(v || NO_SOURCE);
              }}
            />
            {custom && (
              <div style={{ marginTop: 6 }}>
                <ExprInput
                  autoFocus
                  value={fields.data}
                  syncValue={fields.data}
                  placeholder="e.g. Astro.props.items"
                  onChange={(v) => update({ data: v })}
                  onCommit={(v) => commitSource(v)}
                />
              </div>
            )}
          </div>
          <div className="props-field">
            <label>
              <span className="prop-label">Item name</span>
            </label>
            <input
              value={fields.item}
              placeholder="e.g. service"
              spellCheck={false}
              style={itemBad ? { borderColor: 'var(--red)' } : undefined}
              onChange={(e) => update({ item: e.target.value })}
              onBlur={() => commit(fields)}
              onKeyDown={commitOnEnter}
            />
          </div>
          <div className="props-field">
            <label>
              <span className="prop-label">Index name</span>
              <span className="type-tag">optional</span>
            </label>
            <input
              value={fields.index}
              placeholder="e.g. index"
              spellCheck={false}
              style={indexBad ? { borderColor: 'var(--red)' } : undefined}
              onChange={(e) => update({ index: e.target.value })}
              onBlur={() => commit(fields)}
              onKeyDown={commitOnEnter}
            />
          </div>
        </>
      ) : (
        <div
          className="props-field"
          style={{ marginTop: 8, fontSize: 11, color: 'var(--text-faint)' }}
        >
          Custom loop code — edit it below.
        </div>
      )}
      <div className="props-field" style={{ marginTop: parseableNow ? 2 : 0 }}>
        <label>
          <span className="prop-label">
            <CodeIcon size={12} className="prop-label-icon" />
            Code
          </span>
        </label>
        <ExprInput
          value={node.head}
          syncValue={node.head}
          onCommit={(v) => v !== node.head && onSetText(v)}
        />
      </div>
    </>
  );
}

// Tag switcher for plain elements: free text with a suggestion list of
// standard HTML tags. Committing renames the element — the navigator icon
// follows the tag, and attributes invalid for the new tag are dropped.
function TagField({ tag, onChangeTag }) {
  const [draft, setDraft] = useState(tag);
  const [focused, setFocused] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [popupPos, setPopupPos] = useState(null);
  const wrapRef = useRef(null);
  const inputRef = useRef(null);
  useEffect(() => setDraft(tag), [tag]);

  const q = draft.trim().toLowerCase();
  const matches =
    focused && q && q !== tag
      ? HTML_TAGS.filter((t) => t.includes(q))
          .sort((a, b) => {
            const ap = a.startsWith(q) ? 0 : 1;
            const bp = b.startsWith(q) ? 0 : 1;
            return ap - bp || a.length - b.length;
          })
          .slice(0, 12)
      : [];

  useLayoutEffect(() => {
    if (!matches.length || !wrapRef.current) {
      setPopupPos(null);
      return;
    }
    const r = wrapRef.current.getBoundingClientRect();
    setPopupPos({ left: r.left, top: r.bottom + 4, width: r.width });
  }, [matches.length, draft]); // eslint-disable-line react-hooks/exhaustive-deps

  const commit = (t) => {
    const clean = String(t).trim().toLowerCase();
    if (/^[a-z][a-z0-9-]*$/.test(clean) && clean !== tag) onChangeTag(clean);
    else setDraft(tag);
  };

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown' && matches.length) {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, matches.length - 1));
    } else if (e.key === 'ArrowUp' && matches.length) {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      commit(matches.length ? matches[Math.min(highlight, matches.length - 1)] : draft);
      inputRef.current?.blur();
    } else if (e.key === 'Tab' && matches.length) {
      e.preventDefault();
      commit(matches[Math.min(highlight, matches.length - 1)]);
      inputRef.current?.blur();
    } else if (e.key === 'Escape') {
      setDraft(tag);
      inputRef.current?.blur();
    }
  };

  return (
    <div className="props-field" ref={wrapRef}>
      <label>
        <span className="prop-label">
          <TagIcon size={12} className="prop-label-icon" />
          Tag
        </span>
      </label>
      <input
        ref={inputRef}
        value={draft}
        spellCheck={false}
        onChange={(e) => {
          setDraft(e.target.value);
          setHighlight(0);
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          commit(draft);
        }}
        onKeyDown={onKeyDown}
      />
      {popupPos && (
        <div
          className="dd-popup class-suggest"
          style={{ left: popupPos.left, top: popupPos.top, width: popupPos.width }}
        >
          {matches.map((t, i) => (
            <div
              key={t}
              className={`dd-option ${i === highlight ? 'highlight' : ''}`}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setHighlight(i)}
              onClick={() => {
                commit(t);
                inputRef.current?.blur();
              }}
            >
              <span className="dd-option-label">{t}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// The identifier an expression is *about*: `rotatingWords` for both
// `rotatingWords` and `site.nav.items`. Anything with a call, an operator or
// a literal in it isn't a plain reference to one declaration, so it has no
// source to open.
function referencedName(expr) {
  const m = String(expr ?? '')
    .trim()
    .match(/^([A-Za-z_$][\w$]*)(?:\s*\.\s*[A-Za-z_$][\w$]*)*$/);
  return m ? m[1] : '';
}

// A prop value that holds JavaScript. It's code, so it's highlighted; and
// when it names something the file declares, a pencil opens that declaration
// right here — changing the three words in `const rotatingWords = […]` is
// part of the same thought as pointing the prop at it, and shouldn't mean a
// trip to the frontmatter editor.
function ExprValueField({ value, dataCtx, onChange }) {
  const [pos, setPos] = useState(null);
  const wrapRef = useRef(null);

  const code = dataCtx?.frontmatter || '';
  const name = referencedName(value);
  const decl = name && dataCtx?.onSetFrontmatter ? findDeclaration(code, name) : null;

  const open = () => {
    const r = wrapRef.current?.getBoundingClientRect();
    const width = Math.max(r?.width ?? 240, 260);
    setPos({
      top: Math.min((r?.bottom ?? 200) + 6, Math.max(60, window.innerHeight - 240)),
      left: Math.min(r?.left ?? 0, window.innerWidth - width - 12),
      width,
    });
  };

  return (
    <>
      <div className="prop-expr-row" ref={wrapRef}>
        <ExprInput
          value={value}
          syncValue={value}
          placeholder="expression"
          onChange={(v) => onChange({ type: 'expr', value: v })}
          onCommit={(v) => v !== value && onChange({ type: 'expr', value: v }, true)}
        />
        {decl && (
          <button
            className={`attr-asset-toggle ${pos ? 'on' : ''}`}
            title={`Edit ${name}`}
            onClick={() => (pos ? setPos(null) : open())}
          >
            <PencilIcon size={12} />
          </button>
        )}
      </div>
      {pos && decl && (
        <VarSourceEditor
          pos={pos}
          name={name}
          code={code}
          onChangeCode={dataCtx.onSetFrontmatter}
          onClose={() => setPos(null)}
        />
      )}
    </>
  );
}

// Edits one declaration's source in place: the statement is spliced back into
// the frontmatter on every keystroke, so the canvas updates as you type, the
// rest of the file is untouched, and ⌘Z behaves like any other edit.
function VarSourceEditor({ pos, name, code, onChangeCode, onClose }) {
  const ref = useRef(null);
  const codeRef = useRef(code);
  codeRef.current = code;
  const [draft, setDraft] = useState(() => findDeclaration(code, name)?.statement ?? '');
  const rangeRef = useRef(null);

  const apply = (text) => {
    setDraft(text);
    const src = codeRef.current;
    // Re-locate on every write: the surrounding code can shift under us (an
    // undo, an edit elsewhere). Renaming the variable inside this editor is
    // the one case the lookup can't follow — fall back to where we last wrote.
    const found = findDeclaration(src, name);
    const range = found ? { start: found.start, end: found.end } : rangeRef.current;
    if (!range) return;
    rangeRef.current = { start: range.start, end: range.start + text.length };
    onChangeCode(src.slice(0, range.start) + text + src.slice(range.end));
  };

  // Capture phase: what's inside is CodeMirror and what's around it is the
  // panel's own pointer/key handling, either of which can stop an event before
  // a bubbling listener on the document would see it.
  useEffect(() => {
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [onClose]);

  // Outside edits (undo) reach the editor as a changed statement; our own
  // writes come back identical, so typing isn't fought.
  const external = findDeclaration(code, name)?.statement;

  return (
    <div
      ref={ref}
      className="attr-editor var-src"
      style={{ top: pos.top, left: pos.left, width: pos.width }}
      // Escape typed inside the code editor closes the popup, independently of
      // the document listener above.
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="var-src-head">
        <CodeIcon size={12} />
        <span className="var-src-name">{name}</span>
        <span style={{ flex: 1 }} />
        <button className="ghost" title="Close" onClick={onClose}>
          <CloseIcon size={12} />
        </button>
      </div>
      <ExprInput
        multiline
        autoFocus
        className="var-src-code"
        value={draft}
        syncValue={external ?? draft}
        onChange={apply}
      />
    </div>
  );
}

function PropField({
  field,
  value,
  slotOptions,
  projectClasses,
  assetCtx,
  linkContext,
  dataCtx,
  onChange,
}) {
  const { name, type } = field;
  const isSet = value !== undefined;
  const [menuPos, setMenuPos] = useState(null);

  const reset = () => {
    setMenuPos(null);
    onChange(undefined, true);
  };

  const onLabelClick = (e) => {
    if (!isSet) return;
    if (e.altKey) {
      reset();
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    setMenuPos({ left: rect.left, top: rect.bottom + 4 });
  };

  const pill = (
    <span
      className={`prop-label${isSet ? ' set' : ''}`}
      title={isSet ? '⌥-click to reset to default' : undefined}
      onClick={onLabelClick}
    >
      {type === 'number' && <FieldNumberIcon size={12} className="prop-label-icon" />}
      {type === 'enum' && <ComponentPropertiesIcon size={12} className="prop-label-icon" />}
      {type === 'attrs' && <BracesIcon size={12} className="prop-label-icon" />}
      {(type === 'slot' || name === 'slot') && (
        <ElementSlotIcon size={12} className="prop-label-icon" />
      )}
      {(type === 'string' || type === 'other') && name !== 'slot' && (
        <VariableTextSizeIcon size={12} className="prop-label-icon" />
      )}
      {name}
    </span>
  );
  const menu = menuPos && (
    <ResetMenu pos={menuPos} onReset={reset} onClose={() => setMenuPos(null)} />
  );
  const label = (
    <label>
      {pill}
      {menu}
    </label>
  );

  // Attributes-object props (containerAttrs etc.) edit as name/value rows.
  if (type === 'attrs') {
    const src = value?.type === 'expr' ? value.value : null;
    const entries =
      src != null
        ? parseObjectLiteral(src)
        : parseObjectLiteral(typeof field.default === 'string' ? field.default : '{}') ?? [];
    if (entries) {
      return (
        <ObjectAttrsField
          pill={pill}
          menu={menu}
          entries={entries}
          onCommit={(next) =>
            next.length
              ? onChange({ type: 'expr', value: serializeObjectLiteral(next) }, true)
              : onChange(undefined, true)
          }
        />
      );
    }
    // Unparsable (nested objects, spreads) — fall through to the generic
    // expression field below.
  }

  // Class-list props edit as tags with project-wide class autocomplete.
  if (
    /class(es)?$/i.test(name) &&
    name !== 'slot' &&
    (type === 'string' || type === 'other') &&
    value?.type !== 'expr'
  ) {
    return (
      <div className="props-field">
        {label}
        <ClassInput
          value={value?.value || ''}
          suggestions={projectClasses || []}
          onChange={(v, immediate) =>
            v.trim()
              ? onChange({ type: 'string', value: v }, immediate)
              : onChange(undefined, true)
          }
        />
      </div>
    );
  }

  // The slot attribute picks which of the parent component's slots this node
  // fills. Unset = the default slot.
  if (name === 'slot' && Array.isArray(slotOptions) && slotOptions.length) {
    const raw = value?.value;
    const named = slotOptions.filter((s) => s !== 'default');
    // Keep an out-of-list current value selectable rather than losing it.
    const opts = [
      { value: '', label: 'default', dim: true },
      ...(raw && raw !== 'default' && !named.includes(raw) ? [{ value: raw, label: raw }] : []),
      ...named.map((s) => ({ value: s, label: s })),
    ];
    return (
      <div className="props-field">
        {label}
        <Dropdown
          value={raw && raw !== 'default' ? raw : ''}
          options={opts}
          onChange={(v) =>
            v === ''
              ? onChange(undefined, true)
              : onChange({ type: 'string', value: v }, true)
          }
        />
      </div>
    );
  }

  if (type === 'enum' && field.options?.length) {
    const defaultStr = field.default !== undefined ? String(field.default) : undefined;
    const raw = value?.value;
    // The default option is encoded as '' (= prop not set), so an unset prop
    // shows its default as the selected option and picking the default
    // resets the prop rather than writing it out explicitly.
    const cur = raw === undefined || raw === defaultStr ? '' : raw;
    // Keep an out-of-schema current value selectable rather than losing it.
    const opts =
      raw === undefined || field.options.includes(raw)
        ? field.options
        : [raw, ...field.options];
    return (
      <div className="props-field">
        {label}
        <Dropdown
          value={cur}
          placeholder="(not set)"
          options={opts.map((o) => ({ value: o === defaultStr ? '' : o, label: o }))}
          onChange={(v) =>
            v === ''
              ? onChange(undefined, true)
              : onChange({ type: 'string', value: v }, true)
          }
        />
      </div>
    );
  }

  if (type === 'boolean') {
    const checked = value ? value.type !== 'expr' || value.value === 'true' : !!field.default;
    return (
      <div className="props-field">
        {label}
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) =>
            onChange({ type: 'expr', value: e.target.checked ? 'true' : 'false' }, true)
          }
        />
      </div>
    );
  }

  if (type === 'number') {
    const num = value?.type === 'expr' ? value.value : value?.value ?? '';
    // Shift+arrow steps by 10, Option/Alt+arrow by 0.1; plain arrows keep
    // the input's native ±1 stepping.
    const onStepKey = (e) => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      if (!e.shiftKey && !e.altKey) return;
      e.preventDefault();
      const step = e.shiftKey ? 10 : 0.1;
      const dir = e.key === 'ArrowUp' ? 1 : -1;
      const cur = parseFloat(e.target.value);
      const base = Number.isFinite(cur) ? cur : parseFloat(field.default) || 0;
      // Round away float noise (e.g. 38.1 + 0.1 = 38.199999…).
      const next = Math.round((base + dir * step) * 1e6) / 1e6;
      onChange({ type: 'expr', value: String(next) });
    };
    return (
      <div className="props-field">
        {label}
        <input
          type="number"
          step="any"
          value={num}
          placeholder={field.default !== undefined ? String(field.default) : ''}
          onKeyDown={onStepKey}
          onChange={(e) =>
            e.target.value === ''
              ? onChange(undefined)
              : onChange({ type: 'expr', value: e.target.value })
          }
        />
      </div>
    );
  }

  // string / other
  const str = value ? value.value : '';
  const isExpr = value?.type === 'expr';

  // href gets the Webflow-style link settings: URL / page / section / email /
  // phone / asset, all compiling down to one href string.
  if (name === 'href' && !isExpr && linkContext) {
    return (
      <div className="props-field">
        {label}
        <LinkField
          value={value}
          context={{ ...linkContext, projectPath: assetCtx?.projectPath }}
          onChange={onChange}
        />
      </div>
    );
  }

  // Media attributes, and any other prop whose value already names a file in
  // public/ (image="/img/hero.png"), get the asset picker.
  const isMediaAttr = name === 'src' || name === 'poster';
  if (!isExpr && assetCtx?.projectPath && (isMediaAttr || looksLikeAssetPath(str))) {
    const nodeName = String(assetCtx.nodeName || '').toLowerCase();
    const mediaKind = looksLikeAssetPath(str)
      ? mediaKindFor(str)
      : name === 'poster'
        ? 'image'
        : nodeName === 'video'
          ? 'video'
          : nodeName === 'audio'
            ? 'audio'
            : ['img', 'source', 'picture', 'image'].includes(nodeName)
              ? 'image'
              : 'asset';
    return (
      <div className="props-field">
        {label}
        <AssetField
          value={str}
          mediaKind={mediaKind}
          // A non-media prop only lands here because its value is an asset
          // path, so open in asset mode; "Text" is the way back out.
          initialMode={isMediaAttr ? undefined : 'asset'}
          plainLabel={isMediaAttr ? 'URL' : 'Text'}
          projectPath={assetCtx.projectPath}
          onChange={(v, immediate) =>
            v === '' ? onChange(undefined, immediate) : onChange({ type: 'string', value: v }, immediate)
          }
        />
      </div>
    );
  }

  // An expression value is JavaScript, so it edits as code rather than text.
  if (isExpr) {
    return (
      <div className="props-field">
        {label}
        <ExprValueField value={str} dataCtx={dataCtx} onChange={onChange} />
      </div>
    );
  }

  const long =
    String(str).length > 48 || /text|description|content|body|paragraph/i.test(name);

  return (
    <div className="props-field">
      {label}
      {long ? (
        <AutoTextarea
          value={str}
          placeholder={field.default !== undefined ? String(field.default) : ''}
          onChange={(e) => onChange({ type: 'string', value: e.target.value })}
        />
      ) : (
        <input
          value={str}
          placeholder={field.default !== undefined ? String(field.default) : ''}
          onChange={(e) => onChange({ type: 'string', value: e.target.value })}
        />
      )}
    </div>
  );
}

// Small fixed-position menu opened by clicking a set prop's label.
function ResetMenu({ pos, onReset, onClose }) {
  const ref = useRef(null);

  useEffect(() => {
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    const onScroll = (e) => {
      if (ref.current && ref.current.contains(e.target)) return;
      onClose();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);

  return (
    <div ref={ref} className="prop-menu" style={{ left: pos.left, top: pos.top }}>
      <div className="prop-menu-item" onClick={onReset}>
        <ResetIcon size={12} />
        Reset to default property value
      </div>
    </div>
  );
}



