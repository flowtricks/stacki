import { type IconProps, ASTRO_ASSET_ACCENT, I, I24 } from './IconBase';
import * as paths from './iconPaths';
export {
  ElementComponentIcon,
  ElementSlotIcon,
  CustomElementIcon,
  ElementDivIcon,
  ElementImageIcon,
  ElementSectionIcon,
  ElementListDefaultIcon,
  ElementListItemIcon,
  ElementLinkIcon,
  ElementHeading1Icon,
  ElementHeading2Icon,
  ElementHeading3Icon,
  ElementHeading4Icon,
  ElementHeading5Icon,
  ElementHeading6Icon,
  ElementParagraphIcon,
  ElementVideoIcon,
  ElementFormBlockIcon,
  ElementInputIcon,
  ElementSelectIcon,
  ElementButtonIcon,
  HomeIcon,
  elementIcon,
} from './ElementIcons';

export { type IconProps, ASTRO_ASSET_ACCENT } from './IconBase';

export const ComponentEditIcon = (props: IconProps) => (
  <I {...props} filled>
    <path fillRule="evenodd" clipRule="evenodd" d={paths.componentEditIconPath} />
    <path d="M9 13H9.70711L14.3536 8.35359L13.6464 7.64648L9 12.2929V13Z" />
  </I>
);

export const GitHubIcon = (props: IconProps) => (
  <I24 {...props}>
    <path fill="currentColor" d={paths.githubIconPath} />
  </I24>
);

export const SanityIcon = (props: IconProps) => (
  <I24 {...props}>
    <path fill="currentColor" d={paths.sanityIconPath} />
  </I24>
);

export const PayloadIcon = (props: IconProps) => (
  <I24 {...props}>
    <path fill="currentColor" d={paths.payloadIconPath} />
  </I24>
);

// Brand marks inherit the label colour to stay legible on both white and dark buttons.
export const LumosIcon = ({ size = 16, className, style }: IconProps) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 123 120"
    fill="currentColor"
    className={className}
    style={{ display: 'block', flexShrink: 0, ...style, pointerEvents: 'none' }}
    aria-hidden="true"
  >
    <path d={paths.lumosIconPath} />
  </svg>
);

export const AstroIcon = ({ size = 16, className, style }: IconProps) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 370 467"
    fill="currentColor"
    className={className}
    style={{ display: 'block', flexShrink: 0, ...style, pointerEvents: 'none' }}
    aria-hidden="true"
  >
    <path d={paths.astroIconFlamePath} />
    <path d={paths.astroIconLetterPath} />
  </svg>
);

export const FileIcon = (props: IconProps) => (
  <I {...props}>
    <path d={fileIconPath1} />
    <path d="M8.9 1.9v3h3" />
  </I>
);

// An easing curve: what the editor behind it edits.
export const EaseIcon = (props: IconProps) => (
  <I {...props}>
    <path d="M2 13c5.5 0 5-10 12-10" />
  </I>
);

export const ComponentIcon = (props: IconProps) => (
  <I {...props}>
    <rect x="5.2" y="5.2" width="5.6" height="5.6" rx="0.8" transform="rotate(45 8 8)" />
  </I>
);

// Three tall columns represent the preview's column guide.
export const GuideIcon = (props: IconProps) => (
  <I {...props}>
    <rect x="1" y="2" width="2" height="12" rx="0.5" />
    <rect x="7" y="2" width="2" height="12" rx="0.5" />
    <rect x="13" y="2" width="2" height="12" rx="0.5" />
  </I>
);

export const LayoutIcon = (props: IconProps) => (
  <I {...props}>
    <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
    <path d="M2 6h12M6 6v7.5" />
  </I>
);

export const TextIcon = (props: IconProps) => (
  <I {...props}>
    <path d="M3.5 4.5V3.5h9v1M8 3.5v9M6.3 12.5h3.4" />
  </I>
);

export const CommentIcon = (props: IconProps) => (
  <I {...props}>
    <path d={commentIconPath1} />
  </I>
);

export const CodeIcon = (props: IconProps) => (
  <I {...props}>
    <path d="m5.5 5-3 3 3 3M10.5 5l3 3-3 3" />
  </I>
);

