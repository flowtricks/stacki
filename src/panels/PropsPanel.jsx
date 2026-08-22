import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { HTML_TAGS, VOID_TAGS } from '../elementSchemas.js';
import { elementIcon } from '../ui/Icons.jsx';
import Dropdown from '../ui/Dropdown.jsx';
import AutoTextarea from '../ui/AutoTextarea.jsx';
import PropTip from '../ui/PropTip.jsx';
import ClassInput from '../ui/ClassInput.jsx';
import CodeEditor from '../ui/CodeEditor.jsx';
import StyleEditor, { collapseDeclarations } from '../ui/StyleEditor.jsx';
import ExprInput from '../ui/ExprInput.jsx';
import RichContent, { isInlineOnly } from '../ui/RichContent.jsx';
import { checkStatement } from '../jsCheck.js';
import AssetField from '../ui/AssetField.jsx';
import { looksLikeAssetPath, mediaKindFor } from '../ui/AssetThumb.jsx';
import {
  dataTree,
  findDeclaration,
  findImportOf,
  listsOnly,
  scopeChips,
  scopeCompletions,
} from '../dataSuggest.js';
import LinkField from '../ui/LinkField.jsx';
import DataPicker from '../ui/DataPicker.jsx';
import BindInput from '../ui/BindInput.jsx';
import {
  partsFromValue,
  resolvePick,
  templateHoles,
  valueFromParts,
  valueModeOf,
} from '../bindings.js';
import {

  ResetIcon,
  FieldNumberIcon,
  ComponentPropertiesIcon,
  VariableTextSizeIcon,
  ElementComponentIcon,
  astroAssetIcon,
  FieldSwitchIcon,
  ElementSlotIcon,
  CommentIcon,
  CodeIcon,
  ChevronDownIcon,
  PlusIcon,
  TrashIcon,
  BracesIcon,
  ChevronRightIcon,
  TagIcon,
  ElementImageIcon,
  LayoutIcon,
  BranchIcon,
  CornerIcon,
  PencilIcon,
  CloseIcon,
} from '../ui/Icons.jsx';

// Edits the props of the selected node. Fields come from the component's
// prop schema (interface Props / Astro.props destructure), plus any props
// already set on the node that aren't in the schema.
// A click anywhere in a <label onClick={noLabelActivation}> is forwarded to the first control inside it.
// These labels hold no field — the input is their sibling — but they do hold
// the bind dot and the `{}` toggle, so a press on the empty space beside a
// prop's name, or on the name itself, was silently pressing a button. On a
// field showing an expression that button means "use the control instead",
// which drops a value no control can hold: clicking next to the label cleared
// the prop. The label has nothing to activate, so it activates nothing.
//
// The Attributes row below solves the same problem by not being a <label onClick={noLabelActivation}> at
// all; these keep the tag, since the panel's styling hangs off it.
const noLabelActivation = (event) => event.preventDefault();


// Whether the Settings group is open, remembered across selections. See where it
// is read, below.
let settingsGroupOpen = false;

