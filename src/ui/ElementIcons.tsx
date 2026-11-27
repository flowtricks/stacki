// Element icons shared by the Navigator, canvas labels and insert palette, and (at the end) the file-type icons the
// Files panel and the Git panel's list of changes share.
import { centralIcon, centralIconSize } from './central/CentralIcon';
import {
  bulletList as centralBulletList,
  code as centralCode,
  headingOne as centralH1,
  headingTwo as centralH2,
  headingThree as centralH3,
  home as centralHome,
  homeRoundDoor as centralHomeRoundDoor,
  image as centralImage,
  fileText as centralFileText,
  input as centralInput,
  info as centralInfo,
  link as centralLink,
  search as centralSearch,
  select as centralSelect,
  slot as centralSlot,
  square as centralSquare,
  video as centralVideo,
  audio as centralAudio,
  block as centralBlock,
  bold as centralBold,
  book as centralBook,
  bookmark as centralBookmark,
  chainLink as centralChainLink,
  caption as centralCaption,
  check as centralCheck,
  chevronDown as centralChevronDown,
  circle as centralCircle,
  clock as centralClock,
  collection as centralCollection,
  cube as centralCube,
  columns as centralColumns,
  comment as centralComment,
  divider as centralDivider,
  document as centralDocument,
  file as centralFile,
  form as centralForm,
  globe as centralGlobe,
  heading as centralHeading,
  highlight as centralHighlight,
  indentRight as centralIndentRight,
  italic as centralItalic,
  keyboard as centralKeyboard,
  layers as centralLayers,
  layout as centralLayout,
  linebreak as centralLinebreak,
  listMenu as centralListMenu,
  mapPin as centralMapPin,
  number as centralNumber,
  numberList as centralNumberList,
  panelRight as centralPanelRight,
  pieChartOne as centralPieChartOne,
  pointerHand as centralPointerHand,
  quote as centralQuote,
  rewrite as centralRewrite,
  sectionRows as centralSectionRows,
  spinner as centralSpinner,
  strike as centralStrike,
  styles as centralStyles,
  subscript as centralSubscript,
  superscript as centralSuperscript,
  terminal as centralTerminal,
  text as centralText,
  textBlock as centralTextBlock,
  textSize as centralTextSize,
  underline as centralUnderline,
  variables as centralVariables,
  vector as centralVector,
} from './central/centralGeometry';

import type { ReactElement } from 'react';
import type { HTML_TAGS } from '../editor/elementSchemas';
import { type IconProps, I } from './IconBase';
import { mediaKindOf, type ExplorerEntryKind } from '../../shared/ipc/fileExplorer';
import { AstroIcon, AudioFileIcon, BracesIcon, CodeIcon, ExternalIcon, FolderIcon, FolderOpenIcon, LockIcon, UnlinkIcon } from './Icons';
import { elementHeading4IconPath1, elementHeading5IconPath1, elementHeading6IconPath1 } from './iconPaths';

// Astro components keep their cube so they stand apart from HTML elements.
export const ElementComponentIcon = centralIcon(centralCube);

export const ElementSlotIcon = centralIcon(centralSlot);

export const CustomElementIcon = centralIcon(centralCode);

export const ElementDivIcon = centralIcon(centralSquare);

export const ElementImageIcon = centralIcon(centralImage);

export const ElementSectionIcon = centralIcon(centralSectionRows);

export const ElementListDefaultIcon = centralIcon(centralBulletList);

export const ElementListItemIcon = centralIcon(centralBulletList);

export const ElementLinkIcon = centralIcon(centralLink);

// A different chain from <a>'s link, so the head's <link> reads apart from anchors.
const ElementStylesheetLinkIcon = centralIcon(centralChainLink);
const InfoIcon = centralIcon(centralInfo);
const SearchIcon = centralIcon(centralSearch);

export const ElementHeading1Icon = centralIcon(centralH1);

export const ElementHeading2Icon = centralIcon(centralH2);

export const ElementHeading3Icon = centralIcon(centralH3);

export const ElementHeading4Icon = (props: IconProps) => (
  <I {...props} filled>
    <path d="M3 4V12H4V9H7V12H8V4H7V8H4V4H3Z" />
    <path d={elementHeading4IconPath1} />
  </I>
);

export const ElementHeading5Icon = (props: IconProps) => (
  <I {...props} filled>
    <path d="M3 4V12H4V9H7V12H8V4H7V8H4V4H3Z" />
    <path d={elementHeading5IconPath1} />
  </I>
);

