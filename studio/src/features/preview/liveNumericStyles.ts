import { elementsWithPath } from '../../../vendor/stacki/electron/preload/frameRegions';
import { record, string } from '../../shared/validation';
interface Change {
  readonly path: string;
  readonly marker: string;
  readonly variable: string;
  readonly value: string;
}
const pending = new Map<string, Change>();
export function receiveLiveNumericStyles(input: unknown) {
  try {
    const data = record(input);
    if (data['type'] !== 'studio:live-styles' || !Array.isArray(data['changes'])) {
      return;
    }
    if (data['reset'] === true) {
      pending.clear();
    }
    for (const input of data['changes'].slice(0, 500)) {
      const value = record(input);
      const change = {
        path: string(value['path'], 1000),
        marker: string(value['marker'], 1000),
        variable: string(value['variable'], 110),
        value: string(value['value'], 100),
      };
      if (!/^--[\w-]+$/.test(change.variable) || (change.value && !/^-?[\d.]+(ch|px|rem|em|%|vw|vh)$/.test(change.value))) {
        continue;
      }
      const key = change.path + ':' + change.variable;
      if (pending.size < 500 || pending.has(key)) {
        pending.set(key, change);
      }
    }
    applyLiveNumericStyles();
  } catch {
    /* Invalid parent messages cannot modify styles. */
  }
}
export function applyLiveNumericStyles(rendered?: Document) {
  for (const [key, change] of pending) {
    if (rendered) {
      const matches = [...rendered.querySelectorAll<HTMLElement>('[data-avb-p]')].filter((element) => matchesPath(element, change));
      if (matches.length && matches.every((element) => element.style.getPropertyValue(change.variable).trim() === change.value)) {
        pending.delete(key);
        continue;
      }
    }
    for (const element of elementsWithPath(change.path)) {
      if (!(element instanceof HTMLElement) || !matchesPath(element, change)) {
        continue;
      }
      if (change.value) {
        element.style.setProperty(change.variable, change.value);
      } else {
        element.style.removeProperty(change.variable);
      }
    }
  }
}
function matchesPath(element: Element, change: Change) {
  const paths = element.getAttribute('data-avb-p')?.split(' ') ?? [];
  return paths.includes(change.path) && paths.includes(change.marker);
}
