import { centralIcon, centralIconSize } from './central/CentralIcon';
import { ElementComponentIcon } from './ElementIcons';
import {
  add as centralAdd,
  arrowDown as centralArrowDown,
  audio as centralAudio,
  braces as centralBraces,
  branch as centralBranch,
  bucket as centralBucket,
  calendar as centralCalendar,
  canvas as centralCanvas,
  check as centralCheck,
  chevronDown as centralChevronDown,
  chevronLeft as centralChevronLeft,
  chevronRight as centralChevronRight,
  clock as centralClock,
  close as centralClose,
  code as centralCode,
  collapse as centralCollapse,
  collapseVertical as centralCollapseVertical,
  collection as centralCollection,
  comment as centralComment,
  component as centralComponent,
  componentAdd as centralComponentAdd,
  componentEdit as centralComponentEdit,
  copy as centralCopy,
  corner as centralCorner,
  cursor as centralCursor,
  database as centralDatabase,
  desktop as centralDesktop,
  drag as centralDrag,
  droplet as centralDroplet,
  ease as centralEase,
  edit as centralEdit,
  expand as centralExpand,
  expandVertical as centralExpandVertical,
  external as centralExternal,
  eye as centralEye,
  eyeOff as centralEyeOff,
  file as centralFile,
  filter as centralFilter,
  folder as centralFolder,
  folderAdd as centralFolderAdd,
  folderOpen as centralFolderOpen,
  guide as centralGuide,
  help as centralHelp,
  history as centralHistory,
  image as centralImage,
  layers as centralLayers,
  layout as centralLayout,
  mail as centralMail,
  mapPin as centralMapPin,
  merge as centralMerge,
  more as centralMore,
  number as centralNumber,
  panelRight as centralPanelRight,
  paperclip as centralPaperclip,
  paragraph as centralParagraph,
  phone as centralPhone,
  phoneCall as centralPhoneCall,
  pin as centralPin,
  properties as centralProperties,
  refresh as centralRefresh,
  repeat as centralRepeat,
  search as centralSearch,
  settings as centralSettings,
  sort as centralSort,
  sparkle as centralSparkle,
  sync as centralSync,
  tablet as centralTablet,
  terminal as centralTerminal,
  text as centralText,
  textSize as centralTextSize,
  toggle as centralToggle,
  trash as centralTrash,
  undo as centralUndo,
  unlink as centralUnlink,
  upload as centralUpload,
  variables as centralVariables,
  wand as centralWand,
  warning as centralWarning,
} from './central/centralGeometry';
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

export const ComponentEditIcon = centralIcon(centralComponentEdit);

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

// Media hosts in the Assets panel's sources. Simplified marks drawn here, never
// loaded from the hosts: the cloud for Cloudflare R2, the rabbit for Bunny, and a
// plain bucket for any other S3-compatible host.
export const CloudflareIcon = (props: IconProps) => (
  <I24 {...props}>
    <path fill="currentColor" d="M16.9 18.5H6.6a4.1 4.1 0 0 1-.7-8.15 5.9 5.9 0 0 1 11.2-1.6 4.9 4.9 0 0 1-.2 9.75Z" />
  </I24>
);

export const BunnyIcon = (props: IconProps) => (
  <I24 {...props}>
    <g fill="currentColor">
      <ellipse cx="8.8" cy="6.6" rx="2" ry="4.9" transform="rotate(-12 8.8 6.6)" />
      <ellipse cx="15.2" cy="6.6" rx="2" ry="4.9" transform="rotate(12 15.2 6.6)" />
      <circle cx="12" cy="15.4" r="6.1" />
    </g>
  </I24>
);

export const BucketIcon = centralIcon(centralBucket);

export const AudioFileIcon = centralIcon(centralAudio);

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

export const FileIcon = centralIcon(centralFile);

// An open book: the Instructions panel, the project's Markdown for agents and people.
export const InstructionsIcon = (props: IconProps) => (
  <I {...props} size={centralIconSize(props.size ?? 16)} strokeWidth={0.85}>
    <path d="M2 3.4c2-.8 4-.7 6 .8 2-1.5 4-1.6 6-.8v9.2c-2-.8-4-.7-6 .8-2-1.5-4-1.6-6-.8ZM8 4.2v9.2" />
  </I>
);

