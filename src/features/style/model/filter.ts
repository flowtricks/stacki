// i18n-ignore-file: the labels are English next to their `labelKey`, which the panel translates; the rest of the file holds no interface text.
// `filter` / `backdrop-filter` are a SPACE-separated list of filter functions
// (blur/brightness/…/drop-shadow). We model each as one editable layer and
// parse/serialize back, splitting on TOP-LEVEL spaces so drop-shadow()'s inner
// lengths + rgba() survive. Mirrors lib/transform.ts.

import { ENGLISH_TRANSLATE } from '../../../../shared/properties/i18n/englishTranslator';
import type { MessageKey, Translator } from '../../../../shared/properties/i18n/messageRef';
import { splitTopLevelSpaces } from './background';

export type FilterType = 'blur' | 'brightness' | 'contrast' | 'grayscale' | 'hue-rotate' | 'invert' | 'saturate' | 'sepia' | 'drop-shadow';

/** One filter layer: an amount (for the value filters) OR the drop-shadow fields. */
export type Filter = {
  type: FilterType;
  amount: string; // value filters, e.g. '200%', '4px', '180deg'
  x: string;
  y: string;
  blur: string;
  color: string; // drop-shadow only
};
// One control's edit. Each member names the fields that control owns — an
// explicit update surface rather than `Partial<T>` (AGENTS.md §4).
export type FilterPatch = Pick<Filter, 'amount'> | Pick<Filter, 'x'> | Pick<Filter, 'y'> | Pick<Filter, 'blur'> | Pick<Filter, 'color'>;

export type FilterControl = 'amount' | 'angle' | 'shadow';
export const FILTER_META: Record<
  FilterType,
  { label: string; labelKey: MessageKey; unit: string; min: number; max: number; control: FilterControl; def: string }
> = {
  blur: { label: 'Blur', labelKey: 'styleModel.filter.type.blur', unit: 'px', min: 0, max: 100, control: 'amount', def: '4px' },
  brightness: { label: 'Brightness', labelKey: 'styleModel.filter.type.brightness', unit: '%', min: 0, max: 200, control: 'amount', def: '100%' },
  contrast: { label: 'Contrast', labelKey: 'styleModel.filter.type.contrast', unit: '%', min: 0, max: 200, control: 'amount', def: '100%' },
  saturate: { label: 'Saturation', labelKey: 'styleModel.filter.type.saturate', unit: '%', min: 0, max: 200, control: 'amount', def: '100%' },
  grayscale: { label: 'Grayscale', labelKey: 'styleModel.filter.type.grayscale', unit: '%', min: 0, max: 100, control: 'amount', def: '100%' },
  invert: { label: 'Invert', labelKey: 'styleModel.filter.type.invert', unit: '%', min: 0, max: 100, control: 'amount', def: '100%' },
  sepia: { label: 'Sepia', labelKey: 'styleModel.filter.type.sepia', unit: '%', min: 0, max: 100, control: 'amount', def: '100%' },
  'hue-rotate': {
    label: 'Hue rotate',
    labelKey: 'styleModel.filter.type.hueRotate',
    unit: 'deg',
    min: 0,
    max: 360,
    control: 'angle',
    def: '0deg',
  },
  'drop-shadow': { label: 'Drop shadow', labelKey: 'styleModel.filter.type.dropShadow', unit: 'px', min: 0, max: 100, control: 'shadow', def: '' },
};

// Grouped exactly like Webflow's filter menu.
export const FILTER_GROUPS: ReadonlyArray<{ heading: string; headingKey: MessageKey; types: FilterType[] }> = [
  { heading: 'General', headingKey: 'styleModel.filter.group.general', types: ['blur', 'drop-shadow'] },
  { heading: 'Color adjustments', headingKey: 'styleModel.filter.group.colorAdjustments', types: ['brightness', 'contrast', 'hue-rotate', 'saturate'] },
  { heading: 'Color effects', headingKey: 'styleModel.filter.group.colorEffects', types: ['grayscale', 'invert', 'sepia'] },
];

function isFilterType(value: string): value is FilterType {
  return value in FILTER_META;
}

const DROP_DEFAULT = { x: '0px', y: '2px', blur: '5px', color: 'rgba(0, 0, 0, 0.7)' };
const round = (value: number) => Math.round(value * 100) / 100;

