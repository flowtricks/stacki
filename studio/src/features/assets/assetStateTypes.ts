import { filePath, record } from '../../shared/validation';

export const MEDIA_EXT = /\.(svg|png|jpe?g|gif|webp|avif|ico|bmp|tiff?|mp4|webm|mov|m4v|ogv|mp3|wav|ogg|m4a|flac|aac|woff2?|ttf|otf|eot|pdf)$/i;
export interface AssetState {
  readonly deleted: readonly string[];
  readonly directories: readonly string[];
  readonly removedDirectories: readonly string[];
}
export const emptyAssetState: AssetState = { deleted: [], directories: [], removedDirectories: [] };
export function managedAsset(value: unknown) {
  const file = filePath(value);
  if (!MEDIA_EXT.test(file)) {
    throw new Error('Unsupported asset type');
  }
  return file;
}
export function parseAssetState(input: unknown): AssetState {
  const value = record(input);
  return {
    deleted: paths(value['deleted'], managedAsset),
    directories: paths(value['directories'], filePath),
    removedDirectories: paths(value['removedDirectories'], filePath),
  };
}
function paths(input: unknown, parse: (value: unknown) => string) {
  if (!Array.isArray(input) || input.length > 1000) {
    throw new Error('Asset changes exceed the 1,000-path limit');
  }
  return [...new Set(input.map(parse))];
}
