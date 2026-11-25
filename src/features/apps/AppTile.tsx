// An app's icon, wherever an app appears: its own image from the bundle
// (checked square and size-capped at install, shared/properties/appBundle.ts),
// or a tile with the name's initial on a colour that follows the app's id, so
// one app keeps one colour in every list.
import { useState } from 'react';
import { assert } from '../../../shared/core/assert';
import type { AppManifest } from '../../../shared/properties/apps';
import { appFrameURL } from '../../ipc/appsBridge';

const TILE_COLORS = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#8b5cf6', '#14b8a6'] as const;

/** The tile colour for an app id: FNV-1a over the id, into a fixed palette. */
export function appTileColor(appId: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < appId.length; index += 1) {
    hash ^= appId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  const color = TILE_COLORS[hash % TILE_COLORS.length];
  assert(color !== undefined, 'The palette index is inside the palette');
  return color;
}

/** The letter a tile shows: the name's first letter or digit. */
export function appTileInitial(name: string): string {
  const letter = [...name].find((character) => /[\p{L}\p{N}]/u.test(character));
  return (letter ?? '?').toLocaleUpperCase();
}

/** The icon's address, or undefined when the app has none. For lists outside the panel (the command palette). */
export function appIconURL(manifest: Pick<AppManifest, 'id' | 'icon'>): string | undefined {
  return manifest.icon === undefined ? undefined : appFrameURL(manifest.id, manifest.icon);
}

export function AppTile({ manifest, size = 32 }: { readonly manifest: Pick<AppManifest, 'id' | 'name' | 'icon'>; readonly size?: number }) {
  const [failed, setFailed] = useState<string | undefined>(undefined);
  const url = appIconURL(manifest);
  const radius = Math.round(size * 0.25);
  if (url !== undefined && failed !== url) {
    return (
      <img
        className="apps-tile"
        src={url}
        alt=""
        width={size}
        height={size}
        style={{ width: size, height: size, borderRadius: radius }}
        onError={() => setFailed(url)}
      />
    );
  }
  return (
    <span
      className="apps-tile lettered"
      aria-hidden="true"
      style={{ width: size, height: size, borderRadius: radius, background: appTileColor(manifest.id), fontSize: Math.round(size * 0.45) }}
    >
      {appTileInitial(manifest.name)}
    </span>
  );
}
