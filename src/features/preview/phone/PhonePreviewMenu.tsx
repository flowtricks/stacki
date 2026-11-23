// The phone preview, in the title bar's address bar: a globe beside "Open in browser" that opens a popover.
// Its header names it ("Phone preview"), carries the "?" tip (same Wi-Fi, the firewall) and the switch that
// opens the preview on the local network. While on, one card holds what a phone needs: the QR code on a
// light tile and, under it, the address on one line with a copy button. While the server restarts, the card
// holds skeleton shapes of the same size, so nothing jumps. While on, the globe in the bar shows the pressed
// fill and turns the primary blue. Desktop only: the address bar is Desktop's own (AppShell UrlGroup takes it
// as `trailing`); Studio and the demo have no dev server of their own to restart, so they never get it.
//
// Fills, never borders or dividers: the card is a fill on the popover's surface.
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { networkPageURL, type LanAddress } from '../../../../shared/ipc/devNetwork';
import { useTranslate } from '../../../lib/i18n/useTranslate';
import { CodeInline } from '../../../ui/CodeBlock';
import { centralIcon } from '../../../ui/central/CentralIcon';
import { globe as centralGlobe } from '../../../ui/central/centralGeometry';
import { tooltipAnchor, tooltipHost, useDelayedPlacement, type TooltipAnchor } from '../../../ui/delayedTooltip';
import FittedTooltip from '../../../ui/FittedTooltip';
import Dropdown from '../../../ui/Dropdown';
import { CheckIcon, CopyIcon, HelpCircleIcon } from '../../../ui/Icons';
import Popup from '../../../ui/Popup';
import { Skeleton } from '../../../ui/Skeleton';
import { Switch } from '../../../ui/Switch';
import { phoneAddressText } from './phoneAddress';
import { QR_TILE_PX, QrCodeImage } from './QrCodeImage';
import { usePhonePreview, type PhonePreview, type PhonePreviewState } from './usePhonePreview';
import '../../../ui/menu.css';
import './phonePreview.css';

const GlobeIcon = centralIcon(centralGlobe);

/** How long the copy button shows its check after a copy. */
const COPIED_MS = 1500;
// 14.5rem at the app's 16px root: the 13rem code plus 12px of popover padding on each side, so the code fills the popover with no empty bands, and the address of a typical network still fits on one line (phoneAddress.ts).
const MENU_WIDTH_PX = 232;
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
      <PhonePreviewCard state={state} route={route} onCopyFailed={onCopyFailed} />
    </div>
  );
}

// Off: no card. Restarting: the card's shapes. On: the code, the address and, with several, the address picker.
function PhonePreviewCard({ state, route, onCopyFailed }: { readonly state: PhonePreviewState; readonly route: string; readonly onCopyFailed: () => void }) {
  const [chosen, setChosen] = useState<string | undefined>(undefined);
  switch (state.kind) {
    case 'off':
      return undefined;
    case 'changing':
      return <PhonePreviewSkeleton />;
    case 'on': {
      // The chosen address while it is still offered, else the best one.
      const address = state.addresses.find((candidate) => candidate.address === chosen) ?? state.addresses[0];
      if (address === undefined) {
        return undefined; // Main turns the mode off when there is no address; a network that went away since leaves nothing to show.
      }
      const url = networkPageURL(address, state.port, route);
      return (
        <div className="phone-preview-card">
          <PhoneQr url={url} />
          {state.addresses.length > 1 && <AddressPicker addresses={state.addresses} chosen={address} onChoose={setChosen} />}
          <PhoneAddress url={url} onCopyFailed={onCopyFailed} />
        </div>
      );
    }
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}

function PhoneQr({ url }: { readonly url: string }) {
  const translate = useTranslate();
  return <QrCodeImage text={url} label={translate('preview.phone.qr', { url })} />;
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

// The address on one line (phoneAddress.ts writes it), and Copy, which shows a check for a moment in the
// same box: the icon swaps, nothing around it moves.
function PhoneAddress({ url, onCopyFailed }: { readonly url: string; readonly onCopyFailed: () => void }) {
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
      <span className="phone-preview-url" title={url}>
        <CodeInline text={phoneAddressText(url)} language="shell" />
      </span>
      <button type="button" className="phone-preview-icon-button" aria-label={copyLabel} data-copied={copied || undefined} onClick={copy}>
        {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
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
