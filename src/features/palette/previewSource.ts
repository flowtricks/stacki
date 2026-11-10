import { useEffect, useState, type RefObject } from 'react';
import { parseComponentPreviewMessage, type ComponentPreviewMessage } from './paletteModel';

// What both the hover popup and the insert grid need from a preview route: the URL to load
// (resolved through a draft session when the host asks for one) and the status the page
// inside the frame reports. One copy, so the two surfaces cannot drift apart.

export type PreviewURL = { readonly kind: 'loading' } | { readonly kind: 'ready'; readonly url: string } | { readonly kind: 'empty' };

export function useResolvedPreviewURL(directURL: string, resolvePreviewURL?: (url: string) => Promise<string>): PreviewURL {
  const [resolvedURL, setResolvedURL] = useState<PreviewURL>({ kind: 'loading' });
  useEffect(() => {
    if (!resolvePreviewURL) {
      return;
    }
    let active = true;
    void resolvePreviewURL(directURL)
      .then((url) => {
        if (active) {
          setResolvedURL({ kind: 'ready', url });
        }
      })
      .catch(() => {
        // An expired draft session cannot display a component preview.
        if (active) {
          setResolvedURL({ kind: 'empty' });
        }
      });
    return () => {
      active = false;
    };
  }, [directURL, resolvePreviewURL]);
  return resolvePreviewURL ? resolvedURL : { kind: 'ready', url: directURL };
}

/** Delivers the status message of the page inside `frameRef`, and ignores every other window. */
export function usePreviewMessages(frameRef: RefObject<HTMLIFrameElement>, onMessage: (message: ComponentPreviewMessage) => void): void {
  useEffect(() => {
    const receive = (event: MessageEvent<unknown>): void => {
      if (event.source !== frameRef.current?.contentWindow) {
        return;
      }
      const message = parseComponentPreviewMessage(event.data);
      if (message) {
        onMessage(message);
      }
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [frameRef, onMessage]);
}