export const PencilIcon = (props: IconProps) => (
  <I {...props}>
    <path d="M11.2 2.6a1.3 1.3 0 0 1 1.85 1.85L5.6 11.9l-2.45.6.6-2.45Z" />
    <path d="m10.1 3.7 2.2 2.2" />
  </I>
);

export const TagIcon = (props: IconProps) => (
  <I {...props}>
    <path d="m6 3.5-4 4.5 4 4.5M10 3.5l4 4.5-4 4.5" />
  </I>
);

export const ChevronLeftIcon = (props: IconProps) => (
  <I {...props}>
    <path d="m10 4-4 4 4 4" />
  </I>
);

export const ChevronRightIcon = (props: IconProps) => (
  <I {...props}>
    <path d="m6 4 4 4-4 4" />
  </I>
);

export const ChevronDownIcon = (props: IconProps) => (
  <I {...props}>
    <path d="m4 6 4 4 4-4" />
  </I>
);

export const PlusIcon = (props: IconProps) => (
  <I {...props}>
    <path d="M8 3v10M3 8h10" />
  </I>
);

export const RefreshIcon = (props: IconProps) => (
  <I {...props}>
    <path d="M13 8a5 5 0 1 1-1.47-3.54" />
    <path d="M13.2 2.6v2.6h-2.6" />
  </I>
);

export const CloseIcon = (props: IconProps) => (
  <I {...props}>
    <path d="m4 4 8 8M12 4l-8 8" />
  </I>
);

export const ComponentPropertiesIcon = (props: IconProps) => (
  <I {...props} filled>
    <path fillRule="evenodd" clipRule="evenodd" d={componentPropertiesIconPath1} />
  </I>
);

export const VariableTextSizeIcon = (props: IconProps) => (
  <I {...props} filled>
    <path fillRule="evenodd" clipRule="evenodd" d="M5 5H2V4H9V5H6V12H5V5Z" />
    <path fillRule="evenodd" clipRule="evenodd" d="M11 8H9V7H14V8H12V12H11V8Z" />
  </I>
);

export const FieldNumberIcon = (props: IconProps) => (
  <I {...props} filled>
    <path fillRule="evenodd" clipRule="evenodd" d={paths.fieldNumberIconPath1} />
  </I>
);

// Make a component out of what's selected — the component cube with a plus.
export const ComponentPlusIcon = (props: IconProps) => (
  <I {...props} filled>
    <path fillRule="evenodd" clipRule="evenodd" d={paths.componentPlusIconPath1} />
    <path d="M13 10.9999H15V11.9999H13V13.9999H12V11.9999H10V10.9999H12V8.99988H13V10.9999Z" />
  </I>
);

export const ExpandVerticalIcon = (props: IconProps) => (
  <I {...props} filled>
    <path d={paths.expandVerticalIconPath1} />
    <path d={paths.expandVerticalIconPath2} />
  </I>
);

export const CollapseVerticalIcon = (props: IconProps) => (
  <I {...props} filled>
    <path fillRule="evenodd" clipRule="evenodd" d={paths.collapseVerticalIconPath1} />
  </I>
);

export const RepeatIcon = (props: IconProps) => (
  <I {...props}>
    <path d="M3 6.5V6a2.5 2.5 0 0 1 2.5-2.5H13" />
    <path d="m11 1.5 2 2-2 2" />
    <path d="M13 9.5v.5a2.5 2.5 0 0 1-2.5 2.5H3" />
    <path d="m5 10.5-2 2 2 2" />
  </I>
);

export const PreviewIcon = (props: IconProps) => (
  <I {...props} filled>
    <path fillRule="evenodd" clipRule="evenodd" d={paths.previewIconPath1} />
  </I>
);

export const FolderIcon = (props: IconProps) => (
  <I {...props}>
    <path d={paths.folderIconPath1} />
  </I>
);

// Webflow's folder glyph — a filled evenodd path, so it opts into `filled`
// rather than the stroked default the other icons use.
export const FolderDefaultIcon = (props: IconProps) => (
  <I filled {...props}>
    <path fillRule="evenodd" clipRule="evenodd" d={paths.folderDefaultIconPath1} />
  </I>
);

// Webflow's CMS glyph — a page Astro generates from a collection entry rather
// than one someone wrote. Filled evenodd, like the rest of the Webflow set.
export const CollectionIcon = (props: IconProps) => (
  <I filled {...props}>
    <path fillRule="evenodd" clipRule="evenodd" d={paths.collectionIconPath1} />
  </I>
);

