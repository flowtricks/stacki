// Whether a value is one the property will actually accept (via CSS.supports).
// Gates LIVE writes so a half-typed / invalid value is never pushed at Webflow's
// native style API (which errors and gets stuck). var()/custom props pass; fails
// open only when CSS.supports is unavailable.
export function isSupportedCssValue(prop: string, value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  if (typeof CSS === 'undefined' || typeof CSS.supports !== 'function') {
    return true;
  }
  try {
    return CSS.supports(prop, trimmed);
  } catch {
    return false;
  }
}