// A wand: a skill, the know-how an agent picks up when a task calls for it.
export const SkillIcon = centralIcon(centralWand);

// An easing curve: what the editor behind it edits.
export const EaseIcon = centralIcon(centralEase);

export const ComponentIcon = centralIcon(centralComponent);

// Three tall columns represent the preview's column guide.
export const GuideIcon = centralIcon(centralGuide);

export const LayoutIcon = centralIcon(centralLayout);

// A window with its right-hand column marked: the Style and Settings panel.
export const PanelRightIcon = centralIcon(centralPanelRight);

export const TextIcon = centralIcon(centralText);

export const CommentIcon = centralIcon(centralComment);

export const CodeIcon = centralIcon(centralCode);

// A ::before / ::after layer: the two colons that name a pseudo-element.
export const PseudoElementIcon = (props: IconProps) => (
  <I {...props}>
    <path d="M5.5 5.25h.01M5.5 10.75h.01M10.5 5.25h.01M10.5 10.75h.01" strokeWidth={2.4} />
  </I>
);

export const PencilIcon = centralIcon(centralEdit);

export const TagIcon = centralIcon(centralCode);

export const ChevronLeftIcon = centralIcon(centralChevronLeft);

export const ChevronRightIcon = centralIcon(centralChevronRight);

/** A pushpin: what a table pins as its columns. */
export const PinIcon = centralIcon(centralPin);

export const ChevronDownIcon = centralIcon(centralChevronDown);

export const PlusIcon = centralIcon(centralAdd);

export const RefreshIcon = centralIcon(centralRefresh);

// Two arrows chasing each other: a field kept in step with another.
export const SyncIcon = centralIcon(centralSync);

export const CloseIcon = centralIcon(centralClose);

export const ComponentPropertiesIcon = centralIcon(centralProperties);

export const VariableTextSizeIcon = centralIcon(centralTextSize);

export const FieldNumberIcon = centralIcon(centralNumber);

// Make a component out of what's selected — the component cube with a plus.
export const ComponentPlusIcon = centralIcon(centralComponentAdd);

export const ExpandVerticalIcon = centralIcon(centralExpandVertical);

export const CollapseVerticalIcon = centralIcon(centralCollapseVertical);

export const RepeatIcon = centralIcon(centralRepeat);

export const PreviewIcon = centralIcon(centralEye);

export const FolderIcon = centralIcon(centralFolder);

export const FolderDefaultIcon = centralIcon(centralFolder);

export const CollectionIcon = centralIcon(centralCollection);

export const FolderPlusIcon = centralIcon(centralFolderAdd);

export const UploadCloudIcon = centralIcon(centralUpload);

export const BracesIcon = centralIcon(centralBraces);

export const ResetIcon = centralIcon(centralUndo);

export const DragIcon = centralIcon(centralDrag);

// An eye with a slash distinguishes hidden nodes in the Navigator.
export const HideIcon = centralIcon(centralEyeOff);

// A pointer distinguishes nodes that do not take clicks.
export const PointerEventsNoneIcon = centralIcon(centralCursor);

export const CheckIcon = centralIcon(centralCheck);

// The "goes here" elbow: one side of a condition, in the navigator.
export const CornerIcon = centralIcon(centralCorner);

export const BranchIcon = centralIcon(centralBranch);

// The reverse of BranchIcon: a side branch curving back into the trunk. The
// arrowhead is what tells the two apart at 12px — without it a merge and a
// branch are the same three dots and a curve.
// A clock turned back — the panel is about what the project looked like
// before, and a plain clock would read as "scheduled".
export const HistoryIcon = centralIcon(centralHistory);

export const MergeIcon = centralIcon(centralMerge);

export const ExternalIcon = centralIcon(centralExternal);

export const MaximizeIcon = centralIcon(centralExpand);

export const MinimizeIcon = centralIcon(centralCollapse);

export const DesktopIcon = centralIcon(centralDesktop);

export const TabletIcon = centralIcon(centralTablet);

export const PhoneIcon = centralIcon(centralPhone);

export const AssetManagerIcon = centralIcon(centralImage, 20);

// Webflow's CMS icon, drawn on a 16px grid — scaled up for the rail.
export const CmsIcon = centralIcon(centralDatabase, 20);

