import { assert } from '../../../vendor/stacki/shared/core/assert';

// The project route a canvas navigation landed on. A dev server serves pages at
// the site root, but the static demo serves them under the bake base
// (/demo/site/about/), and the frame reports the path it actually loaded. The
// base is whatever the frame's own URL holds before the route it was opened on,
// so no host has to say what it is.
export function canvasRoute(destination: string, previewURL: string | undefined, previewRoute: string): string {
  assert(destination.startsWith('/'), 'A canvas destination is a site path');
  assert(previewRoute.startsWith('/'), 'A preview route is a site path');
  const target = withoutTrailingSlash(destination);
  const base = canvasRouteBase(previewURL, previewRoute);
  if (base.length > 0) {
    if (target === base || target.startsWith(`${base}/`)) {
      return target.slice(base.length) || '/';
    }
  }
  return target || '/';
}

/** The path the frame's pages sit under: '' at the site root, the bake base in the static demo. */
export function canvasRouteBase(previewURL: string | undefined, previewRoute: string): string {
  if (previewURL === undefined) {
    return '';
  }
  let framePath: string;
  try {
    framePath = withoutTrailingSlash(new URL(previewURL).pathname);
  } catch {
    return '';
  }
  const opened = withoutTrailingSlash(previewRoute);
  if (framePath.endsWith(opened)) {
    return framePath.slice(0, framePath.length - opened.length);
  }
  return '';
}

function withoutTrailingSlash(path: string): string {
  return path.replace(/\/+$/, '');
}
