import { useEffect, useRef, useState } from 'react';
import { clientPanel } from '../features/roles/roleStore';
import { useEditorRole } from '../features/roles/useEditorRole';
import { PropertiesIcon } from '../../vendor/stacki/src/features/componentProperties/PropertiesIcon';
import {
  PagePanelIcon,
  NavigatorIcon,
  ComponentFillIcon,
  AssetManagerIcon,
  CmsIcon,
  HistoryIcon,
  CodeIcon,
  VariableIcon,
} from '../../vendor/stacki/src/ui/Icons';

const panels = [
  { id: 'pages', label: 'Pages', shortcut: 'P', Icon: PagePanelIcon },
  { id: 'navigator', label: 'Navigator', shortcut: 'Z', Icon: NavigatorIcon },
  { id: 'properties', label: 'Properties', shortcut: 'K', Icon: PropertiesIcon },
  { id: 'components', label: 'Components', shortcut: '⇧A', Icon: ComponentFillIcon },
  { id: 'assets', label: 'Assets', shortcut: 'J', Icon: AssetManagerIcon },
  { id: 'collections', label: 'Collections', shortcut: '⌥C', Icon: CmsIcon },
  { id: 'variables', label: 'Variables', shortcut: '⌥V', Icon: VariableIcon },
  { id: 'code', label: 'Code', shortcut: 'C', Icon: CodeIcon },
  { id: 'history', label: 'Git', shortcut: '⌥H', Icon: HistoryIcon },
] as const;
export type Panel = (typeof panels)[number]['id'] | 'ai';
interface Props {
  readonly componentOpen: boolean;
  readonly panel: Panel | undefined;
  readonly toggle: (panel: Panel | undefined) => void;
}

export function EditorRail({ panel, toggle, componentOpen }: Props) {
  const role = useEditorRole();
  const [tip, setTip] = useState<{ label: string; left: number; top: number }>();
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const hide = () => {
    clearTimeout(timer.current);
    setTip(undefined);
  };
  const select = (next: Panel) => {
    hide();
    toggle(panel === next ? undefined : next);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  useRailKeys({ panel, toggle, componentOpen });
  return (
    <nav className="rail studio-rail" aria-label="Editor panels">
      {panels
        .filter(({ id }) => (id !== 'properties' || componentOpen) && (role !== 'client' || clientPanel(id)))
        .map(({ id, label, shortcut, Icon }) => (
          <button
            key={id}
            aria-label={label}
            aria-pressed={panel === id}
            className={`rail-btn ${panel === id ? 'on' : ''}`}
            onMouseEnter={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              clearTimeout(timer.current);
              timer.current = setTimeout(
                () =>
                  setTip({
                    label: `${label} (${shortcut})`,
                    left: rect.right + 10,
                    top: rect.top + rect.height / 2,
                  }),
                500,
              );
            }}
            onMouseLeave={hide}
            onBlur={hide}
            onClick={() => select(id)}
          >
            <Icon size={20} />
          </button>
        ))}
      <div className="rail-spacer" />
      {role !== 'client' && (
        <button
          className={`rail-btn ai-icon ${panel === 'ai' ? 'on' : ''}`}
          aria-label="AI chat"
          aria-pressed={panel === 'ai'}
          title="AI chat"
          onClick={() => select('ai')}
        >
          ✦
        </button>
      )}
      {tip && (
        <div role="tooltip" className="rail-tooltip" style={{ left: tip.left, top: tip.top }}>
          {tip.label}
        </div>
      )}
    </nav>
  );
}

function useRailKeys({ panel, toggle, componentOpen }: Props) {
  const role = useEditorRole();
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.metaKey ||
        event.ctrlKey ||
        event.repeat ||
        (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable=true], .cm-editor, [role=dialog]'))
      ) {
        return;
      }
      let next: Panel | undefined;
      if (event.altKey && !event.shiftKey) {
        if (event.code === 'KeyC') {
          next = 'collections';
        }
        if (event.code === 'KeyH') {
          next = 'history';
        }
        if (event.code === 'KeyV') {
          next = 'variables';
        }
      } else if (!event.altKey) {
        const value = event.key.toLowerCase();
        if (event.shiftKey && value === 'a') {
          next = 'components';
        }
        if (!event.shiftKey) {
          if (value === 'k' && componentOpen) {
            next = 'properties';
          }
          if (value === 'p') {
            next = 'pages';
          }
          if (value === 'z') {
            next = 'navigator';
          }
          if (value === 'j') {
            next = 'assets';
          }
          if (value === 'c') {
            next = 'code';
          }
        }
      }
      if (next && (role !== 'client' || clientPanel(next))) {
        event.preventDefault();
        toggle(panel === next ? undefined : next);
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [panel, toggle, componentOpen, role]);
}