// The Apps rail icon: three rounded squares and a plus.
// The plus keeps Apps distinct from the Layout and grid controls.
export const AppsIcon = (props: IconProps) => (
  <I {...props} size={centralIconSize(props.size ?? 20)} strokeWidth={0.85}>
    <rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1.2" />
    <rect x="9" y="2.5" width="4.5" height="4.5" rx="1.2" />
    <rect x="2.5" y="9" width="4.5" height="4.5" rx="1.2" />
    <path d="M11.25 9v4.5M9 11.25h4.5" />
  </I>
);

// The Stacki mark from the wordmark (welcome/StackiLogo.tsx), in `currentColor`
// so it takes the colour of the row it sits in.
export const StackiMarkIcon = ({ size = 16, className, style }: IconProps) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 458 458"
    fill="none"
    className={className}
    style={{ display: 'block', flexShrink: 0, ...style }}
    aria-hidden="true"
  >
    <path d={paths.stackiMarkPath} fill="currentColor" />
  </svg>
);

export const PagePanelIcon = centralIcon(centralFile, 20);

// Indented rows distinguish the Navigator from Git's branch and merge symbols.
export const NavigatorIcon = (props: IconProps) => (
  <I {...props} size={centralIconSize(props.size ?? 20)} strokeWidth={0.85}>
    <path d="M2 4.5h9.5M5 8h9M5 11.5h9" />
  </I>
);

export const ComponentFillIcon = (props: IconProps) => <ElementComponentIcon {...props} size={props.size ?? 20} />;

export const LayersIcon = centralIcon(centralLayers);

export const CanvasIcon = centralIcon(centralCanvas);

// Three dots: the row's own menu, shown on hover.
export const MoreIcon = centralIcon(centralMore);

export const CopyIcon = centralIcon(centralCopy);

// --- CMS field types -------------------------------------------------------

export const ParagraphIcon = centralIcon(centralParagraph);

export const SwitchIcon = centralIcon(centralToggle);

export const CalendarIcon = centralIcon(centralCalendar);

// A time of day: the picker's time tab.
export const ClockIcon = centralIcon(centralClock);

// A place on a map: a CMS location field.
export const MapPinIcon = centralIcon(centralMapPin);

// An attached file: a CMS file field.
export const PaperclipIcon = centralIcon(centralPaperclip);

export const MailIcon = centralIcon(centralMail);

export const PhoneCallIcon = centralIcon(centralPhoneCall);

export const DropletIcon = centralIcon(centralDroplet);

export const HelpCircleIcon = centralIcon(centralHelp);

// A warning: a triangle with an exclamation mark, the triangle at 40% so the mark reads first.
export const WarningTriangleIcon = centralIcon(centralWarning);

export const GearIcon = centralIcon(centralSettings);

export const TrashIcon = centralIcon(centralTrash);

export const FolderOpenIcon = centralIcon(centralFolderOpen);

export const SparkleIcon = centralIcon(centralSparkle);

export const UploadIcon = centralIcon(centralUpload);

export const SearchIcon = centralIcon(centralSearch);

// A list's filters: a funnel, as a builder's collection list settings draw them.
export const FilterIcon = centralIcon(centralFilter);

// A list's sort: an up-and-down arrow beside the lines it orders.
export const SortIcon = centralIcon(centralSort);

// Disconnecting a setting from a property: a chain link broken in two.
// A link broken in two: what disconnecting a value from what it was bound to does.
export const UnlinkIcon = centralIcon(centralUnlink);

export const TerminalIcon = centralIcon(centralTerminal);

export const ArrowDownIcon = centralIcon(centralArrowDown);

const AstroImageIcon = centralIcon(centralImage);
const AstroPictureIcon = centralIcon(centralLayers);

// Astro's accent distinguishes optimized images from plain HTML images.
export function astroAssetIcon(name: unknown, size = 16, className?: string) {
  const Icon = name === 'Picture' ? AstroPictureIcon : AstroImageIcon;
  return <Icon size={size} className={className} style={{ color: ASTRO_ASSET_ACCENT }} />;
}

// Boolean prop — a switch, matching the True/False control the field renders.
export const FieldSwitchIcon = centralIcon(centralToggle);

// Variables — the panel that reads a project's CSS custom properties.
export const VariableIcon = centralIcon(centralVariables, 20);
