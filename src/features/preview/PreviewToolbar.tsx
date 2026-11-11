import { centralIcon } from '../../ui/central/CentralIcon';
import { cursorClick as centralCursorClick } from '../../ui/central/centralGeometry';
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { IconProps } from '../../ui/Icons';
import { AllBreakpointsIcon, ChevronRightIcon, DesktopIcon, PanelRightIcon, PhoneIcon, TabletIcon } from '../../ui/Icons';
import { PreviewSizeControls } from './PreviewSizeControls';
import { GuideMenu, type GuideMenuProps } from './GuideMenu';
import type { PreviewSizeControlsProps } from './PreviewSizeControls';
import { ToolbarOverflow, type ToolbarItem } from './ToolbarOverflow';

const InteractIcon = centralIcon(centralCursorClick);

export type PreviewDevice = 'desktop' | 'tablet' | 'phone' | 'canvas' | 'custom';
type FixedDevice = Exclude<PreviewDevice, 'custom'>;

interface DeviceDefinition {
  readonly key: FixedDevice;
  readonly Icon: React.ComponentType<IconProps>;
  readonly title: string;
  /** The viewport width it simulates; undefined for the full available width. */
  readonly width: number | undefined;
  readonly from?: number;
}

export const DEVICES: readonly DeviceDefinition[] = [
  { key: 'desktop', Icon: DesktopIcon, title: 'Desktop — 1', width: undefined, from: 1024 },
  { key: 'tablet', Icon: TabletIcon, title: 'Tablet (768px) — 2', width: 768, from: 768 },
  { key: 'phone', Icon: PhoneIcon, title: 'Phone (375px) — 3', width: 375, from: 0 },
  { key: 'canvas', Icon: AllBreakpointsIcon, title: 'Canvas — all breakpoints — 4', width: undefined },
];

export interface PreviewCrumb {
  /** The node the crumb selects; undefined for the page itself. */
  readonly id: string | undefined;
  readonly label: string;
}

interface FoldedCrumb {
  readonly kind: 'folded';
  readonly hidden: readonly PreviewCrumb[];
}

interface VisibleCrumb {
  readonly kind: 'visible';
  readonly crumb: PreviewCrumb;
}

type ToolbarCrumb = FoldedCrumb | VisibleCrumb;

export function deviceForWidth(px: number): FixedDevice | undefined {
  if (!Number.isFinite(px) || px <= 0) {
    return undefined;
  }
  return DEVICES.find((device) => device.from !== undefined && px >= device.from)?.key;
}

export function deviceWidth(device: PreviewDevice): number | undefined {
  return DEVICES.find((entry) => entry.key === device)?.width;
}

// In a collapsed editor the Style and Settings panel floats over the canvas; one toolbar
// button opens it and closes it again. The panel keeps its own Style and Settings tabs.
export interface PreviewInspectorActions {
  readonly open: boolean;
  readonly toggle: () => void;
}

interface PreviewToolbarProps {
  readonly crumbs: readonly PreviewCrumb[];
  readonly onCrumb?: (id: string | undefined) => void;
  readonly activeDevice: PreviewDevice;
  readonly onDevice: (device: PreviewDevice) => void;
  readonly sizing?: PreviewSizeControlsProps;
  readonly guide: GuideMenuProps;
  readonly interaction?: {
    readonly active: boolean;
    readonly available: boolean;
    readonly toggle: () => void;
  };
  readonly inspector?: PreviewInspectorActions | undefined;
}

// The breadcrumb keeps room for a page name and one element name at 11.5px, such as
// "Home › Layout"; longer trails fold their middle or end in an ellipsis inside it.
const CRUMBS_WIDTH_PX_MIN = 120;

export function PreviewToolbar(props: PreviewToolbarProps) {
  const shownCrumbs = useFoldedCrumbs(props.crumbs);
  return (
    <ToolbarOverflow items={toolbarItems(props)} childrenWidthPxMin={CRUMBS_WIDTH_PX_MIN}>
      <CrumbTrail crumbs={shownCrumbs.crumbs} {...(props.onCrumb === undefined ? {} : { onCrumb: props.onCrumb })} onExpand={shownCrumbs.expand} />
    </ToolbarOverflow>
  );
}

function toolbarItems(props: PreviewToolbarProps): readonly ToolbarItem[] {
  const devices: ToolbarItem = {
    id: 'devices',
    priority: 90,
    content: <DeviceButtons activeDevice={props.activeDevice} onDevice={props.onDevice} />,
    afterPress: 'close',
  };
  const sizing: readonly ToolbarItem[] = props.sizing
    ? [
        {
          id: 'sizing',
          priority: 20,
          content: <PreviewSizeControls {...props.sizing} />,
          afterPress: 'stay',
        },
      ]
    : [];
  return [
    {
      id: 'guide',
      priority: 30,
      content: <GuideMenu {...props.guide} />,
      afterPress: 'stay',
    },
    ...interactionItems(props.interaction),
    ...sizing,
    devices,
    ...inspectorItems(props.inspector),
  ];
}

