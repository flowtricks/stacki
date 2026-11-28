// The phone preview, in the title bar's address bar: a globe beside "Open in browser" that opens a popover.
// Its header names it ("Phone preview"), carries the "?" tip (same Wi-Fi, the firewall) and the switch that
// opens the preview on the local network. While on, one card holds what a phone needs: the QR code on a
// light tile and, under it, the address on one line with a copy button. While the server restarts, the card
// holds skeleton shapes of the same size, so nothing jumps. While on, the globe in the bar shows the pressed
// fill and turns the primary blue. Desktop only: the address bar is Desktop's own (AppShell UrlGroup takes it
// as `trailing`); Studio and the demo have no dev server of their own to restart, so they never get it.
//
// Beside Copy, a gear opens the card's one setting: "Only devices that scan this code". Off by default and
// never remembered; on, the code and the copied address carry a key (shared/ipc/devNetwork.ts), and every
// other device on the Wi-Fi is refused. The address under the code is always shown without the key.
//
// Fills, never borders or dividers: the card is a fill on the popover's surface.
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { NETWORK_ACCESS_OPEN, networkPageURL, type DevNetworkAccess, type LanAddress } from '../../../../shared/ipc/devNetwork';
import { useTranslate } from '../../../lib/i18n/useTranslate';
import { CodeInline } from '../../../ui/CodeBlock';
import { centralIcon } from '../../../ui/central/CentralIcon';
import { globe as centralGlobe } from '../../../ui/central/centralGeometry';
import { tooltipAnchor, tooltipHost, useDelayedPlacement, type TooltipAnchor } from '../../../ui/delayedTooltip';
import FittedTooltip from '../../../ui/FittedTooltip';
import Dropdown from '../../../ui/Dropdown';
import { CheckIcon, CopyIcon, GearIcon, HelpCircleIcon } from '../../../ui/Icons';
import Popup from '../../../ui/Popup';
import { Skeleton } from '../../../ui/Skeleton';
import { Switch, SwitchRow } from '../../../ui/Switch';
import { phoneAddressText } from './phoneAddress';
import { QR_TILE_PX, QrCodeImage } from './QrCodeImage';
import { usePhonePreview, type PhonePreview, type PhonePreviewState } from './usePhonePreview';
import '../../../ui/menu.css';
import './phonePreview.css';

const GlobeIcon = centralIcon(centralGlobe);

/** How long the copy button shows its check after a copy. */
const COPIED_MS = 1500;
// 16.25rem at the app's 16px root: the 14.75rem code plus 12px of popover padding on each side, so the code fills the popover with no empty bands. The address row holds Copy and the settings gear, and the address of a typical network still fits on one line beside them (phoneAddress.ts).
const MENU_WIDTH_PX = 260;
const MENU_EDGE_PX = 8;

export interface PhonePreviewMenuProps {
  readonly preview: PhonePreview;
  /** The page the canvas shows, as a path (`/`, `/blog/post`). */
  readonly route: string;
  readonly onCopyFailed: () => void;
}

/**
 * Desktop's globe for the address bar: drawn while the project's dev server runs, absent otherwise (a hidden
 * option, never a greyed one). The state is read from main, so the globe shows the running server's mode.
 */
export function PhonePreviewButton(input: {
  readonly projectPath: string;
  readonly devUrl: string | undefined;
  readonly devStatus: string | undefined;
  readonly route: string | undefined;
  readonly showToast: (message: string, kind: 'error') => void;
}) {
  const translate = useTranslate();
  const running = input.devStatus === 'on' ? input.devUrl : undefined;
  const preview = usePhonePreview({ projectPath: input.projectPath, devUrl: running, showToast: input.showToast, translate });
  if (running === undefined) {
    return undefined;
  }
  const route = input.route !== undefined && input.route.startsWith('/') ? input.route : '/';
  const onCopyFailed = (): void => input.showToast(translate('preview.phone.error.copy'), 'error');
  return <PhonePreviewMenu preview={preview} route={route} onCopyFailed={onCopyFailed} />;
}

