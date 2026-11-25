// Where a site's own link leads inside its baked copy. Astro sites write links from
// the site root (`/about`), but the bake is served under a base (`/demo/site/`), so
// such a link would leave the copy and the editor with it. Pure, so the rule is
// testable without a frame.

/** The baked path for a same-origin pathname: a path already under the base is kept,
 * a root path moves under it, and a page path gains the trailing slash its baked
 * `index.html` folder is served at. */
export function bakedLinkPath(pathname: string, siteRoot: string): string {
  if (!siteRoot.startsWith('/') || !siteRoot.endsWith('/')) {
    throw new Error(`The site root is a folder path, not ${siteRoot}`);
  }
  if (pathname.startsWith(siteRoot)) {
    return pathname;
  }
  const relative = pathname.replace(/^\/+/, '');
  const last = relative.split('/').at(-1) ?? '';
  const folder = relative === '' || relative.endsWith('/') || last.includes('.') ? relative : `${relative}/`;
  return `${siteRoot}${folder}`;
}
