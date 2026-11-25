// Where an asset field's "Choose…" answers for every field beneath a provider. A popup that must stay open
// while the person picks (the canvas image popup) asks for the pop-up over the page, so the pick does not
// borrow the side panel and a press in it never counts as a press outside the popup (assetPick.ts).
import { createContext } from 'react';
import type { AssetRequest } from './assetPick';

export const AssetPickPresentationContext = createContext<AssetRequest['presentation']>(undefined);