export const ElementHeading6Icon = (props: IconProps) => (
  <I {...props} filled>
    <path d="M3 12V4H4V8H7V4H8V12H7V9H4V12H3Z" />
    <path fillRule="evenodd" clipRule="evenodd" d={elementHeading6IconPath1} />
  </I>
);

export const ElementVideoIcon = centralIcon(centralVideo);

export const ElementFormBlockIcon = centralIcon(centralForm);

export const ElementInputIcon = centralIcon(centralInput);

export const ElementSelectIcon = centralIcon(centralSelect);

// The pointing hand says "press me"; the plain pill outline looked like a toggle or a generic shape.
export const ElementButtonIcon = centralIcon(centralPointerHand);

export const HomeIcon = centralIcon(centralHome);

// Text with edit arrows: a textarea is a field people rewrite text in, apart from static text blocks.
const RewriteIcon = centralIcon(centralRewrite);

// A home with a round door: <nav> holds the site's way around.
const NavIcon = centralIcon(centralHomeRoundDoor);

const AsideIcon = centralIcon(centralPanelRight);
const AudioIcon = centralIcon(centralAudio);
const ArticleIcon = centralIcon(centralDocument);
const BoldIcon = centralIcon(centralBold);
const BookIcon = centralIcon(centralBook);
const CaptionIcon = centralIcon(centralCaption);
const CellIcon = centralIcon(centralSquare);
const CheckIcon = centralIcon(centralCheck);
const CircleIcon = centralIcon(centralCircle);
const CodeDisabledIcon = centralIcon(centralBlock);
const ColumnsIcon = centralIcon(centralColumns);
const DataIcon = centralIcon(centralNumber);
const DetailsIcon = centralIcon(centralChevronDown);
const DialogIcon = centralIcon(centralComment);
const DividerIcon = centralIcon(centralDivider);
const FileIcon = centralIcon(centralFile);
const FooterIcon = (props: IconProps) => (
  <I {...props} size={centralIconSize(props.size ?? 16)} strokeWidth={0.9}>
    <rect x="2.5" y="2.5" width="11" height="11" rx="1.2" />
    <path d="M2.5 10.5h11" />
  </I>
);
const GlobeIcon = centralIcon(centralGlobe);
const HeaderIcon = (props: IconProps) => (
  <I {...props} size={centralIconSize(props.size ?? 16)} strokeWidth={0.9}>
    <rect x="2.5" y="2.5" width="11" height="11" rx="1.2" />
    <path d="M2.5 5.5h11" />
  </I>
);
const HeadingGroupIcon = centralIcon(centralHeading);
const HighlightIcon = centralIcon(centralHighlight);
const ItalicIcon = centralIcon(centralItalic);
const KeyboardIcon = centralIcon(centralKeyboard);
const LabelIcon = centralIcon(centralBookmark);
const LayersIcon = centralIcon(centralLayers);
const LineBreakIcon = centralIcon(centralLinebreak);
const LocationIcon = centralIcon(centralMapPin);
const MenuIcon = centralIcon(centralListMenu);
// A filled share of a circle: a meter shows where a value sits in its range. Not the gauge, which is the Audits
// panel's icon in the rail, so the tile does not read as that panel.
const MeterIcon = centralIcon(centralPieChartOne);
const NumberedListIcon = centralIcon(centralNumberList);
const OutputIcon = centralIcon(centralTerminal);
const PictureIcon = centralIcon(centralLayers);
// The loader: a progress bar tells how far a task has run.
const ProgressIcon = centralIcon(centralSpinner);
const QuoteIcon = centralIcon(centralQuote);
const RowIcon = centralIcon(centralSectionRows);
const StrikeIcon = centralIcon(centralStrike);
const StyleIcon = centralIcon(centralStyles);
const SubscriptIcon = centralIcon(centralSubscript);
const SuperscriptIcon = centralIcon(centralSuperscript);
const TableIcon = centralIcon(centralCollection);
const TemplateIcon = centralIcon(centralSlot);
const TerminalIcon = centralIcon(centralTerminal);
const TextBlockIcon = centralIcon(centralTextBlock);
const TextDirectionIcon = centralIcon(centralIndentRight);
const TextIcon = centralIcon(centralText);
const TextSizeIcon = centralIcon(centralTextSize);
const TimeIcon = centralIcon(centralClock);
const UnderlineIcon = centralIcon(centralUnderline);
const VariableIcon = centralIcon(centralVariables);
const VectorIcon = centralIcon(centralVector);
const WindowIcon = centralIcon(centralLayout);