export function PhonePreviewMenu(props: PhonePreviewMenuProps) {
  const translate = useTranslate();
  const button = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const label = translate('preview.phone.label');
  return (
    <>
      <button
        ref={button}
        type="button"
        className={props.preview.state.kind === 'on' ? 'titlebar-btn url-phone on' : 'titlebar-btn url-phone'}
        title={label}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <GlobeIcon size={14} />
      </button>
      {button.current !== null && (
        <Popup
          mode="popover"
          open={open}
          anchor={button.current}
          onClose={() => setOpen(false)}
          className="menu-surface phone-preview"
          role="dialog"
          label={label}
          style={menuPosition(button.current)}
        >
          <PhonePreviewRows {...props} />
        </Popup>
      )}
    </>
  );
}

function PhonePreviewRows({ preview, route, onCopyFailed }: PhonePreviewMenuProps) {
  const translate = useTranslate();
  const { state } = preview;
  const on = state.kind === 'on' || (state.kind === 'changing' && state.toward === 'network');
  return (
    <div className="phone-preview-body">
      <div className="phone-preview-header">
        <span className="phone-preview-title">{translate('preview.phone.label')}</span>
        <PhoneHelp />
        <span className="phone-preview-switch">
          <Switch label={translate('preview.phone.toggle')} checked={on} disabled={state.kind === 'changing'} onToggle={preview.toggle} />
        </span>
      </div>
      <PhonePreviewCard preview={preview} route={route} onCopyFailed={onCopyFailed} />
    </div>
  );
}

// Off: no card. Restarting: the card's shapes, unless only the access changes, when the card keeps its place,
// dimmed, with the setting already showing what was asked. On: the code, the address and, with several, the
// address picker; under the address, the card's setting while the gear has it open.
function PhonePreviewCard({ preview, route, onCopyFailed }: { readonly preview: PhonePreview; readonly route: string; readonly onCopyFailed: () => void }) {
  const [chosen, setChosen] = useState<string | undefined>(undefined);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const translate = useTranslate();
  const { state } = preview;
  // What the card draws: the running server's state and whether it is restarting toward another access.
  let on: Extract<PhonePreviewState, { readonly kind: 'on' }>;
  let restarting: DevNetworkAccess | undefined = undefined;
  switch (state.kind) {
    case 'off':
      return undefined;
    case 'changing': {
      if (state.keep === undefined) {
        return <PhonePreviewSkeleton />;
      }
      on = state.keep.on;
      restarting = state.keep.access;
      break;
    }
    case 'on': {
      on = state;
      break;
    }
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
  // The chosen address while it is still offered, else the best one.
  const address = on.addresses.find((candidate) => candidate.address === chosen) ?? on.addresses[0];
  if (address === undefined) {
    return undefined; // Main turns the mode off when there is no address; a network that went away since leaves nothing to show.
  }
  // What the code holds and Copy copies (with the key, when only scanned devices may open it), and what is shown.
  const url = networkPageURL(address, on.port, route, on.access);
  const shown = networkPageURL(address, on.port, route, NETWORK_ACCESS_OPEN);
  const access = restarting ?? on.access.kind;
  return (
    <div className="phone-preview-card" aria-busy={restarting !== undefined} data-restarting={restarting === undefined ? undefined : ''}>
      <PhoneQr url={url} shown={shown} />
      {on.addresses.length > 1 && <AddressPicker addresses={on.addresses} chosen={address} onChoose={setChosen} />}
      <PhoneAddress url={url} shown={shown} settingsOpen={settingsOpen} onSettings={() => setSettingsOpen(!settingsOpen)} onCopyFailed={onCopyFailed} />
      {settingsOpen && (
        <div className="phone-preview-settings">
          <SwitchRow
            label={translate('preview.phone.scannedOnly')}
            checked={access === 'key'}
            disabled={restarting !== undefined}
            onToggle={() => preview.chooseAccess(access === 'key' ? 'open' : 'key')}
          />
        </div>
      )}
    </div>
  );
}

// The code holds `url`; its label names `shown`, the address without the key, so a screen reader never reads it out.
function PhoneQr({ url, shown }: { readonly url: string; readonly shown: string }) {
  const translate = useTranslate();
  return <QrCodeImage text={url} label={translate('preview.phone.qr', { url: shown })} />;
}

// The card's own shapes while the server restarts: the tile and the address line, at their real sizes.
function PhonePreviewSkeleton() {
  const translate = useTranslate();
  return (
    <div className="phone-preview-card" aria-busy="true" aria-label={translate('preview.phone.url')}>
      <Skeleton width={`${QR_TILE_PX}px`} height={`${QR_TILE_PX}px`} radius="8px" />
      <span className="phone-preview-address phone-preview-address-pending">
        <Skeleton width="100%" height="32px" radius="8px" />
      </span>
    </div>
  );
}

// The address on one line (phoneAddress.ts writes it, without the key), Copy, which copies the code's own
// address and shows a check for a moment in the same box (the icon swaps, nothing around it moves), and the
// gear that opens the card's setting.
function PhoneAddress({
  url,
  shown,
  settingsOpen,
  onSettings,
  onCopyFailed,
}: {
  readonly url: string;
  readonly shown: string;
  readonly settingsOpen: boolean;
  readonly onSettings: () => void;
  readonly onCopyFailed: () => void;
}) {
  const translate = useTranslate();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = (): void => {
    navigator.clipboard.writeText(url).then(
      () => {
        setCopied(true);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), COPIED_MS);
      },
      () => onCopyFailed(),
    );
  };
  const copyLabel = copied ? translate('preview.phone.copied') : translate('preview.phone.copy');
  return (
    <div className="phone-preview-address" role="group" aria-label={translate('preview.phone.url')}>
      <span className="phone-preview-url" title={shown}>
        <CodeInline text={phoneAddressText(shown)} language="shell" />
      </span>
      <button type="button" className="phone-preview-icon-button" aria-label={copyLabel} data-copied={copied || undefined} onClick={copy}>
        {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
      </button>
      <button
        type="button"
        className="phone-preview-icon-button"
        aria-label={translate('preview.phone.settings')}
        title={translate('preview.phone.settings')}
        aria-expanded={settingsOpen}
        data-open={settingsOpen || undefined}
        onClick={onSettings}
      >
        <GearIcon size={14} />
      </button>
    </div>
  );
}

