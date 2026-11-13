// A prop field's label row: its pill, its menu, the picker it opens, and the
// reset menu (PropField.tsx).

import { useTranslate } from '../../lib/i18n/useTranslate';
import React, { useRef, useState } from 'react';
import { dataPickerPosition } from './dataPickerPosition';
import { ResetMenu } from '../../ui/ResetLabel';
import { valueFromParts } from '../../editor/bindings';
import { BindHandle, FieldDataPicker } from './propBindings';
import PropTip from './PropTip';
import { BracesIcon } from '../../ui/Icons';
import { FieldTypeIcon } from './FieldTypeIcon';
import { controlLabel, type PropState } from './propFieldModel';
import { fitOfFieldType, literalOf, type NewPropSeed } from './newPropModel';
import { fieldTooltip } from '../../editor/propDocumentation';
import { isMediaName } from '../../editor/fieldNames';
import { arrayItems } from './arrayValue';
import { itemShapeOf } from './listItemShape';
import { ConditionalEditor, useConditionCatalog } from './ConditionalValue';
import { startingConditional, valueLanguageOf } from './conditionalModel';

export const noLabelActivation = (event: React.MouseEvent<HTMLLabelElement>) => event.preventDefault();
export function PropFieldPill({ state }: { readonly state: PropState }) {
  const translate = useTranslate();
  const { name, type, isSet, showExpr, onLabelClick, onLabelContextMenu, required, missingRequired, deprecated } = state;
  // Set is the overridden state: the label takes the accent, as a value the
  // instance gives rather than the component's default.
  const classes = ['prop-label', ...(isSet ? ['set'] : []), ...(deprecated === undefined ? [] : ['deprecated'])];

  return (
    <span
      className={classes.join(' ')}
      title={isSet ? translate('props.field.overridden') : showExpr ? translate('props.field.clickForOptions') : undefined}
      onClick={onLabelClick}
      onContextMenu={onLabelContextMenu}
    >
      <FieldTypeIcon type={type} name={name} />
      {name}
      {required && (
        <span
          className={`prop-required${missingRequired ? ' missing' : ''}`}
          role="img"
          aria-label={missingRequired ? translate('props.field.requiredNotSet') : translate('props.sections.required')}
          title={missingRequired ? translate('props.field.requiredNeeds') : translate('props.sections.required')}
        />
      )}
    </span>
  );
}

// The line under a field that names what it is missing (PropField.tsx).
export function PropFieldNote({ state }: { readonly state: PropState }) {
  const translate = useTranslate();
  if (!state.missingRequired) {
    return undefined;
  }
  return (
    <div className="prop-field-note required" role="note">
      {translate('props.field.requiredNeeds')}
    </div>
  );
}
export function PropFieldMenu({ state }: { readonly state: PropState }) {
  const translate = useTranslate();
  const { field, menuPosition, setMenuPosition, showExpr, reset, fromCustom } = state;

  return (
    menuPosition && (
      <ResetMenu
        position={menuPosition}
        onReset={reset}
        // Only while the field is showing a value instead of its own control —
        // it is the way back, and there is nothing to go back FROM otherwise.
        {...(showExpr ? { onUnbind: fromCustom } : {})}
        unbindLabel={controlLabel(field, translate)}
        onClose={() => setMenuPosition(undefined)}
      />
    )
  );
}
export function PropFieldLabelRow({ state }: { readonly state: PropState }) {
  const translate = useTranslate();
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
      <PropTip text={fieldTooltip(field.doc, state.deprecated, translate)} />
      {state.deprecated !== undefined && (
        <span
          className="prop-deprecated"
          title={state.deprecated === '' ? translate('props.field.deprecated') : translate('props.field.deprecatedNote', { note: state.deprecated })}
        >
          {translate('props.field.deprecated')}
        </span>
      )}
      {reason && (
        <span className="prop-inert" title={reason}>
          {translate('props.field.ignored')}
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
          title={showExpr ? controlLabel(field, translate) : translate('props.field.writeExpression')}
          aria-pressed={showExpr}
          aria-label={translate('props.field.writeExpression')}
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
  // The Value conditions editor, opened from the picker's "Create conditional"
  // and placed under the label row this sits beside.
  const [conditional, setConditional] = useState(false);
  const anchorRef = useRef<HTMLSpanElement>(null);
  const catalog = useConditionCatalog(bindContext);
  const seed = seedOf(field, value);
  // Words only: a branch gives text or a prop, which a number or a switch field cannot hold as typed.
  const wordy = seed?.fit === 'text' || seed?.fit === 'content';
  const start = bindContext?.newProp !== undefined && wordy ? startingConditional(value, catalog) : undefined;

  return (
    <>
      {/* Only while the editor is open, so the field's layout is untouched otherwise. */}
      {conditional && <span ref={anchorRef} className="conditional-anchor" />}
      {conditional && start !== undefined && (
        <ConditionalEditor
          anchorRef={anchorRef}
          start={start}
          model={undefined}
          value={value}
          bindContext={bindContext}
          language={valueLanguageOf(type === 'style' ? 'style' : field.name)}
          onApply={(next) => onChange(next, true)}
          onClose={() => setConditional(false)}
        />
      )}
      {insertAt && (
        <FieldDataPicker
          pos={insertAt}
          bindContext={bindContext}
          seed={seed}
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
          onConditional={
            start === undefined
              ? undefined
              : () => {
                  setInsertAt(undefined);
                  setConditional(true);
                }
          }
          onClose={() => setInsertAt(undefined)}
        />
      )}
    </>
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
