// One icon per audit rule, so a row reads at a glance: an image for alt text,
// a hash for ids, a half-filled circle for contrast. Existing icons
// (src/ui/Icons.tsx) are reused where one says the same thing; the rest are
// drawn here on the same 16px stroke grid.
import type { ComponentType } from 'react';
import type { AuditCheckId } from '../../../shared/page/auditFindings';
import { I, type IconProps } from '../../ui/IconBase';
import {
  ArrowDownIcon,
  BracesIcon,
  CanvasIcon,
  ClockIcon,
  DropletIcon,
  ExternalIcon,
  FileIcon,
  HideIcon,
  LayersIcon,
  NavigatorIcon,
  PreviewIcon,
  TagIcon,
  TextIcon,
  UnlinkIcon,
  VariableIcon,
} from '../../ui/Icons';

type Icon = ComponentType<Pick<IconProps, 'size'>>;

export const ImageIcon: Icon = ({ size }) => (
  <I size={size}>
    <rect x="2.5" y="3" width="11" height="10" rx="1.8" />
    <circle cx="6" cy="6.5" r="1.1" />
    <path d="M3 11.5l3.2-3 2.3 2.1 1.8-1.6 2.7 2.5" />
  </I>
);

export const LinkIcon: Icon = ({ size }) => (
  <I size={size}>
    <path d="M7 9a2.6 2.6 0 0 0 3.7 0l2-2a2.6 2.6 0 0 0-3.7-3.7l-.8.8" />
    <path d="M9 7a2.6 2.6 0 0 0-3.7 0l-2 2A2.6 2.6 0 0 0 7 12.7l.8-.8" />
  </I>
);

export const HashIcon: Icon = ({ size }) => (
  <I size={size}>
    <path d="M6 2.5L5 13.5M11 2.5l-1 11M3 6h10.5M2.5 10H13" />
  </I>
);

export const HeadingIcon: Icon = ({ size }) => (
  <I size={size}>
    <path d="M3.5 3v10M9.5 3v10M3.5 8h6M12 6.5l1.5-1v7.5" />
  </I>
);

export const ContrastIcon: Icon = ({ size }) => (
  <I size={size}>
    <circle cx="8" cy="8" r="5.5" />
    <path d="M8 2.5a5.5 5.5 0 0 1 0 11z" fill="currentColor" />
  </I>
);

export const FormIcon: Icon = ({ size }) => (
  <I size={size}>
    <path d="M3 4.5h5" />
    <rect x="2.5" y="7" width="11" height="4.5" rx="1.2" />
    <path d="M5 9.25h.01" />
  </I>
);

export const GlobeIcon: Icon = ({ size }) => (
  <I size={size}>
    <circle cx="8" cy="8" r="5.5" />
    <path d="M2.5 8h11M8 2.5c1.6 1.7 2.3 3.5 2.3 5.5S9.6 11.8 8 13.5C6.4 11.8 5.7 10 5.7 8S6.4 4.2 8 2.5z" />
  </I>
);

export const AccessibilityIcon: Icon = ({ size }) => (
  <I size={size}>
    <circle cx="8" cy="3.3" r="1.2" />
    <path d="M3.5 5.8L8 6.6l4.5-.8M8 6.6v3M8 9.6l-2 3.9M8 9.6l2 3.9" />
  </I>
);

/** A dashed box: copy or an image that is still a placeholder. */
export const PlaceholderIcon: Icon = ({ size }) => (
  <I size={size}>
    <path d="M3 5V3.5h1.5M7 3h2M11.5 3H13v1.5M13 7v2M13 11.5V13h-1.5M9 13H7M4.5 13H3v-1.5M3 9V7" />
  </I>
);

export const StarIcon: Icon = ({ size }) => (
  <I size={size}>
    <path d="M8 2.5l1.7 3.5 3.8.5-2.8 2.6.7 3.8L8 11.1l-3.4 1.8.7-3.8L2.5 6.5l3.8-.5z" />
  </I>
);

