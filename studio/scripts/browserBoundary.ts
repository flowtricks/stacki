import type { Plugin } from 'esbuild';

export const browserBoundary: Plugin = {
  name: 'parser-filesystem-boundary',
  setup(builder) {
    // The browser parses strings only. File/chunk resolution remains server-owned.
    builder.onResolve({ filter: /^node:(fs|path)$/ }, (args) => ({
      path: args.path,
      namespace: 'server-only',
    }));
    builder.onLoad({ filter: /.*/, namespace: 'server-only' }, () => ({
      contents: 'const unavailable = () => { throw new Error("File resolution is server-only"); }; export default new Proxy({}, {get: () => unavailable});',
    }));
  },
};
