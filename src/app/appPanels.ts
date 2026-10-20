// The panels the app loads lazily, each the first time it is shown, so the
// first paint carries none of them (App.tsx).

import { lazyPanel } from './lazyPanel';

// Each optional editor owns its loading boundary so opening it keeps the
// canvas and neighboring panels visible and interactive.
export const PropsPanel = lazyPanel(() => import('../features/props/PropsPanel'));
export const StylePanel = lazyPanel(() => import('../features/style/StylePanel'));
export const CodeWindow = lazyPanel(() => import('../features/code/CodeWindow'));
export const CmsPanel = lazyPanel(() => import('../features/cms/CmsPanel'));
export const CmsView = lazyPanel(() => import('../features/cms/CmsView'));
export const ContentView = lazyPanel(() => import('../features/content/ContentView'));
export const VariablesPanel = lazyPanel(() => import('../features/variables/VariablesPanel'));
export const VariablesView = lazyPanel(() => import('../features/variables/VariablesView'));
export const FeedbackPanel = lazyPanel(() => import('../features/feedback/FeedbackPanel'));
export const CodePanel = lazyPanel(() => import('../features/code/CodePanel'));
