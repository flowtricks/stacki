// What the connected-CMS panel and view share: one load per subject with its
// failure in place, the open document, and each CMS's logo.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { RemoteCache } from './remoteCmsCache';
import { CmsIcon, PayloadIcon, SanityIcon } from '../../ui/Icons';
import type { CmsConnection } from '../../../shared/properties/cmsConnections';
import type { RemoteResult } from '../../../shared/properties/cmsRemote';

/** The connected-CMS collection open in the main view, and the item in it, if one is open. */
export interface RemoteCmsSelection {
  readonly connection: CmsConnection;
  readonly collection: string;
  readonly item: { readonly id: string; readonly title: string } | undefined;
}

// One read per subject, through its cache (remoteCmsCache.ts): what is kept for
// `key` shows at once and is refreshed behind it. `replace` shows a value the
// panel already knows — an edit's result, a list after a drag — without a read.
export function useRemote<T>(
  cache: RemoteCache<T>,
  key: string,
  load: () => Promise<RemoteResult<T>>,
) {
  const [shown, setShown] = useState(() => ({ key, result: cache.get(key) }));
  const current = useRef(key);
  current.current = key;
  const run = useCallback(() => {
    setShown({ key, result: cache.get(key) });
    void cache.load(key, load).then((result) => {
      if (current.current === key) {
        setShown({ key, result });
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` names what `load` reads
  }, [cache, key]);
  useEffect(run, [run]);
  // Back online: refresh what an offline read could not.
  useEffect(() => {
    window.addEventListener('online', run);
    return () => window.removeEventListener('online', run);
  }, [run]);
  const replace = useCallback(
    (value: T) => {
      cache.set(key, value);
      setShown({ key, result: { ok: true, value } });
    },
    [cache, key],
  );
  // Before the effect catches up with a new key, show that key's kept value,
  // never the previous subject's.
  const result = shown.key === key ? shown.result : cache.get(key);
  return { result, retry: run, replace };
}

export function Loading<T>(props: {
  readonly result: RemoteResult<T> | undefined;
  readonly retry: () => void;
  readonly children: (value: T) => React.ReactNode;
}) {
  if (props.result === undefined) {
    return <p className="remote-cms-note">Loading…</p>;
  }
  if (!props.result.ok) {
    return (
      <div className="remote-cms-note">
        <p className="remote-cms-failure">{props.result.message}</p>
        <button type="button" onClick={props.retry}>
          Try again
        </button>
      </div>
    );
  }
  return props.children(props.result.value);
}

export function ConnectionLogo(props: {
  readonly kind: CmsConnection['kind'];
  readonly size?: number;
}) {
  const size = props.size ?? 14;
  switch (props.kind) {
    case 'sanity':
      return <SanityIcon size={size} />;
    case 'payload':
      return <PayloadIcon size={size} />;
    case 'custom':
      return <CmsIcon size={size} />;
    default: {
      const exhaustive: never = props.kind;
      return exhaustive;
    }
  }
}