export const FolderPlusIcon = (props: IconProps) => (
  <I {...props}>
    <path d={paths.folderPlusIconPath1} />
    <path d="M8 6.8v3.4M6.3 8.5h3.4" />
  </I>
);

export const UploadCloudIcon = (props: IconProps) => (
  <I {...props}>
    <path d="M8 10.5V4M4.8 7.2 8 4l3.2 3.2" />
    <path d="M2.5 13h11" />
  </I>
);

export const BracesIcon = (props: IconProps) => (
  <I {...props} filled>
    <path d={paths.bracesIconPath1} />
    <path d={paths.bracesIconPath2} />
  </I>
);

export const ResetIcon = (props: IconProps) => (
  <I {...props}>
    <path d="M6.5 3.5 3.5 6.5l3 3" />
    <path d="M3.5 6.5h5.25a3.75 3.75 0 0 1 3.75 3.75v2.25" />
  </I>
);

export const DragIcon = (props: IconProps) => (
  <I {...props} filled>
    <circle cx="6" cy="4" r="1" />
    <circle cx="10" cy="4" r="1" />
    <circle cx="6" cy="8" r="1" />
    <circle cx="10" cy="8" r="1" />
    <circle cx="6" cy="12" r="1" />
    <circle cx="10" cy="12" r="1" />
  </I>
);

// Struck-through eye: this node put nothing on the page. Filled paths, so it
// takes `filled` rather than the stroked default the rest of the set uses.
export const HideIcon = (props: IconProps) => (
  <I {...props} filled>
    <path fillRule="evenodd" clipRule="evenodd" d={paths.hideIconPath1} />
    <path d={paths.hideIconPath2} />
  </I>
);

// Struck-through pointer: this node is drawn but takes no clicks
// (`pointer-events: none`). Filled, like the eye above it.
export const PointerEventsNoneIcon = (props: IconProps) => (
  <I {...props} filled>
    <path fillRule="evenodd" clipRule="evenodd" d={paths.pointerEventsNoneIconPath1} />
    <path d={paths.pointerEventsNoneIconPath2} />
  </I>
);

export const CheckIcon = (props: IconProps) => (
  <I {...props} strokeWidth={1.6}>
    <path d="m3.5 8.5 3 3 6-7" />
  </I>
);

// The "goes here" elbow: one side of a condition, in the navigator.
export const CornerIcon = (props: IconProps) => (
  <I {...props}>
    <path d="M4.5 3v6.5a1 1 0 0 0 1 1h6" />
    <path d="m9.3 8.2 2.4 2.3-2.4 2.3" />
  </I>
);

export const BranchIcon = (props: IconProps) => (
  <I {...props}>
    <circle cx="4.5" cy="3.5" r="1.6" />
    <circle cx="4.5" cy="12.5" r="1.6" />
    <circle cx="11.5" cy="5" r="1.6" />
    <path d="M4.5 5.1v5.8" />
    <path d="M11.5 6.6c0 2.6-3.2 2.8-5.2 3.6" />
  </I>
);

// The reverse of BranchIcon: a side branch curving back into the trunk. The
// arrowhead is what tells the two apart at 12px — without it a merge and a
// branch are the same three dots and a curve.
// A clock turned back — the panel is about what the project looked like
// before, and a plain clock would read as "scheduled".
export const HistoryIcon = (props: IconProps) => (
  <I {...props}>
    <path d="M2.6 7.2a5.6 5.6 0 1 1 .9 3.9" />
    <path d="M2.2 4.3v2.9h2.9" />
    <path d="M8 5.1v3.1l2.2 1.3" />
  </I>
);

export const MergeIcon = (props: IconProps) => (
  <I {...props}>
    <circle cx="4.5" cy="3.5" r="1.6" />
    <circle cx="4.5" cy="12.5" r="1.6" />
    <circle cx="11.5" cy="3.5" r="1.6" />
    <path d="M4.5 5.1v5.8" />
    <path d="M11.5 5.1c0 2.6-2.6 3.4-5.4 4.1" />
    <path d="M8.2 9.8 6.1 9.2l1.6-1.5" />
  </I>
);

