import React, { useEffect, useRef, useState } from 'react';
import {
  PagePanelIcon,
  NavigatorIcon,
  ComponentFillIcon,
  AssetManagerIcon,
  CmsIcon,
  TerminalIcon,
} from './Icons.jsx';

const TABS = [
  { id: 'pages', title: 'Pages', shortcut: 'P', Icon: PagePanelIcon },
  { id: 'navigator', title: 'Navigator', shortcut: 'Z', Icon: NavigatorIcon },
  { id: 'components', title: 'Components', shortcut: '⇧A', Icon: ComponentFillIcon },
  { id: 'assets', title: 'Assets', shortcut: 'J', Icon: AssetManagerIcon },
  { id: 'cms', title: 'CMS', shortcut: '⌥C', Icon: CmsIcon },
  { id: 'terminal', title: 'Terminal', shortcut: '⌥T', Icon: TerminalIcon },
];

const TOOLTIP_DELAY = 500;

// Webflow-style icon rail. Clicking the active tab collapses the panel.
// Hovering a button for a moment shows a tooltip with its keyboard shortcut.
export default function LeftRail({ active, onSelect }) {
  const [tip, setTip] = useState(null); // {id, left, top}
  const timerRef = useRef(null);

  const showSoon = (id) => (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(
      () => setTip({ id, left: rect.right + 10, top: rect.top + rect.height / 2 }),
      TOOLTIP_DELAY
    );
  };

  const hide = () => {
    clearTimeout(timerRef.current);
    setTip(null);
  };

  useEffect(() => () => clearTimeout(timerRef.current), []);

  // P / Z / ⇧A / J / ⌥C toggle the panels (ignored while typing in a field).
  useEffect(() => {
    const onKey = (e) => {
      if (e.metaKey || e.ctrlKey) return;
      const t = e.target;
      if (
        t instanceof HTMLElement &&
        (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)
      ) {
        return;
      }
      // ⌥C — matched on the physical key, since Option rewrites e.key to "ç".
      if (e.altKey) {
        if (e.code === 'KeyC') {
          e.preventDefault();
          onSelect('cms');
        } else if (e.code === 'KeyT') {
          e.preventDefault();
          onSelect('terminal');
        }
        return;
      }
      const k = e.key.toLowerCase();
      let id = null;
      if (k === 'p' && !e.shiftKey) id = 'pages';
      else if (k === 'z' && !e.shiftKey) id = 'navigator';
      else if (k === 'a' && e.shiftKey) id = 'components';
      else if (k === 'j' && !e.shiftKey) id = 'assets';
      if (id) {
        e.preventDefault();
        onSelect(id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onSelect]);

  const tipTab = tip && TABS.find((t) => t.id === tip.id);

  return (
    <div className="rail">
      {TABS.map(({ id, Icon }) => (
        <button
          key={id}
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
      {tipTab && (
        <div className="rail-tooltip" style={{ left: tip.left, top: tip.top }}>
          {tipTab.title} ({tipTab.shortcut})
        </div>
      )}
    </div>
  );
}
