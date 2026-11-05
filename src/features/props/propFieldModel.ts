// A prop field's model: what its value means (bound, an asset import, media,
// a number in bounds), the state the field holds, the actions it takes and its
// placeholder (PropField.tsx).

import { PropValuePolicyContext } from './propValuePolicy';
import React, { useContext, useEffect, useRef, useState } from 'react';
import type { ComponentProps } from 'react';
import type { Attr } from '../../../shared/page/pageNode';
import type { PageText } from '../../../shared/properties/pageText';
import type { FieldDefinition, PropValues } from './propRules';
import type { RichContext } from './RichContent';
import type { SourceContext, ValueChange, FieldPosition, FieldPickerAt, InsertAPI } from './propBindings';
import type { AssetDimensions } from '../../ui/AssetThumb';
import type { PickedAsset } from '../../ui/AssetField';
import { assert } from '../../../shared/core/assert';
import { LIMITS } from '../../../shared/core/limits';
import { findImportOf } from '../../editor/dataSuggest';
import { isHrefName, isMediaName } from '../../editor/fieldNames';
import { arrayItems, objectFields } from './arrayValue';
import { optionAttr } from './propKinds';
import { deprecationOf, readPropDocumentation } from '../../editor/propDocumentation';
import LinkField from './LinkField';

export interface AssetContext {
  readonly layoutText?: PageText | undefined;
  readonly layoutImage?: string | undefined;
  readonly layoutType?: string | undefined;
  readonly projectPath?: string | undefined;
  readonly filePath?: string | undefined;
  readonly nodeName?: string | undefined;
  readonly srcDims?: AssetDimensions | undefined;
  readonly siblingProps?: PropValues | undefined;
  readonly srcKind?: 'svg' | 'public' | 'asset' | 'remote' | undefined;
  readonly onPickAsset?: ((name: string, picked: PickedAsset) => void) | false | undefined;
  readonly onPickDimensions?: ((name: string, dimensions: AssetDimensions) => void) | undefined;
  readonly onSrcDimensions?: ((dimensions: AssetDimensions) => void) | undefined;
}
export interface AssetBinding {
  readonly ident: string;
  readonly spec: string;
}
export interface AssetImportFieldProps {
  readonly binding: AssetBinding;
  readonly name: string;
  readonly assetContext: AssetContext;
  readonly onChange: ValueChange;
}
export interface PropFieldProps {
  readonly field: FieldDefinition;
  readonly branchDefault?: string | number | undefined;
  readonly value?: Attr | undefined;
  readonly nodeKey?: string | undefined;
  readonly bindContext?: RichContext | undefined;
  readonly slotOptions?: readonly string[] | undefined;
  readonly projectClasses?: readonly string[] | undefined;
  readonly assetContext?: AssetContext | undefined;
  readonly linkContext?: ComponentProps<typeof LinkField>['context'] | undefined;
  readonly dataContext?: SourceContext | undefined;
  readonly onChange: ValueChange;
}
export function attrText(value: Attr | undefined): string | undefined {
  return value?.type === 'bare' ? undefined : value?.value;
}

// What a name says a field holds lives in one place, shared with the new
// property form and a list's item editor (fieldNames.ts).
export { isHrefName, isMediaName, MEDIA_WORDS, mediaWord } from '../../editor/fieldNames';

export const MEDIA_IMPORT_RE = /\.(png|jpe?g|gif|webp|avif|svg|ico|bmp|mp4|webm|mov|m4v|ogg|mp3|wav)(\?.*)?$/i;

export function assetImportOf(expr: unknown, frontmatter: unknown) {
  const match = String(expr ?? '')
    .trim()
    .match(/^([A-Za-z_$][\w$]*)(?:\.src)?$/);
  if (!match || !frontmatter) {
    return undefined;
  }
  const imported = findImportOf(frontmatter, match[1]);
  if (!imported || !MEDIA_IMPORT_RE.test(imported.spec)) {
    return undefined;
  }
  return { ident: match[1] ?? '', spec: imported.spec };
}

