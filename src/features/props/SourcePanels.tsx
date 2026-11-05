// The settings panel for nodes that are source rather than elements: a
// comment, frontmatter, an expression, a raw line, a loop, a condition and its
// branches, raw markup and text (PropsPanel.tsx).

import type { Attr } from '../../../shared/page/pageNode';
import type { SourceContext } from './propBindings';
import { resolveAssetImport, readAssetDimensions } from '../../ipc/assetBridge';
import { MapEditor } from './propNodeEditors';
import { assetImportOf } from './PropField';
import { AttributesSection } from './propAttributes';
import { ConditionField } from './propBindings';
import React, { useEffect, useRef, useState } from 'react';
import AutoTextarea from '../../ui/AutoTextarea';
import ExprInput from '../../ui/ExprInput';
import { scopeChips, scopeCompletions } from '../../editor/dataSuggest';
import { CommentIcon, CodeIcon, BranchIcon, CornerIcon } from '../../ui/Icons';
import { type PropsPanelProps, type NodePanelProps, type SourceDimensionsOptions } from './propsPanelTypes';
import TextConnectField, { type TextConnectFieldProps } from './TextConnectField';

// Edits the props of the selected node. Fields come from the component's
// prop schema (interface Props / Astro.props destructure), plus any props
// already set on the node that aren't in the schema.
// A click inside a label is forwarded to its first control.
// These labels hold no field — the input is their sibling — but they do hold
// the bind dot and the `{}` toggle, so a press on the empty space beside a
// prop's name, or on the name itself, was silently pressing a button. On a
// field showing an expression that button means "use the control instead",
// which drops a value no control can hold: clicking next to the label cleared
// the prop. The label has nothing to activate, so it activates nothing.
//
// Attributes rows avoid labels; these keep the tag because styling depends on it.
export const noLabelActivation = (event: React.MouseEvent<HTMLLabelElement>) => event.preventDefault();
export function panelDataContext(props: PropsPanelProps): SourceContext {
  return {
    frontmatter: props.loopContext?.frontmatter || '',
    imports: props.frontmatterSource || '',
    projectPath: props.projectPath,
    filePath: props.filePath,
    onSetFrontmatter: props.onSetFrontmatter,
    onOpenSymbol: props.onOpenSymbol,
  };
}

// The HTML comment directly above this node — the note the navigator shows
// beside its name. Written as you type, so that label keeps up with the field:
// the write is coalesced and the save debounced (see setComment), so a burst of
// typing is still one save and one undo step. Clearing the field removes the
// comment node.
export function CommentField({ value, onCommit }: { readonly value?: string | undefined; readonly onCommit: (text: string) => void }) {
  const [draft, setDraft] = useState(value ?? '');
  // Re-sync when the model changes underneath (undo, external edit) — but not
  // while typing, or the caret would jump.
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) {
      setDraft(value ?? '');
    }
  }, [value]);
  const commit = (text = draft) => {
    const next = text.trim();
    if (next !== (value ?? '').trim()) {
      onCommit(next);
    }
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
        onChange={(event) => {
          setDraft(event.target.value);
          commit(event.target.value);
        }}
        onFocus={() => {
          focused.current = true;
        }}
        onBlur={() => {
          focused.current = false;
          commit();
        }}
      />
    </div>
  );
}

