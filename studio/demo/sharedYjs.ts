// One Yjs for the whole page. Yjs keeps a single flag on the global object and logs
// "Yjs was already imported" when a second copy loads, because `instanceof` checks
// across copies fail. The demo's rooms and Studio's client both need it, so the demo
// bundle loads it once and hands its module to the client, whose demo build reads it
// from here instead of carrying its own (see sharedYjsPlugin.ts).
import * as Y from 'yjs';

export const SHARED_YJS_GLOBAL = '__stackiDemoYjs';

/** Publishes this bundle's Yjs before the client loads. Called once, by the demo's entry. */
export function shareYjs(): void {
  if (Reflect.get(globalThis, SHARED_YJS_GLOBAL) === Y) {
    return;
  }
  Object.defineProperty(globalThis, SHARED_YJS_GLOBAL, { value: Y, configurable: false, enumerable: false, writable: false });
}
