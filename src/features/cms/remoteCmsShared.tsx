// What the connected-CMS panel and view share: one load per subject with its
// failure in place, the open document, and each CMS's logo.
import React, { createContext, useCallback, useEffect, useRef, useState } from 'react';
import type { RemoteCache } from './remoteCmsCache';
import { AstroIcon, CmsIcon, PayloadIcon, SanityIcon } from '../../ui/Icons';
import type { CmsSource } from '../../../shared/properties/astroContent';
import type { RemoteResult } from '../../../shared/properties/cmsRemote';
import { useTranslate } from '../../lib/i18n/useTranslate';
import { SkeletonRows } from '../../ui/Skeleton';

/** The connected-CMS collection open in the main view, and the item in it, if one is open. */
export interface RemoteCmsSelection {
  /** A saved connection, or the project's own content collections. */
  readonly connection: CmsSource;
  readonly collection: string;
  readonly item: { readonly id: string; readonly title: string } | undefined;
  /** The collection's settings are open in place of its items (content collections only). */
  readonly mode?: 'settings' | undefined;
}

/**
 * Whether the fields inside say what is wrong with their values. An entry held
 * on screen while the next one loads (entryLoad.ts) is `held`: it is what was
 * last shown, not what is selected, so nothing is reported about it.
 */
export type FieldChecks = 'shown' | 'held';
export const FieldChecksContext = createContext<FieldChecks>('shown');

// One read per subject, through its cache (remoteCmsCache.ts): what is kept for
// `key` shows at once and is refreshed behind it. `replace` shows a value the
// panel already knows — an edit's result, a list after a drag — without a read;
// `replaceAt` keeps one for a key that may no longer be the one in view, as a
// save that answers after the person moved on does.
export function useRemote<T>(cache: RemoteCache<T>, key: string, load: () => Promise<RemoteResult<T>>) {
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
  const replaceAt = useCallback(
    (at: string, value: T) => {
      cache.set(at, value);
      if (current.current === at) {
        setShown({ key: at, result: { ok: true, value } });
      }
    },
    [cache],
  );
  const replace = useCallback((value: T) => replaceAt(key, value), [replaceAt, key]);
  // Before the effect catches up with a new key, show that key's kept value,
  // never the previous subject's.
  const result = shown.key === key ? shown.result : cache.get(key);
  return { result, retry: run, replace, replaceAt };
}

export function Loading<T>(props: {
  readonly result: RemoteResult<T> | undefined;
  readonly retry: () => void;
  readonly children: (value: T) => React.ReactNode;
}) {
  const translate = useTranslate();
  if (props.result === undefined) {
    return (
      <div className="remote-cms-note">
        <SkeletonRows count={4} />
      </div>
    );
  }
  if (!props.result.ok) {
    return (
      <div className="remote-cms-note">
        <p className="remote-cms-failure">{props.result.message}</p>
        <button type="button" onClick={props.retry}>
          {translate('cmsRemote.common.tryAgain')}
        </button>
      </div>
    );
  }
  return props.children(props.result.value);
}

export function ConnectionLogo(props: { readonly kind: CmsSource['kind']; readonly size?: number }) {
  const size = props.size ?? 14;
  switch (props.kind) {
    case 'sanity':
      return <SanityIcon size={size} />;
    case 'payload':
      return <PayloadIcon size={size} />;
    case 'custom':
      return <CmsIcon size={size} />;
    case 'astro':
      return <AstroIcon size={size} />;
    default: {
      const exhaustive: never = props.kind;
      return exhaustive;
    }
  }
}
