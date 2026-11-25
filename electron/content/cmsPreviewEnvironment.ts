// What the project's dev server is told about its CMS while Stacki previews it.
//
// Mapping canvas text back to the Sanity document and field it came from needs
// the site to ask Sanity for source maps, and to read drafts — which needs a
// token. Neither belongs in the site's own .env: the token is Stacki's, and a
// production build must never stega-encode its strings. So Stacki passes them
// to the dev server it starts, and only to it; a site opts in by reading them
// (docs/contracts.md, "CMS connections"). The variables:
//
//   STACKI_SANITY_PREVIEW     "1" while Stacki is previewing with a connection
//   STACKI_SANITY_PROJECT_ID  the connected project
//   STACKI_SANITY_DATASET     the connected dataset
//   STACKI_SANITY_TOKEN       the connection's key: reads drafts, for source maps.
//
// A Payload connection that signs in with an API key passes the same way (a site reads them to fetch
// drafts with `?draft=true`; Payload has no source maps, so there is nothing to map canvas text back to):
//
//   STACKI_PAYLOAD_PREVIEW     "1" while Stacki is previewing with a connection
//   STACKI_PAYLOAD_URL         the server's address
//   STACKI_PAYLOAD_COLLECTION  the auth collection the key belongs to
//   STACKI_PAYLOAD_API_KEY     the key.

import { assert } from '../../shared/core/assert';
import type { CmsConnectionStore } from './cmsConnectionStore';

export type PreviewEnvironment = Readonly<Record<string, string>>;

export function cmsPreviewEnvironment(store: CmsConnectionStore, projectRoot: string): PreviewEnvironment {
  return { ...sanityEnvironment(store, projectRoot), ...payloadEnvironment(store, projectRoot) };
}

function sanityEnvironment(store: CmsConnectionStore, projectRoot: string): PreviewEnvironment {
  const sanity = store.list(projectRoot).connections.find((connection) => connection.kind === 'sanity');
  if (sanity?.kind !== 'sanity') {
    return {};
  }
  const token = store.secret(projectRoot, sanity.id);
  if (token === undefined) {
    return {};
  }
  assert(!/[\r\n]/.test(token), 'A key passed to the dev server is one line');
  return {
    STACKI_SANITY_PREVIEW: '1',
    STACKI_SANITY_PROJECT_ID: sanity.projectId,
    STACKI_SANITY_DATASET: sanity.dataset,
    STACKI_SANITY_TOKEN: token,
  };
}

// A Payload API key lets the site's own dev server read drafts (`?draft=true` with the key sent as
// `<collection> API-Key <key>`). A password connection passes nothing: a password never leaves Stacki.
function payloadEnvironment(store: CmsConnectionStore, projectRoot: string): PreviewEnvironment {
  const payload = store.list(projectRoot).connections.find((connection) => connection.kind === 'payload' && connection.auth === 'apiKey');
  if (payload?.kind !== 'payload') {
    return {};
  }
  const key = store.secret(projectRoot, payload.id);
  if (key === undefined) {
    return {};
  }
  assert(!/[\r\n]/.test(key), 'A key passed to the dev server is one line');
  return {
    STACKI_PAYLOAD_PREVIEW: '1',
    STACKI_PAYLOAD_URL: payload.baseUrl,
    STACKI_PAYLOAD_COLLECTION: payload.collection,
    STACKI_PAYLOAD_API_KEY: key,
  };
}
