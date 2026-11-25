// One tab of the right panel's Style and Settings switch, shared by Desktop (AppPanes.tsx) and Studio (Editor.tsx).
// A resting pointer or keyboard focus shows the app's own tip with the tab's key, "Style (S)", never a native title.
import { useShortcutTip } from '../../ui/shortcutTip';
import { INSPECTOR_TAB_KEYS, type InspectorTabId } from '../inspectorTabKeys';

interface InspectorTabButtonProps {
  readonly tab: InspectorTabId;
  readonly label: string;
  readonly active: boolean;
  readonly select: (tab: InspectorTabId) => void;
}

export function InspectorTabButton({ tab, label, active, select }: InspectorTabButtonProps) {
  const tip = useShortcutTip(label, INSPECTOR_TAB_KEYS[tab]);
  return (
    <>
      <button
        {...tip.props}
        type="button"
        data-right-tab={tab}
        className={active ? 'on' : ''}
        onClick={() => {
          // The press has been answered: the tip (or its pending wait) goes.
          tip.props.onMouseLeave();
          select(tab);
        }}
      >
        {label}
      </button>
      {tip.tip}
    </>
  );
}
