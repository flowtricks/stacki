// The card under a CMS field that links to a video (YouTube, Vimeo and the
// other hosts in shared/properties/linkPreview.ts): its thumbnail, title, a
// way to open it, its description, author and host, and Remove to clear the
// field. Desktop's main process or the Studio server fetches what it shows;
// a link its host will not describe (private, removed) shows no card.
import { useEffect, useState } from 'react';
import { assert } from '../../../shared/core/assert';
import type { RemoteResult } from '../../../shared/properties/cmsRemote';
import type { LinkPreview, VideoLink } from '../../../shared/properties/linkPreview';
import { linkPreview, openLinkPreview } from '../../ipc/cmsConnectionsBridge';
import { ExternalIcon, TrashIcon } from '../../ui/Icons';
import './videoLinkCard.css';

/** Cards already fetched, by link, so moving between items does not fetch again. */
const PREVIEWS_MAX = 64;
const previews = new Map<string, Promise<RemoteResult<LinkPreview | undefined>>>();

type CardState = { readonly kind: 'loading' } | { readonly kind: 'none' } | { readonly kind: 'ready'; readonly preview: LinkPreview };

export function VideoLinkCard(props: { readonly link: VideoLink; readonly onRemove: () => void }) {
  const { url } = props.link;
  const [state, setState] = useState<CardState>({ kind: 'loading' });
  useEffect(() => {
    let live = true;
    setState({ kind: 'loading' });
    void previewOf(url).then((result) => {
      if (live) {
        setState(result.ok && result.value ? { kind: 'ready', preview: result.value } : NONE);
      }
    });
    return () => {
      live = false;
    };
  }, [url]);
  switch (state.kind) {
    case 'none':
      return undefined;
    case 'loading':
      return (
        <div className="video-card is-loading" aria-busy="true">
          <div className="video-card-thumb" />
          <div className="video-card-body">
            <span className="video-card-wait">Loading {props.link.host.name} video…</span>
          </div>
        </div>
      );
    case 'ready':
      return <VideoLinkCardReady preview={state.preview} onRemove={props.onRemove} />;
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}

const NONE: CardState = { kind: 'none' };

function VideoLinkCardReady(props: { readonly preview: LinkPreview; readonly onRemove: () => void }) {
  const { preview } = props;
  const open = () => void openLinkPreview(preview.url);
  return (
    <div className="video-card">
      <button type="button" className="video-card-thumb" title="Open video" onClick={open}>
        {preview.thumbnail ? <img src={preview.thumbnail} alt="" /> : undefined}
      </button>
      <div className="video-card-body">
        <div className="video-card-title">
          <span>{preview.title}</span>
          <button type="button" className="video-card-open" title="Open video" onClick={open}>
            <ExternalIcon size={12} />
          </button>
        </div>
        {preview.description ? <p className="video-card-description">{preview.description}</p> : undefined}
        {preview.author ? <span className="video-card-meta">Author: {preview.author}</span> : undefined}
        <span className="video-card-meta">Source: {preview.source}</span>
        <button type="button" className="video-card-remove" onClick={props.onRemove}>
          <TrashIcon size={12} /> Remove
        </button>
      </div>
    </div>
  );
}

// One request per link while it is remembered; the oldest is forgotten first.
function previewOf(url: string): Promise<RemoteResult<LinkPreview | undefined>> {
  const known = previews.get(url);
  if (known !== undefined) {
    return known;
  }
  const request = linkPreview(url).catch((error: unknown): RemoteResult<LinkPreview | undefined> => ({
    ok: false,
    message: String(error),
  }));
  previews.set(url, request);
  if (previews.size > PREVIEWS_MAX) {
    const oldest = previews.keys().next().value;
    assert(oldest !== undefined, 'A full cache has an oldest entry');
    previews.delete(oldest);
  }
  assert(previews.size <= PREVIEWS_MAX, 'The preview cache stays bounded');
  return request;
}
