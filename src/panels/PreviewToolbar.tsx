import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { IconProps } from '../ui/Icons';
import { CanvasIcon, ChevronRightIcon, DesktopIcon, PhoneIcon, TabletIcon } from '../ui/Icons';
import { PreviewSizeControls } from './PreviewSizeControls';
import type { PreviewSizeControlsProps } from './PreviewSizeControls';

export type PreviewDevice = 'desktop' | 'tablet' | 'phone' | 'canvas' | 'custom';
type FixedDevice = Exclude<PreviewDevice, 'custom'>;

interface DeviceDefinition {
  readonly key: FixedDevice;
  readonly Icon: React.ComponentType<IconProps>;
  readonly title: string;
  readonly width: number | null;
  readonly from?: number;
}

export const DEVICES: readonly DeviceDefinition[] = [
  { key: 'desktop', Icon: DesktopIcon, title: 'Desktop — 1', width: null, from: 1024 },
  { key: 'tablet', Icon: TabletIcon, title: 'Tablet (768px) — 2', width: 768, from: 768 },
  { key: 'phone', Icon: PhoneIcon, title: 'Phone (375px) — 3', width: 375, from: 0 },
  { key: 'canvas', Icon: CanvasIcon, title: 'Canvas — all breakpoints — 4', width: null },
];

export interface PreviewCrumb {
  readonly id: string | null;
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

export function deviceForWidth(px: number): FixedDevice | null {
  if (!Number.isFinite(px) || px <= 0) {
    return null;
  }
  return DEVICES.find((device) => device.from !== undefined && px >= device.from)?.key ?? null;
}

export function deviceWidth(device: PreviewDevice): number | null | undefined {
  return DEVICES.find((entry) => entry.key === device)?.width;
}

export function PreviewToolbar({
  crumbs,
  onCrumb,
  activeDevice,
  onDevice,
  sizing,
}: {
  readonly crumbs: readonly PreviewCrumb[];
  readonly onCrumb?: (id: string | null) => void;
  readonly activeDevice: PreviewDevice;
  readonly onDevice: (device: PreviewDevice) => void;
  readonly sizing?: PreviewSizeControlsProps;
}) {
  const shownCrumbs = useFoldedCrumbs(crumbs);
  const buttonRefs = useRef<Partial<Record<FixedDevice, HTMLButtonElement | null>>>({});
  const [indicator, setIndicator] = useState<{
    readonly left: number;
    readonly width: number;
  } | null>(null);
  useLayoutEffect(() => {
    const element = activeDevice === 'custom' ? undefined : buttonRefs.current[activeDevice];
    setIndicator(element ? { left: element.offsetLeft, width: element.offsetWidth } : null);
  }, [activeDevice]);
  return (
    <div className="preview-toolbar">
      <CrumbTrail
        crumbs={shownCrumbs.crumbs}
        {...(onCrumb === undefined ? {} : { onCrumb })}
        onExpand={shownCrumbs.expand}
      />
      <div className="device-btns">
        {indicator && <span className="device-indicator" style={indicator} />}
        {DEVICES.map(({ key, Icon, title }) => (
          <button
            key={key}
            ref={(element) => {
              buttonRefs.current[key] = element;
            }}
            className={activeDevice === key ? 'on' : ''}
            title={title}
            onClick={() => onDevice(key)}
          >
            <Icon size={13} />
          </button>
        ))}
      </div>
      {sizing && <PreviewSizeControls {...sizing} />}
    </div>
  );
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
    return [
      head,
      folded,
      ...crumbs.slice(crumbs.length - 3).map((crumb): VisibleCrumb => ({ kind: 'visible', crumb })),
    ];
  }, [crumbs, expanded]);
  return { crumbs: shown, expand: () => setExpanded(true) };
}

function CrumbTrail({
  crumbs,
  onCrumb,
  onExpand,
}: {
  readonly crumbs: readonly ToolbarCrumb[];
  readonly onCrumb?: (id: string | null) => void;
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
            <span
              className={`crumb ${index === crumbs.length - 1 ? 'last' : ''}`}
              title={item.crumb.label}
              onClick={() => onCrumb?.(item.crumb.id)}
            >
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
