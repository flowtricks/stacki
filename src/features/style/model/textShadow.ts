// text-shadow is a comma-separated list of shadows, each `<x> <y> <blur>? <color>?`
// (offset-x, offset-y, blur — color may lead or trail). We parse it into an ordered
// list (index 0 = the first/top shadow) and serialize back, splitting on TOP-LEVEL
// commas/spaces only so rgba()/hsl()/var() with inner separators survive.

import { ENGLISH_TRANSLATE } from '../../../../shared/properties/i18n/englishTranslator';
import type { Translator } from '../../../../shared/properties/i18n/messageRef';
import { splitTopLevelCommas, splitTopLevelSpaces } from './background';

export type Shadow = { x: string; y: string; blur: string; color: string };

/** A token that reads as a length (a number with an optional CSS unit). */
function isLength(token: string): boolean {
  return /^-?[\d.]+(px|em|rem|%|vw|vh|vmin|vmax|ch|ex|cqw|cqh|cqi|cqb)?$/i.test(token.trim());
}

/** Parse a `text-shadow` value into an ordered shadow list (`none`/'' → empty). */
export function parseShadows(value: string): Shadow[] {
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === 'none') {
    return [];
  }
  return splitTopLevelCommas(trimmed)
    .filter(Boolean)
    .map((part) => {
      const lengths: string[] = [];
      let color = '';
      for (const token of splitTopLevelSpaces(part)) {
        if (isLength(token)) {
          lengths.push(token);
        } else {
          color = color ? `${color} ${token}` : token;
        }
      }
      return {
        x: lengths[0] ?? '0px',
        y: lengths[1] ?? '0px',
        blur: lengths[2] ?? '0px',
        color: color || 'rgba(0, 0, 0, 0.2)',
      };
    });
}

/** Serialize a shadow list back to a `text-shadow` value ('' when empty). */
export function serializeShadows(shadows: Shadow[]): string {
  if (!shadows.length) {
    return '';
  }
  return shadows.map((shadow) => `${shadow.x || '0px'} ${shadow.y || '0px'} ${shadow.blur || '0px'}` + (shadow.color ? ` ${shadow.color}` : '')).join(', ');
}

/** A new shadow with Webflow-like defaults. */
export function blankShadow(): Shadow {
  return { x: '0px', y: '1px', blur: '1px', color: 'rgba(0, 0, 0, 0.2)' };
}

/** A short label for a collapsed shadow row ("Text shadow: 0px 1px 1px"). */
export function shadowLabel(shadow: Shadow, translate: Translator = ENGLISH_TRANSLATE): string {
  return translate('styleModel.textShadow.label', { x: shadow.x || '0px', y: shadow.y || '0px', blur: shadow.blur || '0px' });
}
