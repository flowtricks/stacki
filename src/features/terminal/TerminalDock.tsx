import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Dispatch, MutableRefObject, PointerEvent as ReactPointerEvent, SetStateAction } from 'react';
import { assert } from '../../../shared/core/assert';
import { useTranslate } from '../../lib/i18n/useTranslate';
import type { Translator } from '../../../shared/properties/i18n/messageRef';
import Dropdown from '../../ui/Dropdown';
import type { DropdownOption } from '../../ui/Dropdown';
import { ChevronDownIcon, CloseIcon, PlusIcon } from '../../ui/Icons';
import { usePointerDrag } from '../../ui/usePointerDrag';
import { closeTerminal, onTerminalProcess } from './terminalBridge';
import type { TerminalPaneHandle } from './TerminalPane';
import { currentDesktopPlatform, shortcutLabel } from '../../lib/shortcutLabel';
import { TERMINAL_LAUNCH_MODE_KEY, onTerminalTabRequest, parseLaunchMode, type LaunchMode } from './terminalAgent';

const TerminalPane = lazy(() => import('./TerminalPane'));

const HEIGHT_PX_MIN = 120;
const DEFAULT_HEIGHT = 280;
const TOP_GAP_PX_MIN = 180;
const STORED_HEIGHT_MAX = 10_000;
const TERMINAL_TABS_MAX = 32;
const CUSTOM_COMMAND_CHARS_MAX = 4_096;
const LABEL_CHARS_MAX = 22;

const HEIGHT_KEY = 'stacki.terminal.height';
const MODE_KEY = TERMINAL_LAUNCH_MODE_KEY;
const CUSTOM_KEY = 'stacki.terminal.autoLaunchCustom';
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

interface TerminalTab {
  readonly id: string;
  readonly oscTitle: string;
  readonly processName: string;
  /** A command this tab starts with in place of the dock's auto-launch: an agent handed a task (terminalAgent.ts). */
  readonly launch?: string;
}

interface TerminalDockProps {
  readonly projectPath: string;
  readonly open: boolean;
  readonly onClose: () => void;
}

// Claude Code and Codex are product names; the other two choices are words of the interface.
function autoLaunchOptions(translate: Translator): readonly DropdownOption<LaunchMode>[] {
  return [
    { value: 'none', label: translate('workspace.terminal.shellOnly') },
    // i18n-ignore: Claude Code and Codex are product names.
    { value: 'claude', label: 'Claude Code' },
    // i18n-ignore: Codex is a product name.
    { value: 'codex', label: 'Codex' },
    { value: 'custom', label: translate('workspace.terminal.custom') },
  ];
}

export function tabLabel(tab: TerminalTab, index: number): string {
  assert(Number.isSafeInteger(index), 'Terminal tab index must be an integer');
  assert(index >= 0, 'Terminal tab index must be nonnegative');
  const processName = tab.processName.startsWith('-') ? tab.processName.slice(1) : tab.processName;
  return cleanLabel(tab.oscTitle || processName) || `${index + 1}`;
}