export const ExternalIcon = (props: IconProps) => (
  <I {...props}>
    <path d="M12.5 9.5v3.5a.5.5 0 0 1-.5.5H3.5a.5.5 0 0 1-.5-.5V4.5a.5.5 0 0 1 .5-.5H7" />
    <path d="M9.5 2.5h4v4M13.2 2.8 7.8 8.2" />
  </I>
);

export const MaximizeIcon = (props: IconProps) => (
  <I {...props}>
    <path d="M2.5 5.5v-3h3M13.5 5.5v-3h-3M2.5 10.5v3h3M13.5 10.5v3h-3" />
  </I>
);

export const MinimizeIcon = (props: IconProps) => (
  <I {...props}>
    <path d="M5.5 2.5v3h-3M10.5 2.5v3h3M5.5 13.5v-3h-3M10.5 13.5v-3h3" />
  </I>
);

export const DesktopIcon = (props: IconProps) => (
  <I {...props}>
    <rect x="2" y="3" width="12" height="8.5" rx="1.2" />
    <path d="M6 14h4M8 11.5V14" />
  </I>
);

export const TabletIcon = (props: IconProps) => (
  <I {...props}>
    <rect x="3.5" y="2" width="9" height="12" rx="1.5" />
    <path d="M7 12h2" />
  </I>
);

export const PhoneIcon = (props: IconProps) => (
  <I {...props}>
    <rect x="4.5" y="1.75" width="7" height="12.5" rx="1.5" />
    <path d="M7 12.25h2" />
  </I>
);

export const AssetManagerIcon = (props: IconProps) => (
  <I24 {...props}>
    <path d={paths.assetManagerIconPath1} fill="currentColor" />
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d={paths.assetManagerIconPath2}
      fill="currentColor"
    />
    <g opacity="0.4">
      <path d={paths.assetManagerIconPath3} fill="currentColor" />
      <path d={paths.assetManagerIconPath4} fill="currentColor" />
      <path
        d="M12.5 18.9999H8L11.6464 15.3535C11.9614 15.0385 12.5 15.2616 12.5 15.707V18.9999Z"
        fill="currentColor"
      />
    </g>
  </I24>
);

// Webflow's CMS icon, drawn on a 16px grid — scaled up for the rail.
export const CmsIcon = ({ size = 24, className, style }: IconProps) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill="none"
    className={className}
    style={{ display: 'block', flexShrink: 0, ...style }}
    aria-hidden="true"
  >
    <path fillRule="evenodd" clipRule="evenodd" d={paths.cmsIconPath1} fill="currentColor" />
  </svg>
);

export const PagePanelIcon = (props: IconProps) => (
  <I24 {...props}>
    <path fillRule="evenodd" clipRule="evenodd" d={paths.pagePanelIconPath1} fill="currentColor" />
    <path opacity="0.4" d={paths.pagePanelIconPath2} fill="currentColor" />
  </I24>
);

export const NavigatorIcon = (props: IconProps) => (
  <I24 {...props}>
    <path d="M2 7H17V6H2V7Z" fill="currentColor" />
    <path d="M22 12H7V11H22V12Z" fill="currentColor" />
    <path d="M22 17H7V16H22V17Z" fill="currentColor" />
  </I24>
);

export const ComponentFillIcon = (props: IconProps) => (
  <I24 {...props}>
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d={paths.componentFillIconPath1}
      fill="currentColor"
    />
    <g opacity="0.4">
      <path d={paths.componentFillIconPath2} fill="currentColor" />
      <path d={paths.componentFillIconPath3} fill="currentColor" />
    </g>
  </I24>
);

export const LayersIcon = (props: IconProps) => (
  <I {...props}>
    <path d="m8 1.8 6 3.2-6 3.2-6-3.2 6-3.2Z" />
    <path d="m2.5 8.2 5.5 3 5.5-3" />
    <path d="m2.5 11.2 5.5 3 5.5-3" />
  </I>
);

export const CanvasIcon = (props: IconProps) => (
  <I {...props}>
    <rect x="1.75" y="3" width="7" height="10" rx="1" />
    <rect x="10.75" y="4.75" width="3.5" height="6.5" rx="0.8" />
  </I>
);

