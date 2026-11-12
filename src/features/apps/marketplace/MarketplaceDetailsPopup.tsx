// A marketplace app's details popup, opened from its row's ⋯. It is laid out like an installed app's details
// (AppDetails.tsx: the same header and the same About and fact-list pieces), so both read as one family: who
// made the app, what it does, where it comes from, what was approved and what it needs. The row itself stays a
// name and an action; everything else is here. Install is in the header, for a role that may install.
import type { ReactNode } from 'react';
import { assert } from '../../../../shared/core/assert';
import { MARKETPLACE_LICENSE, type MarketplaceApp, type MarketplaceVersion } from '../../../../shared/properties/appMarketplace';
import { ExternalIcon } from '../../../ui/Icons';
import Popup from '../../../ui/Popup';
import { AboutText } from '../AppDetails';
import { AppDetailsItem, AppDetailsList, AppDetailsSection } from '../AppDetailsLayout';
import '../appDetails.css';

export interface MarketplaceDetailsProps {
  readonly app: MarketplaceApp;
  /** The newest approved version: the one Install would add. */
  readonly latest: MarketplaceVersion;
  /** The app's icon, drawn by the row's own component so a failed image falls back the same way. */
  readonly icon: ReactNode;
  /** The author's GitHub picture. */
  readonly avatar: ReactNode;
  readonly installed: boolean;
  /** The row's Install button, or nothing for a role that may not install; an installed app shows a tag instead. */
  readonly action: ReactNode;
  readonly onClose: () => void;
}

export function MarketplaceDetailsPopup(props: MarketplaceDetailsProps) {
  const { app, latest } = props;
  assert(app.name.length > 0, 'A marketplace app has a name');
  assert(app.versions.length > 0, 'A marketplace app has an approved version');
  const owner = encodeURIComponent(app.source.owner);
  const repository = encodeURIComponent(app.source.repository);
  return (
    <Popup className="modal apps-details-popup" label={`${app.name} details`} onClose={props.onClose} dismissible={true}>
      {() => (
        <>
          <div className="modal-header apps-details-header">
            {props.icon}
            <span className="apps-details-heading">
              <span className="apps-details-name">{app.name}</span>
              {/* One child, as AppMeta draws the author: the meta row puts a dot before every child after the first. */}
              <span className="apps-details-meta">
                <span className="apps-details-author">
                  <span className="apps-row-avatar">{props.avatar}</span>
                  <span>by {app.author}</span>
                </span>
              </span>
            </span>
            <span className="apps-details-header-actions">{props.installed ? <span className="apps-badge muted">Installed</span> : props.action}</span>
          </div>
          <div className="modal-body apps-details-body">
            <AppDetailsSection label="About">
              <AboutText text={app.description} />
            </AppDetailsSection>
            <AppDetailsSection title="Details">
              <AppDetailsList label={`${app.name} details`}>
                <AppDetailsItem label="Repository">
                  <a className="apps-details-link" href={`https://github.com/${owner}/${repository}`} target="_blank" rel="noopener noreferrer">
                    {app.source.owner}/{app.source.repository}
                    <ExternalIcon size={10} />
                  </a>
                </AppDetailsItem>
                <AppDetailsItem label="Version">v{latest.version}</AppDetailsItem>
                {app.license === MARKETPLACE_LICENSE && <AppDetailsItem label="License">{MARKETPLACE_LICENSE}</AppDetailsItem>}
                {latest.stackiVersionMin !== undefined && <AppDetailsItem label="Needs">Stacki {latest.stackiVersionMin} or later</AppDetailsItem>}
                {app.categories.length > 0 && <AppDetailsItem label="Categories">{app.categories.join(', ')}</AppDetailsItem>}
                <AppDetailsItem label="Approved" hint="Stacki installs only a download whose SHA-256 matches the one recorded when this version was approved.">
                  SHA-256 {latest.sha256.slice(0, 12)}…
                </AppDetailsItem>
              </AppDetailsList>
            </AppDetailsSection>
          </div>
        </>
      )}
    </Popup>
  );
}
