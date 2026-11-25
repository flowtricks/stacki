// Where the main process finds what it ships with: the preload, the renderer,
// the icons, the scripts served to the preview, and the files the project's
// own dev server loads. This is the one module that reads __dirname for them.
//
// Each path is written as the build output it is, `dist/electron/preload/preload.js`,
// and resolved against dist/ from here (dist/electron/lib), inside app.asar or
// out of it. Written whole, a path is what scripts/move/moveSources.mts
// rewrites when its source moves; built from pieces, it would silently go
// stale.
import * as path from 'path';

// dist/, the root of the build output: two folders above this module.
const DIST_ROOT = path.join(__dirname, '..', '..');

function distPath(file: string): string {
  if (!file.startsWith('dist/')) {
    throw new Error(`distPath: ${file} is not a build-output path`);
  }
  return path.join(DIST_ROOT, ...file.slice('dist/'.length).split('/'));
}

// The project's dev server is a plain Node process, and plain Node cannot read
// inside app.asar — it would fail the config import and take the whole preview
// down. build.asarUnpack keeps a real copy on disk beside the archive; this
// points at that copy. Outside a package (no asar in the path) it is a no-op.
function unpackedPath(file: string): string {
  return distPath(file).replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
}

export const RUNTIME_PATHS = {
  preload: distPath('dist/electron/preload/preload.js'),
  rendererIndex: distPath('dist/renderer/index.html'),
  morphClient: distPath('dist/electron/previewClient/morphClient.js'),
  previewMarkers: unpackedPath('dist/electron/previewServer/previewMarkers.js'),
  componentPreview: unpackedPath('dist/electron/previewServer/componentPreview.js'),
  studioEntry: unpackedPath('dist/electron/previewServer/studioEntry.js'),
  previewWarmup: unpackedPath('dist/electron/previewServer/previewWarmup.js'),
} as const;

/** An icon or other file the build copies to dist/resources/. */
export function resourcePath(name: string): string {
  return path.join(distPath('dist/resources'), name);
}

/** A module the content tooling copies into a project's temporary folder. */
export function contentWorkerPath(name: string): string {
  return path.join(distPath('dist/electron/content/workers'), name);
}