// Three dots: the row's own menu, shown on hover.
export const MoreIcon = (props: IconProps) => (
  <svg
    viewBox="0 0 16 16"
    width={props?.size || 14}
    height={props?.size || 14}
    fill="currentColor"
    aria-hidden="true"
  >
    <circle cx="3.5" cy="8" r="1.3" />
    <circle cx="8" cy="8" r="1.3" />
    <circle cx="12.5" cy="8" r="1.3" />
  </svg>
);

export const CopyIcon = (props: IconProps) => (
  <I {...props}>
    <rect x="5.75" y="5.75" width="8.5" height="8.5" rx="1.5" />
    <path d={paths.copyIconPath1} />
  </I>
);

// --- CMS field types -------------------------------------------------------

export const ParagraphIcon = (props: IconProps) => (
  <I {...props}>
    <path d="M2.5 3.5h11M2.5 6.5h11M2.5 9.5h11M2.5 12.5h7" />
  </I>
);

export const SwitchIcon = (props: IconProps) => (
  <I {...props}>
    <rect x="1.75" y="4.75" width="12.5" height="6.5" rx="3.25" />
    <circle cx="11" cy="8" r="1.6" fill="currentColor" stroke="none" />
  </I>
);

export const CalendarIcon = (props: IconProps) => (
  <I {...props}>
    <rect x="2.25" y="3.25" width="11.5" height="10.5" rx="1.5" />
    <path d="M2.25 6.5h11.5M5.5 1.75v2.5M10.5 1.75v2.5" />
  </I>
);

// A place on a map: a CMS location field.
export const MapPinIcon = (props: IconProps) => (
  <I {...props}>
    <path d="M8 14.25S12.25 10.35 12.25 7a4.25 4.25 0 0 0-8.5 0c0 3.35 4.25 7.25 4.25 7.25" />
    <circle cx="8" cy="7" r="1.5" />
  </I>
);

// An attached file: a CMS file field.
export const PaperclipIcon = (props: IconProps) => (
  <I {...props}>
    <path d="m13 7.5-5.2 5.2a3 3 0 0 1-4.25-4.25l5.3-5.3a2 2 0 0 1 2.85 2.85" />
    <path d="M11.7 6 6.4 11.3a1 1 0 0 1-1.4-1.4l4.6-4.6" />
  </I>
);

export const MailIcon = (props: IconProps) => (
  <I {...props}>
    <rect x="1.75" y="3.75" width="12.5" height="8.5" rx="1.5" />
    <path d="m2.5 5 5.5 4 5.5-4" />
  </I>
);

export const PhoneCallIcon = (props: IconProps) => (
  <I {...props}>
    <path d={paths.phoneCallIconPath1} />
  </I>
);

export const DropletIcon = (props: IconProps) => (
  <I {...props}>
    <path d="M8 2.2s4 4 4 6.6a4 4 0 0 1-8 0C4 6.2 8 2.2 8 2.2Z" />
  </I>
);

export const HelpCircleIcon = ({ size = 16, className, style }: IconProps) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill="none"
    className={className}
    style={{ display: 'block', flexShrink: 0, ...style }}
    aria-hidden="true"
  >
    <path d={paths.helpCircleIconPath1} fill="currentColor" />
    <path d={paths.helpCircleIconPath2} fill="currentColor" />
    <path
      opacity="0.4"
      fillRule="evenodd"
      clipRule="evenodd"
      d={paths.helpCircleIconPath3}
      fill="currentColor"
    />
  </svg>
);

export const GearIcon = (props: IconProps) => (
  <I {...props}>
    <circle cx="8" cy="8" r="2.15" />
    <path d={paths.gearIconPath1} />
  </I>
);

export const TrashIcon = (props: IconProps) => (
  <I {...props}>
    <path d="M3 4.5h10M6.5 2.5h3M5.5 4.5l.5 9h4l.5-9" />
  </I>
);

export const FolderOpenIcon = (props: IconProps) => (
  <I {...props}>
    <path d="M2 12.5V3.8a.8.8 0 0 1 .8-.8h3.4l1.5 1.8h5.5a.8.8 0 0 1 .8.8v1" />
    <path d="M2 12.5 3.8 7h10.7l-1.8 5.5H2Z" />
  </I>
);

export const SparkleIcon = (props: IconProps) => (
  <I {...props}>
    <path d={paths.sparkleIconPath1} />
  </I>
);

export const UploadIcon = (props: IconProps) => (
  <I {...props}>
    <path d="M8 10.5V3M4.8 6.2 8 3l3.2 3.2" />
    <path d="M2.5 13h11" />
  </I>
);

