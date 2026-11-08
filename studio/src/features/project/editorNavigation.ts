import { useEffect, useRef, useState } from 'react';
import { addressHistoryFor, pageAddressHost } from './pageAddress';
import { chooseTemplateEntry, isTemplateFile, useCanvasRoute } from '../pages/templateEntryStore';
import { useEditorRole } from '../roles/useEditorRole';
import type { Peer } from '../collaboration/presence';
import type { FollowTarget } from '../collaboration/useCollaborators';
import { clearAssetRequest, getPendingAsset } from '../../../vendor/stacki/src/ui/assetPick';

export interface ComponentFocus {
  readonly path: string;
  readonly occurrence: number;
}
export type OpenFile = (file: string, focus?: ComponentFocus) => void;

export function useEditorNavigation() {
  const role = useEditorRole();
  // A host that keeps the address in step names the first page; Studio opens the home page.
  const [host] = useState(pageAddressHost);
  const [file, setFile] = useState(() => initialFile(host));
  const [previewFile, setPreviewFile] = useState(file);
  const [focus, setFocus] = useState<ComponentFocus>();
  const [followTarget, setFollowTarget] = useState<FollowTarget>();
  useEffect(() => {
    if (role === 'client' && file.endsWith('.astro') && !file.startsWith('src/pages/')) {
      setFile(previewFile);
      setFocus(undefined);
      setFollowTarget(undefined);
    }
  }, [role, file, previewFile]);
  const open: OpenFile = (file, focus) => {
    if (role === 'client' && file.endsWith('.astro') && !file.startsWith('src/pages/')) {
      return;
    }
    clearPendingAsset();
    setFollowTarget(undefined);
    setFocus(focus);
    setFile(file);
    if (isCanvasPage(file)) {
      setPreviewFile(file);
    }
  };
  usePageAddress(host, previewFile, open);
  const follow = (peer: Peer) => {
    if (role === 'client' && peer.file.endsWith('.astro') && !peer.file.startsWith('src/pages/')) {
      return;
    }
    clearPendingAsset();
    setFocus(undefined);
    setFile(peer.file);
    setPreviewFile(peer.page);
    setFollowTarget({ ...peer, request: Date.now() });
  };
  return { file, previewFile, focus, followTarget, open, follow };
}
/** The page the address names, and for a template page the entry it names, shown first. */
function initialFile(host: ReturnType<typeof pageAddressHost>): string {
  const file = host?.initialFile() ?? 'src/pages/index.astro';
  const route = host?.initialRoute();
  if (route !== undefined && isTemplateFile(file)) {
    chooseTemplateEntry(file, route);
  }
  return file;
}
/** Tells the host each page (and template entry) the canvas shows, and opens the ones it names on back and forward. */
function usePageAddress(host: ReturnType<typeof pageAddressHost>, previewFile: string, open: OpenFile) {
  const latestOpen = useRef(open);
  latestOpen.current = open;
  // Read only: the canvas reads a template's entries; until one is chosen there is no address.
  const route = useCanvasRoute(previewFile, false);
  useEffect(() => {
    if (route !== undefined) {
      host?.opened(previewFile, route, addressHistoryFor(route));
    }
  }, [host, previewFile, route]);
  useEffect(
    () =>
      host?.listen((file, entry) => {
        if (entry !== undefined && isTemplateFile(file)) {
          chooseTemplateEntry(file, entry);
        }
        latestOpen.current(file);
      }),
    [host],
  );
}
function clearPendingAsset() {
  if (getPendingAsset()) {
    clearAssetRequest();
  }
}
import { isCanvasPage } from '../../../vendor/stacki/shared/properties/defaultsCanvas';
