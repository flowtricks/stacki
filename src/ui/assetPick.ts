import type { WireAssetEntry } from '../../shared/ipc/ipcResults';

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
