import { centralIcon } from '../../ui/central/CentralIcon';
import {
  accessibility as centralAccessibility,
  block as centralBlock,
  chart as centralChart,
  contrast as centralContrast,
  gauge as centralGauge,
  globe as centralGlobe,
  headingOne as centralH1,
  image as centralImage,
  input as centralInput,
  link as centralLink,
  move as centralMove,
  number as centralNumber,
  placeholder as centralPlaceholder,
  ruler as centralRuler,
  star as centralStar,
  target as centralTarget,
} from '../../ui/central/centralGeometry';
// One icon per audit rule, so a row reads at a glance: an image for alt text,
// a hash for ids, a half-filled circle for contrast. Existing icons
// (src/ui/Icons.tsx) are reused where one says the same thing.
import type { ComponentType } from 'react';
import type { AuditCheckId } from '../../../shared/page/auditFindings';
import type { IconProps } from '../../ui/IconBase';
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

export const ImageIcon: Icon = centralIcon(centralImage);

export const LinkIcon: Icon = centralIcon(centralLink);

export const HashIcon: Icon = centralIcon(centralNumber);

export const HeadingIcon: Icon = centralIcon(centralH1);

export const ContrastIcon: Icon = centralIcon(centralContrast);

export const FormIcon: Icon = centralIcon(centralInput);

export const GlobeIcon: Icon = centralIcon(centralGlobe);

export const AccessibilityIcon: Icon = centralIcon(centralAccessibility);

/** A dashed box: copy or an image that is still a placeholder. */
export const PlaceholderIcon: Icon = centralIcon(centralPlaceholder);

export const StarIcon: Icon = centralIcon(centralStar);

export const ChartIcon: Icon = centralIcon(centralChart);

export const RulerIcon: Icon = centralIcon(centralRuler);

export const GaugeIcon: Icon = centralIcon(centralGauge);

export const ShiftIcon: Icon = centralIcon(centralMove);

export const BlockIcon: Icon = centralIcon(centralBlock);

/** Go to the element: a crosshair. */
export const CrosshairIcon: Icon = centralIcon(centralTarget);

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
