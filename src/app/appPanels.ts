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
export const SelectorsPanel = lazyPanel(() => import('../features/selectors/SelectorsPanel'));
export const CodePanel = lazyPanel(() => import('../features/code/CodePanel'));
export const InstructionsPanel = lazyPanel(() => import('../features/instructions/InstructionsPanel'));
export const InstructionsView = lazyPanel(() => import('./shell/InstructionsDocument'));
export const AuditsPanel = lazyPanel(() => import('../features/audits/AuditsPanel'));
export const AiPanel = lazyPanel(() => import('../features/ai/AiPanel'));

// Every lazy panel, in the order a session usually reaches them: the inspectors
// first, the rarer editors last. Fixed in length, so a preload pass is bounded.
const LAZY_PANELS = [
  PropsPanel,
  StylePanel,
  VariablesPanel,
  CmsPanel,
  SelectorsPanel,
  CodePanel,
  CodeWindow,
  VariablesView,
  CmsView,
  ContentView,
  InstructionsPanel,
  InstructionsView,
  AuditsPanel,
  AiPanel,
] as const;

/**
 * Fetches every lazy panel's chunk, one at a time so the fetches never crowd
 * the page load, and so a panel opened later paints in its first frame.
 */
export async function preloadPanels(): Promise<void> {
  for (const panel of LAZY_PANELS) {
    await panel.preload();
  }
}
