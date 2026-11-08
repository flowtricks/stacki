// The demo's copy of the Studio client takes Yjs from the page instead of bundling it.
// `yjs` resolves to a module that re-exports the namespace the demo bundle published
// (demo/sharedYjs.ts), so the page holds one Yjs and every document, update and
// `instanceof` check agrees. Normal Studio never uses this plugin.
import type { Plugin } from 'esbuild';
import * as Y from 'yjs';
import { SHARED_YJS_GLOBAL } from './sharedYjs';

const NAMESPACE = 'demo-shared-yjs';
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** The module text that stands in for `yjs`: every export of the real one, read from the page. */
export function sharedYjsModule(names: readonly string[]): string {
  if (names.length === 0) {
    throw new Error('Yjs has no exports to share');
  }
  for (const name of names) {
    if (!IDENTIFIER.test(name) || name === 'default') {
      throw new Error(`Yjs export cannot be re-exported: ${name}`);
    }
  }
  const global = JSON.stringify(SHARED_YJS_GLOBAL);
  return [
    `const shared = globalThis[${global}];`,
    `if (shared === undefined) { throw new Error('The demo did not share its Yjs before loading Studio'); }`,
    `export const { ${names.join(', ')} } = shared;`,
  ].join('\n');
}

export const demoSharedYjs: Plugin = {
  name: NAMESPACE,
  setup(context) {
    context.onResolve({ filter: /^yjs$/ }, () => ({ path: 'yjs', namespace: NAMESPACE }));
    context.onLoad({ filter: /.*/, namespace: NAMESPACE }, () => ({
      contents: sharedYjsModule(Object.keys(Y).filter((name) => name !== 'default')),
      loader: 'js',
    }));
  },
};
