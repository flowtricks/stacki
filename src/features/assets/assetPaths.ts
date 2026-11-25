// Asset paths as the panel reads them: which kind a name is, the prompt a
// pick shows, breadcrumbs, a parent and a base name, whether a path is in the
// pick home, and a tile's title (AssetsPanel.tsx).

import type { AssetRequest } from '../../ui/assetPick';
import type { AssetPanelEntry } from './assetPanelBridge';
import { BOUNDARY_LIMITS } from '../../../shared/core/boundary';
import { ENGLISH_TRANSLATE } from '../../../shared/properties/i18n/englishTranslator';
import type { Translator } from '../../../shared/properties/i18n/messageRef';

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

export function pickPrompt(kind: AssetRequest['mediaKind'], translate: Translator = ENGLISH_TRANSLATE): string {
  switch (kind) {
    case 'image':
      return translate('assets.pick.image');
    case 'video':
      return translate('assets.pick.video');
    case 'audio':
      return translate('assets.pick.audio');
    case 'asset':
      return translate('assets.pick.file');
  }
}

export function buildCrumbs(cwd: string, translate: Translator = ENGLISH_TRANSLATE): readonly { readonly rel: string; readonly label: string }[] {
  const crumbs = [{ rel: '', label: translate('assets.title') }];
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

export function assetTitle(
  file: AssetFile,
  mode: { readonly editable: boolean; readonly picking: boolean },
  translate: Translator = ENGLISH_TRANSLATE,
): string {
  if (mode.picking) {
    return translate('assets.tile.use', { path: `/${file.rel}` });
  }
  return mode.editable ? translate('assets.tile.clickToEdit', { path: `/${file.rel}` }) : `/${file.rel}`;
}
