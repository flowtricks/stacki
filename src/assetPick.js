// "Choose an asset" requests, from a field to the Assets panel.
//
// The fields that ask (src, poster, an attribute value) sit several levels
// down inside the props panel, and the panel that answers lives in a
// different branch of the tree entirely — so the request travels through a
// module rather than being threaded as props through every field in between.
// Only one request can be open at a time, which is what makes that safe.

let listener = null;
let pending = null;

// Called by App to receive requests. Returns an unsubscribe.
export function onAssetRequest(fn) {
  listener = fn;
  return () => {
    if (listener === fn) listener = null;
  };
}

// { mediaKind: 'image'|'video'|'audio'|'asset', current: string,
//   onPick(rel, entry) } — entry carries the root ('public'|'src') and abs path,
//   which decide whether the value is a URL string or an ESM import.
export function requestAsset(req) {
  pending = req;
  listener?.(req);
}

export function getPendingAsset() {
  return pending;
}

export function clearAssetRequest() {
  pending = null;
  listener?.(null);
}
