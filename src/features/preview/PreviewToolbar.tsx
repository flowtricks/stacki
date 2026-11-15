import { centralIcon } from '../../ui/central/CentralIcon';
import { cursorClick as centralCursorClick } from '../../ui/central/centralGeometry';
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { IconProps } from '../../ui/Icons';
import {
  AllBreakpointsIcon,
  ChevronRightIcon,
  DesktopIcon,
  LaptopIcon,
  PanelRightIcon,
  PhoneIcon,
  SmartwatchIcon,
  StudioDisplayXdrIcon,
  TabletIcon,
  TelevisionIcon,
} from '../../ui/Icons';
import type { ResolvedBreakpoint } from '../../../shared/properties/projectBreakpoints';
import { barDevices, shortcutOf, type BarDevice, type DeviceIconKind, type PreviewDevice } from './breakpointDevices';
import { breakpointLabel } from './breakpointLabel';
import { PreviewSizeControls } from './PreviewSizeControls';
import { GuideMenu, type GuideMenuProps } from './GuideMenu';
import type { PreviewSizeControlsProps } from './PreviewSizeControls';
import { useTranslate } from '../../lib/i18n/useTranslate';
import type { Translator } from '../../lib/i18n/localeContext';
import { ToolbarOverflow, type ToolbarItem } from './ToolbarOverflow';

const InteractIcon = centralIcon(centralCursorClick);

export type { PreviewDevice } from './breakpointDevices';
export { deviceForWidth, deviceWidth } from './breakpointDevices';

const DEVICE_ICONS: Readonly<Record<DeviceIconKind, React.ComponentType<IconProps>>> = {
  desktop: DesktopIcon,
  laptop: LaptopIcon,
  tablet: TabletIcon,
  phone: PhoneIcon,
  studioDisplayXdr: StudioDisplayXdrIcon,
  television: TelevisionIcon,
  smartwatch: SmartwatchIcon,
  canvas: AllBreakpointsIcon,
};

/** The icon component of a device kind: the same ones Settings draws on its cards. */
export function deviceIconComponent(kind: DeviceIconKind): React.ComponentType<IconProps> {
  return DEVICE_ICONS[kind];
}

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

// In a collapsed editor the Style and Settings panel floats over the canvas; one toolbar
// button opens it and closes it again. The panel keeps its own Style and Settings tabs.
export interface PreviewInspectorActions {
  readonly open: boolean;
  readonly toggle: () => void;
}

interface PreviewToolbarProps {
  /** The project's breakpoints with their canvas widths: one button each, and the pixel numbers in the tooltips. */
  readonly breakpoints: readonly ResolvedBreakpoint[];
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
  const translate = useTranslate();
  const shownCrumbs = useFoldedCrumbs(props.crumbs);
  return (
    <ToolbarOverflow items={toolbarItems(props, translate)} childrenWidthPxMin={CRUMBS_WIDTH_PX_MIN}>
      <CrumbTrail crumbs={shownCrumbs.crumbs} {...(props.onCrumb === undefined ? {} : { onCrumb: props.onCrumb })} onExpand={shownCrumbs.expand} />
    </ToolbarOverflow>
  );
}

function toolbarItems(props: PreviewToolbarProps, translate: Translator): readonly ToolbarItem[] {
  const devices: ToolbarItem = {
    id: 'devices',
    priority: 90,
    content: <DeviceButtons activeDevice={props.activeDevice} onDevice={props.onDevice} breakpoints={props.breakpoints} />,
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
    ...interactionItems(props.interaction, translate),
    ...sizing,
    devices,
    ...inspectorItems(props.inspector, translate),
  ];
}

// Treat the original segmented switch as one overflow item so its shared surface
// and sliding selection remain intact whenever the toolbar has room for it.
export function DeviceButtons({ activeDevice, onDevice, breakpoints }: Pick<PreviewToolbarProps, 'activeDevice' | 'onDevice' | 'breakpoints'>) {
  const translate = useTranslate();
  const devices = barDevices(breakpoints);
  const buttons = useRef(new Map<PreviewDevice, HTMLButtonElement>());
  const [indicator, setIndicator] = useState<{ readonly left: number; readonly width: number } | undefined>();
  const devicesSignature = devices.map((device) => device.key).join(',');
  useLayoutEffect(() => {
    const element = activeDevice === 'custom' ? undefined : buttons.current.get(activeDevice);
    setIndicator(element ? { left: element.offsetLeft, width: element.offsetWidth } : undefined);
  }, [activeDevice, devicesSignature]);
  return (
    <div className="device-btns" role="group" aria-label={translate('preview.device.group')}>
      {indicator && <span className="device-indicator" style={indicator} />}
      {devices.map((device) => {
        const Icon = deviceIconComponent(device.icon);
        const title = deviceTitle(device, devices, translate);
        return (
          <button
            key={device.key}
            ref={(element) => {
              if (element) {
                buttons.current.set(device.key, element);
              } else {
                buttons.current.delete(device.key);
              }
            }}
            className={activeDevice === device.key ? 'on' : ''}
            data-tooltip={title}
            aria-label={title}
            aria-pressed={activeDevice === device.key}
            onClick={() => onDevice(device.key)}
          >
            <Icon size={13} />
          </button>
        );
      })}
    </div>
  );
}

// A breakpoint names its width and its key (`Tablet (767px) — 3`); Desktop and the canvas name only their key. A device past the ninth
// position has no key to name.
function deviceTitle(device: BarDevice, devices: readonly BarDevice[], translate: Translator): string {
  const key = shortcutOf(device, devices);
  if (device.breakpoint === undefined) {
    if (device.key === 'desktop') {
      return key === undefined ? translate('preview.device.desktopNoKey') : translate('preview.device.desktop', { key });
    }
    return key === undefined ? translate('preview.device.canvasNoKey') : translate('preview.device.canvas', { key });
  }
  const name = breakpointLabel(device.breakpoint, translate);
  const width = device.breakpoint.widthPx;
  return key === undefined ? translate('preview.device.itemNoKey', { name, width }) : translate('preview.device.item', { name, width, key });
}

function inspectorItems(inspector: PreviewInspectorActions | undefined, translate: Translator): readonly ToolbarItem[] {
  if (!inspector) {
    return [];
  }
  const label = inspector.open ? translate('preview.inspector.hide') : translate('preview.inspector.show');
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
  const translate = useTranslate();
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
            <span className="crumb crumb-more" title={foldedTitle(item, translate)} onClick={onExpand}>
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

function foldedTitle(item: FoldedCrumb, translate: Translator): string {
  return translate('preview.crumbs.more', { count: item.hidden.length, names: item.hidden.map((crumb) => crumb.label).join(' › ') });
}

function interactionItems(interaction: PreviewToolbarProps['interaction'], translate: Translator): readonly ToolbarItem[] {
  if (!interaction) {
    return [];
  }
  const button = (
    <div className="device-btns guide-btns">
      <button
        type="button"
        aria-label={translate('preview.interact.label')}
        data-tooltip={translate('preview.interact.tip')}
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
