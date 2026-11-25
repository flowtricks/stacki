import type { Plugin } from 'vite';

export function sourceWatch(): Plugin {
  return {
    name: 'studio-source-watch',
    config() {
      // Atomic saves expose only the completed source to Astro. Watching the
      // staging file also rebuilds routes on its creation and removal.
      return { server: { watch: { ignored: [/\.studio-tmp$/] } } };
    },
  };
}
