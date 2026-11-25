// A back chevron a panel's header inherits from where the panel was opened, without the panel knowing.
// The one user: a rail panel a person moved into the Settings panel (src/app/railOrder.ts) opens from a Settings
// row, and its header then carries the same chevron as Settings' own views, returning to the Settings list.
// A header that passes its own `back` (a panel's detail view) keeps it: the nearer back wins.
import { createContext } from 'react';
import type { PanelHeaderBack } from './PanelHeader';

export const PanelBackContext = createContext<PanelHeaderBack | undefined>(undefined);
