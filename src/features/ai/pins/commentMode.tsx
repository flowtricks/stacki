// Comment mode's entry in the AI panel's Modes menu (panelModes.ts). The Desktop shell registers it while its
// canvas host is mounted (src/app/shell/DesktopPins.tsx), so the mode is offered only where pins can be dropped.
import { centralIcon } from '../../../ui/central/CentralIcon';
import { comment as centralComment } from '../../../ui/central/centralGeometry';
import type { PanelMode } from '../panelModes';
import { pinState, setCommentMode, subscribePins } from './pinStore';

export const COMMENT_MODE_ID = 'comment-pins';

const CommentGlyph = centralIcon(centralComment);

export const COMMENT_PANEL_MODE: PanelMode = {
  id: COMMENT_MODE_ID,
  order: 10,
  label: (translate) => translate('ai.pins.mode'),
  tooltip: (translate) => translate('ai.pins.modeTip'),
  icon: () => <CommentGlyph size={16} />,
  isActive: () => pinState().mode === 'on',
  setActive: (active) => setCommentMode(active),
  subscribe: (listener) => {
    // Only the mode's own changes matter to the menu: typing in a pin re-renders nothing there.
    let last = pinState().mode;
    return subscribePins(() => {
      const mode = pinState().mode;
      if (mode !== last) {
        last = mode;
        listener();
      }
    });
  },
};
