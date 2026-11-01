// Defaults use a temporary rendering of the same page. Only that transition may
// change a frame's render source without navigating its document.
const DEFAULTS_ROUTE = /^\/__avb\/preview\?defaults=[a-f0-9-]{36}$/;
const URL_CHARS_MAX = 4096;

export function defaultsPreviewTransition(previous: string, next: string): boolean {
  const before = previewURL(previous);
  const after = previewURL(next);
  if (!before || !after || before.origin !== after.origin) {
    return false;
  }
  return DEFAULTS_ROUTE.test(before.pathname + before.search) || DEFAULTS_ROUTE.test(after.pathname + after.search);
}

export function parsePreviewRoute(input: unknown, current: string): string | undefined {
  if (!input || typeof input !== 'object' || !('type' in input) || !('url' in input)) {
    return undefined;
  }
  if (input.type !== 'avb:preview-route' || typeof input.url !== 'string') {
    return undefined;
  }
  if (!defaultsPreviewTransition(current, input.url)) {
    return undefined;
  }
  const next = previewURL(input.url);
  return next ? next.pathname + next.search + '#avb-design' : undefined;
}

function previewURL(value: string): URL | undefined {
  if (value.length > URL_CHARS_MAX) {
    return undefined;
  }
  try {
    const url = new URL(value);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return url;
    }
    return undefined;
  } catch {
    return undefined;
  }
}