export default function PropsPanel({
  node,
  /** Bumped by ⌘Enter — open Settings and focus the class field. */
  focusClass,
  /** Bumped by a canvas double-click on text — focus the Content field. */
  focusContent,
  isLayout,
  layouts,
  currentLayoutName,
  onChangeLayout,
  schema,
  slotOptions,
  takesSlotText,
  tagOptions,
  projectClasses,
  allowAttrs,
  comment,
  onSetComment,
  loopContext,
  /** loopContext plus what the app can see of the data itself — the entry on
      the canvas, this file's declared props. Feeds the binding picker. */
  bindContext,
  linkContext,
  onSetProp,
  onSetProps,
  onSetAssetProp,
  onRenameProp,
  onChangeTag,
  onSetText,
  onSetContent,
  onSetInline,
  onOpenCode,
  onSetFrontmatter,
  frontmatterSource,
  onOpenSymbol,
  onToggleElse,
  projectPath,
  filePath,
}) {
  // What an expression field here can name — this file's props, its frontmatter
  // values, the item of any loop around the selection. Offered as you type, so a
  // name doesn't have to be remembered (or spelled right) to be used.
  const scope = scopeCompletions(bindContext || loopContext || {});
  // The same names, as a set: what an expression field draws as purple chips.
  const scopeNames = new Set(scope.map((c) => c.label.split('.')[0]));
  const chipsInScope = (text) => scopeChips(text, scopeNames);

  // Where the data a field points at can be edited: declarations in this
  // file's frontmatter, imports (which live in another file), and the two ways
  // of getting at them.
  const buildDataCtx = () => ({
    frontmatter: loopContext?.frontmatter || '',
    imports: frontmatterSource || '',
    onSetFrontmatter,
    onOpenSymbol,
  });

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
          <label onClick={noLabelActivation}>
            <span className="prop-label">Code</span>
          </label>
          <ExprInput
            key={node.id}
            value={node.value}
            syncValue={node.value}
            completions={scope}
            onCommit={(v) => v !== node.value && onSetText(v)}
          />
        </div>
      </div>
    );
  }

  // A literal line of source — in practice the doctype. It isn't an element,
  // so it has no tag and no props; without this it fell through to the
  // component render and claimed to "declare no props".
  if (node.kind === 'raw-line') {
    const isDoctype = /^<!doctype/i.test(node.value || '');
    return (
      <div className="panel-section grow" style={{ flex: '1 1 50%', overflow: 'hidden' }}>
        <div className="panel-header">
          <h2>{isDoctype ? 'Doctype' : 'Source line'}</h2>
        </div>
        <div className="props-field" style={{ marginTop: 8 }}>
          <label onClick={noLabelActivation}>
            <span className="prop-label">
              <CodeIcon size={12} className="prop-label-icon" />
              Line
            </span>
          </label>
          <AutoTextarea
            key={node.id}
            minRows={1}
            value={node.value}
            spellCheck={false}
            style={{ fontFamily: 'var(--mono)' }}
            onChange={(e) => onSetText(e.target.value)}
          />
          <div style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 6, lineHeight: 1.5 }}>
            {isDoctype
              ? 'Written out verbatim at the top of the page. Not an element — it has no tag or attributes.'
              : 'Written out verbatim, exactly as typed.'}
          </div>
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
        <MapEditor
          key={node.id}
          node={node}
          loopContext={loopContext}
          bindCtx={bindContext || loopContext}
          dataCtx={buildDataCtx()}
          onSetText={onSetText}
        />
      </div>
    );
  }

  // Conditions: the test is the whole node, and it's JavaScript.
  if (node.kind === 'cond') {
    const hasElse = (node.children || []).length > 1;
    return (
      <div className="panel-section grow" style={{ flex: '1 1 50%', overflow: 'hidden' }}>
        <div className="panel-header">
          <h2>Condition</h2>
        </div>
        <div className="props-field" style={{ marginTop: 8 }}>
          <label onClick={noLabelActivation}>
            <span className="prop-label">
              <BranchIcon size={12} className="prop-label-icon" />
              Show when
            </span>
          </label>
          <ConditionField
            key={node.id}
            test={node.test}
            scope={scope}
            chipsOf={chipsInScope}
            bindCtx={bindContext || loopContext}
            onSetText={onSetText}
          />
          <div style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 8, lineHeight: 1.5 }}>
            True renders <strong>then</strong>
            {hasElse ? (
              <>
                , false renders <strong>else</strong>.
              </>
            ) : (
              '; nothing renders otherwise.'
            )}{' '}
            Drop elements into either branch in the navigator.
          </div>
        </div>
        {onToggleElse && (
          <div className="props-field">
            <button style={{ width: '100%' }} onClick={() => onToggleElse(!hasElse)}>
              {hasElse ? 'Remove else branch' : 'Add else branch'}
            </button>
          </div>
        )}
      </div>
    );
  }

  // One side of a condition — nothing to configure, but saying which side it
  // is beats an empty panel.
  if (node.kind === 'branch') {
    const isElse = node.name === 'else';
    return (
      <div className="panel-section grow" style={{ flex: '1 1 50%', overflow: 'hidden' }}>
        <div className="props-title">
          <CornerIcon size={14} className="props-title-icon" />
          {isElse ? 'else' : 'then'}
        </div>
        <div className="props-empty">
          {isElse
            ? 'Rendered when the condition is false.'
            : 'Rendered when the condition is true.'}
        </div>
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
          <label onClick={noLabelActivation}>
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
  // their attributes editable above it — the same section an element gets.
  //
  // These tags carry the attributes that decide what they DO: `is:global` and
  // `define:vars` on a style, `is:inline`, `type` and `src` on a script. The
  // panel could show the ones already written but had no way to add one, so
  // the only route to a global stylesheet was to go and type the attribute
  // into the file by hand — in an app whose whole point is not having to.
  if (node.kind === 'raw') {
    const language = node.name === 'style' ? 'css' : 'javascript';
    const attrs = Object.keys(node.props || {});
    return (
      <div className="panel-section grow" style={{ flex: '1 1 50%', overflow: 'hidden' }}>
        <div className="props-title">
          <CodeIcon size={14} className="props-title-icon" />
          {`<${node.name}>`}
        </div>
        <div style={{ flexShrink: 0 }}>
          {/* `class` is not filtered out the way it is for an element: an
              element keeps a dedicated class field (the selector well drives
              its styling), and these have no such field — so here it is an
              attribute like any other, and adding one is how you get it. */}
          <AttributesSection
            node={node}
            names={attrs}
            projectPath={projectPath}
            bindCtx={bindContext || loopContext}
            onSetProp={onSetProp}
            onSetProps={onSetProps}
            onRenameProp={onRenameProp}
          />
        </div>
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
          <label onClick={noLabelActivation}>
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
  // as individual fields — except class and style, which keep dedicated ones.
  let attrNames = [];
  if (allowAttrs) {
    attrNames = extraProps.filter((k) => k !== 'class' && k !== 'style' && k !== 'slot');
    // `slot` is sorted last so a hand-written one lands where the picker's
    // does — directly above the comment — instead of in among the props.
    extraProps = extraProps
      .filter((k) => k === 'class' || k === 'slot')
      .sort((a, b) => (a === 'slot' ? 1 : b === 'slot' ? -1 : 0));
  }

  // Content field: shown when the children are inline-only (text plus simple
  // tags like <strong>/<em>), edited with the rich inline editor. An element
  // that's still empty — a just-inserted <h1> or <p> — has no inline children
  // to detect, so offer the editor there too; otherwise there'd be no way to
  // type its first words. Void tags can't hold content at all.
  // A component with a default <slot/> holds content exactly the way an
  // element does. Without this an empty one — everything the insert palette
  // adds, since a fresh instance is self-closing — has no Content field, and
  // so no way to be given its first words.
  const isEmpty = !Array.isArray(node.children) || node.children.length === 0;
  const canHoldText =
    (node.kind === 'element' && !VOID_TAGS.has(String(node.name).toLowerCase())) ||
    !!takesSlotText;
  const showContentField = isInlineOnly(node.children) || (isEmpty && canHoldText);
  // HTML lets a node hold text *and* elements — `<div>Intro<Button/></div>` is
  // ordinary markup — but the rich editor above only covers all-inline
  // children. Rather than leave the text unreachable from the node that owns
  // it, mixed children get a plain field over the loose text alone; the
  // element children it sits among are left exactly where they are.
  const looseText = !isEmpty && (node.children || []).find((c) => c.kind === 'text');
  const showLooseTextField = !showContentField && canHoldText && !isEmpty;
  // <slot> does take children, but they're the fallback Astro renders only
  // when the caller passes nothing — labelling it "Content" reads as if it
  // were what shows on the page.
  const isSlot = node.kind === 'element' && node.name === 'slot';

  // Where a prop's {expression} can be pointing, and how to write that source
  // back — lets an expression field edit the declaration behind it.
  const dataCtx = buildDataCtx();

  // Astro's <Image> (and any component that forwards to it) rejects a public/
  // path with no width and height — "MissingImageDimension" takes the page
  // down. The picker already knows the size it just showed, so an image pick
  // fills those in when the component has them. One edit, one undo.
  // The size of the image currently in `src`. width/height fall back to it
  // when unset, so it is what those fields should show as their placeholder.
  const [srcDims, setSrcDims] = useState(null);
  useEffect(() => setSrcDims(null), [node?.id]);

  // …and read them from the file as well. The card above reports what its
  // thumbnail decoded, which only happens if a thumbnail rendered — so a
  // source the picker couldn't preview (or a field the eye never reached)
  // left width/height claiming the size was "inferred". Astro infers nothing
  // for a local asset: it reads the real size out of the file, and so do we.
  const srcProp = node?.props?.src;
  const srcKey = srcProp ? `${srcProp.type}:${srcProp.value}` : '';
  useEffect(() => {
    if (!srcProp || !projectPath) return undefined;
    let live = true;
    const fromRel = (rel) =>
      rel &&
      window.avb
        .assetDimensions({ projectPath, rel })
        .then((r) => live && r?.dims && setSrcDims(r.dims))
        .catch(() => {});

    if (srcProp.type === 'string') {
      const value = String(srcProp.value || '');
      // A remote source is the one case Astro really does infer — leave it.
      if (!value || /^(https?:)?\/\//.test(value) || value.startsWith('data:')) return undefined;
      fromRel(`public/${value.replace(/^\//, '')}`);
      return () => { live = false; };
    }
    const binding = assetImportOf(srcProp.value, dataCtx?.imports);
    if (!binding || !filePath) return undefined;
    window.avb
      .resolveSourcePath({ projectPath, fromFile: filePath, spec: binding.spec })
      .then((r) => live && r?.ok && fromRel(r.rel))
      .catch(() => {});
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [srcKey, projectPath, filePath]);

  // What Astro will do with whatever is in `src`, which decides whether the
  // optimisation props mean anything:
  //   'svg'    — passed through untouched, however it's asked to be encoded
  //   'public' — served as-is; Astro never reads files under public/
  //   'asset' / 'remote' — processed normally
  // The type system can't say this (the prop is valid, the value is what makes
  // it moot) and the component can only warn about it at runtime, so the panel
  // is the only place it can be said before the fact.
  const srcKind = React.useMemo(() => {
    if (!srcProp) return null;
    const isSvg = (s) => /\.svg(\?|#|$)/i.test(String(s || ''));
    if (srcProp.type === 'string') {
      const v = String(srcProp.value || '');
      if (!v) return null;
      if (isSvg(v)) return 'svg';
      return /^(https?:)?\/\//.test(v) || v.startsWith('data:') ? 'remote' : 'public';
    }
    const binding = assetImportOf(srcProp.value, dataCtx?.imports);
    if (!binding) return null;
    return isSvg(binding.spec) ? 'svg' : 'asset';
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [srcKey, dataCtx?.imports]);

  // Changing the discriminant changes which props exist. The ones that no
  // longer apply are removed, not just hidden — leaving them in the markup
  // means the file carries props the component will ignore, and they would
  // reappear the moment the discriminant went back. Same edit, so it is one
  // undo, and the value is recoverable that way.
  // Values a discriminant switch took away, per node, kept only while the
  // panel is up: flicking variant → full-width → constrained should hand
  // `sizes` back, but reopening the project shouldn't resurrect it.
  const stashRef = useRef({});

  const setPropCascading = (fieldName, value, immediate) => {
    // Setting a prop can move which branch applies, and the props the new
    // branch forbids have to go — leaving them means the file carries props
    // the component ignores, and they would reappear on switching back. Same
    // edit, so it is one undo and the values come back together.
    const next = { ...(node.props || {}), [fieldName]: value };
    if (value === undefined) delete next[fieldName];
    // Which props this branch rules out, and every prop the same union covers
    // — the second set bounds what a switch back is allowed to bring in, so a
    // value held for one union can't be restored by an edit to another.
    const forbidden = new Set();
    const involved = new Set();
    for (const union of unions) {
      if (!union.names.includes(fieldName)) continue;
      for (const name of union.names) involved.add(name);
      // How this union decides which branch applies. When the edited prop is
      // one the branches pin to a literal (variant: "constrained"), the value
      // just picked settles it on its own — the props the losing branches
      // allowed are precisely the ones to clear, so they mustn't get a vote.
      // Otherwise the branch is discriminated by presence (`href?: never`) and
      // what's set is the only evidence there is.
      const pinsField = union.branches.some((b) =>
        Object.prototype.hasOwnProperty.call(b.pins, fieldName)
      );
      const pinsMatch = (b) => {
        for (const [name, want] of Object.entries(b.pins)) {
          const set = next[name];
          const have = set ? (set.type === 'bare' ? 'true' : String(set.value ?? ''))
            : (schema.find((x) => x.name === name)?.default ?? undefined);
          // `want` is the set of values this branch allows for that prop —
          // one for `variant: "autofit"`, several for `"autofit" | "autofill"`.
          if (have !== undefined && !want.includes(String(have))) return false;
        }
        return true;
      };
      const fits = union.branches.filter((b) => {
        if (!pinsField) for (const name of b.forbids) if (next[name] !== undefined) return false;
        return pinsMatch(b);
      });
      const live = fits.length ? fits : union.branches;
      for (const name of union.names) {
        if (name === fieldName) continue;
        if (live.every((b) => b.forbids.includes(name))) forbidden.add(name);
      }
    }

    const stash = stashRef.current[node.id] || (stashRef.current[node.id] = {});
    // Writing a prop by hand supersedes whatever was held for it.
    delete stash[fieldName];

    const patch = { [fieldName]: value };
    for (const name of forbidden) {
      if (node.props?.[name] === undefined) continue;
      stash[name] = node.props[name]; // held, so switching back can put it back
      patch[name] = undefined;
    }
    // Switching back: anything set aside that this branch allows again, and
    // that nothing has written in the meantime, returns exactly as it was.
    for (const [name, held] of Object.entries(stash)) {
      if (!involved.has(name) || forbidden.has(name)) continue;
      if (node.props?.[name] !== undefined) continue;
      patch[name] = held;
      delete stash[name];
    }

    if (Object.keys(patch).length === 1 || !onSetProps) {
      onSetProp(fieldName, value, immediate);
      return;
    }
    onSetProps(node.id, patch);
  };

  // A union type says which props go together. The panel matches what is
  // currently set against each branch and shows only the branches that could
  // still apply — so `type` disappears once `href` is filled, and `sizes` once
  // the variant is one that forbids it.
  //
  // Discrimination is by value (`variant: "fixed"`) or by presence
  // (`href?: never`); both are the same test here. When more than one branch
  // still fits — nothing set yet — everything shows, because the type hasn't
  // ruled anything out.
  const unions = schema.find((f) => f.unions)?.unions || [];
  const effective = (name) => {
    const set = node.props?.[name];
    if (set) return set.type === 'bare' ? 'true' : String(set.value ?? '');
    const f = schema.find((x) => x.name === name);
    return f?.default === undefined ? undefined : String(f.default);
  };
  // Which branches still fit what is set. One prop can be left out of the
  // test: asking what a prop may be set to cannot be answered by the branches
  // its own current value already chose — that reasoning ends with the
  // variant dropdown offering the variant it is on, and no way back.
  const branchesFitting = (ignore) =>
    unions.map((union) => {
      const fits = union.branches.filter((b) => {
        // A branch is out if something set on the node is forbidden there…
        for (const name of b.forbids) {
          if (name !== ignore && node.props?.[name] !== undefined) return false;
        }
        // …or if it fixes a prop to a value the node doesn't have.
        for (const [name, want] of Object.entries(b.pins)) {
          if (name === ignore) continue;
          const have = effective(name);
          if (have !== undefined && !want.includes(String(have))) return false;
        }
        return true;
      });
      // No branch fits (the markup is already invalid) — show everything
      // rather than hide the fields needed to fix it.
      return fits.length ? fits : union.branches;
    });

  const liveBranches = branchesFitting(null);
  // A prop whose fallback differs per branch has no single answer for the
  // field — `label` reads Play on a play control and Close on a close one —
  // but the branch in force has one, and the panel already knows which branch
  // that is. Only claimed when every branch still standing agrees: with the
  // variant unset, several fit, and the field would otherwise show whichever
  // was declared first.
  const branchDefault = (name) => {
    let found;
    for (const [i, union] of unions.entries()) {
      if (!union.names.includes(name)) continue;
      for (const b of liveBranches[i]) {
        // A branch may answer with a rule rather than a value: "Next, or
        // Previous when direction is back" turns on a prop this panel is
        // already holding, so it can be weighed rather than only shown.
        const rule = b.rules?.[name];
        const v = rule
          ? effective(rule.prop) === rule.is
            ? rule.then
            : rule.otherwise
          : b.defaults?.[name];
        if (v === undefined) continue;
        if (found !== undefined && found !== v) return undefined;
        found = v;
      }
    }
    return found;
  };

  // A branch may allow fewer values than the prop as a whole: emphasis is
  // primary, secondary or link on the main button, and only the first two on
  // a mark, which has no line of text to draw a rule under. The union says so
  // already and the panel knows which branch is in force, so the list offered
  // is that branch's rather than the sum of all of them.
  //
  // A branch that fixes nothing allows everything, and a value already in the
  // markup stays in the list whatever the branch says — hiding it would leave
  // markup the panel disagrees with and no way to see it, let alone fix it.
  //
  // The prop that CHOOSES the branch is the exception, and it has to be: the
  // props a branch allows are its consequences, not its conditions. `pressed`
  // exists only on a play control, so a paused one has it set — and the close
  // and arrow branches forbid it, which left the variant list offering main and
  // play and no way to reach the other two. Nothing was wrong with the markup
  // and nothing said so; the switch was simply not on offer. It is a switch the
  // panel already knows how to make: setPropCascading clears what the new
  // branch forbids and hands it back on the way in.
  //
  // A prop chooses the branch when its pinned values name at most one branch
  // each — pick one and the branch is settled. `emphasis` is pinned in every
  // branch too, and its sets overlap (primary is allowed on all four variants),
  // so choosing it settles nothing and it narrows as before.
  const choosesBranch = (union, name) => {
    const seen = new Set();
    let pinning = 0;
    for (const b of union.branches) {
      const pinned = b.pins?.[name];
      if (!pinned) continue;
      pinning++;
      for (const v of pinned) {
        if (seen.has(v)) return false;
        seen.add(v);
      }
    }
    return pinning > 1;
  };

  const narrowOptions = (field) => {
    if (!field.options?.length) return field;
    let allowed;
    const fitting = branchesFitting(field.name);
    for (const [i, union] of unions.entries()) {
      if (!union.names.includes(field.name)) continue;
      if (choosesBranch(union, field.name)) continue;
      for (const b of fitting[i]) {
        const pinned = b.pins?.[field.name];
        if (!pinned) return field;
        allowed = allowed ? [...new Set([...allowed, ...pinned])] : [...pinned];
      }
    }
    if (!allowed) return field;
    const set = node.props?.[field.name];
    const keep = set && set.type !== 'expr' ? String(set.value ?? '') : undefined;
    const options = field.options.filter(
      (o) => allowed.includes(o) || o === keep
    );
    return options.length && options.length < field.options.length
      ? { ...field, options }
      : field;
  };

  const appliesNow = (field) => {
    for (const [i, union] of unions.entries()) {
      if (!union.names.includes(field.name)) continue;
      if (liveBranches[i].every((b) => b.forbids.includes(field.name))) return false;
    }
    return true;
  };

  // The class field, wherever it came from: the element's schema, a
  // component's declared prop, or the markup itself. Rendered on its own,
  // below the props and above Attributes. Defined here rather than up with
  // the other field lists because it asks `appliesNow` — reading a `const`
  // above its declaration is a ReferenceError, not a warning.
  // The data picker over the Content field, and the way into the editor's
  // caret once something is chosen.
  const [contentPicker, setContentPicker] = useState(null);
  const contentInsertRef = useRef(null);

  // The folded "Settings" group at the foot of the panel. Kept on the panel
  // (not per node) so opening it once keeps it open as you move around — and
  // kept at MODULE scope, because "as you move around" includes elements that
  // have no settings at all. The panel returns early for those (a condition, a
  // text node), and a render that calls no hooks throws away the hook state of
  // the ones that did: the group came back closed after every such visit.
  const [settingsOpen, setSettingsOpenState] = useState(settingsGroupOpen);
  const setSettingsOpen = (next) => {
    settingsGroupOpen = typeof next === 'function' ? next(settingsGroupOpen) : next;
    setSettingsOpenState(settingsGroupOpen);
  };

  // ⌘Enter, forwarded from App as a counter: open Settings and put the caret
  // in the class field. Two steps, because the field doesn't exist to focus
  // until the render that opens the group has happened.
  const [wantClassFocus, setWantClassFocus] = useState(false);
  const rootRef = useRef(null);
  useEffect(() => {
    if (!focusClass) return;
    setSettingsOpen(true);
    setWantClassFocus(true);
  }, [focusClass]);
  useEffect(() => {
    if (!wantClassFocus || !settingsOpen) return;
    setWantClassFocus(false);
    const input = rootRef.current?.querySelector('.class-input-field');
    if (!input) return;
    input.focus();
    input.closest('.props-field')?.scrollIntoView({ block: 'nearest' });
  }, [wantClassFocus, settingsOpen]);

  // Double-clicking text on the canvas, forwarded the same way: caret in the
  // Content field, at the end of what's already written. No group to open
  // first — Content sits at the top of the panel — but still an effect, so
  // the field belongs to the node that was double-clicked and not the one
  // that was selected a render ago.
  useEffect(() => {
    if (!focusContent) return;
    const field = rootRef.current?.querySelector('.rich-content');
    if (!field) return;
    field.focus();
    // Land after the last character rather than at the top: the gesture means
    // "let me write here", and a caret parked before the first word makes
    // typing insert in front of the sentence.
    const range = document.createRange();
    range.selectNodeContents(field);
    range.collapse(false);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    field.closest('.props-field')?.scrollIntoView({ block: 'nearest' });
  }, [focusContent]);

  const classField =
    schema.find((f) => f.name === 'class' && appliesNow(f)) ||
    (node.props?.class !== undefined ? { name: 'class', type: 'string' } : null);

  // Inline styles, directly under the class field. Anything that renders a
  // real element has one, whatever it declares; a component only when it
  // takes the attribute (…rest) or already carries it, so the panel never
  // offers a prop the component would ignore. Always the CSS editor, even
  // when a component types it `style?: string`.
  const styleField =
    allowAttrs || node.props?.style !== undefined
      ? { ...(schema.find((f) => f.name === 'style') || {}), name: 'style', type: 'style' }
      : null;

  // The page's wrapper switches through the same Tag field as everything else
  // — it just answers with a layout rather than a tag, so its list is the
  // project's layouts and the change goes through the import rewrite.
  const layoutTag = isLayout && !!onChangeLayout && Array.isArray(layouts) && layouts.length > 0;
  const changeToLayout = (name) => {
    // The wrapper is an import, not markup: a name no layout file provides
    // can't be written, so the field puts the old one back.
    if (!layouts.some((l) => l.name === name)) return false;
    onChangeLayout(name);
    return true;
  };

  // Anything with a real tag or component name — not a loop, a condition, a
  // comment or a slot (switching a slot away would be a one-way door).
  const showTagField =
    !isSlot &&
    (layoutTag ||
      (!!onChangeTag && !isLayout && (node.kind === 'element' || node.kind === 'component')));

  const hasSettings =
    showTagField ||
    !!classField ||
    !!styleField ||
    allowAttrs ||
    showSlotField ||
    !!(onSetComment && (node.kind === 'element' || node.kind === 'component'));
  // How many of them actually carry something, shown on the closed header.
  const settingsCount =
    (node.props?.class !== undefined ? 1 : 0) +
    (node.props?.style !== undefined ? 1 : 0) +
    attrNames.length +
    (comment ? 1 : 0) +
    (node.props?.slot !== undefined ? 1 : 0);

  const onPickDimensions = (fieldName, dims) => {
    if (!onSetProps || !node || !dims?.w || !dims?.h) return;
    if (!/^(src|poster)$/i.test(fieldName)) return;
    const takes = (n) => (schema || []).some((f) => f.name === n);
    const patch = {};
    if (takes('width')) patch.width = { type: 'expr', value: String(dims.w) };
    if (takes('height')) patch.height = { type: 'expr', value: String(dims.h) };
    if (Object.keys(patch).length) onSetProps(node.id, patch);
  };

  return (
    <div className="panel-section grow" ref={rootRef} style={{ flex: '1 1 50%', overflow: 'hidden' }}>
      <div className="props-title">
        {node.kind === 'element' ? (
          elementIcon(node.name, 16, 'props-title-icon')
        ) : (
          node.astroAsset ? (
            astroAssetIcon(node.name, 16, 'props-title-icon')
          ) : (
            <ElementComponentIcon size={16} className="props-title-icon" />
          )
        )}
        {isLayout ? currentLayoutName || node.name : node.name}
        {isLayout && <span className="badge">layout</span>}
      </div>
      <div className="panel-body" style={{ padding: 0 }}>
        {/* A slot isn't a tag choice — it's where the caller's content plugs
            in. Renaming it would silently turn it into an empty element. */}

        {showContentField && (
          <div className="props-field" key="content">
            <label onClick={noLabelActivation}>
              <span className="prop-label">
                <VariableTextSizeIcon size={12} className="prop-label-icon" />
                {isSlot ? 'Fallback' : 'Content'}
              </span>
              {/* Text can hold data too — the same handle, the same picker,
                  dropping the same chip in at the caret. Without it, putting a
                  field into a sentence means knowing to type
                  `{post.data.title}`. */}
              <BindHandle
                active={!!contentPicker}
                onOpen={(host) => {
                  if (contentPicker) {
                    setContentPicker(null);
                    return;
                  }
                  const r = host?.getBoundingClientRect();
                  if (!r) return;
                  setContentPicker({
                    left: r.left,
                    top: Math.min(r.bottom + 4, Math.max(60, window.innerHeight - 340)),
                    width: Math.max(r.width, 240),
                  });
                }}
              />
            </label>
            <RichContent
            key={node.id}
            nodes={node.children}
            bindCtx={bindContext || loopContext}
            insertRef={contentInsertRef}
            onChange={onSetInline}
          />
            {contentPicker && (
              <FieldDataPicker
                pos={contentPicker}
                bindCtx={bindContext || loopContext}
                current={null}
                onPick={(path) => {
                  setContentPicker(null);
                  contentInsertRef.current?.insert(path);
                }}
                onClose={() => setContentPicker(null)}
              />
            )}
            {isSlot && (
              <div style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 6, lineHeight: 1.5 }}>
                Shown only when whatever uses this component passes nothing for
                the slot.
              </div>
            )}
          </div>
        )}
        {showLooseTextField && (
          <div className="props-field" key="loose-text">
            <label onClick={noLabelActivation}>
              <span className={`prop-label${looseText ? ' set' : ''}`}>
                <VariableTextSizeIcon size={12} className="prop-label-icon" />
                Content
              </span>
            </label>
            <AutoTextarea
              key={node.id}
              minRows={2}
              value={looseText ? looseText.value : ''}
              placeholder="Text alongside the children below"
              onChange={(e) => onSetContent(e.target.value)}
            />
          </div>
        )}
        {schema
          .filter(appliesNow)
          .filter((f) => f.name !== 'class' && !(styleField && f.name === 'style'))
          .map((field) => (
          <PropField
            key={field.name}
            nodeKey={node.id}
            bindCtx={bindContext || loopContext}
            field={narrowOptions(field)}
            branchDefault={branchDefault(field.name)}
            value={node.props[field.name]}
            slotOptions={slotOptions}
            projectClasses={projectClasses}
            assetCtx={{ projectPath, filePath, nodeName: node.name, onPickDimensions, srcDims, onSrcDimensions: setSrcDims, siblingProps: node.props, srcKind, onPickAsset: onSetAssetProp && ((f, picked) => onSetAssetProp(node.id, f, picked)) }}
            linkContext={linkContext}
            dataCtx={dataCtx}
            onChange={(v, immediate) => setPropCascading(field.name, v, immediate)}
          />
        ))}
        {extraProps
          .filter((name) => name !== 'class' && !(styleField && name === 'style'))
          .map((name) => (
          <PropField
            key={name}
            nodeKey={node.id}
            bindCtx={bindContext || loopContext}
            field={{ name, type: 'other' }}
            value={node.props[name]}
            slotOptions={slotOptions}
            projectClasses={projectClasses}
            assetCtx={{ projectPath, filePath, nodeName: node.name, onPickDimensions, srcDims, onSrcDimensions: setSrcDims, siblingProps: node.props, srcKind, onPickAsset: onSetAssetProp && ((f, picked) => onSetAssetProp(node.id, f, picked)) }}
            linkContext={linkContext}
            dataCtx={dataCtx}
            onChange={(v, immediate) => onSetProp(name, v, immediate)}
          />
        ))}
        {/* Class, attributes, the comment and slot are the same four fields on
            every node, and they're the ones you reach for least — folded away
            behind one heading so a component's own props are what the panel
            opens on. Shut by default; the choice sticks while the app is up. */}
        {hasSettings && (
          <div className={`props-group ${settingsOpen ? 'open' : ''}`}>
            <button
              type="button"
              className="props-group-head"
              aria-expanded={settingsOpen}
              onClick={() => setSettingsOpen((v) => !v)}
            >
              <span className="props-group-name">Settings</span>
              {/* Something set in there is worth knowing about without opening
                  it — otherwise a class you gave the element looks lost. */}
              {!settingsOpen && settingsCount > 0 && (
                <span className="props-group-count">{settingsCount}</span>
              )}
              <ChevronRightIcon size={11} className="props-group-chevron" />
            </button>
          </div>
        )}
        {hasSettings && settingsOpen && (
        <>
        {/* First in Settings, and on every node: the tag is what the node IS,
            and it's how a <div> becomes a component (or a component becomes a
            <div>) without going to the code. */}
        {showTagField && (
          <TagField
            key="tag"
            // A layout shows (and offers) the layout it resolves to, not the
            // local name the page imported it under — that name is a detail of
            // this page, while the file is what you're choosing between.
            tag={layoutTag ? currentLayoutName || node.name : node.name}
            options={layoutTag ? layouts.map((l) => ({ name: l.name, kind: 'layout' })) : tagOptions}
            onChangeTag={layoutTag ? changeToLayout : onChangeTag}
          />
        )}
        {classField && (
          <PropField
            key="class"
            nodeKey={node.id}
            bindCtx={bindContext || loopContext}
            field={classField}
            value={node.props?.class}
            slotOptions={slotOptions}
            projectClasses={projectClasses}
            assetCtx={{ projectPath, filePath, nodeName: node.name, onPickDimensions, srcDims, onSrcDimensions: setSrcDims, siblingProps: node.props, srcKind, onPickAsset: onSetAssetProp && ((f, picked) => onSetAssetProp(node.id, f, picked)) }}
            linkContext={linkContext}
            dataCtx={dataCtx}
            onChange={(v, immediate) => setPropCascading('class', v, immediate)}
          />
        )}
        {styleField && (
          <PropField
            // The editor is mounted with its text and doesn't re-sync, so it
            // has to be a new one per node — otherwise selecting a sibling
            // would leave the previous element's CSS sitting in the field.
            key={`style:${node.id}`}
            nodeKey={node.id}
            bindCtx={bindContext || loopContext}
            field={styleField}
            value={node.props?.style}
            slotOptions={slotOptions}
            projectClasses={projectClasses}
            linkContext={linkContext}
            dataCtx={dataCtx}
            onChange={(v, immediate) => setPropCascading('style', v, immediate)}
          />
        )}
        {allowAttrs && (
          <AttributesSection
            key="attrs"
            node={node}
            names={attrNames}
            projectPath={projectPath}
            bindCtx={bindContext || loopContext}
            onSetProp={onSetProp}
            onSetProps={onSetProps}
            onRenameProp={onRenameProp}
          />
        )}
        {onSetComment && (node.kind === 'element' || node.kind === 'component') && (
          <CommentField key="comment" value={comment} onCommit={onSetComment} />
        )}
        {/* `slot` is not a prop of this component — it tells the PARENT where to
            put it — so it sits apart from the component's own props, last of
            all, below even the comment. */}
        {showSlotField && (
          <PropField
            key="slot"
            field={{ name: 'slot', type: 'slot' }}
            value={node.props?.slot}
            slotOptions={slotOptions}
            onChange={(v, immediate) => onSetProp('slot', v, immediate)}
          />
        )}
        </>
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
// beside its name. Written as you type, so that label keeps up with the field:
// the write is coalesced and the save debounced (see setComment), so a burst of
// typing is still one save and one undo step. Clearing the field removes the
// comment node.
function CommentField({ value, onCommit }) {
  const [draft, setDraft] = useState(value ?? '');
  // Re-sync when the model changes underneath (undo, external edit) — but not
  // while typing, or the caret would jump.
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(value ?? '');
  }, [value]);
  const commit = (text = draft) => {
    const next = text.trim();
    if (next !== (value ?? '').trim()) onCommit(next);
  };
  return (
    <div className="props-field props-comment">
      <label onClick={noLabelActivation}>
        <span className="prop-label">
          <CommentIcon size={12} className="prop-label-icon" />
          Comment
        </span>
      </label>
      <AutoTextarea
        minRows={1}
        placeholder="Note above this element…"
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          commit(e.target.value);
        }}
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
function AttributesSection({ node, names, projectPath, bindCtx, onSetProp, onSetProps, onRenameProp }) {
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
      {/* Not a <label onClick={noLabelActivation}>: a click anywhere inside one activates the control it
          holds, so the whole row — icon, word and all — acted as the button. */}
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
          bindCtx={bindCtx}
          dataCtx={bindCtx}
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
          // Pasting `id="hero"` fills both boxes at once — the attribute is
          // created and given its value in one go rather than needing the
          // name committed first.
          onCommitPair={(attrName, text) => {
            const clean = attrName.trim();
            if (!clean) return;
            if (editor.attr && editor.attr !== clean) onRenameProp(editor.attr, clean);
            onSetProp(clean, encodeAttr(text), true);
            setEditor((e) => ({ ...e, attr: clean }));
          }}
          // Several pairs pasted at once — written together so it is one undo,
          // and the editor closes because there is no single attribute left
          // for it to be editing.
          onCommitMany={(pairs) => {
            const patch = {};
            for (const { name: attrName, value: text } of pairs) {
              const clean = attrName.trim();
              if (clean) patch[clean] = encodeAttr(text);
            }
            if (!Object.keys(patch).length) return;
            if (onSetProps) onSetProps(node.id, patch);
            else for (const [k, v] of Object.entries(patch)) onSetProp(k, v, true);
            setEditor(null);
          }}
          onClose={() => setEditor(null)}
        />
      )}
    </div>
  );
}

// Attribute markup pasted into the name box — `id="hero"`, `id=hero`, or a
// whole run of them — split into the pairs it describes. Copying attributes
// off an existing element is the normal way to move them, and typing them
// back one box at a time is the tedious part.
//
// Deliberately looser than the .astro parser: HTML allows an unquoted value
// (`id=hero`), and that is exactly what someone types from memory. A brace
// value keeps its braces so encodeAttr reads it as an expression.
const ATTR_PASTE_RE =
  /([\w@:.-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|(\{(?:[^{}]|\{[^{}]*\})*\})|([^\s]+)))?/g;

function parseAttrPaste(text) {
  const out = [];
  ATTR_PASTE_RE.lastIndex = 0;
  let m;
  while ((m = ATTR_PASTE_RE.exec(text)) !== null) {
    if (!m[0].trim()) continue;
    const value = m[2] ?? m[3] ?? m[4] ?? m[5];
    out.push({ name: m[1], value: value === undefined ? '' : value });
  }
  return out;
}

// Floating name/value editor for one attribute.
function AttrEditor({ pos, name, value, isNew, projectPath, bindCtx, dataCtx, onCommitName, onCommitPair, onCommitMany, onChangeValue, onClose }) {
  const [draftName, setDraftName] = useState(name);
  const [draftValue, setDraftValue] = useState(value);
  const ref = useRef(null);
  // Where the purple dot's picker sits, and the field's own insert-at-the-caret
  // handle — the same pair every schema-driven field uses (see PropField).
  const [insertAt, setInsertAt] = useState(null);
  // Where the bigger value editor sits, when `=` has asked for one.
  const [bigAt, setBigAt] = useState(null);
  // What this value can name, for the completions and the chips — the same list
  // the picker beside the field offers.
  const scope = scopeCompletions(bindCtx || {});
  const scopeNames = new Set(scope.map((c) => c.label.split('.')[0]));
  const chipsInScope = (text) => scopeChips(text, scopeNames);
  const bindApiRef = useRef(null);

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
          onPaste={(e) => {
            const text = e.clipboardData.getData('text');
            // Only when it actually looks like markup — a plain name paste
            // must keep behaving like a paste into a text box.
            if (!text || !/=/.test(text)) return;
            const pairs = parseAttrPaste(text);
            if (!pairs.length) return;
            e.preventDefault();
            if (pairs.length === 1) {
              setDraftName(pairs[0].name);
              setDraftValue(pairs[0].value);
              onCommitPair(pairs[0].name, pairs[0].value);
            } else {
              onCommitMany(pairs);
            }
          }}
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
          // The same field a schema-driven prop gets: text with data in it shown
          // as chips, and real code edited as code — JavaScript, highlighted. A
          // hand-added attribute used to be the one value in the panel typed into
          // a bare box, with `{expression}` as a placeholder and no way to reach
          // the data it would name. The editor round-trips text, so the value
          // object is made on the way in and unmade on the way out.
          <div
            className="attr-value-field"
            // Captured: what's inside is CodeMirror (or a contenteditable), and both
            // would take the key first. `=` is a character a JS value can want —
            // typing `a === b` inline is the trade — but the box this opens is where
            // an expression that needs one is worth writing anyway.
            onKeyDownCapture={(e) => {
              if (e.key !== '=' || e.metaKey || e.ctrlKey || e.altKey || bigAt) return;
              e.preventDefault();
              e.stopPropagation();
              // Kept on screen: the field sits deep in a right-hand panel, so a box
              // wider than it and anchored to its left edge runs off the window.
              const r = e.currentTarget.getBoundingClientRect();
              const width = Math.min(Math.max(r.width, 320), window.innerWidth - 16);
              setBigAt({
                left: Math.max(8, Math.min(r.left, window.innerWidth - width - 8)),
                top: Math.max(8, Math.min(r.top, window.innerHeight - 320)),
                width,
              });
            }}
          >
          <BindField
            // An empty attribute is `{type:'bare'}`, which as a VALUE reads as no
            // value at all rather than an empty one — the field would show the word
            // "undefined". Empty text is an empty string here; encodeAttr still
            // stores it as bare on the way out.
            value={draftValue === '' ? { type: 'string', value: '' } : encodeAttr(draftValue)}
            placeholder="Type, or insert data"
            bindCtx={bindCtx}
            dataCtx={dataCtx}
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
              if (insertAt) { setInsertAt(null); return; }
              const r = (host || ref.current)?.getBoundingClientRect();
              if (!r) return;
              setInsertAt({
                left: r.left,
                top: Math.min(r.bottom + 4, Math.max(60, window.innerHeight - 340)),
                width: Math.max(r.width, 240),
              });
            }}
          />
          </div>
        )}
        {bigAt ? (
          <ValueCodeEditor
            pos={bigAt}
            name={draftName || 'value'}
            value={draftValue}
            scope={scope}
            chipsOf={chipsInScope}
            bindCtx={bindCtx}
            onChange={(text) => { setDraftValue(text); onChangeValue(text); }}
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
              if (bindApiRef.current?.insert) { bindApiRef.current.insert(path); return; }
              const text = `{${path}}`;
              setDraftValue(text);
              onChangeValue(text);
            }}
            onClose={() => setInsertAt(null)}
          />
        ) : null}
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
// Does this prop name end in the word "href"? Splits camelCase, kebab and
// snake alike, so `buttonHref`, `cta-href` and plain `href` all say yes while
// `hrefLabel` says no.
function isHrefName(name) {
  const words = String(name)
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return words[words.length - 1] === 'href';
}

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
function ObjectAttrsField({ pill, menu, entries, bindCtx, projectPath, onCommit }) {
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
          bindCtx={bindCtx}
          dataCtx={bindCtx}
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
// the single parameter may be bare — `items.map(item => (` — the way a
// one-argument arrow is often written. Only destructured params or non-arrow
// callbacks fall back to code.
function parseMapHead(head) {
  const m = String(head)
    .trim()
    .match(
      /^([\s\S]+?)\.map\(\s*(?:\(\s*([\w$]+)\s*(?:,\s*([\w$]+)\s*)?\)|([\w$]+))\s*=>\s*\($/
    );
  return m ? { data: m[1].trim(), item: m[2] || m[4], index: m[3] || '' } : null;
}

// The leading name in an expression — what the value is a list OF, before
// anything is done to it. `posts.filter(p => p.draft)[0]` is `posts`; a lone
// `Astro.props.items` is all of it.
const SOURCE_RE = /^\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/;

function sourceChip(value) {
  const text = String(value || '').trim();
  if (!text || text === NO_SOURCE) return '';
  const match = SOURCE_RE.exec(text);
  if (!match) return '';
  let name = match[1];
  // A segment that is called is not part of the path: `posts.filter(…)` is
  // `posts`, done to — and a call on the whole thing (`getPosts()`) names a
  // function, which is not a source anything can be swapped for.
  while (text[name.length] === '(') {
    const at = name.lastIndexOf('.');
    if (at < 0) return '';
    name = name.slice(0, at);
  }
  return name;
}

// The same expression with a different source: what follows the old one is
// kept, so choosing another list does not throw away the code around it.
function withSource(value, path) {
  const current = sourceChip(value);
  if (!current) return path;
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
const CUSTOM_SOURCE = '__custom__'; // not a valid expression, so it can't collide
const DEFAULT_ITEM = 'item'; // a value no expression can collide with

function MapEditor({ node, loopContext, bindCtx, dataCtx, onSetText }) {
  const parsed = parseMapHead(node.head);
  const [fields, setFields] = useState(parsed || { data: '', item: '', index: '' });
  const lastBuiltRef = useRef(node.head);

  // Whether the source is something the picker offers, or an expression
  // someone wrote themselves — which is what decides between showing the
  // picker's name and showing the code field.
  const isCustomData = (data) => {
    const d = (data || '').trim();
    if (!d || d === NO_SOURCE) return false;
    const known = new Set();
    const walk = (nodes) => {
      for (const n of nodes || []) {
        if (n.pickable !== false) known.add(n.path);
        walk(n.children);
      }
    };
    walk(listsOnly(dataTree(bindCtx || loopContext || {})));
    return !known.has(d);
  };
  // Kept only so the picker's "write an expression" entry can put the caret in
  // the field; there is no longer a mode to be in — the field is always the
  // expression, with its source drawn as a chip inside it.
  const [, setCustom] = useState(false);

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
    // The source, not the whole expression: `.slice(0, 3)` typed after a list
    // — or a value dropped into it — leaves the item exactly what it was, and
    // only picking a different list makes the old name wrong.
    const changed = sourceChip(parseMapHead(node.head)?.data || '') !== sourceChip(data);
    commit({ ...fields, data, item: changed ? DEFAULT_ITEM : fields.item });
  };

  // Anchors the source popup under the Data row.
  const dataRef = useRef(null);
  const codeRef = useRef(null);
  const [sourceMenu, setSourceMenu] = useState(null);
  // The bind handle's picker, and the way into whichever field it belongs to.
  // The source picker chooses what is being looped over; this drops a value
  // into the expression around it — `posts.slice(0, count)` needs `count` from
  // somewhere, and there was no way to reach it from here.
  const [insertAt, setInsertAt] = useState(null); // {pos, field}
  const dataApiRef = useRef(null);
  const codeApiRef = useRef(null);
  const openInsert = (field, ref) => {
    if (insertAt) {
      setInsertAt(null);
      return;
    }
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    setInsertAt({
      field,
      pos: {
        left: r.left,
        top: Math.min(r.bottom + 4, Math.max(60, window.innerHeight - 340)),
        width: Math.max(r.width, 240),
      },
    });
  };
  const openSourceMenu = () => {
    const r = dataRef.current?.getBoundingClientRect();
    if (!r) return;
    setSourceMenu({
      left: r.left,
      top: Math.min(r.bottom + 4, Math.max(60, window.innerHeight - 340)),
      width: Math.max(r.width, 240),
    });
  };

  const parseableNow = !!parseMapHead(node.head);
  const isNoSource = !fields.data.trim() || fields.data.trim() === NO_SOURCE;
  const itemBad = fields.item !== '' && !IDENT_RE.test(fields.item);
  const indexBad = fields.index !== '' && !IDENT_RE.test(fields.index);

  return (
    <>
      {parseableNow ? (
        <>
          <div className="props-field" style={{ marginTop: 8 }} ref={dataRef}>
            <label onClick={noLabelActivation}>
              <span className="prop-label">Data</span>
              <BindHandle
                active={insertAt?.field === 'data'}
                onOpen={() => openInsert('data', dataRef)}
              />
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
                onChipClick={() => (sourceMenu ? setSourceMenu(null) : openSourceMenu())}
                onChange={(v) => update({ data: v })}
                onCommit={(v) => commitSource(v.trim() || NO_SOURCE)}
              />
              <SourceEditButton
                name={referencedName(fields.data)}
                dataCtx={dataCtx}
                anchorRef={dataRef}
              />
            </div>
            {sourceMenu && (
              <FieldDataPicker
                pos={sourceMenu}
                bindCtx={bindCtx || loopContext}
                tree={listsOnly(dataTree(bindCtx || loopContext || {}))}
                current={isNoSource ? null : sourceChip(fields.data) || fields.data.trim()}
                onPick={(path) => {
                  setSourceMenu(null);
                  setCustom(false);
                  // Picking swaps the source and keeps the code after it: a
                  // list chosen again is still `.filter(…)`-ed the same way.
                  commitSource(withSource(fields.data, path));
                }}
                onWrite={() => {
                  setSourceMenu(null);
                  setCustom(true);
                  if (isNoSource) update({ data: '' });
                }}
                onClose={() => setSourceMenu(null)}
              />
            )}
          </div>
          <div className="props-field">
            <label onClick={noLabelActivation}>
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
            <label onClick={noLabelActivation}>
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
      <div className="props-field" style={{ marginTop: parseableNow ? 2 : 0 }} ref={codeRef}>
        <label onClick={noLabelActivation}>
          <span className="prop-label">
            <CodeIcon size={12} className="prop-label-icon" />
            Code
          </span>
          <BindHandle
            active={insertAt?.field === 'code'}
            onOpen={() => openInsert('code', codeRef)}
          />
        </label>
        <ExprInput
          value={node.head}
          syncValue={node.head}
          apiRef={codeApiRef}
          onCommit={(v) => v !== node.head && onSetText(v)}
        />
      </div>
      {insertAt && (
        <FieldDataPicker
          pos={insertAt.pos}
          bindCtx={bindCtx || loopContext}
          current={null}
          onPick={(path) => {
            const field = insertAt.field;
            setInsertAt(null);
            const next =
              field === 'data' ? dataApiRef.current?.insert(path) : codeApiRef.current?.insert(path);
            if (next == null) return;
            if (field === 'data') commitSource(next.trim() || NO_SOURCE);
            else if (next !== node.head) onSetText(next);
          }}
          onClose={() => setInsertAt(null)}
        />
      )}
    </>
  );
}

// Tag switcher for plain elements: free text with a suggestion list of
// standard HTML tags. Committing renames the element — the navigator icon
// follows the tag, and attributes invalid for the new tag are dropped.
// The glyph an option wears in the tag list — the same ones the insert
// palette uses, so a component reads as a component in both places.
function tagOptionIcon(opt) {
  if (opt.kind === 'astroAsset') return astroAssetIcon(opt.name, 13);
  if (opt.kind === 'layout') return <LayoutIcon size={13} style={{ color: '#79e09c' }} />;
  if (opt.kind === 'component')
    return <ElementComponentIcon size={13} style={{ color: '#79e09c' }} />;
  return elementIcon(opt.name, 13);
}

function TagField({ tag, options, onChangeTag }) {
  const [draft, setDraft] = useState(tag);
  const [focused, setFocused] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [popupPos, setPopupPos] = useState(null);
  const wrapRef = useRef(null);
  const inputRef = useRef(null);
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
  const updateDraft = (v) => {
    draftRef.current = v;
    setDraft(v);
  };
  useEffect(() => {
    committedRef.current = tag;
    updateDraft(tag);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tag]);

  // Components as well as tags: Astro tells them apart by case, and so does
  // this list — typing a capital narrows to what the page can actually
  // provide (a project component, an astro:assets one, or something the
  // frontmatter already imports).
  const pool =
    options && options.length ? options : HTML_TAGS.map((name) => ({ name, kind: 'element' }));
  const q = draft.trim();
  const ql = q.toLowerCase();
  const matches =
    focused && q && q !== tag
      ? pool
          .filter((o) => o.name.toLowerCase().includes(ql))
          .sort((a, b) => {
            const ap = a.name.toLowerCase().startsWith(ql) ? 0 : 1;
            const bp = b.name.toLowerCase().startsWith(ql) ? 0 : 1;
            return ap - bp || a.name.length - b.name.length;
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

  // Ask for a name, and put the old one back if the caller says nothing
  // provides it — a component that isn't imported anywhere, a layout name
  // that isn't a layout file.
  const apply = (name) => {
    committedRef.current = name;
    updateDraft(name);
    Promise.resolve(onChangeTag(name)).then((ok) => {
      if (ok === false) {
        committedRef.current = tag;
        updateDraft(tag);
      }
    });
  };

  const commit = (t) => {
    const raw = String(t).trim();
    if (raw === committedRef.current) return updateDraft(committedRef.current);
    // A capital means a component — passed through with its case intact, and
    // it's the caller that decides whether anything provides that name.
    if (/^[A-Z][\w$]*$/.test(raw)) return apply(raw);
    const clean = raw.toLowerCase();
    // Not `slot` either: switching into one here would be a one-way door —
    // insert a slot from the palette instead.
    if (/^[a-z][a-z0-9-]*$/.test(clean) && clean !== committedRef.current && clean !== 'slot') {
      apply(clean);
    } else updateDraft(committedRef.current);
  };

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown' && matches.length) {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, matches.length - 1));
    } else if (e.key === 'ArrowUp' && matches.length) {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === 'Enter' || (e.key === 'Tab' && matches.length)) {
      e.preventDefault();
      const picked = matches[Math.min(highlight, matches.length - 1)];
      commit(picked ? picked.name : draftRef.current);
      inputRef.current?.blur();
    } else if (e.key === 'Escape') {
      // Put the text back before blurring, or the blur below would commit
      // whatever was being typed — the opposite of what Escape means.
      updateDraft(committedRef.current);
      inputRef.current?.blur();
    }
  };

  return (
    <div className="props-field" ref={wrapRef}>
      <label onClick={noLabelActivation}>
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
          updateDraft(e.target.value);
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
      {popupPos && (
        <div
          className="dd-popup class-suggest"
          style={{ left: popupPos.left, top: popupPos.top, width: popupPos.width }}
        >
          {matches.map((o, i) => (
            <div
              key={o.name}
              className={`dd-option ${i === highlight ? 'highlight' : ''}`}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setHighlight(i)}
              onClick={() => {
                commit(o.name);
                inputRef.current?.blur();
              }}
            >
              <span className="dd-option-icon">{tagOptionIcon(o)}</span>
              <span className="dd-option-label">{o.name}</span>
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

// Where the data behind an expression can be edited from here: 'local' when
// this file's frontmatter declares it (edited in place), 'file' when it's
// imported (opens the file that defines it), null when neither.
function symbolTarget(name, dataCtx) {
  if (!name || !dataCtx) return null;
  if (dataCtx.onSetFrontmatter && findDeclaration(dataCtx.frontmatter || '', name)) return 'local';
  if (dataCtx.onOpenSymbol && findImportOf(dataCtx.imports || '', name)) return 'file';
  return null;
}

// The pencil beside a field bound to data: it opens whatever defines that
// data. A `const` in this file opens inline, right under the field; anything
// imported opens its own file, on the line that declares it. Renders nothing
// when the value doesn't name something we can find.
function SourceEditButton({ name, dataCtx, anchorRef, className = 'attr-asset-toggle' }) {
  const [pos, setPos] = useState(null);
  const target = symbolTarget(name, dataCtx);
  if (!target) return null;

  const open = () => {
    if (target === 'file') {
      dataCtx.onOpenSymbol(name);
      return;
    }
    const r = anchorRef?.current?.getBoundingClientRect();
    const width = Math.max(r?.width ?? 240, 260);
    setPos({
      top: Math.min((r?.bottom ?? 200) + 6, Math.max(60, window.innerHeight - 240)),
      left: Math.min(r?.left ?? 0, window.innerWidth - width - 12),
      width,
    });
  };

  return (
    <>
      <button
        className={`${className} ${pos ? 'on' : ''}`}
        title={target === 'file' ? `Open where ${name} is defined` : `Edit ${name}`}
        onClick={() => (pos ? setPos(null) : open())}
      >
        <PencilIcon size={12} />
      </button>
      {pos && (
        <VarSourceEditor
          pos={pos}
          name={name}
          code={dataCtx.frontmatter || ''}
          onChangeCode={dataCtx.onSetFrontmatter}
          onClose={() => setPos(null)}
        />
      )}
    </>
  );
}

// Files an import can name that are pictures rather than code.
const MEDIA_IMPORT_RE =
  /\.(png|jpe?g|gif|webp|avif|svg|ico|bmp|mp4|webm|mov|m4v|ogg|mp3|wav)(\?.*)?$/i;

// The image an expression is bound to, if it is one: `hero` and `hero.src`
// both point at whatever `hero` was imported from. Returns null for any other
// expression, which then edits as code.
function assetImportOf(expr, frontmatter) {
  const m = String(expr ?? '')
    .trim()
    .match(/^([A-Za-z_$][\w$]*)(?:\.src)?$/);
  if (!m || !frontmatter) return null;
  const imp = findImportOf(frontmatter, m[1]);
  if (!imp || !MEDIA_IMPORT_RE.test(imp.spec)) return null;
  return { ident: m[1], spec: imp.spec };
}

// The asset card for an imported image. The import specifier is resolved to a
// real file so the card can show it; picking a new one goes through the host,
// which rewrites the import rather than the value.
function AssetImportField({ binding, name, assetCtx, onChange }) {
  const [rel, setRel] = useState(null);

  useEffect(() => {
    let live = true;
    setRel(null);
    window.avb
      .resolveSourcePath({
        projectPath: assetCtx.projectPath,
        fromFile: assetCtx.filePath,
        spec: binding.spec,
      })
      .then((r) => live && setRel(r?.ok ? r.rel : null))
      .catch(() => live && setRel(null));
    return () => {
      live = false;
    };
  }, [binding.spec, assetCtx.projectPath, assetCtx.filePath]);

  return (
    <AssetField
      value=""
      srcRel={rel}
      mediaKind={/\.(mp4|webm|mov|m4v)$/i.test(binding.spec) ? 'video' : 'image'}
      initialMode="asset"
      plainLabel="URL"
      projectPath={assetCtx.projectPath}
      onChange={(v, immediate) =>
        v === '' ? onChange(undefined, immediate) : onChange({ type: 'string', value: v }, immediate)
      }
      onPickEntry={assetCtx.onPickAsset && ((picked) => assetCtx.onPickAsset(name, picked))}
      onDimensions={(d) => assetCtx.onPickDimensions?.(name, d)}
      onCurrentDimensions={(d) => /^src$/i.test(name) && assetCtx.onSrcDimensions?.(d)}
    />
  );
}

// A prop value that holds JavaScript. It's code, so it's highlighted; and
// when it names something with a definition — here or in another file — the
// pencil goes straight to it. Changing the three words in `const
// rotatingWords = […]` is part of the same thought as pointing the prop at
// it, and shouldn't mean hunting for the file.
function ExprValueField({ value, placeholder, dataCtx, onChange }) {
  const wrapRef = useRef(null);
  const name = referencedName(value);

  return (
    <div className="prop-expr-row" ref={wrapRef}>
      <ExprInput
        value={value}
        syncValue={value}
        // Empty when nothing is known, like every other field. The old
        // generic "expression" described the input format, not the fallback,
        // and in a column of placeholders that all name real values it read as
        // if the value itself were the word.
        placeholder={placeholder || ''}
        onChange={(v) => onChange({ type: 'expr', value: v })}
        onCommit={(v) => v !== value && onChange({ type: 'expr', value: v }, true)}
      />
      <SourceEditButton name={name} dataCtx={dataCtx} anchorRef={wrapRef} />
    </div>
  );
}

// The condition an `if` renders on, as the values it names rather than as a line
// of text: each one in scope is a purple chip, pressing one opens the list to swap
// it, and the dot inserts another at the caret.
//
// Its own component because it holds state, and PropsPanel returns early for every
// node kind above this one — a hook in that body runs for some selections and not
// others, which is what "Rendered fewer hooks than expected" means. A child's hooks
// are its own, so nothing above it has to change.
function ConditionField({ test, scope, chipsOf, bindCtx, onSetText }) {
  const [pick, setPick] = useState(null); // {chip, pos}
  const apiRef = useRef(null);
  const wrapRef = useRef(null);

  const open = (chip) => {
    const r = wrapRef.current?.getBoundingClientRect();
    if (!r) return;
    setPick({
      chip: chip || null,
      pos: {
        left: r.left,
        top: Math.min(r.bottom + 4, Math.max(60, window.innerHeight - 340)),
        width: Math.max(r.width, 240),
      },
    });
  };

  return (
    <>
      <div className="props-cond-field attr-value-field" ref={wrapRef}>
        <ExprInput
          value={test}
          syncValue={test}
          placeholder="e.g. logo.src"
          completions={scope}
          apiRef={apiRef}
          // The values a condition names, drawn as the same purple chips the rest
          // of the panel shows data in — and pressing one opens the list to swap
          // it, rather than retyping a name inside a boolean.
          chipsOf={chipsOf}
          onChipClick={(chip) => open(chip)}
          onCommit={(v) => v.trim() && v !== test && onSetText(v.trim())}
        />
        {/* And the way a new one gets in: the same purple dot every bindable field
            has, inserting at the caret. */}
        <BindHandle active={!!pick} onOpen={() => (pick ? setPick(null) : open(null))} />
      </div>
      {pick ? (
        <FieldDataPicker
          pos={pick.pos}
          bindCtx={bindCtx}
          current={pick.chip?.path ?? null}
          onPick={(path) => {
            const chip = pick.chip;
            setPick(null);
            const next = chip
              ? apiRef.current?.replaceRange(chip.from, chip.to, path)
              : apiRef.current?.insert(path);
            if (next != null) onSetText(next);
          }}
          onClose={() => setPick(null)}
        />
      ) : null}
    </>
  );
}

// The way data gets into a field: nothing until the field is hovered, then a
// small purple dot on its top-left corner — the same purple a binding is shown
// in, so what it does is legible before it is read. Hovering the dot itself
// grows it into a +, which is the click. A button that sat there permanently
// would be chrome on every field in the panel, for something most fields never
// need.
function BindHandle({ active, onOpen }) {
  return (
    <button
      type="button"
      className={`bind-handle${active ? ' on' : ''}`}
      title="Insert data — a component prop, a CMS field"
      aria-label="Insert data"
      onClick={(e) => onOpen(e.currentTarget.closest('.props-field'))}
    >
      <span className="bind-dot" />
      <PlusIcon size={10} className="bind-plus" />
    </button>
  );
}

// The picker, over a field. Positioned against whatever the handle belongs to
// rather than against the handle itself, so it lines up with the field's edge.
function FieldDataPicker({ pos, bindCtx, current, tree, onPick, onWrite, onClose }) {
  const pick = (path, query) => onPick(resolvePick(path, query, bindCtx));
  useEffect(() => {
    const close = (e) => {
      // The thing that opened it is not "outside": letting the mousedown close
      // it would leave the click that follows to open it straight back up.
      //
      // A chip is in that list because it opens the picker ON MOUSEDOWN — the
      // caret must not land inside a name — and React flushes this effect
      // synchronously for a discrete event, so the listener below is live
      // while the very mousedown that opened the picker is still on its way up
      // to document. Without the chip here, pressing it opened the picker and
      // closed it again before the button came back up, which looked like a
      // chip that did nothing at all. Clicking it again still closes, through
      // the same toggle that opened it.
      if (e.target.closest?.('.bind-menu, .bind-handle, .dd-source, .cm-chip')) return;
      onClose();
    };
    const onKey = (e) => e.key === 'Escape' && onClose();
    const onScroll = (e) => {
      if (e.target?.closest?.('.bind-menu')) return;
      onClose();
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);

  return (
    <div className="dd-popup bind-menu" style={{ left: pos.left, top: pos.top, width: pos.width }}>
      <DataPicker
        tree={tree || dataTree(bindCtx || {})}
        current={current}
        entries={bindCtx?.entryNav}
        onPick={pick}
        onExpand={(node) => node.query && bindCtx?.onNeedSample?.(node.query.collection)}
        onWrite={onWrite}
        footer={!!onWrite}
      />
    </div>
  );
}

// A prop's value, edited as what it IS: text with the data in it shown as
// chips. `Posted ` · [post.data.pubDate] reads as one field rather than as a
// binding that took the field over — so a value can be part typed and part
// bound, and either half changed without touching the other.
//
// The expression a chip stands for. Two kinds reach here: the ones in the
// chips-and-text field are DOM nodes carrying it in an attribute, and the holes
// in the code editor are `{from, to, path}` objects. Both name a value, and
// that name is what the picker's Edit row goes and opens.
function chipExpr(chip) {
  if (!chip) return '';
  if (typeof chip.path === 'string') return chip.path;
  if (typeof chip.getAttribute === 'function') return chip.getAttribute('data-expr') || '';
  return '';
}

// What the chip STANDS FOR, which is not always what it writes: a chip reached
// through a `?` (`featured` · "?" · `.data.title`) writes the tail and means the
// whole path. The picker marks the current value by this, so opening that chip
// shows `title` ticked rather than nothing at all.
function chipPath(chip) {
  if (chip && typeof chip.getAttribute === 'function') {
    return chip.getAttribute('data-full') || chip.getAttribute('data-expr') || '';
  }
  return chipExpr(chip);
}

// Clicking a chip repoints it — or, through the same menu, opens whatever
// defines it. The pencil that used to sit beside the field could only ever mean
// ONE value, so a field holding two bindings had a button that silently spoke
// for the first; per chip, the question has an answer every time.
// The braces button drops a new chip in at the caret. All of it opens the same
// picker, which is where the data itself is.
export function BindField({ value, field, placeholder, bindCtx, dataCtx, apiRef, onChange }) {
  const wrapRef = useRef(null);
  const inputRef = useRef(null);
  const [menu, setMenu] = useState(null); // {left, top, width, chip}
  // Editing a `const` from this file happens right under the field, the way the
  // pencil used to open it — it is the menu that asks for it now.
  const [src, setSrc] = useState(null); // {name, top, left, width}
  // The code editor, so a chip pressed inside it can be repointed in place.
  const exprApiRef = useRef(null);
  const [raw, setRaw] = useState(false);
  // What the code editor draws as chips: every `${…}` hole naming a path, plus
  // every value in scope the code names outright.
  const scopeNames = new Set(scopeCompletions(bindCtx || {}).map((c) => c.label.split('.')[0]));
  const codeChips = (text) => {
    const holes = templateHoles(text);
    const taken = (from, to) => holes.some((h) => from < h.to && to > h.from);
    return [...holes, ...scopeChips(text, scopeNames).filter((c) => !taken(c.from, c.to))].sort(
      (a, b) => a.from - b.from,
    );
  };
  // Typing must not move the field out from under the caret: an expression
  // half-way to becoming a call reads as code the moment the bracket lands,
  // and swapping in the code editor mid-word would take the text with it.
  const [editing, setEditing] = useState(false);
  const parts = partsFromValue(value);
  const expr = value?.type === 'expr' ? String(value.value ?? '').trim() : '';
  // Code no field of chips and text can hold keeps the code editor.
  const showInput = !raw && (parts !== null || editing);
  // What the parts mean when they are written back — content, or an
  // expression with data in it. The value decides, so a field never changes
  // the meaning of what it was opened on.
  const mode = valueModeOf(value);
  // Written as an expression rather than as text. Booleans and numbers are the
  // obvious ones — `cols={3}` — and a prop that takes an array or an object is
  // the same thing: typing `["Designer", "Developer"]` into it has to write
  // `options={["Designer", "Developer"]}`, not `options="[\"Designer\", …]"`,
  // which is a string the component then calls .map on. It also cost the field
  // its own editor: a string is text, so the panel showed the array in a plain
  // box with no highlighting, and there was no way to type one that stayed code.
  const numeric =
    field?.type === 'number' ||
    field?.type === 'boolean' ||
    field?.type === 'code' ||
    (field?.type === 'enum' && field?.numeric);

  const open = (chip) => {
    const r = wrapRef.current?.getBoundingClientRect();
    if (!r) return;
    setMenu({
      left: r.left,
      // Below the field, or above it when the field sits near the bottom of
      // the panel — the popup is fixed, so it would otherwise run off-screen.
      top: Math.min(r.bottom + 4, Math.max(60, window.innerHeight - 340)),
      width: Math.max(r.width, 240),
      chip: chip || null,
    });
  };

  // What the menu's Edit row does, for the chip it was opened on. Null when the
  // menu wasn't opened on a chip, or when nothing in reach defines that name —
  // and then the row isn't drawn at all, rather than drawn and inert.
  const editName = referencedName(chipExpr(menu?.chip));
  const editTarget = symbolTarget(editName, dataCtx);
  const editChip = () => {
    setMenu(null);
    if (editTarget === 'file') {
      dataCtx.onOpenSymbol(editName);
      return;
    }
    const r = wrapRef.current?.getBoundingClientRect();
    const width = Math.max(r?.width ?? 240, 260);
    setSrc({
      name: editName,
      top: Math.min((r?.bottom ?? 200) + 6, Math.max(60, window.innerHeight - 240)),
      left: Math.min(r?.left ?? 0, window.innerWidth - width - 12),
      width,
    });
  };

  const pick = (rawPath, query) => {
    const chip = menu?.chip;
    const path = resolvePick(rawPath, query, bindCtx);
    setMenu(null);
    if (!showInput) {
      // A hole in the code was pressed: repoint THAT hole and leave the program
      // around it alone. Replacing the whole expression — which is what a pick
      // used to do, since the code editor holds one — would throw away the
      // ternary the hole was written inside.
      if (chip && typeof chip.from === 'number') {
        const next = exprApiRef.current?.replaceRange(chip.from, chip.to, `\${${path}}`);
        if (next != null) onChange({ type: 'expr', value: next }, true);
        return;
      }
      // The code editor holds one expression, so a pick replaces it.
      setRaw(false);
      onChange({ type: 'expr', value: path }, true);
      return;
    }
    if (chip) inputRef.current?.replace(chip, path);
    else inputRef.current?.insert(path);
  };

  useEffect(() => {
    if (!menu) return undefined;
    const close = (e) => {
      if (e.target.closest?.('.bind-menu, .bind-pick')) return;
      // `.cm-chip` for the same reason as the rest: a chip opens this picker on
      // mousedown, and this listener is live before that mousedown has finished
      // reaching document — so a chip missing from the list opens the picker and
      // closes it in the one press. Only a chip in THIS field, though: pressing
      // one somewhere else is how you move on, and leaving both open left two
      // pickers over the panel, one of them about a value nobody was looking at.
      const chip = e.target.closest?.('.expr-chip, .cm-chip');
      if (chip && wrapRef.current?.contains(chip)) return;
      setMenu(null);
    };
    const onKey = (e) => e.key === 'Escape' && setMenu(null);
    const onScroll = (e) => {
      // The list scrolls inside itself; the panel behind it moves the field
      // out from under it, so that one closes it.
      if (e.target?.closest?.('.bind-menu')) return;
      setMenu(null);
    };
    const onResize = () => setMenu(null);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [menu]);

  const list = menu && (
    <div
      className="dd-popup bind-menu"
      style={{ left: menu.left, top: menu.top, width: menu.width }}
    >
      {/* Built on every render rather than captured when the popup opened:
          stepping to another entry from inside it changes what the data IS,
          and a snapshot would go on showing the entry you stepped away from. */}
      <DataPicker
        tree={dataTree(bindCtx || {})}
        current={menu.chip?.path ?? (menu.chip ? chipPath(menu.chip) : showInput ? null : expr)}
        entries={bindCtx?.entryNav}
        onPick={pick}
        onExpand={(node) => node.query && bindCtx?.onNeedSample?.(node.query.collection)}
        onEdit={editTarget ? editChip : undefined}
        editLabel={editTarget === 'file' ? `Open where ${editName} is defined` : `Edit ${editName}`}
        onWrite={() => {
          setMenu(null);
          setRaw(true);
        }}
      />
    </div>
  );

  const srcEditor = src && (
    <VarSourceEditor
      pos={src}
      name={src.name}
      code={dataCtx?.frontmatter || ''}
      onChangeCode={dataCtx?.onSetFrontmatter}
      onClose={() => setSrc(null)}
    />
  );

  // The field's handle inserts through here, so one picker serves both the
  // chip already in the field and the next one. Null while the code editor is
  // up: that holds one expression, so a pick replaces it instead.
  useEffect(() => {
    if (!apiRef) return undefined;
    apiRef.current = showInput ? { insert: (path) => inputRef.current?.insert(path) } : null;
    return () => {
      apiRef.current = null;
    };
  });

  if (showInput) {
    return (
      <div className="prop-expr-row bind-row" ref={wrapRef}>
        <BindInput
          ref={inputRef}
          parts={parts}
          placeholder={placeholder || 'Type, or insert data'}
          // A code prop's parts join as code: text beside a chip is an
          // expression with a value in it, not a sentence with one quoted into
          // it, so `[...items, other]` stays what was typed.
          onChange={(next) =>
            onChange(valueFromParts(next, { numeric, mode: field?.type === 'code' ? 'code' : mode }))
          }
          onChipClick={(chip) => open(chip)}
          onFocus={() => setEditing(true)}
          onBlur={() => setEditing(false)}
        />
        {list}
        {srcEditor}
      </div>
    );
  }

  return (
    <div className="prop-expr-row" ref={wrapRef}>
      {/* Code, with the data in it still shown as data: an expression this
          field can't hold as chips and text — a ternary, a template, a call —
          keeps the editor, and every `${…}` hole naming a plain path is drawn
          as a chip inside it. Pressing one repoints that hole and leaves the
          program around it exactly as written. */}
      <ExprInput
        value={expr}
        syncValue={expr}
        placeholder={placeholder || ''}
        apiRef={exprApiRef}
        // Both kinds of data in one field: a `${…}` hole in a template, and a
        // value named outright — `variantClasses` in a class list is as much a
        // binding as `${post.title}` in a sentence, and only one of them used to
        // look like one.
        chipsOf={codeChips}
        onChipClick={(hit) => open(hit)}
        // Code keeps its shape: wrapping an array across the panel's width throws
        // away the indentation that says what belongs to what. It scrolls instead.
        wrap={false}
        onChange={(v) => onChange({ type: 'expr', value: v })}
        onCommit={(v) => v !== expr && onChange({ type: 'expr', value: v }, true)}
      />
      {list}
      {srcEditor}
    </div>
  );
}

// Edits one declaration's source in place: the statement is spliced back into
// the frontmatter on every keystroke, so the canvas updates as you type, the
// rest of the file is untouched, and ⌘Z behaves like any other edit.
// The value, in a box big enough to write in. A one-line field is the wrong place
// to write an array across six lines, which is what an attribute like `class:list`
// usually is — so `=` opens this, the same key the style panel's fields use for the
// same thing. It edits the value as TEXT, braces and all, because that is what the
// attribute editor round-trips.
function ValueCodeEditor({ pos, name, value, scope, chipsOf, bindCtx, onChange, onClose }) {
  const ref = useRef(null);
  const apiRef = useRef(null);
  const [pick, setPick] = useState(null); // {chip, pos}
  useEffect(() => {
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    };
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="attr-editor var-src"
      style={{ top: pos.top, left: pos.left, width: pos.width }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
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
        // Code opened to be read keeps its shape: the indentation says what is
        // nested in what, and wrapping every long line throws that away.
        wrap={false}
        className="var-src-code"
        value={value}
        syncValue={value}
        completions={scope}
        apiRef={apiRef}
        chipsOf={chipsOf}
        onChipClick={(chip) => {
          const r = ref.current?.getBoundingClientRect();
          if (!r) return;
          setPick({
            chip: chip || null,
            pos: {
              left: r.left,
              top: Math.min(r.bottom + 4, Math.max(60, window.innerHeight - 340)),
              width: Math.max(r.width, 240),
            },
          });
        }}
        onChange={onChange}
      />
      {pick ? (
        <FieldDataPicker
          pos={pick.pos}
          bindCtx={bindCtx}
          current={pick.chip?.path ?? null}
          onPick={(path) => {
            const chip = pick.chip;
            setPick(null);
            const next = chip
              ? apiRef.current?.replaceRange(chip.from, chip.to, path)
              : apiRef.current?.insert(path);
            if (next != null) onChange(next);
          }}
          onClose={() => setPick(null)}
        />
      ) : null}
    </div>
  );
}

function VarSourceEditor({ pos, name, code, onChangeCode, onClose }) {
  const ref = useRef(null);
  const codeRef = useRef(code);
  codeRef.current = code;
  const [draft, setDraft] = useState(() => findDeclaration(code, name)?.statement ?? '');
  // What is wrong with the draft, once there has been a reason to say. Empty
  // until the first commit: a statement is unfinished for most of the time it
  // takes to type one, and going red at every keystroke would be nagging about
  // a mistake that hasn't been made yet.
  const [error, setError] = useState('');
  const rangeRef = useRef(null);

  const apply = (text) => {
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

  // Nothing is written while typing. This is code being spliced into a file the
  // site is compiled from, so every keystroke used to be compiled — and the
  // half-finished shape of a statement is a build error, which replaced the
  // preview with a stack trace you then had to wait out. It goes in when you
  // leave the field, and only if it parses.
  const commit = (text) => {
    if (text === draft && error) return false;
    const verdict = checkStatement(text);
    if (!verdict.ok) {
      setError(verdict.message);
      return false;
    }
    setError('');
    if (text !== (findDeclaration(codeRef.current, name)?.statement ?? '')) apply(text);
    return true;
  };

  // Capture phase: what's inside is CodeMirror and what's around it is the
  // panel's own pointer/key handling, either of which can stop an event before
  // a bubbling listener on the document would see it.
  useEffect(() => {
    const onDown = (e) => {
      if (!ref.current || ref.current.contains(e.target)) return;
      // A press outside commits, the way leaving any field does — and if that
      // fails, the popup stays up holding the message. Closing on the press
      // that produced the error would be showing it to nobody. Escape and the
      // × still close, so this is a reason to stay, not a trap.
      if (commit(draftRef.current)) onClose();
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
  });

  // Read by the document listener above, which is registered once per render
  // and must not close over a stale draft.
  const draftRef = useRef(draft);
  draftRef.current = draft;

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
        invalid={!!error}
        onChange={(text) => {
          setDraft(text);
          // Only once it has already gone red: then it is a correction being
          // watched for, not a running commentary on an unfinished line.
          if (error) setError(checkStatement(text).ok ? '' : error);
        }}
        onCommit={commit}
      />
      {error ? (
        <div className="var-src-error" role="alert">
          {error}
        </div>
      ) : null}
    </div>
  );
}

// Whether a prop name says "this holds a file". Read as words, so the LAST one
// decides: `image` and `ogImage` are pictures, `imageAlt` and `imageClass` are
// not. A name alone is the only signal available — the type is just `string`.
const MEDIA_WORDS = new Set([
  'src', 'image', 'poster', 'icon', 'logo', 'avatar', 'thumb', 'thumbnail',
  'photo', 'banner', 'cover', 'video', 'audio',
]);
function mediaWord(name) {
  const words = String(name || '')
    .replace(/[-_]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .trim()
    .split(/\s+/);
  return words[words.length - 1] || '';
}
function isMediaName(name) {
  return MEDIA_WORDS.has(mediaWord(name));
}

// "1–12, whole numbers" — what a bounded number field will take, on hover.
// The doc comment says it too, but that's behind the ? and reads as prose.
function boundsHint(field) {
  const { min, max, step, minExclusive, maxExclusive } = field;
  const parts = [];
  if (min !== undefined && max !== undefined) {
    parts.push(`${minExclusive ? '>' : ''}${min}–${maxExclusive ? '<' : ''}${max}`);
  } else if (min !== undefined) {
    parts.push(minExclusive ? `greater than ${min}` : `${min} or more`);
  } else if (max !== undefined) {
    parts.push(maxExclusive ? `less than ${max}` : `${max} or less`);
  }
  if (step === 1) parts.push('whole numbers');
  else if (step !== undefined) parts.push(`steps of ${step}`);
  return parts.length ? `Accepts ${parts.join(', ')}` : undefined;
}

// Every field with a control of its own — a toggle, an options list, a link or
// asset picker — can also hold a binding instead: `overlap={overlap}` passes a
// parent prop straight through, `title={post.data.title}` reads a CMS entry.
// No control can show one of those, so the field switches to a plain
// expression input for them. These three decide when that happens and how a
// value crosses between the two.

// Whether this value is a binding rather than something the control can show.
// "Is it an expression" is the wrong question: booleans, numbers and numeric
// unions are ALL written as expressions (`cols={3}`), and each of those is
// exactly what its own control puts there.
function isBoundValue(field, value) {
  if (!value || value.type !== 'expr') return false;
  const src = String(value.value).trim();
  if (field.type === 'boolean') return !/^(true|false)$/.test(src);
  if (field.type === 'number') return !/^[-+]?(\d+\.?\d*|\.\d+)$/.test(src);
  if (field.type === 'enum') return !(field.options || []).includes(src);
  return true;
}

// The way back. An expression the control could have written itself survives
// as a value; anything else WAS the binding, so dropping it drops the prop and
// the component's default applies again — better than leaving markup the field
// on screen no longer shows.
function valueFromExpr(field, raw) {
  const src = String(raw ?? '').trim();
  const quoted = src.match(/^(['"])((?:[^\\]|\\.)*)\1$/);
  if (quoted) {
    if (field.type === 'boolean' || field.type === 'number') return undefined;
    const text = quoted[2].replace(/\\n/g, '\n').replace(/\\(['"\\])/g, '$1');
    return field.type === 'enum' && !(field.options || []).includes(text)
      ? undefined
      : { type: 'string', value: text };
  }
  if (field.type === 'boolean') return /^(true|false)$/.test(src) ? { type: 'expr', value: src } : undefined;
  if (field.type === 'number')
    return /^[-+]?(\d+\.?\d*|\.\d+)$/.test(src) ? { type: 'expr', value: src } : undefined;
  if (field.type === 'enum')
    return (field.options || []).includes(src)
      ? { type: field.numeric ? 'expr' : 'string', value: src }
      : undefined;
  return undefined;
}

// What the toggle offers to go back to, named as what's on screen rather than
// as a type — "Use the toggle" beats "switch to boolean".
function controlWord(field) {
  if (field.type === 'boolean') return 'toggle';
  if (field.type === 'enum' && field.options?.length) return 'options list';
  if (field.type === 'style') return 'CSS editor';
  if (isMediaName(field.name)) return 'asset picker';
  if (isHrefName(field.name)) return 'link settings';
  return 'normal field';
}

// Two choices, side by side, with the chip sliding between them. Used for
// booleans and for any two-option enum: a dropdown to pick between exactly two
// things costs a click to see what the other one even is, and this shows both
// at once.
function SegSwitch({ options, current, onPick }) {
  const at = options.findIndex((o) => o.value === current);
  return (
    <div className={`bool-seg ${at === 1 ? 'is-second' : 'is-first'}`} role="group">
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          className={o.value === current ? 'on' : ''}
          aria-pressed={o.value === current}
          title={o.label}
          onClick={() => onPick(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function PropField({
  field,
  /** What this prop falls back to under the union branch now in force. */
  branchDefault,
  value,
  /** The node this field is editing — a different one resets the custom
      switch, since the same component instance edits both. */
  nodeKey,
  /** In-scope data at the selection, for the binding menu. */
  bindCtx,
  slotOptions,
  projectClasses,
  assetCtx,
  linkContext,
  dataCtx,
  onChange,
}) {
  // A sibling prop as a plain number, or null when it's unset or an
  // expression we can't evaluate ({heroWidth}).
  const siblingNumber = (propName) => {
    const v = assetCtx?.siblingProps?.[propName];
    if (!v) return null;
    const n = parseFloat(v.type === 'expr' ? v.value : v.value);
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  // What an empty field falls back to, most concrete first:
  //   the literal default the component declares  (picture = false)
  //   the source image's own size                 (width/height of the asset)
  //   the behaviour its docs describe             ("inferred")
  // Blank when the component says nothing — better than implying a value that
  // isn't there.
  const placeholderFor = (field) => {
    if (field.default !== undefined) return String(field.default);
    if (branchDefault !== undefined) return String(branchDefault);
    const dims = assetCtx?.srcDims;
    if (dims) {
      const isW = /^width$/i.test(field.name);
      const isH = /^height$/i.test(field.name);
      if ((isW || isH) && dims.w && dims.h) {
        // Setting one dimension makes the other follow the source's aspect
        // ratio — that, not the asset's own size, is what leaving this field
        // empty now means.
        const other = siblingNumber(isW ? 'height' : 'width');
        if (other) {
          const ratio = isW ? dims.w / dims.h : dims.h / dims.w;
          return String(Math.round(other * ratio));
        }
      }
      if (isW && dims.w) return String(dims.w);
      if (isH && dims.h) return String(dims.h);
    }
    return field.hint || '';
  };

  const { name, type } = field;
  const isSet = value !== undefined;
  const [menuPos, setMenuPos] = useState(null);
  // The last value a bounded number field accepted, so a rejected one has
  // somewhere to go back to.
  const lastGoodRef = useRef('');

  // Whether this field is showing a plain expression instead of its own
  // control. A value that already IS a binding opens that way on its own;
  // `custom` is the manual switch, for putting a binding where there isn't one
  // yet — the control has no way to write `overlap={overlap}`.
  const [custom, setCustom] = useState(false);
  // The data picker this field's handle opens, and the way into the value
  // field's caret once something is chosen.
  const [insertAt, setInsertAt] = useState(null);
  const bindApiRef = useRef(null);
  // The same field component edits the next node's prop of this name, so the
  // switch has to go back to what THAT value is.
  useEffect(() => setCustom(false), [nodeKey, name]);
  // Attribute rows edit as name/value pairs, and `slot` names one of the
  // parent's slots, which is markup rather than data — neither has anything to
  // bind to.
  //
  // A code prop does. It was excluded on the grounds that it is already an
  // expression and so has no control to switch away from, which is true and
  // beside the point: `headings` passed straight through from the frontmatter
  // is the same binding as `previous` next to it, and showing one as a chip
  // and the other as raw text made the pair look like different things. What
  // it holds still decides — a name or a path chips, and anything a field of
  // chips cannot hold honestly (`items.filter(Boolean)`, a call) keeps the code
  // editor exactly as before.
  const bindable = type !== 'attrs' && name !== 'slot';
  const str = value ? value.value : '';
  const assetBinding = assetImportOf(str, dataCtx?.imports);
  // `src={hero}` is an expression, but it's the one expression a picker can
  // show and replace — that card stays rather than dropping to raw code.
  const shownAsAsset =
    value?.type === 'expr' && assetBinding && assetCtx?.projectPath && assetCtx?.filePath;
  const showExpr = bindable && (custom || (isBoundValue(field, value) && !shownAsAsset));

  // Props that only mean something while Astro is actually processing the
  // image. Set one against a source it passes through and nothing happens —
  // the component can warn once it renders, the panel can say so up front.
  const reason =
    !/^(quality|format|formats|fallbackFormat|densities|widths|sizes)$/i.test(name) ||
    !assetCtx?.srcKind
      ? null
      : assetCtx.srcKind === 'svg'
        ? 'SVG sources are passed through unoptimized, so this has no effect.'
        : assetCtx.srcKind === 'public'
          ? 'Files in public/ are served as-is — import from src/assets to optimize.'
          : null;

  // Nothing to offer, so don't: the field is gone for this source. One that
  // already carries a value stays, flagged — it's in the markup either way,
  // and hiding it would leave a prop the component ignores with no way to
  // reach it from here.
  if (reason && !isSet) return null;

  const reset = () => {
    setMenuPos(null);
    onChange(undefined, true);
  };

  const fromCustom = () => {
    setCustom(false);
    if (value?.type === 'expr') onChange(valueFromExpr(field, value.value), true);
  };

  const onLabelClick = (e) => {
    // A field switched to a value has something to offer even before anything
    // is set: the way back to its control.
    if (!isSet && !showExpr) return;
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
      title={isSet ? '⌥-click to reset to default' : showExpr ? 'Click for options' : undefined}
      onClick={onLabelClick}
    >
      {type === 'number' && <FieldNumberIcon size={12} className="prop-label-icon" />}
      {type === 'boolean' && <FieldSwitchIcon size={12} className="prop-label-icon" />}
      {type === 'enum' && <ComponentPropertiesIcon size={12} className="prop-label-icon" />}
      {type === 'attrs' && <BracesIcon size={12} className="prop-label-icon" />}
      {(type === 'code' || type === 'style') && <CodeIcon size={12} className="prop-label-icon" />}
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
    <ResetMenu
      pos={menuPos}
      onReset={reset}
      // Only while the field is showing a value instead of its own control —
      // it is the way back, and there is nothing to go back FROM otherwise.
      onUnbind={showExpr ? fromCustom : null}
      unbindLabel={`Use the ${controlWord(field)}`}
      onClose={() => setMenuPos(null)}
    />
  );
  const labelEl = (
    <label onClick={noLabelActivation}>
      {pill}
      {/* The prop's own documentation — the comment above it in the
          component's `interface Props`. */}
      <PropTip text={field.doc} />
      {reason && (
        <span className="prop-inert" title={reason}>
          ignored
        </span>
      )}
      {/* The way between the field's own control and an expression, both ways,
          in the one place a field's name already is. Some values a control
          cannot hold — `href={page.url}` is not a link setting — and until this
          existed the only way in was to pick data, which is a value rather than
          the code somebody had in mind. */}
      {bindable && (
        <button
          type="button"
          className={`prop-expr-toggle${showExpr ? ' on' : ''}`}
          title={showExpr ? `Use the ${controlWord(field)}` : 'Write an expression'}
          aria-pressed={showExpr}
          aria-label="Write an expression"
          onClick={() => (showExpr ? fromCustom() : setCustom(true))}
        >
          <BracesIcon size={12} />
        </button>
      )}
      {bindable && (
        <BindHandle
          active={!!insertAt}
          onOpen={(host) => {
            if (insertAt) {
              setInsertAt(null);
              return;
            }
            const r = host?.getBoundingClientRect();
            if (!r) return;
            setInsertAt({
              left: r.left,
              top: Math.min(r.bottom + 4, Math.max(60, window.innerHeight - 340)),
              width: Math.max(r.width, 240),
            });
          }}
        />
      )}
      {menu}
    </label>
  );

  const pickerEl = insertAt && (
    <FieldDataPicker
      pos={insertAt}
      bindCtx={bindCtx}
      current={showExpr ? null : undefined}
      onPick={(path) => {
        setInsertAt(null);
        // Into the value field's caret when there is one — so a chip can land
        // beside text already typed. Otherwise this is the field's first
        // binding, and choosing one is what turns the control into a value.
        if (bindApiRef.current?.insert) {
          bindApiRef.current.insert(path);
          return;
        }
        setCustom(true);
        // Text already typed is kept and the chip goes after it — inserting
        // data into "Read more about " should not throw the sentence away. A
        // control's value can't be joined to anything (`true` and a binding is
        // not a value), so those are replaced.
        const numeric =
          type === 'number' || type === 'boolean' || (type === 'enum' && field.numeric);
        const keep = numeric || type === 'enum' ? null : partsFromValue(value);
        const next = keep?.length ? [...keep, { expr: path }] : [{ expr: path }];
        onChange(valueFromParts(next, { numeric }), true);
      }}
      onClose={() => setInsertAt(null)}
    />
  );
  // Carried with the label so every kind of field gets one, wherever its own
  // branch returns. The popup is fixed, so where it sits in the DOM is moot.
  const label = (
    <>
      {labelEl}
      {pickerEl}
    </>
  );

  // A binding is code, so it edits as code: no toggle, dropdown or picker can
  // show `post.data.title`, let alone let you change it.
  if (showExpr) {
    return (
      <div className="props-field">
        {label}
        <BindField
          value={value}
          field={field}
          apiRef={bindApiRef}
          placeholder={placeholderFor(field)}
          bindCtx={bindCtx}
          dataCtx={dataCtx}
          onChange={(v, immediate) => {
            // Editing holds the field open: clearing a binding on the way to
            // another one shouldn't snap the control back mid-edit. An empty
            // value unsets the prop and leaves the field where it is.
            setCustom(true);
            onChange(v, immediate);
          }}
        />
      </div>
    );
  }

  // Inline CSS. A declaration list, not a string, so it gets the same little
  // CSS editor the Attributes popover uses — and its own field, since every
  // element has one. An {expression} value falls through to the plain input
  // below: that's JavaScript, and the CSS mode would mangle it.
  if (type === 'style' && (!isSet || value.type === 'string')) {
    return (
      <div className="props-field">
        {label}
        <StyleEditor
          value={value?.value || ''}
          placeholder="color: red;"
          onChange={(text) => {
            const flat = collapseDeclarations(text);
            // Nothing left in it means no attribute at all — an element never
            // asked for an empty style="" and shouldn't carry one.
            if (!flat) onChange(undefined, true);
            else onChange({ type: 'string', value: flat }, false);
          }}
        />
      </div>
    );
  }

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
          bindCtx={bindCtx}
          projectPath={assetCtx?.projectPath}
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
    // Exactly two options, one of them the default: the same shape as a
    // boolean — an either/or with a known resting state — so it reads as one.
    // Only when what's set is one of the two; an out-of-schema value has to
    // stay visible, and the dropdown is the only field that can show it.
    if (
      field.options.length === 2 &&
      defaultStr !== undefined &&
      field.options.includes(defaultStr) &&
      (raw === undefined || field.options.includes(raw))
    ) {
      const current = raw ?? defaultStr;
      return (
        <div className="props-field">
          {label}
          <SegSwitch
            options={field.options.map((o) => ({ value: o, label: o }))}
            current={current}
            onPick={(v) =>
              // Picking the default clears the prop, exactly as the dropdown
              // does — an untouched component stays untouched in the markup.
              v === defaultStr
                ? onChange(undefined, true)
                : onChange({ type: field.numeric ? 'expr' : 'string', value: v }, true)
            }
          />
        </div>
      );
    }
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
          // Says what happens when nothing is picked. For a conditional
          // default that's the condition itself — better than naming one of
          // the two answers as if it were the only one.
          placeholder={placeholderFor(field) || '(not set)'}
          options={opts.map((o) => ({ value: o === defaultStr ? '' : o, label: o }))}
          onChange={(v) =>
            v === ''
              ? onChange(undefined, true)
              : // A union of numbers is still numbers: the component is typed
                // for one, so it has to be written `cols={3}`, not `cols="3"`.
                onChange({ type: field.numeric ? 'expr' : 'string', value: v }, true)
          }
        />
      </div>
    );
  }

  if (type === 'boolean') {
    // A checkbox can only say on/off, and a boolean prop has three states:
    // true, false, and unset (= whatever the component defaults to). Two
    // segments say which one is in effect, and picking the default clears the
    // prop rather than writing it out — the same rule the enum dropdown uses,
    // so an untouched component stays untouched in the markup.
    // A boolean that isn't there is false — that's what the component sees for
    // an undeclared default, so false IS the default unless the component says
    // otherwise. Picking it clears the prop instead of writing `x={false}`,
    // which would mark the field set and put `false` in the markup to say what
    // its absence already said.
    const fallback = field.default === undefined ? false : !!field.default;
    const current = value ? value.type !== 'expr' || value.value === 'true' : fallback;
    const choose = (next) =>
      next === fallback
        ? onChange(undefined, true)
        : onChange({ type: 'expr', value: next ? 'true' : 'false' }, true);
    return (
      <div className="props-field">
        {label}
        <SegSwitch
          options={[
            { value: true, label: 'True' },
            { value: false, label: 'False' },
          ]}
          current={current}
          onPick={choose}
        />
      </div>
    );
  }

  if (type === 'number') {
    const num = value?.type === 'expr' ? value.value : value?.value ?? '';
    // What the component says it will accept (see numberRules): a bound the
    // type can't express, read from the doc comment. Typing stays free — you
    // have to be able to pass through "-" or "1." on the way to a real number
    // — and the check happens when the value is committed, on Enter or on
    // leaving the field.
    const { min, max, step: grain, minExclusive, maxExclusive } = field;
    const bounded = min !== undefined || max !== undefined || grain !== undefined;
    const allows = (n) => {
      if (!Number.isFinite(n)) return false;
      if (min !== undefined && (minExclusive ? n <= min : n < min)) return false;
      if (max !== undefined && (maxExclusive ? n >= max : n > max)) return false;
      // Rounded before comparing, or 0.1 + 0.2 fails a step of 0.1.
      if (grain !== undefined && Math.abs(Math.round(n / grain) * grain - n) > 1e-9) return false;
      return true;
    };
    const clamp = (n) => {
      let v = n;
      if (grain !== undefined) v = Math.round(v / grain) * grain;
      if (min !== undefined) v = Math.max(v, minExclusive ? min + (grain ?? 1e-6) : min);
      if (max !== undefined) v = Math.min(v, maxExclusive ? max - (grain ?? 1e-6) : max);
      return Math.round(v * 1e6) / 1e6;
    };
    // The last value that was allowed, to fall back to. An empty field is
    // allowed — it means "unset", and the component's own default applies.
    if (num === '' || allows(parseFloat(num))) lastGoodRef.current = num;
    const revertIfRejected = () => {
      if (!bounded || num === '' || allows(parseFloat(num))) return;
      const back = lastGoodRef.current;
      onChange(back === '' ? undefined : { type: 'expr', value: back }, true);
    };
    // One place decides what a step does, so the arrow keys and the buttons
    // can't drift apart. Shift ×10, Option ÷10 — the modifiers the style
    // panel's number fields already use.
    const step = (dir, mods, from) => {
      const size = mods.shiftKey ? 10 : mods.altKey ? 0.1 : 1;
      const cur = parseFloat(from);
      // An empty field steps from the value it is SHOWING — the placeholder is
      // the effective value (the source image's 115, the component's default),
      // so ▲ on a blank width goes to 116, not 1.
      const shown = parseFloat(placeholderFor(field));
      const base = Number.isFinite(cur)
        ? cur
        : Number.isFinite(shown)
          ? shown
          : parseFloat(field.default) || 0;
      // Round away float noise (e.g. 38.1 + 0.1 = 38.199999…), then keep the
      // result inside what the component accepts — a step is an applied value,
      // so it should never land somewhere the field would reject.
      const next = Math.round((base + dir * size) * 1e6) / 1e6;
      onChange({ type: 'expr', value: String(bounded ? clamp(next) : next) });
    };
    const onStepKey = (e) => {
      if (e.key === 'Enter') {
        revertIfRejected();
        return;
      }
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      e.preventDefault();
      step(e.key === 'ArrowUp' ? 1 : -1, e, e.target.value);
    };
    return (
      <div className="props-field">
        {label}
        {/* type=text, not number: the native spinner can't be styled, ignores
            the modifier steps, and its scroll-to-change fires while scrolling
            the panel. inputMode keeps the numeric keypad on touch. */}
        <div className="num-field">
          <input
            type="text"
            inputMode="decimal"
            value={num}
            placeholder={placeholderFor(field)}
            onKeyDown={onStepKey}
            onBlur={revertIfRejected}
            title={boundsHint(field)}
            onChange={(e) =>
              e.target.value === ''
                ? onChange(undefined)
                : onChange({ type: 'expr', value: e.target.value })
            }
          />
          <span className="num-steppers">
            {[1, -1].map((dir) => (
              <button
                key={dir}
                type="button"
                tabIndex={-1}
                aria-label={dir > 0 ? 'Increase' : 'Decrease'}
                title={`${dir > 0 ? 'Increase' : 'Decrease'} — ⇧ by 10, ⌥ by 0.1`}
                onClick={(e) => step(dir, e, num)}
              >
                <ChevronDownIcon size={11} style={dir > 0 ? { transform: 'rotate(180deg)' } : undefined} />
              </button>
            ))}
          </span>
        </div>
      </div>
    );
  }

  // string / other
  // An array/object prop is a JS value, so it edits as code and writes
  // `prop={…}`. Without this a text field writes `densities="[1, 2]"` — a
  // string the component then calls .map on.
  const isExpr = value?.type === 'expr' || (type === 'code' && value?.type !== 'string');

  // href gets the Webflow-style link settings: URL / page / section / email /
  // phone / asset, all compiling down to one href string. Not just the
  // attribute itself: a component that forwards a link namespaces it
  // (`buttonHref`, `ctaHref`), and that's the same value going to the same
  // place. The last word has to BE href, so `hrefLabel` stays a text field.
  if (isHrefName(name) && !isExpr && linkContext && (type === 'string' || type === 'other')) {
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
  const isMediaAttr = isMediaName(name);
  if (!isExpr && assetCtx?.projectPath && (isMediaAttr || looksLikeAssetPath(str))) {
    const nodeName = String(assetCtx.nodeName || '').toLowerCase();
    const mediaKind = looksLikeAssetPath(str)
      ? mediaKindFor(str)
      : /^(poster|image|logo|icon|avatar|thumb|thumbnail|photo|banner|cover)$/.test(mediaWord(name))
        ? 'image'
        : mediaWord(name) === 'video'
          ? 'video'
          : mediaWord(name) === 'audio'
            ? 'audio'
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
          onPickEntry={assetCtx.onPickAsset && ((picked) => assetCtx.onPickAsset(name, picked))}
          onDimensions={(d) => assetCtx.onPickDimensions?.(name, d)}
          onCurrentDimensions={(d) => /^src$/i.test(name) && assetCtx.onSrcDimensions?.(d)}
        />
      </div>
    );
  }

  // An expression bound to an imported image is still an image: `src={hero}`
  // gets the same card and "Choose Image…" a public/ path does, instead of
  // becoming a code field the moment you pick one.
  if (isExpr && assetBinding && assetCtx?.projectPath && assetCtx?.filePath) {
    return (
      <div className="props-field">
        {label}
        <AssetImportField
          binding={assetBinding}
          name={name}
          assetCtx={assetCtx}
          onChange={onChange}
        />
      </div>
    );
  }

  // An expression value is JavaScript, so it edits as code rather than text.
  if (isExpr) {
    return (
      <div className="props-field">
        {label}
        <ExprValueField
          value={str}
          placeholder={placeholderFor(field)}
          dataCtx={dataCtx}
          onChange={onChange}
        />
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
          placeholder={placeholderFor(field)}
          onChange={(e) => onChange({ type: 'string', value: e.target.value })}
        />
      ) : (
        <input
          value={str}
          placeholder={placeholderFor(field)}
          onChange={(e) => onChange({ type: 'string', value: e.target.value })}
        />
      )}
    </div>
  );
}

// Small fixed-position menu opened by clicking a set prop's label.
function ResetMenu({ pos, onReset, onUnbind, unbindLabel, onClose }) {
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
      {onUnbind && (
        <div className="prop-menu-item" onClick={onUnbind}>
          <CornerIcon size={12} />
          {unbindLabel}
        </div>
      )}
      <div className="prop-menu-item" onClick={onReset}>
        <ResetIcon size={12} />
        Reset to default property value
      </div>
    </div>
  );
}



