// The Assets panel over the page, for a field that must stay open while its
// asset is chosen: a CMS entry's image (RemoteField.tsx). A pick through the
// side panel would replace the CMS view with the Assets tab; here the panel
// opens in a pop-up and the entry is where it was when the pop-up closes.
// Each host puts its own Assets panel inside (Desktop's, or Studio's wrapper).
import type { ReactNode } from 'react';
import Popup from './Popup';
import './assetPickOverlay.css';

export function AssetPickOverlay(props: { readonly title: string; readonly onClose: () => void; readonly children: ReactNode }) {
  return (
    <Popup className="asset-pick-overlay" labelledBy="asset-pick-overlay-title" onClose={props.onClose}>
      {({ close }) => (
        <>
          <header>
            <h2 id="asset-pick-overlay-title">{props.title}</h2>
            <button type="button" aria-label="Close" onClick={close}>
              ×
            </button>
          </header>
          <div className="asset-pick-overlay-body">{props.children}</div>
        </>
      )}
    </Popup>
  );
}

/** The overlay's heading for a request of this kind. */
export function assetPickTitle(mediaKind: 'image' | 'video' | 'audio' | 'asset'): string {
  return mediaKind === 'asset' ? 'Choose a file' : `Choose an ${mediaKind === 'image' ? 'image' : mediaKind}`;
}