export function tabLabels(tabs: readonly TerminalTab[]): readonly string[] {
  assert(tabs.length <= TERMINAL_TABS_MAX, 'Terminal tab count exceeds limit');
  const raw = tabs.map(tabLabel);
  const counts = new Map<string, number>();
  for (const label of raw) {
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return raw.map((label, index) => ((counts.get(label) ?? 0) > 1 ? `${label} ${index + 1}` : label));
}

export default function TerminalDock(props: TerminalDockProps) {
  const translate = useTranslate();
  const settings = useDockSettings();
  const terminals = useTerminalTabs(props.projectPath, { open: props.open });
  const onHandleDown = useDockResize(settings.height, settings.setHeight, settings.setDragging);
  useVisiblePaneFit({ open: props.open, activeId: terminals.activeId, height: settings.height }, terminals.paneRefs.current);
  const autoLaunch = launchCommand(settings.mode, settings.custom);
  return (
    <div className={`term-dock ${props.open ? 'on' : ''}`} style={{ height: props.open ? settings.height : 0 }}>
      <div className={`term-resize ${settings.dragging ? 'on' : ''}`} onPointerDown={onHandleDown} title={translate('workspace.terminal.resize')} />
      <TerminalBar
        tabs={terminals.tabs}
        activeId={terminals.activeId}
        createTab={terminals.createTab}
        closeTab={terminals.closeTab}
        activate={terminals.setActiveId}
        settings={settings}
        onClose={props.onClose}
      />
      <div className="term-panes">
        {terminals.tabs.map((tab) => (
          <div key={tab.id} className="term-pane-wrap" style={{ display: tab.id === terminals.activeId ? 'block' : 'none' }}>
            <Suspense fallback={<div className="term-pane" role="status" aria-busy="true" aria-label={translate('workspace.terminal.loading')} />}>
              <TerminalPane
                ref={(pane) => terminals.setPaneRef(tab.id, pane ?? undefined)}
                terminalId={tab.id}
                projectPath={props.projectPath}
                autoLaunch={tab.launch ?? autoLaunch}
                onTitleChange={(title) => terminals.setTabTitle(tab.id, title)}
              />
            </Suspense>
          </div>
        ))}
      </div>
    </div>
  );
}

interface DockSettings {
  readonly height: number;
  readonly setHeight: (height: number) => void;
  readonly dragging: boolean;
  readonly setDragging: (dragging: boolean) => void;
  readonly mode: LaunchMode;
  readonly setMode: (mode: LaunchMode) => void;
  readonly custom: string;
  readonly setCustom: (custom: string) => void;
}

function useDockSettings(): DockSettings {
  const [height, setHeight] = useState(() => parseStoredHeight(readStored(HEIGHT_KEY, '')));
  const [dragging, setDragging] = useState(false);
  const [mode, setMode] = useState(() => parseLaunchMode(readStored(MODE_KEY, 'none')));
  const [custom, setCustom] = useState(() => readStored(CUSTOM_KEY, ''));
  return { height, setHeight, dragging, setDragging, mode, setMode, custom, setCustom };
}

interface TerminalTabs {
  readonly tabs: readonly TerminalTab[];
  readonly activeId: string | undefined;
  readonly setActiveId: (id: string | undefined) => void;
  readonly createTab: () => void;
  readonly closeTab: (id: string) => void;
  readonly setTabTitle: (id: string, title: string) => void;
  readonly paneRefs: MutableRefObject<Map<string, TerminalPaneHandle>>;
  readonly setPaneRef: (id: string, pane: TerminalPaneHandle | undefined) => void;
}

function useTerminalTabs(projectPath: string, dock: { readonly open: boolean }): TerminalTabs {
  const [tabs, setTabs] = useState<readonly TerminalTab[]>([]);
  const [activeId, setActiveId] = useState<string | undefined>(undefined);
  const tabsRef = useRef(tabs);
  const paneRefs = useRef(new Map<string, TerminalPaneHandle>());
  const nextNumber = useRef(1);
  const seeded = useRef(false);
  tabsRef.current = tabs;
  const createTab = useCallback(
    (launch?: string) => {
      if (tabsRef.current.length >= TERMINAL_TABS_MAX) {
        return;
      }
      const id = `${projectPath}:term-${nextNumber.current}`;
      nextNumber.current += 1;
      const tab: TerminalTab = launch === undefined ? { id, oscTitle: '', processName: '' } : { id, oscTitle: '', processName: '', launch };
      setTabs((previous) => [...previous, tab]);
      setActiveId(id);
    },
    [projectPath],
  );
  // A hand-off to the agent opens its own tab; it counts as the dock's first, so opening adds no idle shell beside it.
  useEffect(
    () =>
      onTerminalTabRequest((command) => {
        seeded.current = true;
        createTab(command);
      }),
    [createTab],
  );
  const closeTab = useCallback((id: string) => {
    void closeTerminal(id);
    paneRefs.current.delete(id);
    setTabs((previous) => closeTabFromList(previous, id, setActiveId));
  }, []);
  useProjectTerminalLifecycle(
    projectPath,
    dock,
    {
      tabsRef,
      paneRefs,
      nextNumber,
      seeded,
      setTabs,
      setActiveId,
    },
    createTab,
  );
  useTerminalProcessNames(setTabs);
  const setTabTitle = useCallback((id: string, title: string) => {
    setTabs((previous) => updateTab(previous, id, 'oscTitle', title));
  }, []);
  const setPaneRef = useCallback((id: string, pane: TerminalPaneHandle | undefined) => {
    if (pane) {
      paneRefs.current.set(id, pane);
    } else {
      paneRefs.current.delete(id);
    }
  }, []);
  return { tabs, activeId, setActiveId, createTab, closeTab, setTabTitle, paneRefs, setPaneRef };
}

interface LifecycleRefs {
  readonly tabsRef: MutableRefObject<readonly TerminalTab[]>;
  readonly paneRefs: MutableRefObject<Map<string, TerminalPaneHandle>>;
  readonly nextNumber: MutableRefObject<number>;
  readonly seeded: MutableRefObject<boolean>;
  readonly setTabs: Dispatch<SetStateAction<readonly TerminalTab[]>>;
  readonly setActiveId: Dispatch<SetStateAction<string | undefined>>;
}

function useProjectTerminalLifecycle(projectPath: string, dock: { readonly open: boolean }, refs: LifecycleRefs, createTab: () => void): void {
  const { open } = dock;
  const { paneRefs, seeded, setActiveId, setTabs, tabsRef, nextNumber } = refs;
  useEffect(() => {
    const panes = paneRefs.current;
    return () => {
      closeTrackedTerminals(tabsRef);
      panes.clear();
      nextNumber.current = 1;
      seeded.current = false;
      setTabs([]);
      setActiveId(undefined);
    };
  }, [projectPath, paneRefs, seeded, setActiveId, setTabs, tabsRef, nextNumber]);
  useEffect(() => {
    if (open && !seeded.current) {
      seeded.current = true;
      createTab();
    }
  }, [open, createTab, seeded]);
}

function closeTrackedTerminals(tabs: MutableRefObject<readonly TerminalTab[]>): void {
  for (const tab of tabs.current) {
    void closeTerminal(tab.id);
  }
}

function useTerminalProcessNames(setTabs: Dispatch<SetStateAction<readonly TerminalTab[]>>): void {
  useEffect(
    () =>
      onTerminalProcess(({ id, name }) => {
        setTabs((previous) => updateTab(previous, id, 'processName', name));
      }),
    [setTabs],
  );
}

function closeTabFromList(previous: readonly TerminalTab[], id: string, setActiveId: Dispatch<SetStateAction<string | undefined>>): readonly TerminalTab[] {
  const index = previous.findIndex((tab) => tab.id === id);
  assert(index >= 0, 'Closed terminal tab must exist');
  const next = previous.filter((tab) => tab.id !== id);
  setActiveId((current) => {
    if (current !== id) {
      return current;
    }
    return next[Math.min(index, next.length - 1)]?.id;
  });
  return next;
}

function updateTab(tabs: readonly TerminalTab[], id: string, field: 'oscTitle' | 'processName', value: string): readonly TerminalTab[] {
  if (!tabs.some((tab) => tab.id === id && tab[field] !== value)) {
    return tabs;
  }
  return tabs.map((tab) => (tab.id === id ? { ...tab, [field]: value } : tab));
}

interface TerminalBarProps {
  readonly tabs: readonly TerminalTab[];
  readonly activeId: string | undefined;
  readonly createTab: () => void;
  readonly closeTab: (id: string) => void;
  readonly activate: (id: string) => void;
  readonly settings: DockSettings;
  readonly onClose: () => void;
}

function TerminalBar(props: TerminalBarProps) {
  const translate = useTranslate();
  const labels = tabLabels(props.tabs);
  return (
    <div className="term-bar">
      <div className="term-tabs">
        {props.tabs.map((tab, index) => (
          <button
            key={tab.id}
            className={`term-tab ${tab.id === props.activeId ? 'on' : ''}`}
            onClick={() => props.activate(tab.id)}
            title={tab.oscTitle || tab.processName}
          >
            <span className="term-tab-label">{labels[index]}</span>
            {props.tabs.length > 1 && (
              <span
                className="term-tab-x"
                title={translate('workspace.terminal.close')}
                onClick={(event) => {
                  event.stopPropagation();
                  props.closeTab(tab.id);
                }}
              >
                <CloseIcon size={10} />
              </span>
            )}
          </button>
        ))}
        <button
          className="ghost term-add"
          title={translate('workspace.terminal.new')}
          onClick={() => props.createTab()}
          disabled={props.tabs.length >= TERMINAL_TABS_MAX}
        >
          <PlusIcon size={13} />
        </button>
      </div>
      <TerminalSettings settings={props.settings} onClose={props.onClose} />
    </div>
  );
}

function TerminalSettings(props: Pick<TerminalBarProps, 'settings' | 'onClose'>) {
  const { settings } = props;
  const translate = useTranslate();
  return (
    <div className="term-bar-right">
      {settings.mode === 'custom' && (
        <input
          className="term-custom"
          value={settings.custom}
          maxLength={CUSTOM_COMMAND_CHARS_MAX}
          placeholder={translate('workspace.terminal.customPlaceholder')}
          title={translate('workspace.terminal.customTitle')}
          onChange={(event) => {
            settings.setCustom(event.target.value);
            storeSetting(CUSTOM_KEY, event.target.value);
          }}
        />
      )}
      <Dropdown
        className="term-launch"
        value={settings.mode}
        options={autoLaunchOptions(translate)}
        livePreview={false}
        onChange={(mode) => {
          settings.setMode(mode);
          storeSetting(MODE_KEY, mode);
        }}
      />
      <button
        className="ghost"
        title={translate('workspace.terminal.hide', { shortcut: shortcutLabel('J', 'primary', currentDesktopPlatform()) })}
        onClick={props.onClose}
      >
        <ChevronDownIcon size={13} />
      </button>
    </div>
  );
}

function useDockResize(
  height: number,
  setHeight: (height: number) => void,
  setDragging: (dragging: boolean) => void,
): (event: ReactPointerEvent<HTMLDivElement>) => void {
  const startDrag = usePointerDrag();
  return (event) => {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = height;
    const heightMax = Math.max(HEIGHT_PX_MIN, window.innerHeight - TOP_GAP_PX_MIN);
    let nextHeight = startHeight;
    setDragging(true);
    startDrag(event, {
      cursor: 'ns-resize',
      onMove: (move) => {
        nextHeight = Math.min(heightMax, Math.max(HEIGHT_PX_MIN, startHeight + startY - move.clientY));
        setHeight(nextHeight);
      },
      onEnd: () => {
        setDragging(false);
        storeSetting(HEIGHT_KEY, String(nextHeight));
      },
    });
  };
}

function useVisiblePaneFit(
  view: {
    readonly open: boolean;
    readonly activeId: string | undefined;
    readonly height: number;
  },
  panes: Map<string, TerminalPaneHandle>,
): void {
  const { open, activeId, height } = view;
  useLayoutEffect(() => {
    if (!open || !activeId) {
      return undefined;
    }
    const pane = panes.get(activeId);
    const frame = requestAnimationFrame(() => {
      pane?.fit();
      pane?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [open, activeId, height, panes]);
}

function cleanLabel(raw: string): string {
  const flat = raw.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
  const short = shortenPathLike(flat);
  return short.length <= LABEL_CHARS_MAX ? short : `${short.slice(0, LABEL_CHARS_MAX - 1).trimEnd()}…`;
}

function shortenPathLike(label: string): string {
  if (/\s/.test(label) || !label.includes('/')) {
    return label;
  }
  return label.split(/[\\/]/).filter(Boolean).at(-1) ?? label;
}

function launchCommand(mode: LaunchMode, custom: string): string {
  switch (mode) {
    case 'claude':
      return 'claude';
    case 'codex':
      return 'codex';
    case 'custom':
      return custom;
    case 'none':
      return '';
  }
}

function parseStoredHeight(value: string): number {
  const height = Number.parseInt(value, 10);
  if (Number.isSafeInteger(height) && height >= HEIGHT_PX_MIN && height <= STORED_HEIGHT_MAX) {
    return height;
  }
  return DEFAULT_HEIGHT;
}

function readStored(key: string, fallback: string): string {
  try {
    const value = localStorage.getItem(key) ?? fallback;
    return value.length <= CUSTOM_COMMAND_CHARS_MAX ? value : fallback;
  } catch {
    return fallback;
  }
}

function storeSetting(key: string, value: string): void {
  assert(value.length <= CUSTOM_COMMAND_CHARS_MAX, 'Terminal setting exceeds length limit');
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage can be unavailable in private mode; the live setting still applies.
  }
}