export const ChartIcon: Icon = ({ size }) => (
  <I size={size}>
    <path d="M3 13V9M6.5 13V5.5M10 13V7.5M13.5 13V3" />
  </I>
);

export const RulerIcon: Icon = ({ size }) => (
  <I size={size}>
    <rect x="1.8" y="5.5" width="12.4" height="5" rx="1" />
    <path d="M4.5 5.5v2M7 5.5v1.3M9.5 5.5v2M12 5.5v1.3" />
  </I>
);

export const GaugeIcon: Icon = ({ size }) => (
  <I size={size}>
    <path d="M2.8 11.5a5.5 5.5 0 1 1 10.4 0" />
    <path d="M8 9.5l2.5-3" />
  </I>
);

export const ShiftIcon: Icon = ({ size }) => (
  <I size={size}>
    <rect x="2.5" y="2.5" width="6" height="5" rx="1" />
    <rect x="7.5" y="8.5" width="6" height="5" rx="1" />
    <path d="M10 4.5h2.5V7M6 11.5H3.5V9" />
  </I>
);

export const BlockIcon: Icon = ({ size }) => (
  <I size={size}>
    <circle cx="8" cy="8" r="5.5" />
    <path d="M4.2 11.8l7.6-7.6" />
  </I>
);

/** Go to the element: a crosshair. */
export const CrosshairIcon: Icon = ({ size }) => (
  <I size={size}>
    <circle cx="8" cy="8" r="4.5" />
    <path d="M8 1.5v3M8 11.5v3M1.5 8h3M11.5 8h3" />
  </I>
);

/** Every rule's icon. Total over AUDIT_CHECK_IDS, so a new rule needs one. */
export const AUDIT_ICONS: Readonly<Record<AuditCheckId, Icon>> = {
  'img-alt': ImageIcon,
  'img-decorative': ImageIcon,
  'img-dimensions': ImageIcon,
  'img-large': ImageIcon,
  'link-name': LinkIcon,
  'link-text': LinkIcon,
  'link-noopener': LinkIcon,
  'link-broken': UnlinkIcon,
  'button-name': AccessibilityIcon,
  'svg-button-label': AccessibilityIcon,
  'aria-role': AccessibilityIcon,
  'aria-hidden-focusable': AccessibilityIcon,
  'tabindex-positive': AccessibilityIcon,
  'control-label': FormIcon,
  'heading-order': HeadingIcon,
  'h1-count': HeadingIcon,
  'html-lang': GlobeIcon,
  'duplicate-id': HashIcon,
  contrast: ContrastIcon,
  'video-autoplay': PreviewIcon,
  'iframe-title': CanvasIcon,
  'title-missing': TextIcon,
  'title-duplicate': TextIcon,
  'description-missing': TextIcon,
  'description-duplicate': TextIcon,
  'description-short': TextIcon,
  'description-long': TextIcon,
  canonical: TagIcon,
  'social-tags': TagIcon,
  noindex: HideIcon,
  sitemap: NavigatorIcon,
  robots: FileIcon,
  'structured-data': BracesIcon,
  'placeholder-text': PlaceholderIcon,
  'placeholder-image': PlaceholderIcon,
  'launch-favicon': StarIcon,
  'launch-404': FileIcon,
  'launch-social-image': ImageIcon,
  'launch-analytics': ChartIcon,
  'token-color': DropletIcon,
  'token-value': VariableIcon,
  'token-unit': RulerIcon,
  'style-global': LayersIcon,
  'style-layer': LayersIcon,
  'perf-lcp': GaugeIcon,
  'perf-cls': ShiftIcon,
  'perf-tbt': ClockIcon,
  'perf-weight': ArrowDownIcon,
  'perf-blocking': BlockIcon,
  'perf-image-size': ImageIcon,
  'perf-image-format': ImageIcon,
  'perf-lazy': ImageIcon,
  'perf-fetchpriority': ImageIcon,
  'perf-font-display': TextIcon,
  'perf-third-party': ExternalIcon,
};
