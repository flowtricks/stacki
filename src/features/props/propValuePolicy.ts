import { createContext } from 'react';

// Recipes must retain explicit choices even when they match an Astro fallback.
// Ordinary instances keep omitting redundant fallback values.
export type PropValuePolicy = 'instance' | 'defaults';
export const PropValuePolicyContext = createContext<PropValuePolicy>('instance');

// Whether hovering a dropdown's choice shows it before it is picked. A prop on
// the canvas previews live; a CMS field stores what is picked, so it does not.
export const PropHoverPreviewContext = createContext(true);
