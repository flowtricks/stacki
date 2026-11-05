import { PropValuePolicyContext } from './propValuePolicy';
import type { PropValues } from './propRules';
import { isFragmentNode } from '../../editor/liveClasses';
import React, { useRef } from 'react';
import { elementIcon } from '../../ui/Icons';
import { clickNote } from '../../ui/sound';
import { SoundHere } from '../../ui/soundScope';
import { CustomElementIcon, ElementComponentIcon, astroAssetIcon } from '../../ui/Icons';
import { type PropsPanelProps, type ElementPropsPanelProps } from './propsPanelTypes';
import {
  panelDataContext,
  EmptyPanel,
  FrontmatterPanel,
  ExprPanel,
  RawLinePanel,
  MapPanel,
  CondPanel,
  BranchPanel,
  CommentPanel,
  RawPanel,
  TextPanel,
} from './SourcePanels';
import { useElementProps, type ElementState } from './elementState';
import { isTextConnection } from './TextConnectField';
import { ElementContent, ElementLooseText, ElementSchemaFields, ElementExtraFields, ElementSettingsHeader, ElementSettings } from './ElementFields';

export { type PropsPanelProps } from './propsPanelTypes';

export { BindField } from './propBindings';

export default function PropsPanel(props: PropsPanelProps) {
  // Held union values survive selections of text, loops, and other special nodes.
  const stashRef = useRef(new Map<string, PropValues>());
  return <PropValuePolicyContext.Provider value={props.valuePolicy ?? 'instance'}>{renderPropsPanel(props, stashRef)}</PropValuePolicyContext.Provider>;
}
function renderPropsPanel(props: PropsPanelProps, stashRef: React.MutableRefObject<Map<string, PropValues>>) {
  const { node } = props;
  if (!node) {
    return <EmptyPanel {...props} />;
  }
  switch (node.kind) {
    case 'frontmatter':
      return <FrontmatterPanel {...props} node={node} />;
    case 'expr':
      // `{label}` in the markup is a text connected to data, and keeps the Text
      // panel it had as words, where it can be disconnected; other code is code.
      return props.onSetTextPieces !== undefined && isTextConnection(node.value, props.bindContext || props.loopContext) ? (
        <TextPanel {...props} node={{ kind: 'expr', id: node.id, value: node.value }} />
      ) : (
        <ExprPanel {...props} node={node} />
      );
    case 'raw-line':
      return <RawLinePanel {...props} node={node} />;
    case 'map':
      return <MapPanel {...props} node={node} />;
    case 'cond':
      return <CondPanel {...props} node={node} />;
    case 'branch':
      return <BranchPanel {...props} node={node} />;
    case 'comment':
      return <CommentPanel {...props} node={node} />;
    case 'raw':
      return <RawPanel {...props} node={node} />;
    case 'text':
      // The node's own kind, restated: a value node's type spans every value kind.
      return <TextPanel {...props} node={{ kind: 'text', id: node.id, value: node.value }} />;
    case 'element':
    case 'component':
    case 'chunk-group':
      return <ElementPropsPanel {...props} node={node} dataContext={panelDataContext(props)} stashRef={stashRef} />;
    default: {
      const exhaustive: never = node;
      return exhaustive;
    }
  }
}
function ElementPropsPanel(props: ElementPropsPanelProps) {
  const state = useElementProps(props);
  return <ElementPanelView state={state} />;
}
function ElementPanelView({ state }: { readonly state: ElementState }) {
  const { node, isLayout, currentLayoutName, schema, allowAttrs, extraProps, showContentField, rootRef } = state;

  return (
    // Every button in the panel taps, and every dropdown under it sounds its
    // highlight — the same two the style panel makes, wired the same way. The
    // click handler sits here rather than on each button because a popover
    // portals to <body> and React still sends its events up the tree that
    // rendered it; SoundHere is what carries the same fact to the menus, which
    // cannot be reached by a DOM ancestor at all. Silent unless the setting is
    // on.
    <SoundHere>
      <div
        className="panel-section grow"
        ref={rootRef}
        style={{ flex: '1 1 50%', overflow: 'hidden' }}
        onClick={(event) => {
          const button = event.target instanceof Element ? event.target.closest('button') : undefined;
          if (button && !button.disabled) {
            clickNote();
          }
        }}
      >
        <div className="props-title">
          {isFragmentNode(node) ? (
            <CustomElementIcon size={16} className="props-title-icon" />
          ) : node.kind === 'element' ? (
            elementIcon(node.name, 16, 'props-title-icon')
          ) : 'astroAsset' in node && node.astroAsset ? (
            astroAssetIcon(node.name, 16, 'props-title-icon')
          ) : (
            <ElementComponentIcon size={16} className="props-title-icon" />
          )}
          {isLayout ? currentLayoutName || node.name : node.name}
          {isLayout && <span className="badge">layout</span>}
        </div>
        <div className="panel-body" style={{ padding: 0 }}>
          {/* A slot isn't a tag choice — it's where the caller's content plugs
            in. Renaming it would silently turn it into an empty element. */}

          <ElementContent state={state} />
          <ElementLooseText state={state} />
          <ElementSchemaFields state={state} />
          <ElementExtraFields state={state} />
          {/* Class, attributes, the comment and slot are the same four fields on
            every node, and they're the ones you reach for least — folded away
            behind one heading so a component's own props are what the panel
            opens on. Shut by default; the choice sticks while the app is up. */}
          <ElementSettingsHeader state={state} />
          <ElementSettings state={state} />
          {!isLayout && !allowAttrs && schema.length === 0 && extraProps.length === 0 && !showContentField && (
            <div className="props-empty">
              {node.kind === 'element'
                ? 'This HTML element has no attributes set.'
                : 'This component declares no props (add an interface Props or ' + 'an Astro.props destructure to expose some).'}
            </div>
          )}
        </div>
      </div>
    </SoundHere>
  );
}
