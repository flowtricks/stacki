import { createContext } from 'react';

// Recipes must retain explicit choices even when they match an Astro fallback.
// Ordinary instances keep omitting redundant fallback values. A preview (a component canvas frame) shows fallbacks as
// an instance does, but keeps every explicit choice, since what a choice falls back to may be a wider frame setting;
// reset removes the value, and no field is required, as the canvas gives each required prop something to show.
export type PropValuePolicy = 'instance' | 'defaults' | 'preview';
export const PropValuePolicyContext = createContext<PropValuePolicy>('instance');

// Whether hovering a dropdown's choice shows it before it is picked. A prop on
// the canvas previews live; a CMS field stores what is picked, so it does not.
export const PropHoverPreviewContext = createContext(true);
