import path from 'node:path';
export const cmsSourcePath = (root: string, relative: string) => path.resolve(root, relative);
export const cmsDirectoryPath = cmsSourcePath;
// Astro sites commonly keep global settings in src/consts.ts or src/constants.ts.
// Recognize those entry points without exposing internal utility constants as content.
export function cmsIncludesGeneral(relative: string): boolean {
  if (/^data\//i.test(relative)) {
    return true;
  }
  return /^(consts|constants)\.(cjs|cts|js|jsx|mjs|mts|ts|tsx)$/i.test(relative);
}
