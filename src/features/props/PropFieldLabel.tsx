// A prop field's label row: its pill, its menu, the picker it opens, and the
// reset menu (PropField.tsx).

import React from 'react';
import { dataPickerPosition } from './dataPickerPosition';
import { ResetMenu } from '../../ui/ResetLabel';
import { valueFromParts } from '../../editor/bindings';
import { BindHandle, FieldDataPicker } from './propBindings';
import PropTip from './PropTip';
import { FieldNumberIcon, ComponentPropertiesIcon, FieldSwitchIcon, BracesIcon, CodeIcon, ElementSlotIcon, VariableTextSizeIcon } from '../../ui/Icons';
import { controlWord, type PropState } from './propFieldModel';
import { fitOfFieldType, literalOf, type NewPropSeed } from './newPropModel';
import { fieldTooltip } from '../../editor/propDocumentation';
import { isMediaName } from '../../editor/fieldNames';
import { arrayItems } from './arrayValue';
import { itemShapeOf } from './listItemShape';

export const noLabelActivation = (event: React.MouseEvent<HTMLLabelElement>) => event.preventDefault();
export function PropFieldPill({ state }: { readonly state: PropState }) {
  const { name, type, isSet, showExpr, onLabelClick, onLabelContextMenu, required, missingRequired, deprecated } = state;
  // Set is the overridden state: the label takes the accent, as a value the
  // instance gives rather than the component's default.
  const classes = ['prop-label', ...(isSet ? ['set'] : []), ...(deprecated === undefined ? [] : ['deprecated'])];

  return (
    <span
      className={classes.join(' ')}
      title={isSet ? 'Overridden — click to reset, ⌥-click resets at once' : showExpr ? 'Click for options' : undefined}
      onClick={onLabelClick}
      onContextMenu={onLabelContextMenu}
    >
      {type === 'number' && <FieldNumberIcon size={12} className="prop-label-icon" />}
      {type === 'boolean' && <FieldSwitchIcon size={12} className="prop-label-icon" />}
      {type === 'enum' && <ComponentPropertiesIcon size={12} className="prop-label-icon" />}
      {type === 'attrs' && <BracesIcon size={12} className="prop-label-icon" />}
      {(type === 'code' || type === 'style') && <CodeIcon size={12} className="prop-label-icon" />}
      {(type === 'slot' || name === 'slot') && <ElementSlotIcon size={12} className="prop-label-icon" />}
      {(type === 'string' || type === 'other') && name !== 'slot' && <VariableTextSizeIcon size={12} className="prop-label-icon" />}
      {name}
      {required && (
        <span
          className={`prop-required${missingRequired ? ' missing' : ''}`}
          role="img"
          aria-label={missingRequired ? 'Required, not set' : 'Required'}
          title={missingRequired ? 'Required — the component needs a value' : 'Required'}
        />
      )}
    </span>
  );
}

// The line under a field that names what it is missing (PropField.tsx).
export function PropFieldNote({ state }: { readonly state: PropState }) {
  if (state.customProblem !== undefined) {
    return (
      <div className="prop-field-note problem" role="alert">
        {state.customProblem}
      </div>
    );
  }
  if (!state.missingRequired) {
    return undefined;
  }
  return (
    <div className="prop-field-note required" role="note">
      Required — the component needs a value
    </div>
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
      <PropTip text={fieldTooltip(field.doc, state.deprecated)} />
      {state.deprecated !== undefined && (
        <span className="prop-deprecated" title={state.deprecated === '' ? 'Deprecated' : `Deprecated: ${state.deprecated}`}>
          Deprecated
        </span>
      )}
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
          onOpen={(host, focus) => {
            if (insertAt) {
              setInsertAt(undefined);
              return;
            }
            const bounds = host?.getBoundingClientRect();
            if (!bounds) {
              return;
            }
            setInsertAt({ ...dataPickerPosition(bounds), focus });
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
          const numeric = !!(type === 'number' || type === 'boolean' || (type === 'enum' && field.numeric));
          onChange(valueFromParts([{ expr: path }], { numeric }), true);
        }}
        onPick={(path) => {
          setInsertAt(undefined);
          // Into the value field's caret while it is being typed — so a chip
          // lands beside the words around it (fieldFocus.ts).
          if (insertAt.focus.kind === 'focused' && bindApiRef.current?.insert) {
            bindApiRef.current.insert(path);
            return;
          }
          // The dot pressed outside the field connects the whole of it, as the
          // Content field's does: the chip is the value, and choosing one is
          // what turns a control into a value.
          setCustom(true);
          const numeric = !!(type === 'number' || type === 'boolean' || (type === 'enum' && field.numeric));
          onChange(valueFromParts([{ expr: path }], { numeric }), true);
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