export function boundsHint(field: FieldDefinition) {
  const { min, max, step, minExclusive, maxExclusive } = field;
  const parts = [];
  if (min !== undefined && max !== undefined) {
    parts.push(`${minExclusive ? '>' : ''}${min}–${maxExclusive ? '<' : ''}${max}`);
  } else if (min !== undefined) {
    parts.push(minExclusive ? `greater than ${min}` : `${min} or more`);
  } else if (max !== undefined) {
    parts.push(maxExclusive ? `less than ${max}` : `${max} or less`);
  }
  if (step === 1) {
    parts.push('whole numbers');
  } else if (step !== undefined) {
    parts.push(`steps of ${step}`);
  }
  return parts.length ? `Accepts ${parts.join(', ')}` : undefined;
}

export function isBoundValue(field: FieldDefinition, value: Attr | undefined) {
  if (!value || value.type !== 'expr') {
    return false;
  }
  const source = String(value.value).trim();
  if (field.type === 'boolean') {
    return !/^(true|false)$/.test(source);
  }
  if (field.type === 'number') {
    return !/^[-+]?(\d+\.?\d*|\.\d+)$/.test(source);
  }
  if (field.type === 'enum') {
    return !(field.options || []).includes(source);
  }
  // A list of plain items is a list, and the list control writes exactly that.
  // Anything else an array prop can hold — a name, a spread, an object per item
  // — is a program, and the code editor is the only field that can show one.
  // An object of simple fields is the same: the object control writes it.
  if (field.type === 'code' && field.codeKind === 'object') {
    return objectFields(source) === undefined;
  }
  if (field.type === 'code') {
    return arrayItems(source) === undefined;
  }
  return true;
}

