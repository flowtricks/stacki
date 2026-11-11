// Element icons shared by the Navigator, canvas labels and insert palette.
import { centralIcon, centralIconSize } from './central/CentralIcon';
import {
  bulletList as centralBulletList,
  button as centralButton,
  code as centralCode,
  headingOne as centralH1,
  headingTwo as centralH2,
  headingThree as centralH3,
  home as centralHome,
  image as centralImage,
  input as centralInput,
  link as centralLink,
  select as centralSelect,
  slot as centralSlot,
  square as centralSquare,
  video as centralVideo,
  audio as centralAudio,
  block as centralBlock,
  bold as centralBold,
  book as centralBook,
  bookmark as centralBookmark,
  caption as centralCaption,
  check as centralCheck,
  chevronDown as centralChevronDown,
  circle as centralCircle,
  clock as centralClock,
  collection as centralCollection,
  columns as centralColumns,
  comment as centralComment,
  divider as centralDivider,
  document as centralDocument,
  file as centralFile,
  form as centralForm,
  gauge as centralGauge,
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
  quote as centralQuote,
  sectionRows as centralSectionRows,
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
import { elementHeading4IconPath1, elementHeading5IconPath1, elementHeading6IconPath1 } from './iconPaths';

// Astro components keep their cube so they stand apart from HTML elements.
export const ElementComponentIcon = (props: IconProps) => (
  <I {...props} size={centralIconSize(props.size ?? 16)} strokeWidth={0.9}>
    <path d="M8 2 13.5 5v6L8 14 2.5 11V5Zm-5.5 3L8 8l5.5-3M8 8v6" />
  </I>
);

export const ElementSlotIcon = centralIcon(centralSlot);

export const CustomElementIcon = centralIcon(centralCode);

export const ElementDivIcon = centralIcon(centralSquare);

export const ElementImageIcon = centralIcon(centralImage);

// Horizontal bands distinguish a section from a generic container.
export const ElementSectionIcon = (props: IconProps) => (
  <I {...props} size={centralIconSize(props.size ?? 16)} strokeWidth={0.9}>
    <rect x="2.5" y="2.5" width="11" height="11" rx="1.2" />
    <path d="M2.5 5h11m-11 6h11" />
  </I>
);

export const ElementListDefaultIcon = centralIcon(centralBulletList);

export const ElementListItemIcon = centralIcon(centralBulletList);

export const ElementLinkIcon = centralIcon(centralLink);

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

// A lowercase p reads as the HTML tag at the Navigator's compact size.
export const ElementParagraphIcon = (props: IconProps) => (
  <I {...props} size={centralIconSize(props.size ?? 16)} strokeWidth={1}>
    <path d="M5 14V4.5m0 3.3a3.25 3.25 0 1 1 6.5 0 3.25 3.25 0 0 1-6.5 0" />
  </I>
);

export const ElementVideoIcon = centralIcon(centralVideo);

export const ElementFormBlockIcon = centralIcon(centralForm);

export const ElementInputIcon = centralIcon(centralInput);

export const ElementSelectIcon = centralIcon(centralSelect);

export const ElementButtonIcon = centralIcon(centralButton);

export const HomeIcon = centralIcon(centralHome);

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
const MeterIcon = centralIcon(centralGauge);
const NumberedListIcon = centralIcon(centralNumberList);
const OutputIcon = centralIcon(centralTerminal);
const PictureIcon = centralIcon(centralLayers);
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
  nav: MenuIcon,
  noscript: CodeDisabledIcon,
  object: WindowIcon,
  ol: NumberedListIcon,
  optgroup: ElementListDefaultIcon,
  option: CheckIcon,
  output: OutputIcon,
  p: ElementParagraphIcon,
  picture: PictureIcon,
  pre: TextBlockIcon,
  progress: MeterIcon,
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
  textarea: TextBlockIcon,
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
} satisfies Readonly<Record<(typeof HTML_TAGS)[number], ElementIcon>>;

// Existing pages also contain document-level and inline SVG elements.
const EXTRA_ICONS = {
  area: CellIcon,
  base: ElementLinkIcon,
  body: WindowIcon,
  circle: CircleIcon,
  defs: TemplateIcon,
  ellipse: CircleIcon,
  g: LayersIcon,
  head: HeaderIcon,
  html: GlobeIcon,
  line: DividerIcon,
  link: ElementLinkIcon,
  math: DataIcon,
  meta: LabelIcon,
  param: ElementInputIcon,
  path: VectorIcon,
  polygon: VectorIcon,
  polyline: VectorIcon,
  rect: ElementDivIcon,
  script: CustomElementIcon,
  slot: ElementSlotIcon,
  style: StyleIcon,
  svg: VectorIcon,
  symbol: TemplateIcon,
  text: TextIcon,
  title: TextIcon,
  tspan: TextIcon,
  use: ElementLinkIcon,
};

const TAG_ICONS: ReadonlyMap<string, ElementIcon> = new Map([...Object.entries(HTML_ICONS), ...Object.entries(EXTRA_ICONS)]);
const TAG_NAME_LENGTH_MAX = 32;

export function elementIcon(tag: unknown, size = 12, className?: string) {
  const name = typeof tag === 'string' ? tag.slice(0, TAG_NAME_LENGTH_MAX + 1).toLowerCase() : '';
  const Icon = TAG_ICONS.get(name) ?? CustomElementIcon;
  return <Icon size={size} className={className} />;
}
