// The demo's copy of the Studio client takes TypeScript from the page instead of
// bundling it. `typescript` resolves to a module whose default export is the compiler
// the demo bundle published (demo/sharedTypeScript.ts). Every client import of it is a
// default import (`import ts from 'typescript'`), which is all this stand-in provides; a
// named import would fail the build instead of loading a second copy. Normal Studio
// never uses this plugin.
import type { Plugin } from 'esbuild';
import { SHARED_TYPESCRIPT_GLOBAL } from './sharedTypeScript';

const NAMESPACE = 'demo-shared-typescript';

/** The module text that stands in for `typescript`: the compiler, read from the page. */
export function sharedTypeScriptModule(): string {
  const global = JSON.stringify(SHARED_TYPESCRIPT_GLOBAL);
  return [
    `const shared = globalThis[${global}];`,
    `if (shared === undefined) { throw new Error('The demo did not share its TypeScript before loading Studio'); }`,
    'export default shared;',
  ].join('\n');
}

export const demoSharedTypeScript: Plugin = {
  name: NAMESPACE,
  setup(context) {
    context.onResolve({ filter: /^typescript$/ }, () => ({ path: 'typescript', namespace: NAMESPACE }));
    context.onLoad({ filter: /.*/, namespace: NAMESPACE }, () => ({ contents: sharedTypeScriptModule(), loader: 'js' }));
  },
};
