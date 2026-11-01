// Asset paths as the panel reads them: which kind a name is, the prompt a
// pick shows, breadcrumbs, a parent and a base name, whether a path is in the
// pick home, and a tile's title (AssetsPanel.tsx).

import type { AssetRequest } from '../../ui/assetPick';
import type { AssetPanelEntry } from './assetPanelBridge';
import { BOUNDARY_LIMITS } from '../../../shared/core/boundary';

export const PICK_HOME = 'src/assets';
export const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|svg|ico|bmp)$/i;
export const VIDEO_EXT = /\.(mp4|webm|mov|m4v|ogv|ogg)$/i;
export const AUDIO_EXT = /\.(mp3|wav|m4a|aac|flac|oga)$/i;

export type AssetFile = Extract<AssetPanelEntry, { readonly isDir: false }>;

export function kindMatches(kind: AssetRequest['mediaKind'], name: string): boolean {
  switch (kind) {
    case 'image':
      return IMAGE_EXT.test(name);
    case 'video':
      return VIDEO_EXT.test(name);
    case 'audio':
      return AUDIO_EXT.test(name);
    case 'asset':
      return true;
  }
}

export function pickPrompt(kind: AssetRequest['mediaKind']): string {
  switch (kind) {
    case 'image':
      return 'Choose an image';
    case 'video':
      return 'Choose a video';
    case 'audio':
      return 'Choose an audio file';
    case 'asset':
      return 'Choose a file';
  }
}

export function buildCrumbs(cwd: string): readonly { readonly rel: string; readonly label: string }[] {
  const crumbs = [{ rel: '', label: 'Assets' }];
  const parts = cwd ? cwd.split('/') : [];
  if (parts.length > BOUNDARY_LIMITS.depthMax) {
    throw new Error('Asset breadcrumbs: depth limit exceeded');
  }
  for (let index = 0; index < parts.length; index++) {
    const label = parts[index];
    if (label !== undefined) {
      crumbs.push({ rel: parts.slice(0, index + 1).join('/'), label });
    }
  }
  return crumbs;
}

export function parentOf(rel: string): string {
  const index = rel.lastIndexOf('/');
  return index < 0 ? '' : rel.slice(0, index);
}

export function basename(rel: string): string {
  return rel.slice(rel.lastIndexOf('/') + 1);
}

export function isInPickHome(rel: string): boolean {
  return rel === PICK_HOME || rel.startsWith(`${PICK_HOME}/`);
}

export function assetTitle(file: AssetFile, mode: { readonly editable: boolean; readonly picking: boolean }): string {
  if (mode.picking) {
    return `Use /${file.rel}`;
  }
  return mode.editable ? `/${file.rel} — click to edit` : `/${file.rel}`;
}
