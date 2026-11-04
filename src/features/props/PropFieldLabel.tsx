// A prop field's label row: its pill, its menu, the picker it opens, and the
// reset menu (PropField.tsx).

import React from 'react';
import { dataPickerPosition } from './dataPickerPosition';
import { ResetMenu } from '../../ui/ResetLabel';
import { partsFromValue, valueFromParts } from '../../editor/bindings';
import { BindHandle, FieldDataPicker } from './propBindings';
import PropTip from './PropTip';
import { FieldNumberIcon, ComponentPropertiesIcon, FieldSwitchIcon, BracesIcon, CodeIcon, ElementSlotIcon, VariableTextSizeIcon } from '../../ui/Icons';
import { controlWord, type PropState } from './propFieldModel';
import { fitOfFieldType, literalOf, type NewPropSeed } from './newPropModel';
import { withoutSettingTags } from '../../editor/propDocumentation';
import { isMediaName } from '../../editor/fieldNames';
import { arrayItems } from './arrayValue';
import { itemShapeOf } from './listItemShape';

export const noLabelActivation = (event: React.MouseEvent<HTMLLabelElement>) => event.preventDefault();
export function PropFieldPill({ state }: { readonly state: PropState }) {
  const { name, type, isSet, showExpr, onLabelClick } = state;

  return (
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
      {(type === 'slot' || name === 'slot') && <ElementSlotIcon size={12} className="prop-label-icon" />}
      {(type === 'string' || type === 'other') && name !== 'slot' && <VariableTextSizeIcon size={12} className="prop-label-icon" />}
      {name}
    </span>
  );
}
export function PropFieldMenu({ state }: { readonly state: PropState }) {
  const { field, menuPosition, setMenuPosition, showExpr, reset, fromCustom } = state;

  return (
    menuPosition && (
      <ResetMenu
        position={menuPosition}
        onReset={reset}
        // Only while the field is showing a value instead of its own control —
        // it is the way back, and there is nothing to go back FROM otherwise.
        {...(showExpr ? { onUnbind: fromCustom } : {})}
        unbindLabel={`Use the ${controlWord(field)}`}
        onClose={() => setMenuPosition(undefined)}
      />
    )
  );
}
export function PropFieldLabelRow({ state }: { readonly state: PropState }) {
  const {
    field,

    setCustom,
    insertAt,
    setInsertAt,
    bindable,
    showExpr,
    reason,
    fromCustom,
  } = state;
  const pill = <PropFieldPill state={state} />;
  const menu = <PropFieldMenu state={state} />;
  return (
    <label onClick={noLabelActivation}>
      {pill}
      {/* The prop's own documentation — the comment above it in the
          component's `interface Props`. */}
      <PropTip {...(field.doc === undefined ? {} : { text: withoutSettingTags(field.doc) })} />
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
              setInsertAt(undefined);
              return;
            }
            const bounds = host?.getBoundingClientRect();
            if (!bounds) {
              return;
            }
            setInsertAt(dataPickerPosition(bounds));
          }}
        />
      )}
      {menu}
    </label>
  );
}
export function PropFieldPicker({ state }: { readonly state: PropState }) {
  const { field, value, bindContext, onChange, type, setCustom, insertAt, setInsertAt, bindApiRef } = state;

  return (
    insertAt && (
      <FieldDataPicker
        pos={insertAt}
        bindContext={bindContext}
        seed={seedOf(field, value)}
        // A prop made for this field is the whole of its value, as a builder binds one.
        onBindNew={(path) => {
          setInsertAt(undefined);
          setCustom(true);
          onChange({ type: 'expr', value: path }, true);
        }}
        onPick={(path) => {
          setInsertAt(undefined);
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
          const numeric = !!(type === 'number' || type === 'boolean' || (type === 'enum' && field.numeric));
          const keep = numeric || type === 'enum' ? undefined : partsFromValue(value);
          const next = keep?.length ? [...keep, { expr: path }] : [{ expr: path }];
          onChange(valueFromParts(next, { numeric }), true);
        }}
        onClose={() => setInsertAt(undefined)}
      />
    )
  );
}

// What a new prop for this field starts from: its kind, its name and its value.
// A media field (an <img> src, an image prop) offers an Image prop, and says
// whether it takes an imported image's URL (typed string) or the image itself.
// A list field of a child component offers a List prop with its items' fields,
// starting from the items it holds.
function seedOf(field: PropState['field'], value: PropState['value']): NewPropSeed | undefined {
  const list = field.shapeIsList === true;
  const fit = fitOfFieldType(field.type, { numeric: field.numeric, media: isMediaName(field.name), list });
  if (fit === undefined) {
    return undefined;
  }
  const reference = field.type === 'string' ? 'url' : 'module';
  if (fit === 'list') {
    const items = value?.type === 'expr' && arrayItems(value.value) !== undefined ? value.value : '';
    return { fit, label: field.name, value: items, reference, itemFields: itemShapeOf(field.shape) };
  }
  return { fit, label: field.name, value: literalOf(value), reference };
}
