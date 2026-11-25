// A breakpoint's name as the person reads it: what they typed, else the built-in Laptop, Tablet or Phone in their language, else its id.
import type { Breakpoint } from '../../shared/properties/projectBreakpoints';
import type { MessageKey, Translator } from './i18n/localeContext';

type BreakpointNameSource = Pick<Breakpoint, 'id' | 'name'>;

const BUILTIN_NAMES: Readonly<Record<string, MessageKey>> = {
  laptop: 'settings.breakpoints.laptop',
  tablet: 'settings.breakpoints.tablet',
  phone: 'settings.breakpoints.phone',
};

export function breakpointLabel(breakpoint: BreakpointNameSource, translate: Translator): string {
  if (breakpoint.name !== undefined) {
    return breakpoint.name;
  }
  const key = BUILTIN_NAMES[breakpoint.id];
  return key === undefined ? breakpoint.id : translate(key);
}
