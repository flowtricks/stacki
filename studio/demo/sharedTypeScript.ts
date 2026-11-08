// One TypeScript for the whole page. The demo's page engine and Studio's client both
// parse Astro frontmatter with the TypeScript compiler, which is about 3.6 MB of
// minified JavaScript: more than half of either bundle. The demo bundle loads it once
// and hands it to the client, whose demo build reads it from here instead of carrying
// its own (see sharedTypeScriptPlugin.ts), so a visitor downloads and compiles it once.
import ts from 'typescript';

export const SHARED_TYPESCRIPT_GLOBAL = '__stackiDemoTypeScript';

/** Publishes this bundle's TypeScript before the client loads. Called once, by the demo's entry. */
export function shareTypeScript(): void {
  if (Reflect.get(globalThis, SHARED_TYPESCRIPT_GLOBAL) === ts) {
    return;
  }
  Object.defineProperty(globalThis, SHARED_TYPESCRIPT_GLOBAL, { value: ts, configurable: false, enumerable: false, writable: false });
}
