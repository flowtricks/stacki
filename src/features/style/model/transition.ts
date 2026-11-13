// i18n-ignore-file: property names and groups are English next to their `labelKey`/`headingKey`, which the panel translates.
// The `transition` property is a comma-separated list of transitions, each
// `<property> <duration> <timing-function> <delay>` (property first, the two times
// in order). We parse it into an ordered list (index 0 = first) and serialize back,
// splitting on TOP-LEVEL commas/spaces so cubic-bezier()/steps() survive.

import { ENGLISH_TRANSLATE } from '../../../../shared/properties/i18n/englishTranslator';
import type { MessageKey, Translator } from '../../../../shared/properties/i18n/messageRef';
import { splitTopLevelCommas, splitTopLevelSpaces } from './background';

export type Transition = { property: string; duration: string; timing: string; delay: string };
// One control's edit. Each member names the fields that control owns — an
// explicit update surface rather than `Partial<T>` (AGENTS.md §4).
export type TransitionPatch = Pick<Transition, 'property'> | Pick<Transition, 'duration'> | Pick<Transition, 'timing'>;

// `label` is the English text (search, logs); `labelKey` is what the panel translates.
export type TransitionProp = { value: string; label: string; labelKey: MessageKey };

// Webflow's grouped Type dropdown — label shown, CSS property written.
export const TRANSITION_GROUPS: ReadonlyArray<{
  heading: string;
  headingKey: MessageKey;
  items: ReadonlyArray<TransitionProp>;
}> = [
  {
    heading: 'Common',
    headingKey: 'styleModel.transition.group.common',
    items: [
      { value: 'opacity', label: 'Opacity', labelKey: 'styleModel.transition.prop.opacity' },
      { value: 'margin', label: 'Margin', labelKey: 'styleModel.transition.prop.margin' },
      { value: 'padding', label: 'Padding', labelKey: 'styleModel.transition.prop.padding' },
      { value: 'border', label: 'Border', labelKey: 'styleModel.transition.prop.border' },
      { value: 'transform', label: 'Transform', labelKey: 'styleModel.transition.prop.transform' },
      { value: 'filter', label: 'Filter', labelKey: 'styleModel.transition.prop.filter' },
      { value: 'flex', label: 'Flex', labelKey: 'styleModel.transition.prop.flex' },
    ],
  },
  {
    heading: 'Background',
    headingKey: 'styleModel.transition.group.background',
    items: [
      { value: 'background-color', label: 'Background Color', labelKey: 'styleModel.transition.prop.backgroundColor' },
      { value: 'background-position', label: 'Background Position', labelKey: 'styleModel.transition.prop.backgroundPosition' },
      { value: 'text-shadow', label: 'Text Shadow', labelKey: 'styleModel.transition.prop.textShadow' },
      { value: 'box-shadow', label: 'Box Shadow', labelKey: 'styleModel.transition.prop.boxShadow' },
    ],
  },
  {
    heading: 'Size',
    headingKey: 'styleModel.transition.group.size',
    items: [
      { value: 'width', label: 'Width', labelKey: 'styleModel.transition.prop.width' },
      { value: 'height', label: 'Height', labelKey: 'styleModel.transition.prop.height' },
      { value: 'max-height', label: 'Max Height', labelKey: 'styleModel.transition.prop.maxHeight' },
      { value: 'max-width', label: 'Max Width', labelKey: 'styleModel.transition.prop.maxWidth' },
      { value: 'min-height', label: 'Min Height', labelKey: 'styleModel.transition.prop.minHeight' },
      { value: 'min-width', label: 'Min Width', labelKey: 'styleModel.transition.prop.minWidth' },
    ],
  },
  {
    heading: 'Borders',
    headingKey: 'styleModel.transition.group.borders',
    items: [
      { value: 'border-radius', label: 'Border Radius', labelKey: 'styleModel.transition.prop.borderRadius' },
      { value: 'border-color', label: 'Border Color', labelKey: 'styleModel.transition.prop.borderColor' },
      { value: 'border-width', label: 'Border Width', labelKey: 'styleModel.transition.prop.borderWidth' },
    ],
  },
  {
    heading: 'Typography',
    headingKey: 'styleModel.transition.group.typography',
    items: [
      { value: 'color', label: 'Font Color', labelKey: 'styleModel.transition.prop.color' },
      { value: 'font-size', label: 'Font Size', labelKey: 'styleModel.transition.prop.fontSize' },
      { value: 'line-height', label: 'Line Height', labelKey: 'styleModel.transition.prop.lineHeight' },
      { value: 'letter-spacing', label: 'Letter Spacing', labelKey: 'styleModel.transition.prop.letterSpacing' },
      { value: 'text-indent', label: 'Text Indent', labelKey: 'styleModel.transition.prop.textIndent' },
      { value: 'word-spacing', label: 'Word Spacing', labelKey: 'styleModel.transition.prop.wordSpacing' },
      { value: 'font-variation-settings', label: 'Font Variations', labelKey: 'styleModel.transition.prop.fontVariationSettings' },
      { value: '-webkit-text-stroke-color', label: 'Text Stroke Color', labelKey: 'styleModel.transition.prop.webkitTextStrokeColor' },
      { value: 'text-underline-offset', label: 'Text Underline Offset', labelKey: 'styleModel.transition.prop.textUnderlineOffset' },
      { value: 'text-decoration-color', label: 'Text Decoration Color', labelKey: 'styleModel.transition.prop.textDecorationColor' },
    ],
  },
  {
    heading: 'Position',
    headingKey: 'styleModel.transition.group.position',
    items: [
      { value: 'top', label: 'Top', labelKey: 'styleModel.transition.prop.top' },
      { value: 'left', label: 'Left', labelKey: 'styleModel.transition.prop.left' },
      { value: 'bottom', label: 'Bottom', labelKey: 'styleModel.transition.prop.bottom' },
      { value: 'right', label: 'Right', labelKey: 'styleModel.transition.prop.right' },
      { value: 'z-index', label: 'z-Index', labelKey: 'styleModel.transition.prop.zIndex' },
    ],
  },
  {
    heading: 'Margin',
    headingKey: 'styleModel.transition.group.margin',
    items: [
      { value: 'margin-bottom', label: 'Margin Bottom', labelKey: 'styleModel.transition.prop.marginBottom' },
      { value: 'margin-left', label: 'Margin Left', labelKey: 'styleModel.transition.prop.marginLeft' },
      { value: 'margin-right', label: 'Margin Right', labelKey: 'styleModel.transition.prop.marginRight' },
      { value: 'margin-top', label: 'Margin Top', labelKey: 'styleModel.transition.prop.marginTop' },
    ],
  },
  {
    heading: 'Padding',
    headingKey: 'styleModel.transition.group.padding',
    items: [
      { value: 'padding-bottom', label: 'Padding Bottom', labelKey: 'styleModel.transition.prop.paddingBottom' },
      { value: 'padding-left', label: 'Padding Left', labelKey: 'styleModel.transition.prop.paddingLeft' },
      { value: 'padding-right', label: 'Padding Right', labelKey: 'styleModel.transition.prop.paddingRight' },
      { value: 'padding-top', label: 'Padding Top', labelKey: 'styleModel.transition.prop.paddingTop' },
    ],
  },
  {
    heading: 'Flex',
    headingKey: 'styleModel.transition.group.flex',
    items: [
      { value: 'flex-grow', label: 'Flex Grow', labelKey: 'styleModel.transition.prop.flexGrow' },
      { value: 'flex-shrink', label: 'Flex Shrink', labelKey: 'styleModel.transition.prop.flexShrink' },
      { value: 'flex-basis', label: 'Flex Basis', labelKey: 'styleModel.transition.prop.flexBasis' },
    ],
  },
  {
    heading: 'Advanced',
    headingKey: 'styleModel.transition.group.advanced',
    items: [{ value: 'all', label: 'All Properties', labelKey: 'styleModel.transition.prop.all' }],
  },
];