type ElementIcon = (props: IconProps) => ReactElement;

// Each insertable tag has an icon, including when new tags are added to the palette.
const HTML_ICONS = {
  a: ElementLinkIcon,
  abbr: TextIcon,
  address: LocationIcon,
  article: ArticleIcon,
  aside: AsideIcon,
  audio: AudioIcon,
  b: BoldIcon,
  bdi: TextIcon,
  bdo: TextDirectionIcon,
  blockquote: QuoteIcon,
  br: LineBreakIcon,
  button: ElementButtonIcon,
  canvas: VectorIcon,
  caption: CaptionIcon,
  cite: QuoteIcon,
  code: CustomElementIcon,
  col: ColumnsIcon,
  colgroup: ColumnsIcon,
  data: DataIcon,
  datalist: ElementListDefaultIcon,
  dd: TextBlockIcon,
  del: StrikeIcon,
  details: DetailsIcon,
  dfn: BookIcon,
  dialog: DialogIcon,
  div: ElementDivIcon,
  dl: ElementListDefaultIcon,
  dt: TextIcon,
  em: ItalicIcon,
  embed: WindowIcon,
  fieldset: ElementFormBlockIcon,
  figcaption: CaptionIcon,
  figure: ElementImageIcon,
  footer: FooterIcon,
  form: ElementFormBlockIcon,
  h1: ElementHeading1Icon,
  h2: ElementHeading2Icon,
  h3: ElementHeading3Icon,
  h4: ElementHeading4Icon,
  h5: ElementHeading5Icon,
  h6: ElementHeading6Icon,
  header: HeaderIcon,
  hgroup: HeadingGroupIcon,
  hr: DividerIcon,
  i: ItalicIcon,
  iframe: WindowIcon,
  img: ElementImageIcon,
  input: ElementInputIcon,
  ins: UnderlineIcon,
  kbd: KeyboardIcon,
  label: LabelIcon,
  legend: LabelIcon,
  li: ElementListItemIcon,
  main: WindowIcon,
  mark: HighlightIcon,
  menu: MenuIcon,
  meter: MeterIcon,
  nav: NavIcon,
  noscript: CodeDisabledIcon,
  object: WindowIcon,
  ol: NumberedListIcon,
  optgroup: ElementListDefaultIcon,
  option: CheckIcon,
  output: OutputIcon,
  p: TextIcon,
  picture: PictureIcon,
  pre: TextBlockIcon,
  progress: ProgressIcon,
  q: QuoteIcon,
  ruby: TextSizeIcon,
  s: StrikeIcon,
  samp: TerminalIcon,
  section: ElementSectionIcon,
  select: ElementSelectIcon,
  small: TextSizeIcon,
  source: FileIcon,
  span: TextIcon,
  strong: BoldIcon,
  sub: SubscriptIcon,
  summary: DetailsIcon,
  sup: SuperscriptIcon,
  table: TableIcon,
  tbody: TableIcon,
  td: CellIcon,
  template: TemplateIcon,
  textarea: RewriteIcon,
  tfoot: FooterIcon,
  th: BoldIcon,
  thead: HeaderIcon,
  time: TimeIcon,
  tr: RowIcon,
  track: CaptionIcon,
  u: UnderlineIcon,
  ul: ElementListDefaultIcon,
  var: VariableIcon,
  video: ElementVideoIcon,
  wbr: LineBreakIcon,
  area: CellIcon,
  base: ElementLinkIcon,
  body: WindowIcon,
  head: HeaderIcon,
  html: GlobeIcon,
  meta: InfoIcon,
  script: CustomElementIcon,
  style: StyleIcon,
  title: TextIcon,
  link: ElementStylesheetLinkIcon,
  map: LocationIcon,
  rp: TextSizeIcon,
  rt: TextSizeIcon,
  search: SearchIcon,
} satisfies Readonly<Record<(typeof HTML_TAGS)[number], ElementIcon>>;

