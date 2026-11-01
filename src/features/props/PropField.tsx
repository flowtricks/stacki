import { arrayItems, objectFields } from './arrayValue';
import { looksLikeAssetPath } from '../../ui/AssetThumb';
import { type PropFieldProps, isHrefName, usePropField, type PropState, type PropControlState } from './propFieldModel';
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
  TextControl,
} from './PropControls';
import { PropFieldPill, PropFieldMenu, PropFieldLabelRow, PropFieldPicker } from './PropFieldLabel';

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
  return propFieldControl(view);
}
function propFieldControl(view: PropControlState) {
  const { field, value, slotOptions, assetContext, linkContext, name, type, isSet, valueText, assetBinding, showExpr, isExpr, isMediaAttr } = view;
  if (showExpr) {
    return <BindingControl state={view} />;
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
  if (isHrefName(name) && !isExpr && linkContext && (type === 'string' || type === 'other')) {
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
