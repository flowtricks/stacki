// The Assets panel over the page, for a field that must stay open while its
// asset is chosen: a CMS entry's image (RemoteField.tsx). A pick through the
// side panel would replace the CMS view with the Assets tab; here the panel
// opens in a pop-up and the entry is where it was when the pop-up closes.
// Each host puts its own Assets panel inside (Desktop's, or Studio's wrapper).
import type { ReactNode } from 'react';
import Popup from './Popup';
import './assetPickOverlay.css';
import type { MessageKey } from '../lib/i18n/localeContext';
import { useTranslate } from '../lib/i18n/useTranslate';

export function AssetPickOverlay(props: { readonly mediaKind: AssetPickKind; readonly onClose: () => void; readonly children: ReactNode }) {
  const translate = useTranslate();
  return (
    <Popup className="asset-pick-overlay" labelledBy="asset-pick-overlay-title" onClose={props.onClose}>
      {({ close }) => (
        <>
          <header>
            <h2 id="asset-pick-overlay-title">{translate(TITLE_KEYS[props.mediaKind])}</h2>
            <button type="button" aria-label={translate('ui.close')} onClick={close}>
              ×
            </button>
          </header>
          <div className="asset-pick-overlay-body">{props.children}</div>
        </>
      )}
    </Popup>
  );
}

export type AssetPickKind = 'image' | 'video' | 'audio' | 'asset';

/** The overlay's heading for a request of this kind. */
const TITLE_KEYS = {
  asset: 'ui.assetPick.title.asset',
  image: 'ui.assetPick.title.image',
  video: 'ui.assetPick.title.video',
  audio: 'ui.assetPick.title.audio',
} as const satisfies Record<AssetPickKind, MessageKey>;
