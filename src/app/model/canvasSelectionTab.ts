import type { LeftTab } from '../appTypes';

// The left panel a canvas selection leaves open. Code, Apps and AI chat keep their panel:
// code is another view of the same selection, and a running app reads the
// selection while its panel stays visible, so switching away would close it.
// Every other panel gives way to the navigator so the selected row is visible.
export function leftTabAfterCanvasSelection(tab: LeftTab): LeftTab {
  if (tab === 'code') {
    return tab;
  }
  if (tab === 'apps') {
    return tab;
  }
  // A chat in progress stays in view while the person clicks around the page it is changing.
  if (tab === 'ai') {
    return tab;
  }
  return 'navigator';
}
