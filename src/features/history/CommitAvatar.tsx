// A commit author's picture at the start of the row's meta line. The initials are
// always drawn underneath, so they show while the image loads, when there is no
// picture, and when the image fails; the image only covers them once it has loaded.
import React, { useState } from 'react';
import { assert } from '../../../shared/core/assert';
import { authorColor, authorInitials } from './commitAvatars';

// Pictures this window has already shown. A row drawn again (the Git panel opened
// once more) starts on its picture rather than on its initials: starting every
// mount on 'loading' showed the initials for a frame and then swapped in the
// picture, a flicker across the whole timeline on every open. The image is in
// the browser's cache by then, so it paints with the row.
const LOADED_URLS_MAX = 512;
const loadedUrls = new Set<string>();

function rememberLoaded(url: string): void {
  loadedUrls.delete(url);
  loadedUrls.add(url);
  if (loadedUrls.size > LOADED_URLS_MAX) {
    const oldest = loadedUrls.values().next().value;
    assert(oldest !== undefined, 'CommitAvatar: a full set has an oldest picture');
    loadedUrls.delete(oldest);
  }
  assert(loadedUrls.size <= LOADED_URLS_MAX, 'CommitAvatar: the shown pictures stay within their bound');
}

function initialState(url: string | undefined): 'loading' | 'ready' {
  return url !== undefined && loadedUrls.has(url) ? 'ready' : 'loading';
}

export default function CommitAvatar({ name, email, url }: { readonly name: string; readonly email: string; readonly url: string | undefined }) {
  const [image, setImage] = useState<{ readonly url: string | undefined; readonly state: 'loading' | 'ready' | 'failed' }>(() => ({
    url,
    state: initialState(url),
  }));
  // A new URL for the same row starts over rather than inheriting the old failure.
  const state = image.url === url ? image.state : initialState(url);
  return (
    <span className="history-avatar" style={{ color: authorColor(email, name) }} aria-hidden="true">
      {authorInitials(name, email)}
      {url !== undefined && state !== 'failed' && (
        <img
          src={url}
          alt=""
          width={16}
          height={16}
          loading="lazy"
          // A picture already shown decodes with its row, so it never paints blank for a frame.
          decoding={state === 'ready' ? 'sync' : 'async'}
          referrerPolicy="no-referrer"
          data-state={state}
          onLoad={() => {
            rememberLoaded(url);
            setImage({ url, state: 'ready' });
          }}
          onError={() => setImage({ url, state: 'failed' })}
        />
      )}
    </span>
  );
}
