import { arrayItems, objectFields } from './arrayValue';
import { looksLikeAssetPath } from '../../ui/AssetThumb';
import { type PropFieldProps, usePropField, type PropState, type PropControlState } from './propFieldModel';
import { codeRowKind, isLinkProp, objectSeed } from './propKinds';
import {
  BindingControl,
  StyleControl,
  AttributeControl,
  ClassControl,
  SlotControl,
  EnumControl,
  BooleanControl,
  NumberControl,
  LinkControl,
  MediaControl,
  ImportedAssetControl,
  ObjectControl,
  ListControl,
  ExpressionControl,
  CodeControl,
  ColorControl,
  TextControl,
} from './PropControls';
import { PropFieldPill, PropFieldMenu, PropFieldLabelRow, PropFieldPicker, PropFieldNote } from './PropFieldLabel';
import { ConditionalField } from './ConditionalValue';
import { conditionalOfAttr, valueLanguageOf } from './conditionalModel';

export { type AssetContext, type PropFieldProps, assetImportOf } from './propFieldModel';

export default function PropField(props: PropFieldProps) {
  const state = usePropField(props);
  if (state.reason && !state.isSet) {
    return undefined;
  }
  return <PropFieldControls state={state} />;
}
function PropFieldControls({ state }: { readonly state: PropState }) {
  const pill = <PropFieldPill state={state} />;
  const menu = <PropFieldMenu state={state} />;
  const label = (
    <>
      <PropFieldLabelRow state={state} />
      <PropFieldPicker state={state} />
    </>
  );
  const view = { ...state, pill, menu, label };
  // The note sits under the field, outside it: every control lays out its own
  // box, and a note is about the field, not part of any one control.
  return (
    <>
      {propFieldControl(view)}
      <PropFieldNote state={state} />
    </>
  );
}
function propFieldControl(view: PropControlState) {
  const { field, value, slotOptions, assetContext, linkContext, name, type, isSet, valueText, assetBinding, showExpr, isExpr, isMediaAttr } = view;
  // Values only code can give never get a field that writes a string: an
  // action is always the read-only row, `any` and the like while unset.
  const codeRow = codeRowKind(field, value);
  if (codeRow === 'action') {
    return <CodeControl state={view} />;
  }
  // A conditional the Value conditions editor can draw is drawn by it, until
  // "Write an expression" asks for the code; any other code stays code.
  const conditional = view.custom ? undefined : conditionalOfAttr(value);
  if (conditional !== undefined) {
    return (
      <div className="props-field">
        {view.label}
        <ConditionalField
          model={conditional}
          value={value}
          bindContext={view.bindContext}
          language={valueLanguageOf(type === 'style' ? 'style' : name)}
          onApply={(next) => view.onChange(next, true)}
        />
      </div>
    );
  }
  if (showExpr) {
    return <BindingControl state={view} />;
  }
  if (codeRow === 'code') {
    return <CodeControl state={view} />;
  }
  // An object is edited as its fields when they are simple, and is otherwise
  // set in code; the list editor would write an array into it.
  if (type === 'code' && field.codeKind === 'object') {
    return objectSeed(field, valueText) === undefined ? <CodeControl state={view} /> : <ObjectControl state={view} />;
  }
  if (type === 'style' && (!isSet || value?.type === 'string')) {
    return <StyleControl state={view} />;
  }
  if (type === 'attrs') {
    const control = AttributeControl({ state: view });
    if (control !== undefined) {
      return control;
    }
  }
  if (/class(es)?$/i.test(name) && name !== 'slot' && (type === 'string' || type === 'other') && value?.type !== 'expr') {
    return <ClassControl state={view} />;
  }
  if (name === 'slot' && slotOptions?.length) {
    return <SlotControl state={view} />;
  }
  if (type === 'enum' && field.options?.length) {
    return <EnumControl state={view} />;
  }
  if (type === 'boolean') {
    return <BooleanControl state={view} />;
  }
  if (type === 'number') {
    return <NumberControl state={view} />;
  }
  // A colour typed as one (`@format color`) or named for one with a colour
  // default: a swatch beside the text, never a bare text box.
  if (view.isColor && !isExpr) {
    return <ColorControl state={view} />;
  }
  if (isLinkProp(field) && !isExpr && linkContext) {
    return <LinkControl state={view} />;
  }
  if (!isExpr && assetContext?.projectPath && (isMediaAttr || looksLikeAssetPath(valueText))) {
    return <MediaControl state={view} />;
  }
  if (isExpr && assetBinding && assetContext?.projectPath && assetContext?.filePath) {
    return <ImportedAssetControl state={view} />;
  }
  if (type === 'code' && !showExpr && valueText && objectFields(valueText)) {
    return <ObjectControl state={view} />;
  }
  if (type === 'code' && !showExpr && (value === undefined || arrayItems(valueText))) {
    return <ListControl state={view} />;
  }
  if (isExpr) {
    return <ExpressionControl state={view} />;
  }
  return <TextControl state={view} />;
}