const PROP_LABEL_KEY = new Map(TRANSITION_GROUPS.flatMap((group) => group.items).map((i) => [i.value, i.labelKey]));
export function transitionPropLabel(prop: string, translate: Translator = ENGLISH_TRANSLATE): string {
  const key = PROP_LABEL_KEY.get(prop.trim().toLowerCase());
  return key === undefined ? prop.trim() : translate(key);
}

const TIMING_KEYWORDS = new Set(['ease', 'linear', 'ease-in', 'ease-out', 'ease-in-out', 'step-start', 'step-end']);
function isTiming(token: string): boolean {
  const normalized = token.trim().toLowerCase();
  return TIMING_KEYWORDS.has(normalized) || normalized.startsWith('cubic-bezier(') || normalized.startsWith('steps(');
}
function isTime(token: string): boolean {
  return /^-?[\d.]+m?s$/i.test(token.trim());
}

/** Parse a `transition` value into an ordered list ('' / 'none' → empty).
 *  Positional (matching our serialize order property → duration → timing → delay) so
 *  that typed keywords/var() survive in the duration and easing slots: a bare `unset`
 *  or `var(--x)` isn't a recognized <time> or <easing>, so the old token-role scan
 *  dropped it — here we key off position instead. */
export function parseTransitions(value: string): Transition[] {
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === 'none') {
    return [];
  }
  return splitTopLevelCommas(trimmed)
    .filter(Boolean)
    .map((part) => {
      const tokens = splitTopLevelSpaces(part)
        .map((token) => token.trim())
        .filter(Boolean);
      // A leading token that's neither a time nor an easing is the property. Our own
      // output always leads with it; external CSS may omit it (defaults to `all`).
      let property = 'all';
      let rest = tokens;
      const firstToken = tokens[0];
      if (firstToken !== undefined && !isTime(firstToken) && !isTiming(firstToken)) {
        property = firstToken;
        rest = tokens.slice(1);
      }
      // Next comes the duration — a <time>, or a typed keyword/var() we keep verbatim.
      // (An easing keyword here means the duration was omitted.) After the duration, a
      // <time> is the delay and anything else is the easing.
      let duration = '0s';
      const firstRest = rest[0];
      if (firstRest !== undefined && !isTiming(firstRest)) {
        duration = firstRest;
        rest = rest.slice(1);
      }
      let timing = '';
      let delay = '';
      for (const token of rest) {
        if (isTime(token)) {
          delay = token;
        } else {
          timing = token;
        }
      }
      return { property, duration, delay, timing };
    });
}

