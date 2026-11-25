import type { WireAssetEntry } from '../../shared/ipc/ipcResults';
import { assert } from '../../shared/core/assert';
import type { AppMediaKind } from '../../shared/properties/appsRpc';
import { askAppOverride } from './appOverrideSlot';
import { isExternalAsset } from './assetPath';

// "Choose an asset" requests, from a field to the Assets panel.
//
// The fields that ask (src, poster, an attribute value) sit several levels
// down inside the props panel, and the panel that answers lives in a
// different branch of the tree entirely — so the request travels through a
// module rather than being threaded as props through every field in between.
// Only one request can be open at a time, which is what makes that safe.

export interface AssetRequest {
  readonly mediaKind: 'image' | 'video' | 'audio' | 'asset';
  readonly current: string;
  readonly onPick: (rel: string, entry?: WireAssetEntry) => void;
  /**
   * A file picked from a connected media host (Cloudflare R2, Bunny, any S3
   * host) answers with its public URL. A request without this offers project
   * files only, so a field that cannot hold a URL is never handed one.
   */
  readonly onPickURL?: ((url: string) => void) | undefined;
  /**
   * Where the Assets panel answers: in the side panel (the default), or in a
   * pop-up over the page, for a field that must stay open meanwhile.
   */
  readonly presentation?: 'panel' | 'overlay';
  /**
   * An app's pick that came with alt text, written with the alt as one edit, so
   * it is one undo step: the field and its element's alt together. Absent when
   * the field has no alt to write; the alt is then dropped.
   */
  readonly onPickWithAlt?: ((pick: AssetAltPick, alt: string) => void) | undefined;
}

/** What an app picked, for `onPickWithAlt`: a hosted file's public URL, or a project file. */
export type AssetAltPick = { readonly kind: 'url'; readonly url: string } | { readonly kind: 'file'; readonly rel: string };

/** The element field a request is for, which an app answering `assets.pick` is told. */
export interface AssetPickTarget {
  readonly nodeId: string | undefined;
  readonly field: string;
}

const ACCEPTS: Readonly<Record<AssetRequest['mediaKind'], readonly AppMediaKind[]>> = {
  image: ['image'],
  video: ['video'],
  audio: ['audio'],
  asset: ['image', 'video', 'audio', 'file'],
};

/**
 * A "Choose…" button's press: a running app that answers `assets.pick` is asked
 * first (docs/apps.md, "Overrides"), and its pick is written through the
 * request's own `onPick` / `onPickURL`, the same call the Assets panel's pick
 * makes, so it is the same one undo step; a pick with alt text goes through
 * `onPickWithAlt`, which writes both in that one step. `default`, a URL for a field that takes
 * project files only, or Alt held opens the Assets panel as before; `cancel`
 * changes nothing.
 */
export async function chooseAsset(request: AssetRequest, options: { readonly bypass: boolean; readonly target: AssetPickTarget | undefined }): Promise<void> {
  const call = askAppOverride(
    {
      point: 'assets.pick',
      context: {
        nodeId: options.target?.nodeId,
        field: options.target?.field,
        accepts: ACCEPTS[request.mediaKind],
        current: request.current,
        acceptsURL: request.onPickURL !== undefined,
      },
    },
    { bypass: options.bypass },
  );
  const answer = await call.answer;
  assert(answer.point === 'assets.pick', 'An asset pick is answered at its own point');
  const { result } = answer;
  switch (result.kind) {
    case 'default':
      requestAsset(request);
      return;
    case 'cancel':
      return;
    case 'picked':
      if (!applyPickedAsset(request, result.url, result.alt)) {
        requestAsset(request);
      }
      return;
    default: {
      const exhaustive: never = result;
      return exhaustive;
    }
  }
}

// An app's pick, written the way the Assets panel's would be. False when the field cannot hold it.
// With alt text and a field that writes one, the two go in one call, so one edit and one undo step.
function applyPickedAsset(request: AssetRequest, url: string, alt: string | undefined): boolean {
  const external = isExternalAsset(url);
  if (external) {
    if (request.onPickURL === undefined) {
      return false;
    }
  }
  const pick: AssetAltPick = external ? { kind: 'url', url } : { kind: 'file', rel: url };
  if (alt !== undefined) {
    if (request.onPickWithAlt !== undefined) {
      request.onPickWithAlt(pick, alt);
      return true;
    }
  }
  switch (pick.kind) {
    case 'url':
      assert(request.onPickURL !== undefined, 'A URL is written only to a field that takes one');
      request.onPickURL(pick.url);
      return true;
    case 'file':
      request.onPick(pick.rel, undefined);
      return true;
    default: {
      const exhaustive: never = pick;
      return exhaustive;
    }
  }
}

type AssetListener = (request: AssetRequest | undefined) => void;
// A single request and listener bound state for the whole window. Undefined is the
// cancellation message.
let listener: AssetListener | undefined = undefined;
let pending: AssetRequest | undefined = undefined;

// Called by App to receive requests. Returns an unsubscribe.
export function onAssetRequest(handler: AssetListener): () => void {
  listener = handler;
  return () => {
    if (listener === handler) {
      listener = undefined;
    }
  };
}

// { mediaKind: 'image'|'video'|'audio'|'asset', current: string,
//   onPick(rel, entry) } — entry carries the root ('public'|'src') and abs path,
//   which decide whether the value is a URL string or an ESM import.
export function requestAsset(request: AssetRequest): void {
  pending = request;
  listener?.(request);
}

export function getPendingAsset(): AssetRequest | undefined {
  return pending;
}

export function clearAssetRequest(): void {
  pending = undefined;
  listener?.(undefined);
}
