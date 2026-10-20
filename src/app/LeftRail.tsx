import { PropertiesIcon } from '../features/componentProperties/PropertiesIcon';
import type { MouseEvent } from 'react';
import { useEffect, useRef, useState } from 'react';
import {
  PagePanelIcon,
  NavigatorIcon,
  ComponentFillIcon,
  AssetManagerIcon,
  CmsIcon,
  VariableIcon,
  CodeIcon,
  HistoryIcon,
  CommentIcon,
} from '../ui/Icons';

const TABS = [
  { id: 'pages', title: 'Pages', shortcut: 'P', Icon: PagePanelIcon },
  { id: 'navigator', title: 'Navigator', shortcut: 'Z', Icon: NavigatorIcon },
  { id: 'properties', title: 'Properties', shortcut: 'K', Icon: PropertiesIcon },
  { id: 'components', title: 'Components', shortcut: '⇧A', Icon: ComponentFillIcon },
  { id: 'assets', title: 'Assets', shortcut: 'J', Icon: AssetManagerIcon },
  { id: 'cms', title: 'CMS', shortcut: '⌥C', Icon: CmsIcon },
  { id: 'variables', title: 'Variables', shortcut: '⌥V', Icon: VariableIcon },
  { id: 'code', title: 'Code', shortcut: 'C', Icon: CodeIcon },
  { id: 'history', title: 'History', shortcut: '⌥H', Icon: HistoryIcon },
  { id: 'feedback', title: 'Feedback', shortcut: 'M', Icon: CommentIcon },
] as const;
export type RailTab = (typeof TABS)[number]['id'];

const TOOLTIP_DELAY = 500;

// Webflow-style icon rail. Clicking the active tab collapses the panel.
// Hovering a button for a moment shows a tooltip with its keyboard shortcut.
export default function LeftRail({
  active,
  onSelect,
  componentOpen = false,
}: {
  readonly componentOpen?: boolean;
  readonly active?: RailTab | undefined;
  readonly onSelect: (tab: RailTab) => void;
}) {
  const [tip, setTip] = useState<
    | {
        readonly id: RailTab;
        readonly left: number;
        readonly top: number;
      }
    | undefined
  >(undefined); // {id, left, top}
  const timerRef = useRef<ReturnType<typeof setTimeout>>();

  const showSoon = (id: RailTab) => (event: MouseEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(
      () => setTip({ id, left: rect.right + 10, top: rect.top + rect.height / 2 }),
      TOOLTIP_DELAY,
    );
  };

  const hide = () => {
    clearTimeout(timerRef.current);
    setTip(undefined);
  };

  useEffect(() => () => clearTimeout(timerRef.current), []);

  useRailKeys({ componentOpen }, onSelect);
  const tabs = TABS.filter((tab) => tab.id !== 'properties' || componentOpen);

  const tipTab = tip && tabs.find((tab) => tab.id === tip.id);

  return (
    <div className="rail">
      {tabs.map(({ id, Icon, title, shortcut }) => (
        <button
          key={id}
          aria-label={shortcut ? `${title} (${shortcut})` : title}
          aria-pressed={active === id}
          className={`rail-btn ${active === id ? 'on' : ''}`}
          onMouseEnter={showSoon(id)}
          onMouseLeave={hide}
          onClick={() => {
            hide();
            onSelect(id);
          }}
        >
          <Icon size={20} />
        </button>
      ))}
      {tipTab && tip && (
        <div className="rail-tooltip" style={{ left: tip.left, top: tip.top }}>
          {tipTab.title}
          {tipTab.shortcut ? ` (${tipTab.shortcut})` : ''}
        </div>
      )}
    </div>
  );
}

function useRailKeys(
  { componentOpen }: { readonly componentOpen: boolean },
  onSelect: (tab: RailTab) => void,
): void {
  // P / Z / ⇧A / J / M / ⌥C / ⌥H toggle the panels (ignored while typing in a field).
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey) {
        return;
      }
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }
      if (event.altKey) {
        // Matched on the physical key: Option rewrites e.key ("ç" for C,
        // "˙" for H), so e.key would never equal the letter.
        if (event.code === 'KeyC') {
          event.preventDefault();
          onSelect('cms');
        } else if (event.code === 'KeyH') {
          event.preventDefault();
          onSelect('history');
        }
        return;
      }
      const key = event.key.toLowerCase();
      let id: RailTab | undefined;
      if (key === 'p' && !event.shiftKey) {
        id = 'pages';
      } else if (key === 'z' && !event.shiftKey) {
        id = 'navigator';
      } else if (key === 'a' && event.shiftKey) {
        id = 'components';
      } else if (key === 'k' && !event.shiftKey && componentOpen) {
        id = 'properties';
      } else if (key === 'j' && !event.shiftKey) {
        id = 'assets';
      } else if (key === 'c' && !event.shiftKey) {
        id = 'code';
      } else if (key === 'm' && !event.shiftKey) {
        id = 'feedback';
      }
      if (id) {
        event.preventDefault();
        onSelect(id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onSelect, componentOpen]);
}