export function valueFromExpr(field: FieldDefinition, raw: string): Attr | undefined {
  const source = String(raw ?? '').trim();
  const quoted = source.match(/^(['"])((?:[^\\]|\\.)*)\1$/);
  if (quoted) {
    if (field.type === 'boolean' || field.type === 'number') {
      return undefined;
    }
    const text = (quoted[2] ?? '').replace(/\\n/g, '\n').replace(/\\(['"\\])/g, '$1');
    return field.type === 'enum' && !(field.options || []).includes(text) ? undefined : { type: 'string', value: text };
  }
  if (field.type === 'boolean') {
    return /^(true|false)$/.test(source) ? { type: 'expr', value: source } : undefined;
  }
  if (field.type === 'number') {
    return /^[-+]?(\d+\.?\d*|\.\d+)$/.test(source) ? { type: 'expr', value: source } : undefined;
  }
  if (field.type === 'enum') {
    return (field.options || []).includes(source) ? optionAttr(field, source) : undefined;
  }
  if (field.type === 'code' && field.codeKind === 'object') {
    return objectFields(source) ? { type: 'expr', value: source } : undefined;
  }
  // An array of plain items survives the trip: the list can show it, so going
  // back to the control keeps the value rather than dropping the prop.
  if (field.type === 'code' && arrayItems(source)) {
    return { type: 'expr', value: source };
  }
  return undefined;
}

export function controlWord(field: FieldDefinition) {
  if (field.type === 'boolean') {
    return 'toggle';
  }
  if (field.type === 'code' && field.codeKind === 'object') {
    return 'fields';
  }
  if (field.type === 'code') {
    return 'list';
  }
  if (field.type === 'enum' && field.options?.length) {
    return 'options list';
  }
  if (field.type === 'style') {
    return 'CSS editor';
  }
  if (isMediaName(field.name)) {
    return 'asset picker';
  }
  if (isHrefName(field.name)) {
    return 'link settings';
  }
  return 'normal field';
}
export function usePropField(props: PropFieldProps) {
  const state = usePropFieldModel(props);
  return { ...state, ...propFieldActions(state) };
}
export function usePropFieldModel(props: PropFieldProps) {
  const policy = useContext(PropValuePolicyContext);
  // Choice controls show the effective fallback while isSet tracks authored values.
  const showsFallback = ['boolean', 'enum'].includes(props.field.type);
  const field = policy === 'defaults' && !showsFallback ? { ...props.field, default: undefined, hint: '' } : props.field;
  const {
    branchDefault,
    value,
    nodeKey,

    assetContext,

    dataContext,
  } = props;
  const placeholderFor = (target: FieldDefinition) =>
    policy === 'defaults' && !showsFallback ? '' : propFieldPlaceholder(target, assetContext, branchDefault);
  const { name, type } = field;
  const isSet = value !== undefined;
  const [menuPosition, setMenuPosition] = useState<FieldPosition | undefined>(undefined);
  const lastGoodRef = useRef('');
  const [custom, setCustomState] = useState(false);
  // Why the field stayed on its code after "use the control" was asked for:
  // code the control cannot show is kept as written rather than dropped.
  const [customProblem, setCustomProblem] = useState<string | undefined>(undefined);
  const setCustom = (next: boolean): void => {
    setCustomState(next);
    setCustomProblem(undefined);
  };
  const [insertAt, setInsertAt] = useState<FieldPickerAt | undefined>(undefined);
  // A ref prop: BindField fills it with its caret API while it is mounted.
  const bindApiRef = useRef<InsertAPI | undefined>(undefined);
  useEffect(() => {
    setCustomState(false);
    setCustomProblem(undefined);
  }, [nodeKey, name]);
  // An action is set in code only; there is nothing a binding could give it.
  const bindable = type !== 'attrs' && name !== 'slot' && field.codeKind !== 'function';
  const valueText = attrText(value) ?? '';
  const assetBinding = assetImportOf(valueText, dataContext?.imports);
  const shownAsAsset = value?.type === 'expr' && assetBinding && assetContext?.projectPath && assetContext?.filePath;
  const showExpr = bindable && (custom || (isBoundValue(field, value) && !shownAsAsset));
  const reason =
    !/^(quality|format|formats|fallbackFormat|densities|widths|sizes)$/i.test(name) || !assetContext?.srcKind
      ? undefined
      : assetContext.srcKind === 'svg'
        ? 'SVG sources are passed through unoptimized, so this has no effect.'
        : assetContext.srcKind === 'public'
          ? 'Files in public/ are served as-is — import from src/assets to optimize.'
          : undefined;
  assert(valueText.length <= LIMITS.attrCharsMax, 'PropField: value limit exceeded');
  assert((field.options?.length ?? 0) <= LIMITS.propOptionsMax, 'PropField: option limit exceeded');
  const isExpr = value?.type === 'expr' || (type === 'code' && value?.type !== 'string');
  // An Image prop (its default imports a file, `image = placeholder`) is
  // media whatever it is called; otherwise its name says so.
  const isMediaAttr = isMediaName(name) || field.defaultAsset !== undefined;
  // Required and its note are an instance's concern: a defaults recipe or a
  // CMS entry states its own obligations (remoteCms.css marks those).
  const required = policy === 'instance' && isRequiredField(props.field, branchDefault);
  const missingRequired = required && !isSet && !spreadsProps(assetContext?.siblingProps);
  const deprecated = fieldDeprecation(props.field);
  const isColor = isColorField(props.field);
  return {
    ...props,
    field,
    name,
    type,
    isSet,
    menuPosition,
    setMenuPosition,
    lastGoodRef,
    custom,
    setCustom,
    customProblem,
    setCustomProblem,
    insertAt,
    setInsertAt,
    bindApiRef,
    bindable,
    valueText,
    assetBinding,
    shownAsAsset,
    showExpr,
    reason,
    placeholderFor,
    isExpr,
    isMediaAttr,
    required,
    missingRequired,
    deprecated,
    isColor,
  };
}

/**
 * A prop the component cannot do without: declared without `?` and with no
 * default, neither its own nor its variant's. A destructure default makes the
 * runtime fine, so it is not flagged (docs/plans/prop-controls.md §7.1).
 * Element attributes leave `optional` unset and are never required.
 */
export function isRequiredField(field: FieldDefinition, branchDefault: string | number | undefined): boolean {
  if (field.optional !== false) {
    return false;
  }
  if (field.default !== undefined) {
    return false;
  }
  if (field.defaultExpr === true) {
    return false;
  }
  return branchDefault === undefined;
}

// A spread (`{...rest}`) on the instance may well carry any prop, so a missing
// one is not reported as missing.
function spreadsProps(siblings: PropValues | undefined): boolean {
  const values = Object.values(siblings ?? {});
  assert(values.length <= LIMITS.attrsPerNodeMax, 'spreadsProps: attribute limit exceeded');
  return values.some((sibling) => sibling?.type === 'spread');
}

/**
 * A prop's `@deprecated` text ('' for the bare tag), or undefined. The schema
 * states it when the prop model read it; a schema from elsewhere (a CMS, an
 * older scan) still has the tag in its doc comment.
 */
export function fieldDeprecation(field: FieldDefinition): string | undefined {
  return field.deprecated ?? deprecationOf(field.doc);
}

// A literal colour: hex, a colour function, or a CSS variable (a token).
const COLOR_HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const COLOR_FUNCTION = /^(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^()]*\)$/i;
const COLOR_VARIABLE = /^var\(--[\w-]+(?:\s*,[^()]*)?\)$/;
const COLOR_NAME = /(?:^|[a-z])colou?r$/i;

/** Whether text is a CSS colour a swatch can be painted with, or a token that names one. */
export function isColorText(text: string): boolean {
  const value = text.trim();
  assert(value.length <= LIMITS.attrCharsMax, 'isColorText: value limit exceeded');
  return COLOR_HEX.test(value) || COLOR_FUNCTION.test(value) || COLOR_VARIABLE.test(value);
}

/**
 * A text prop that holds a colour: typed so by its Kind (`@format color`), or
 * named for one (`color`, `accentColour`) with a colour for its default. The
 * name alone is not enough — `color="primary"` is a word, not a colour.
 */
export function isColorField(field: FieldDefinition): boolean {
  if (field.type !== 'string' && field.type !== 'other') {
    return false;
  }
  if (readPropDocumentation(field.doc).format === 'color') {
    return true;
  }
  if (!COLOR_NAME.test(field.name)) {
    return false;
  }
  return typeof field.default === 'string' && isColorText(field.default);
}
export function propFieldActions(state: ReturnType<typeof usePropFieldModel>) {
  const { setMenuPosition, onChange, setCustom, setCustomProblem, value, field, isSet, showExpr } = state;
  const reset = () => {
    setMenuPosition(undefined);
    onChange(undefined, true);
  };
  const fromCustom = () => {
    setMenuPosition(undefined);
    if (value?.type !== 'expr') {
      setCustom(false);
      return;
    }
    const back = valueFromExpr(field, value.value);
    if (back === undefined && value.value.trim() !== '') {
      // The control cannot hold this code: going back to it used to drop the
      // value. It stays as code, and the field says why.
      setCustomProblem(`The ${controlWord(field)} cannot show this code, so it stays as code. Change it to a value the ${controlWord(field)} can hold first.`);
      return;
    }
    setCustom(false);
    onChange(back, true);
  };
  const onLabelClick = (event: React.MouseEvent<HTMLSpanElement>) => {
    // A field switched to a value has something to offer even before anything
    // is set: the way back to its control.
    if (!isSet && !showExpr) {
      return;
    }
    if (event.altKey) {
      reset();
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    setMenuPosition({ left: rect.left, top: rect.bottom + 4 });
  };
  // The label's context menu is the same menu, opened where the click was.
  const onLabelContextMenu = (event: React.MouseEvent<HTMLSpanElement>) => {
    if (!isSet && !showExpr) {
      return;
    }
    event.preventDefault();
    setMenuPosition({ left: event.clientX, top: event.clientY });
  };
  return { reset, fromCustom, onLabelClick, onLabelContextMenu };
}
export type PropState = ReturnType<typeof usePropField>;
export type PropControlState = PropState & {
  readonly label: React.ReactNode;
  readonly pill: React.ReactNode;
  readonly menu: React.ReactNode;
};
export function propFieldPlaceholder(field: FieldDefinition, assetContext: AssetContext | undefined, branchDefault: string | number | undefined): string {
  // Rendered layout metadata resolves delegated and CMS defaults that source hints cannot.
  if (field.name === 'title' || field.name === 'description') {
    const rendered = assetContext?.layoutText?.[field.name];
    if (rendered !== undefined) {
      return rendered;
    }
  }
  const siblingNumber = (propName: string) => {
    const sibling = assetContext?.siblingProps?.[propName];
    if (!sibling) {
      return undefined;
    }
    const parsed = parseFloat(attrText(sibling) ?? '');
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  };

  if (field.default !== undefined) {
    return String(field.default);
  }
  if (branchDefault !== undefined) {
    return String(branchDefault);
  }
  const dimensions = assetContext?.srcDims;
  if (dimensions) {
    const isWidth = /^width$/i.test(field.name);
    const isHeight = /^height$/i.test(field.name);
    if ((isWidth || isHeight) && dimensions.w && dimensions.h) {
      // Setting one dimension makes the other follow the source's aspect
      // ratio — that, not the asset's own size, is what leaving this field
      // empty now means.
      const other = siblingNumber(isWidth ? 'height' : 'width');
      if (other) {
        const ratio = isWidth ? dimensions.w / dimensions.h : dimensions.h / dimensions.w;
        return String(Math.round(other * ratio));
      }
    }
    if (isWidth && dimensions.w) {
      return String(dimensions.w);
    }
    if (isHeight && dimensions.h) {
      return String(dimensions.h);
    }
  }
  return field.hint || '';
}

export function numberControlBounds(field: FieldDefinition) {
  const { min, max, step: grain, minExclusive, maxExclusive } = field;
  const bounded = min !== undefined || max !== undefined || grain !== undefined;
  const allows = (candidate: number) => {
    if (!Number.isFinite(candidate)) {
      return false;
    }
    if (min !== undefined && (minExclusive ? candidate <= min : candidate < min)) {
      return false;
    }
    if (max !== undefined && (maxExclusive ? candidate >= max : candidate > max)) {
      return false;
    }
    // Rounded before comparing, or 0.1 + 0.2 fails a step of 0.1.
    if (grain !== undefined && Math.abs(Math.round(candidate / grain) * grain - candidate) > 1e-9) {
      return false;
    }
    return true;
  };
  const clamp = (input: number) => {
    let clamped = input;
    if (grain !== undefined) {
      clamped = Math.round(clamped / grain) * grain;
    }
    if (min !== undefined) {
      clamped = Math.max(clamped, minExclusive ? min + (grain ?? 1e-6) : min);
    }
    if (max !== undefined) {
      clamped = Math.min(clamped, maxExclusive ? max - (grain ?? 1e-6) : max);
    }
    return Math.round(clamped * 1e6) / 1e6;
  };
  return { bounded, allows, clamp };
}

/** A colour as the six-digit hex the platform picker takes, or undefined when it is not a hex colour. */
export function hexOfColor(text: string): string | undefined {
  const match = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(text.trim()) ?? undefined;
  const digits = match?.[1];
  if (digits === undefined) {
    return undefined;
  }
  const full = digits.length <= 4 ? [...digits.slice(0, 3)].map((digit) => digit + digit).join('') : digits.slice(0, 6);
  assert(full.length === 6, 'hexOfColor: six digits');
  return `#${full.toLowerCase()}`;
}
