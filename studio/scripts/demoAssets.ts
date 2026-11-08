// The demo's release assets. They ride along with a release as optional files: never in
// the required list, and named so nothing that picks installers by suffix sees them.
export const DEMO_ASSETS = ['studio.js', 'studio.css', 'demo.js', 'demo.css', 'index.html', 'morph.js', 'preview-static.js', 'bake.mjs'] as const;
export const DEMO_MANIFEST_ASSET = 'stacki-demo-manifest.json';

export function demoAssetName(name: string): string {
  return `stacki-demo-${name}`;
}
