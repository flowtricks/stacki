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
import type { SourceContext, ValueChange, FieldPosition, InsertAPI } from './propBindings';
import type { AssetDimensions } from '../../ui/AssetThumb';
import type { PickedAsset } from '../../ui/AssetField';
import { assert } from '../../../shared/core/assert';
import { LIMITS } from '../../../shared/core/limits';
import { findImportOf } from '../../editor/dataSuggest';
import { arrayItems } from './arrayValue';
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

export function isHrefName(name: string) {
  const words = String(name)
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return words[words.length - 1] === 'href';
}

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

export const MEDIA_WORDS = new Set(['src', 'image', 'poster', 'icon', 'logo', 'avatar', 'thumb', 'thumbnail', 'photo', 'banner', 'cover', 'video', 'audio']);

export function mediaWord(name: string) {
  const words = String(name || '')
    .replace(/[-_]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .trim()
    .split(/\s+/);
  return words[words.length - 1] || '';
}

export function isMediaName(name: string) {
  return MEDIA_WORDS.has(mediaWord(name));
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
    return (field.options || []).includes(source) ? { type: field.numeric ? 'expr' : 'string', value: source } : undefined;
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
  const [custom, setCustom] = useState(false);
  const [insertAt, setInsertAt] = useState<FieldPosition | undefined>(undefined);
  // A ref prop: BindField fills it with its caret API while it is mounted.
  const bindApiRef = useRef<InsertAPI | undefined>(undefined);
  useEffect(() => setCustom(false), [nodeKey, name]);
  const bindable = type !== 'attrs' && name !== 'slot';
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
  const isMediaAttr = isMediaName(name);
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
  };
}
export function propFieldActions(state: ReturnType<typeof usePropFieldModel>) {
  const { setMenuPosition, onChange, setCustom, value, field, isSet, showExpr } = state;
  const reset = () => {
    setMenuPosition(undefined);
    onChange(undefined, true);
  };
  const fromCustom = () => {
    setCustom(false);
    if (value?.type === 'expr') {
      onChange(valueFromExpr(field, value.value), true);
    }
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
  return { reset, fromCustom, onLabelClick };
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