export const SearchIcon = (props: IconProps) => (
  <I {...props}>
    <circle cx="7" cy="7" r="4.5" />
    <path d="m10.5 10.5 3 3" />
  </I>
);

export const TerminalIcon = (props: IconProps) => (
  <I {...props}>
    <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5" />
    <path d="m4.75 6.5 2 1.75-2 1.75M8.5 10.25h3" />
  </I>
);

export const ArrowDownIcon = (props: IconProps) => (
  <I {...props}>
    <path d="M8 3v10M4.25 9.25 8 13l3.75-3.75" />
  </I>
);

// astro:assets <Image> / <Picture>. The glyph is the element they render, so
// the row still reads as an image, tinted with Astro's accent and carrying a
// small mark — a plain <img> is grey, a project component is green, and this
// is neither.
export function astroAssetIcon(name: unknown, size = 14, className?: string) {
  const stack = name === 'Picture';
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      className={className}
      style={{ display: 'block', flexShrink: 0, color: ASTRO_ASSET_ACCENT }}
    >
      {/* A second frame behind the first says "more than one source". */}
      {stack && (
        <path
          d="M4.5 3.5H2.75A.75.75 0 0 0 2 4.25v8a.75.75 0 0 0 .75.75H10"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinecap="round"
          opacity="0.55"
        />
      )}
      <rect
        x={stack ? 5 : 2.6}
        y={stack ? 2 : 3}
        width={stack ? 9 : 10.8}
        height={stack ? 9 : 10}
        rx="1.1"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <circle cx={stack ? 7.6 : 5.6} cy={stack ? 4.7 : 5.9} r="1" fill="currentColor" />
      <path
        d={stack ? 'M5.4 10.2 8.2 7.6l5.2 4.6' : 'M3 12.2l3.4-3.2 6.6 5.5'}
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// Boolean prop — a switch, matching the True/False control the field renders.
export const FieldSwitchIcon = (props: IconProps) => (
  <I {...props} filled>
    <path d={paths.fieldSwitchIconPath1} />
    <path fillRule="evenodd" clipRule="evenodd" d={paths.fieldSwitchIconPath2} />
  </I>
);

// Variables — the panel that reads a project's CSS custom properties.
export const VariableIcon = ({ size = 24, className, style }: IconProps) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    className={className}
    style={{ display: 'block', flexShrink: 0, ...style }}
    aria-hidden="true"
  >
    <path opacity="0.4" d={paths.variableIconPath1} fill="currentColor" />
    <path d={paths.variableIconPath2} fill="currentColor" />
    <path fillRule="evenodd" clipRule="evenodd" d={paths.variableIconPath3} fill="currentColor" />
  </svg>
);

// Original vector paths, split only for source readability.
const fileIconPath1 =
  'M4.5 1.75h4.4l3.1 3.1v9.15a.5.5 0 0 1-.5.5h-7a.5.5 0 0 1-.5-.5V2.25a.5.5 0 ' + '0 1 .5-.5Z';

const commentIconPath1 =
  'M13.5 7.6c0 2.8-2.5 5-5.5 5-.7 0-1.4-.1-2-.35L2.8 13l.6-2.5A4.7 4.7 0 0 1 2' +
  '.5 7.6c0-2.8 2.5-5 5.5-5s5.5 2.2 5.5 5Z';

const componentPropertiesIconPath1 =
  'M8.47885 1.69162C8.18037 1.52882 7.81963 1.52882 7.52115 1.69162L2.52115 4.' +
  '4189C2.19989 4.59413 2 4.93085 2 5.29679V10.7032C2 11.0691 2.19989 11.4058 ' +
  '2.52115 11.5811L7.52115 14.3083C7.81963 14.4711 8.18037 14.4711 8.47885 14.' +
  '3083L13.4789 11.5811C13.8001 11.4058 14 11.0691 14 10.7032V5.29679C14 4.930' +
  '85 13.8001 4.59413 13.4789 4.4189L8.47885 1.69162ZM3.54416 4.99998L8 2.5695' +
  '2L12.4558 4.99998L8 7.43043L3.54416 4.99998ZM3 5.84225L3 10.7032L7.5 13.157' +
  '7V8.29679L3 5.84225Z';
