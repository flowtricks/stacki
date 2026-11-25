// How the phone preview's popover writes the network address: without the scheme a phone does not need
// typed (`192.168.4.135:48781/blog`), on one line. The host and port are what a person reads back to check
// the address, so they are always whole; a long page path gives way in its middle (`/blog/…/post`), which
// keeps where it starts and where it ends. Copying always copies the full URL, never this text.
import { assert } from '../../../../shared/core/assert';

/** The most characters shown: what one line of the popover's code holds at its fixed width. */
export const PHONE_ADDRESS_CHARS_MAX = 23;
const ELLIPSIS = '…';

/** The shown address for `url` (an http URL the popover built), at most `charsMax` characters unless the host itself is longer. */
export function phoneAddressText(url: string, charsMax: number = PHONE_ADDRESS_CHARS_MAX): string {
  assert(Number.isSafeInteger(charsMax), 'phoneAddressText: the bound is an integer');
  assert(charsMax >= 8, 'phoneAddressText: the bound holds an address');
  const parsed = new URL(url);
  const host = parsed.host;
  const path = `${parsed.pathname}${parsed.search}`;
  const whole = `${host}${path}`;
  if (whole.length <= charsMax) {
    return whole;
  }
  // The room left for the path once the host is whole; at least "/…", so a long host still leaves one line.
  const pathRoom = Math.max(charsMax - host.length, 2);
  const kept = pathRoom - ELLIPSIS.length;
  const head = Math.ceil(kept / 2);
  const tail = Math.floor(kept / 2);
  const shown = `${host}${path.slice(0, head)}${ELLIPSIS}${path.slice(path.length - tail)}`;
  assert(shown.startsWith(host), 'phoneAddressText: the host is always whole');
  return shown;
}
