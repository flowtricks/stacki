// What a colour value resolves to on one element of the page. `var(--background)`
// means nothing in the app's own document, and can mean different things on two
// elements of the same page (a theme class, a container query, a colour scheme).
// Only the page can say, so it is asked: a throwaway span in the element inherits
// its custom properties, takes the value as a colour, and the engine hands back
// the computed one.

import { assert } from '../../shared/core/assert';
import { PROBE_ATTR } from './frameBasics';

const PROBE_STYLE = 'position:absolute;width:0;height:0;visibility:hidden';

/** Each value as the computed colour it is on `host`; undefined for a value that is not a colour. */
export const computeValues = (host: Element, wanted: readonly string[]): Record<string, string | undefined> => {
  const computed: Record<string, string | undefined> = {};
  const probe = createProbe();
  const outermost = attachProbe(host, probe, wanted);
  for (const value of wanted) {
    try {
      // A sentinel first: assigning a value the engine rejects leaves the
      // previous one in place, and reading that back would report a
      // colour the value never had.
      probe.style.color = 'rgb(1, 2, 3)';
      probe.style.color = value;
      computed[value] = probe.style.color === 'rgb(1, 2, 3)' ? undefined : getComputedStyle(probe).color;
    } catch {
      computed[value] = undefined;
    }
  }
  outermost.remove();
  assert(!probe.isConnected, 'computeValues: the probe leaves no trace in the page');
  return computed;
};

function createProbe(): HTMLSpanElement {
  const probe = document.createElement('span');
  probe.setAttribute(PROBE_ATTR, ''); // The canvas's own: no page walk (mutationKind).
  probe.setAttribute('style', PROBE_STYLE);
  return probe;
}

// Puts the probe where the engine computes it and returns the node to remove after.
// A <textarea> or <input> draws its own contents, so a child of one is never
// rendered and every computed value on it is empty: each swatch then fell back to a
// `var()` the panel cannot resolve and showed as transparent. Such a probe goes in a
// sibling standing in for the element instead, carrying what the values read from it.
function attachProbe(host: Element, probe: HTMLSpanElement, wanted: readonly string[]): HTMLElement {
  host.appendChild(probe);
  const parent = host.parentElement;
  if (getComputedStyle(probe).color !== '' || parent === null) {
    return probe;
  }
  const standIn = createProbe();
  const hostStyle = getComputedStyle(host);
  standIn.style.color = hostStyle.color;
  standIn.style.colorScheme = hostStyle.colorScheme;
  for (const [name] of wanted.join(' ').matchAll(/--[\w-]+/g)) {
    standIn.style.setProperty(name, hostStyle.getPropertyValue(name));
  }
  standIn.appendChild(probe);
  host.after(standIn);
  assert(probe.parentElement === standIn, 'attachProbe: the probe moved to the stand-in');
  assert(standIn.parentElement === parent, 'attachProbe: the stand-in sits beside the element');
  return standIn;
}