/** Serialize a transition list back to a `transition` value ('' when empty). */
export function serializeTransitions(list: Transition[]): string {
  if (!list.length) {
    return '';
  }
  return list
    .map((token) => [token.property || 'all', token.duration || '0s', token.timing, token.delay].filter((part) => part && part.trim()).join(' '))
    .join(', ');
}

export function blankTransition(): Transition {
  return { property: 'opacity', duration: '200ms', timing: 'ease', delay: '' };
}

/** A collapsed-row label ("Opacity: 200ms"). */
export function transitionLabel(transition: Transition, translate: Translator = ENGLISH_TRANSLATE): string {
  return `${transitionPropLabel(transition.property, translate)}: ${transition.duration || '0s'}`;
}

// ─────────────────────────── Easing ───────────────────────────

/** The four cubic-bezier control values for a timing-function keyword or cubic-bezier(). */
/**
 * Is this a timing function the curve editor can open?
 *
 * Deliberately narrow: the five keywords and a well-formed `cubic-bezier()`,
 * which are exactly what a bezier curve can express and round-trip. `steps(4,
 * end)` and `linear(0, 0.5 50%, 1)` are timing functions too, and opening a
 * curve editor on one would quietly rewrite it as a bezier — so they are left
 * alone rather than mangled.
 */
export function isEasing(value: string): boolean {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase();
  if (/^(?:ease|linear|ease-in|ease-out|ease-in-out)$/.test(normalized)) {
    return true;
  }
  return /^cubic-bezier\(\s*[\d.-]+\s*,\s*[\d.-]+\s*,\s*[\d.-]+\s*,\s*[\d.-]+\s*\)$/.test(normalized);
}

export function easingToBezier(timing: string): [number, number, number, number] {
  const normalized = timing.trim().toLowerCase();
  const named: Record<string, [number, number, number, number]> = {
    ease: [0.25, 0.1, 0.25, 1],
    linear: [0, 0, 1, 1],
    'ease-in': [0.42, 0, 1, 1],
    'ease-out': [0, 0, 0.58, 1],
    'ease-in-out': [0.42, 0, 0.58, 1],
  };
  if (named[normalized]) {
    return named[normalized];
  }
  const match = normalized.match(/^cubic-bezier\(\s*([\d.-]+)\s*,\s*([\d.-]+)\s*,\s*([\d.-]+)\s*,\s*([\d.-]+)\s*\)$/);
  if (match) {
    return [parseFloat(match[1] ?? ''), parseFloat(match[2] ?? ''), parseFloat(match[3] ?? ''), parseFloat(match[4] ?? '')];
  }
  return [0.25, 0.1, 0.25, 1]; // fall back to ease
}

const round = (value: number) => Math.round(value * 1000) / 1000;
/** Serialize four bezier values to a timing-function, collapsing to a keyword when exact. */
export function bezierToEasing([x1, y1, x2, y2]: [number, number, number, number]): string {
  const key = `${round(x1)},${round(y1)},${round(x2)},${round(y2)}`;
  const keywords: Record<string, string> = {
    '0.25,0.1,0.25,1': 'ease',
    '0,0,1,1': 'linear',
    '0.42,0,1,1': 'ease-in',
    '0,0,0.58,1': 'ease-out',
    '0.42,0,0.58,1': 'ease-in-out',
  };
  return keywords[key] ?? `cubic-bezier(${round(x1)}, ${round(y1)}, ${round(x2)}, ${round(y2)})`;
}