// The "?" beside the title: why a phone may not connect (the Wi-Fi, the firewall), in a tooltip, never a paragraph.
function PhoneHelp() {
  const translate = useTranslate();
  const tip = useDelayedPlacement(measureAnchor);
  const element = useRef<HTMLButtonElement>(null);
  const text = translate('preview.phone.firewall');
  return (
    <>
      <button
        ref={element}
        type="button"
        className="phone-preview-icon-button phone-preview-help"
        aria-label={translate('preview.phone.help')}
        aria-description={text}
        onMouseEnter={(event) => tip.show(event.currentTarget)}
        onMouseLeave={tip.hide}
        onFocus={(event) => tip.showNow(event.currentTarget)}
        onBlur={tip.hide}
      >
        <HelpCircleIcon size={14} />
      </button>
      {tip.value !== undefined &&
        createPortal(
          <FittedTooltip className="settings-info-tip" role="tooltip" anchor={tip.value}>
            {text}
          </FittedTooltip>,
          tooltipHost(element.current ?? undefined),
        )}
    </>
  );
}

// More than one network (Wi-Fi and Ethernet, or a VPN beside them): the best is shown, the others a pick away.
function AddressPicker({
  addresses,
  chosen,
  onChoose,
}: {
  readonly addresses: readonly LanAddress[];
  readonly chosen: LanAddress;
  readonly onChoose: (address: string) => void;
}) {
  const translate = useTranslate();
  return (
    <Dropdown
      className="phone-preview-picker"
      ariaLabel={translate('preview.phone.url')}
      value={chosen.address}
      options={addresses.map((candidate) => ({ value: candidate.address, label: candidate.address, description: candidate.interfaceName }))}
      optionLayout="stacked"
      onChange={onChoose}
    />
  );
}

function measureAnchor(element: HTMLElement): TooltipAnchor {
  return tooltipAnchor(element.getBoundingClientRect());
}

// Under the globe, right-aligned to it, inside the window on every side.
export function menuPosition(anchor: HTMLElement) {
  const rect = anchor.getBoundingClientRect();
  const width = Math.min(MENU_WIDTH_PX, window.innerWidth - MENU_EDGE_PX * 2);
  return {
    position: 'fixed' as const,
    top: rect.bottom + 6,
    left: Math.max(MENU_EDGE_PX, Math.min(rect.right - width, window.innerWidth - width - MENU_EDGE_PX)),
    width,
    maxHeight: Math.max(80, window.innerHeight - rect.bottom - 14),
  };
}
