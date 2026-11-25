import { AsyncLocalStorage } from 'node:async_hooks';

declare global {
  // Astro's SSR modules and the integration bundle must share the request scope.
  var __studioRenderScope: AsyncLocalStorage<'patch'> | undefined;
}

// Astro hides headers on prerendered pages. Capture the internal refresh mode in
// Vite before routing, without adding query parameters visible to project code.
export const renderScope = (globalThis.__studioRenderScope ??= new AsyncLocalStorage<'patch'>());
