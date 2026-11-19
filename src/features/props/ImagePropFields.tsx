// Some of an element's property fields, drawn by the Properties panel's own editors and written through its
// own handlers: the canvas image popup shows the picture and its alt text this way (CanvasImagePopup.tsx), so
// a field there is the panel's field, with the same asset picker, binding dots, undo step and instant canvas
// update. Only the named fields are drawn, in the order named.

import { useRef } from 'react';
import { PropValuePolicyContext } from './propValuePolicy';
import type { PropValues } from './propRules';
import { SoundHere } from '../../ui/soundScope';
import type { PropsPanelProps, ElementPropsPanelProps } from './propsPanelTypes';
import { panelDataContext } from './SourcePanels';
import { useElementProps } from './elementState';
import PropField from './PropField';
import type { ValueChange } from './bindingTypes';

export function ImagePropFields(
  props: Omit<PropsPanelProps, 'node'> & { readonly node: ElementPropsPanelProps['node']; readonly fieldNames: readonly string[] },
) {
  const stashRef = useRef(new Map<string, PropValues>());
  return (
    <PropValuePolicyContext.Provider value={props.valuePolicy ?? 'instance'}>
      <ImagePropFieldsView {...props} dataContext={panelDataContext(props)} stashRef={stashRef} />
    </PropValuePolicyContext.Provider>
  );
}

function ImagePropFieldsView(props: ElementPropsPanelProps & { readonly fieldNames: readonly string[] }) {
  const state = useElementProps(props);
  const { node, schema, slotOptions, projectClasses, loopContext, bindContext, linkContext, dataContext, appliesNow, branchDefault, narrowOptions } = state;
  const { setPropCascading, assetContext, onSetProp } = state;
  // The named fields in the order named, each one the schema's own definition of it, or a bare attribute the element holds.
  return (
    <SoundHere>
      <div className="canvas-image-fields" ref={state.rootRef}>
        {props.fieldNames.map((name) => {
          const field = schema.find((candidate) => candidate.name === name);
          if (field !== undefined && !appliesNow(field)) {
            return undefined;
          }
          const onChange: ValueChange =
            field === undefined ? (next, immediate) => onSetProp(name, next, immediate) : (next, immediate) => setPropCascading(name, next, immediate);
          return (
            <PropField
              key={name}
              nodeKey={node.id}
              bindContext={bindContext || loopContext}
              field={field === undefined ? { name, type: 'other' } : narrowOptions(field)}
              branchDefault={branchDefault(name)}
              value={node.props?.[name]}
              slotOptions={slotOptions}
              projectClasses={projectClasses}
              assetContext={assetContext}
              linkContext={linkContext}
              dataContext={dataContext}
              onChange={onChange}
            />
          );
        })}
      </div>
    </SoundHere>
  );
}