// Treat the original segmented switch as one overflow item so its shared surface
// and sliding selection remain intact whenever the toolbar has room for it.
function DeviceButtons({ activeDevice, onDevice }: Pick<PreviewToolbarProps, 'activeDevice' | 'onDevice'>) {
  const buttons = useRef(new Map<FixedDevice, HTMLButtonElement>());
  const [indicator, setIndicator] = useState<{ readonly left: number; readonly width: number } | undefined>();
  useLayoutEffect(() => {
    const element = activeDevice === 'custom' ? undefined : buttons.current.get(activeDevice);
    setIndicator(element ? { left: element.offsetLeft, width: element.offsetWidth } : undefined);
  }, [activeDevice]);
  return (
    <div className="device-btns" role="group" aria-label="Preview device">
      {indicator && <span className="device-indicator" style={indicator} />}
      {DEVICES.map(({ key, Icon, title }) => (
        <button
          key={key}
          ref={(element) => {
            if (element) {
              buttons.current.set(key, element);
            } else {
              buttons.current.delete(key);
            }
          }}
          className={activeDevice === key ? 'on' : ''}
          data-tooltip={title}
          aria-label={title}
          aria-pressed={activeDevice === key}
          onClick={() => onDevice(key)}
        >
          <Icon size={13} />
        </button>
      ))}
    </div>
  );
}

function inspectorItems(inspector: PreviewInspectorActions | undefined): readonly ToolbarItem[] {
  if (!inspector) {
    return [];
  }
  const label = inspector.open ? 'Hide style and settings panel' : 'Show style and settings panel';
  const button = (
    <div className="device-btns guide-btns">
      <button
        type="button"
        aria-label={label}
        data-tooltip={label}
        aria-pressed={inspector.open}
        className={inspector.open ? 'on' : ''}
        onClick={inspector.toggle}
      >
        <PanelRightIcon size={13} />
      </button>
    </div>
  );
  return [{ id: 'inspector', priority: 100, content: button, afterPress: 'close' }];
}

function useFoldedCrumbs(crumbs: readonly PreviewCrumb[]): {
  readonly crumbs: readonly ToolbarCrumb[];
  readonly expand: () => void;
} {
  const [expanded, setExpanded] = useState(false);
  const crumbKey = crumbs.map((crumb) => crumb.id).join('/');
  useEffect(() => setExpanded(false), [crumbKey]);
  const shown = useMemo(() => {
    if (expanded || crumbs.length <= 5) {
      return crumbs.map((crumb): VisibleCrumb => ({ kind: 'visible', crumb }));
    }
    const first = crumbs.at(0);
    if (!first) {
      return [];
    }
    const head: VisibleCrumb = { kind: 'visible', crumb: first };
    const folded: FoldedCrumb = {
      kind: 'folded',
      hidden: crumbs.slice(1, crumbs.length - 3),
    };
    return [head, folded, ...crumbs.slice(crumbs.length - 3).map((crumb): VisibleCrumb => ({ kind: 'visible', crumb }))];
  }, [crumbs, expanded]);
  return { crumbs: shown, expand: () => setExpanded(true) };
}

function CrumbTrail({
  crumbs,
  onCrumb,
  onExpand,
}: {
  readonly crumbs: readonly ToolbarCrumb[];
  readonly onCrumb?: (id: string | undefined) => void;
  readonly onExpand: () => void;
}) {
  return (
    <div className="crumbs">
      {crumbs.map((item, index) => (
        <React.Fragment key={item.kind === 'folded' ? 'ellipsis' : `${item.crumb.id}-${index}`}>
          {index > 0 && (
            <span className="crumb-sep">
              <ChevronRightIcon size={9} />
            </span>
          )}
          {item.kind === 'folded' ? (
            <span className="crumb crumb-more" title={foldedTitle(item)} onClick={onExpand}>
              …
            </span>
          ) : (
            <span className={`crumb ${index === crumbs.length - 1 ? 'last' : ''}`} title={item.crumb.label} onClick={() => onCrumb?.(item.crumb.id)}>
              {item.crumb.label}
            </span>
          )}
        </React.Fragment>
      ))}
    </div>
  );
}

function foldedTitle(item: FoldedCrumb): string {
  return `Show ${item.hidden.length} more: ${item.hidden.map((crumb) => crumb.label).join(' › ')}`;
}

function interactionItems(interaction: PreviewToolbarProps['interaction']): readonly ToolbarItem[] {
  if (!interaction) {
    return [];
  }
  const button = (
    <div className="device-btns guide-btns">
      <button
        type="button"
        aria-label="Interact with canvas"
        data-tooltip="Interact with canvas — links, buttons and forms"
        aria-pressed={interaction.active}
        className={interaction.active ? 'on' : ''}
        disabled={!interaction.available}
        onClick={interaction.toggle}
      >
        <InteractIcon />
      </button>
    </div>
  );
  return [{ id: 'interaction', priority: 40, content: button, afterPress: 'close' }];
}