const functionName = (call: string): string => call.slice(0, call.indexOf('(')).trim().toLowerCase();
const innerOf = (call: string): string => {
  const openIndex = call.indexOf('(');
  const closeIndex = call.lastIndexOf(')');
  return openIndex < 0 || closeIndex <= openIndex ? '' : call.slice(openIndex + 1, closeIndex).trim();
};
const isLength = (token: string): boolean => /^-?[\d.]+(px|em|rem|%|vw|vh|vmin|vmax)?$/i.test(token.trim());

// Normalize a value filter's argument to the meta unit: %-filters store a percentage
// (a unitless `1.5` → `150%`), deg-filters store degrees, blur stores px. A value we
// can't parse (var()/calc()) is kept verbatim.
function normalizeAmount(type: FilterType, inner: string): string {
  const meta = FILTER_META[type];
  const match = inner.trim().match(/^(-?[\d.]+)(%|px|deg|rad|turn|grad|em|rem)?$/i);
  if (!match) {
    return inner.trim();
  }
  let amount = parseFloat(match[1] ?? '');
  const unit = (match[2] || '').toLowerCase();
  if (meta.unit === '%') {
    return `${round(unit === '%' ? amount : amount * 100)}%`;
  }
  if (meta.unit === 'deg') {
    if (unit === 'turn') {
      amount *= 360;
    } else if (unit === 'grad') {
      amount *= 0.9;
    } else if (unit === 'rad') {
      amount = (amount * 180) / Math.PI;
    }
    return `${round(amount)}deg`;
  }
  return `${round(amount)}${unit || 'px'}`;
}

/** Parse a `filter` value into ordered layers (`none`/'' → empty). */
export function parseFilters(value: string): Filter[] {
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === 'none') {
    return [];
  }
  const out: Filter[] = [];
  for (const call of splitTopLevelSpaces(trimmed).filter((token) => token.includes('('))) {
    const name = functionName(call);
    if (!isFilterType(name)) {
      continue;
    }
    if (name === 'drop-shadow') {
      const lens: string[] = [];
      let color = '';
      for (const argument of splitTopLevelSpaces(innerOf(call))) {
        if (isLength(argument)) {
          lens.push(argument);
        } else {
          color = argument;
        }
      }
      out.push({
        type: name,
        amount: '',
        x: lens[0] ?? '0px',
        y: lens[1] ?? '0px',
        blur: lens[2] ?? '0px',
        color: color || DROP_DEFAULT.color,
      });
    } else {
      out.push({ ...blankFilter(name), amount: normalizeAmount(name, innerOf(call)) });
    }
  }
  return out;
}

function serializeOne(filter: Filter): string {
  if (filter.type === 'drop-shadow') {
    const x = filter.x.trim() || '0px',
      y = filter.y.trim() || '0px',
      blur = filter.blur.trim() || '0px';
    const color = filter.color.trim() || DROP_DEFAULT.color;
    return `drop-shadow(${x} ${y} ${blur} ${color})`;
  }
  return `${filter.type}(${filter.amount.trim() || FILTER_META[filter.type].def})`;
}

/** Serialize layers back to a `filter` value ('' when empty). */
export function serializeFilters(list: Filter[]): string {
  return list.map(serializeOne).filter(Boolean).join(' ');
}

/** A new layer of `type`, seeded with that type's default. */
export function blankFilter(type: FilterType = 'blur'): Filter {
  return {
    type,
    amount: FILTER_META[type].def,
    x: DROP_DEFAULT.x,
    y: DROP_DEFAULT.y,
    blur: DROP_DEFAULT.blur,
    color: DROP_DEFAULT.color,
  };
}

/** Re-type a layer to its new type's default. */
export function retypeFilter(type: FilterType): Filter {
  return blankFilter(type);
}

/** A short label for a collapsed row. */
export function filterLabel(filter: Filter, translate: Translator = ENGLISH_TRANSLATE): string {
  const meta = FILTER_META[filter.type];
  const name = translate(meta.labelKey);
  if (filter.type === 'drop-shadow') {
    const lengths = [filter.x, filter.y, filter.blur].map((length) => length.trim() || '0px');
    return `${name}: ${lengths.join(' ')}`;
  }
  return `${name}: ${filter.amount.trim() || meta.def}`;
}