export function EmptyPanel(props: PropsPanelProps) {
  const {} = props;

  return (
    <div className="panel-section grow" style={{ flex: '1 1 50%' }}>
      <div className="panel-header">
        <h2>Settings</h2>
      </div>
      <div className="props-empty">Select a component to edit its props.</div>
    </div>
  );
}
export function FrontmatterPanel(props: NodePanelProps<'frontmatter'>) {
  const { onOpenCode } = props;

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
          Imports, constants, and data for this page. Opens in a floating editor you can move and resize while working with the canvas.
        </div>
      </div>
    </div>
  );
}
export function ExprPanel(props: NodePanelProps<'expr'>) {
  const { node, loopContext, bindContext, onSetText } = props;
  const scope = scopeCompletions(bindContext || loopContext || {});

  return (
    <div className="panel-section grow" style={{ flex: '1 1 50%', overflow: 'hidden' }}>
      <div className="panel-header">
        <h2>Expression</h2>
      </div>
      <div className="props-field" style={{ marginTop: 8 }}>
        <label onClick={noLabelActivation}>
          <span className="prop-label">Code</span>
        </label>
        <ExprInput key={node.id} value={node.value} syncValue={node.value} completions={scope} onCommit={(next) => next !== node.value && onSetText(next)} />
      </div>
    </div>
  );
}
export function RawLinePanel(props: NodePanelProps<'raw-line'>) {
  const { node, onSetText } = props;

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
          onChange={(event) => onSetText(event.target.value)}
        />
        <div style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 6, lineHeight: 1.5 }}>
          {isDoctype
            ? 'Written out verbatim at the top of the page. ' + 'Not an element — it has no tag or attributes.'
            : 'Written out verbatim, exactly as typed.'}
        </div>
      </div>
    </div>
  );
}
export function MapPanel(props: NodePanelProps<'map'>) {
  const { node, loopContext, bindContext, onSetText } = props;

  const buildDataContext = () => panelDataContext(props);

  return (
    <div className="panel-section grow" style={{ flex: '1 1 50%', overflow: 'hidden' }}>
      <div className="panel-header">
        <h2>Loop</h2>
      </div>
      <MapEditor
        key={node.id}
        node={node}
        loopContext={loopContext}
        bindContext={bindContext || loopContext}
        dataContext={buildDataContext()}
        onSetText={onSetText}
        imports={props.frontmatterImports}
        projectPath={props.projectPath}
        onSetLoopSource={props.onSetLoopSource}
        onEditLoopProperty={props.onEditLoopProperty}
      />
    </div>
  );
}
export function CondPanel(props: NodePanelProps<'cond'>) {
  const { node, loopContext, bindContext, onSetText, onToggleElse } = props;
  const scope = scopeCompletions(bindContext || loopContext || {});
  const scopeNames = new Set(scope.map((completion) => completion.label.split('.')[0] ?? ''));
  const chipsInScope = (text: string) => scopeChips(text, scopeNames);

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
        <ConditionField key={node.id} test={node.test} scope={scope} chipsOf={chipsInScope} bindContext={bindContext || loopContext} onSetText={onSetText} />
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
export function BranchPanel(props: NodePanelProps<'branch'>) {
  const { node } = props;

  const isElse = node.name === 'else';
  return (
    <div className="panel-section grow" style={{ flex: '1 1 50%', overflow: 'hidden' }}>
      <div className="props-title">
        <CornerIcon size={14} className="props-title-icon" />
        {isElse ? 'else' : 'then'}
      </div>
      <div className="props-empty">{isElse ? 'Rendered when the condition is false.' : 'Rendered when the condition is true.'}</div>
    </div>
  );
}
export function CommentPanel(props: NodePanelProps<'comment'>) {
  const { node, onSetText } = props;

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
        <AutoTextarea minRows={3} value={node.value} onChange={(event) => onSetText(event.target.value)} />
      </div>
    </div>
  );
}
export function RawPanel(props: NodePanelProps<'raw'>) {
  const { node, loopContext, bindContext, onSetProp, onSetProps, onRenameProp, onOpenCode, projectPath } = props;

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
          bindContext={bindContext || loopContext}
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
          Opens the {language} in a floating editor you can move and resize while working with the canvas.
        </div>
      </div>
    </div>
  );
}
// Words, or the `{label}` they were connected to (TextConnectField.tsx): the
// one field, so a text keeps its panel when it is connected and when it is not.
export function TextPanel(props: Omit<PropsPanelProps, 'node'> & { readonly node: TextConnectFieldProps['node'] }) {
  const { node, onSetText, onSetTextPieces, bindContext, loopContext } = props;

  return (
    <div className="panel-section grow" style={{ flex: '1 1 50%', overflow: 'hidden' }}>
      <div className="panel-header">
        <h2>Text</h2>
      </div>
      <TextConnectField node={node} bindContext={bindContext || loopContext} onSetText={(value) => onSetText(value)} onSetTextPieces={onSetTextPieces} />
    </div>
  );
}
export function sourceKind(source: Attr | undefined, imports: unknown): 'svg' | 'public' | 'remote' | 'asset' | undefined {
  if (!source || source.type === 'bare') {
    return undefined;
  }
  const isSVG = (value: string) => /\.svg(\?|#|$)/i.test(value);
  if (source.type === 'string') {
    const value = source.value;
    if (!value) {
      return undefined;
    }
    if (isSVG(value)) {
      return 'svg';
    }
    return /^(https?:)?\/\//.test(value) || value.startsWith('data:') ? 'remote' : 'public';
  }
  const binding = assetImportOf(source.value, imports);
  if (!binding) {
    return undefined;
  }
  return isSVG(binding.spec) ? 'svg' : 'asset';
}
export function useSourceDimensions({ source, projectPath, filePath, imports, setSourceDimensions }: SourceDimensionsOptions) {
  // Primitive dependencies also refresh dimensions when an import changes in place.
  const sourceType = source?.type;
  const sourceValue = source?.type === 'bare' ? undefined : source?.value;
  useEffect(() => {
    if (!sourceValue || !projectPath) {
      return undefined;
    }
    let live = true;
    const fromRel = async (rel: string) => {
      const result = await readAssetDimensions(projectPath, rel);
      if (live && result.ok && result.value) {
        setSourceDimensions(result.value);
      }
    };
    if (sourceType === 'string') {
      if (/^(https?:)?\/\//.test(sourceValue) || sourceValue.startsWith('data:')) {
        return undefined;
      }
      void fromRel('public/' + sourceValue.replace(/^\//, ''));
    } else {
      const binding = assetImportOf(sourceValue, imports);
      if (!binding || !filePath) {
        return undefined;
      }
      void resolveAssetImport(projectPath, filePath, binding.spec).then((result) => {
        if (live && result.ok) {
          return fromRel(result.rel);
        }
        return undefined;
      });
    }
    return () => {
      live = false;
    };
  }, [sourceType, sourceValue, projectPath, filePath, imports, setSourceDimensions]);
}