// Existing pages also contain document-level and inline SVG elements.
const EXTRA_ICONS = {
  content: ArticleIcon,
  fragment: CodeDisabledIcon,
  circle: CircleIcon,
  defs: TemplateIcon,
  ellipse: CircleIcon,
  g: LayersIcon,
  line: DividerIcon,
  math: DataIcon,
  param: ElementInputIcon,
  path: VectorIcon,
  polygon: VectorIcon,
  polyline: VectorIcon,
  rect: ElementDivIcon,
  slot: ElementSlotIcon,
  svg: VectorIcon,
  symbol: TemplateIcon,
  text: TextIcon,
  tspan: TextIcon,
  use: ElementLinkIcon,
};

const TAG_ICONS: ReadonlyMap<string, ElementIcon> = new Map([...Object.entries(HTML_ICONS), ...Object.entries(EXTRA_ICONS)]);
const TAG_NAME_LENGTH_MAX = 32;

/** Whether `tag` has an icon of its own rather than the generic custom-element one (the Add elements catalog's test asks). */
export function hasElementIcon(tag: string): boolean {
  return TAG_ICONS.has(tag.toLowerCase());
}

export function elementIcon(tag: unknown, size = 12, className?: string) {
  const name = typeof tag === 'string' ? tag.slice(0, TAG_NAME_LENGTH_MAX + 1).toLowerCase() : '';
  const Icon = TAG_ICONS.get(name) ?? CustomElementIcon;
  return <Icon size={size} className={className} />;
}

// ---------------------------------------------------------------------------
// File-type icons
// ---------------------------------------------------------------------------
//
// The icon a file row draws, by what the entry is and, for a file, by its name. Every drawing is from the Central icon
// system already in the app (src/ui/central/centralGeometry.tsx, docs/central-icons.md), with one exception the owner
// asked for: an .astro file wears Astro's own mark, the app's `AstroIcon` (the supplied brand paths in
// src/ui/iconPaths.ts). Nothing new is drawn.

const ImageFileIcon = centralIcon(centralImage);
const VideoFileIcon = centralIcon(centralVideo);
const TextFileIcon = centralIcon(centralFileText);

const ASTRO_NAME = /\.astro$/i;
const CODE_NAME = /\.([cm]?[jt]sx?|css|scss|sass|less|html?|vue|svelte|svg|sh|zsh|bash|toml|ya?ml|xml)$/i;
const DATA_NAME = /\.(json|jsonc|json5|lock)$/i;
const TEXT_NAME = /\.(md|mdx|markdown|txt|log|csv)$/i;
// Files that by convention hold secrets: drawn with a lock, so a person sees what they are opening.
const SECRET_NAME = /^\.env(\..+)?$|\.(pem|key)$/i;

export function FileEntryIcon(props: { readonly name: string; readonly kind: ExplorerEntryKind; readonly open: boolean | undefined }) {
  switch (props.kind) {
    case 'directory':
    case 'link-directory':
      return props.open === true ? <FolderOpenIcon size={14} /> : <FolderIcon size={14} />;
    case 'link-outside':
      return <ExternalIcon size={14} />;
    case 'link-broken':
      return <UnlinkIcon size={14} />;
    case 'file':
    case 'link-file':
    case 'other':
      return <NamedFileIcon name={props.name} />;
    default: {
      const exhaustive: never = props.kind;
      return exhaustive;
    }
  }
}

function NamedFileIcon({ name }: { readonly name: string }) {
  if (SECRET_NAME.test(name)) {
    return <LockIcon size={14} />;
  }
  const media = mediaKindOf(name);
  if (media === 'image' || /\.svg$/i.test(name)) {
    return <ImageFileIcon size={14} />;
  }
  if (media === 'video') {
    return <VideoFileIcon size={14} />;
  }
  if (media === 'audio') {
    return <AudioFileIcon size={14} />;
  }
  if (DATA_NAME.test(name)) {
    return <BracesIcon size={14} />;
  }
  if (ASTRO_NAME.test(name)) {
    // The other rows' icons draw 16px (CentralIcon rounds the size asked for up) with a margin of their own. The mark
    // runs to the edges of its drawing, so it is drawn 12px in the same 16px box: names line up and it looks their size.
    return (
      <span className="files-icon-brand">
        <AstroIcon size={12} />
      </span>
    );
  }
  if (CODE_NAME.test(name)) {
    return <CodeIcon size={14} />;
  }
  if (TEXT_NAME.test(name)) {
    return <TextFileIcon size={14} />;
  }
  return <FileIcon size={14} />;
}
