// The demo's release assets. They ride along with a release as optional files: never in
// the required list, and named so nothing that picks installers by suffix sees them.
export const DEMO_ASSETS = ['studio.js', 'studio.css', 'demo.js', 'demo.css', 'index.html', 'morph.js', 'preview-static.js', 'bake.mjs'] as const;
export const DEMO_MANIFEST_ASSET = 'stacki-demo-manifest.json';
// The largest demo file stacki.build accepts (FILE_BYTES_MAX in the site's worker/demo.ts): a manifest
// naming a larger one is "not valid" and the site keeps its previous demo. 1.4.12 shipped a 20.8 MB
// studio.js and its site deploy failed after the release was public; the build now stops first.
export const DEMO_FILE_BYTES_MAX = 20_000_000;

export function demoAssetName(name: string): string {
  return `stacki-demo-${name}`;
}
