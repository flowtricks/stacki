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
  brandBun as centralBun,
  brandGit as centralGit,
  brandJavascript as centralJavascript,
  brandJson as centralJson,
  brandNetlify as centralNetlify,
  brandNpm as centralNpm,
  brandPhp as centralPhp,
  brandPython as centralPython,
  brandReact as centralReact,
  brandSvelte as centralSvelte,
  brandTypescript as centralTypescript,
  brandVercel as centralVercel,
  brandVue as centralVue,
  filePdf as centralFilePdf,
  fileZip as centralFileZip,
  fontStyle as centralFontStyle,
  law as centralLaw,
  markdown as centralMarkdown,
  table as centralTable,
  vectorLogo as centralVectorLogo,
} from './central/centralGeometry';

import type { ReactElement } from 'react';
import { assert } from '../../shared/core/assert';
import type { HTML_TAGS } from '../editor/elementSchemas';
import { type IconProps, I } from './IconBase';
import { mediaKindOf, type ExplorerEntryKind } from '../../shared/ipc/fileExplorer';
import { AstroIcon, BracesIcon, CodeIcon, ExternalIcon, FolderIcon, FolderOpenIcon, LockIcon, UnlinkIcon } from './Icons';
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
// The one table of what a listed file looks like, by its name: the Files tree and its search, the open file's header,
// the Git panel's changes and conflicts, `@` rows and chips, and the file lists in pickers and assets all read it, so
// a file looks the same everywhere. Every drawing is from the Central icon system (src/ui/central/centralGeometry.tsx,
// docs/central-icons.md), language and tool marks included, with one exception the owner asked for: an .astro file
// wears Astro's own mark, the app's `AstroIcon` (the supplied brand paths in src/ui/iconPaths.ts). Nothing new is
// drawn. A type Central has no mark for (CSS, Sass, Less, HTML, YAML, TOML, XML) keeps the plain code icon with no
// colour of its own, so it never passes for a mark it is not.

const FILE_GLYPHS = {
  bun: centralIcon(centralBun),
  git: centralIcon(centralGit),
  javascript: centralIcon(centralJavascript),
  json: centralIcon(centralJson),
  netlify: centralIcon(centralNetlify),
  npm: centralIcon(centralNpm),
  php: centralIcon(centralPhp),
  python: centralIcon(centralPython),
  react: centralIcon(centralReact),
  svelte: centralIcon(centralSvelte),
  typescript: centralIcon(centralTypescript),
  vercel: centralIcon(centralVercel),
  vue: centralIcon(centralVue),
  archive: centralIcon(centralFileZip),
  audio: centralIcon(centralAudio),
  braces: BracesIcon,
  code: CodeIcon,
  file: centralIcon(centralFile),
  font: centralIcon(centralFontStyle),
  image: centralIcon(centralImage),
  info: centralIcon(centralInfo),
  license: centralIcon(centralLaw),
  lock: LockIcon,
  markdown: centralIcon(centralMarkdown),
  pdf: centralIcon(centralFilePdf),
  table: centralIcon(centralTable),
  terminal: centralIcon(centralTerminal),
  text: centralIcon(centralFileText),
  vector: centralIcon(centralVectorLogo),
  video: centralIcon(centralVideo),
} as const;

export type FileGlyph = keyof typeof FILE_GLYPHS | 'astro';
/** The colour a type wears, a theme token each (styles.css, `data-file-hue`). */
export type FileHue = 'astro' | 'blue' | 'cyan' | 'green' | 'grey' | 'orange' | 'purple' | 'red' | 'yellow';

export interface FileLook {
  readonly glyph: FileGlyph;
  /** Absent: the icon takes the colour of the row it is in. */
  readonly hue: FileHue | undefined;
}

type FileRule = readonly [RegExp, FileGlyph, FileHue?];

// The first rule that matches wins, so whole names come before the extensions they end in.
const NAMED_RULES: readonly FileRule[] = [
  // Files that by convention hold secrets: drawn with a lock, so a person sees what they are opening.
  [/^\.env(\..+)?$|\.(pem|key)$/, 'lock', 'yellow'],
  [/^astro\.config\.[cm]?[jt]s$/, 'astro', 'astro'],
  [/^tsconfig(\..+)?\.json$/, 'typescript', 'blue'],
  [/^jsconfig(\..+)?\.json$/, 'javascript', 'yellow'],
  [/^(package(-lock)?\.json|npm-shrinkwrap\.json|\.npmrc|\.npmignore)$/, 'npm', 'red'],
  [/^(bun\.lockb?|bunfig\.toml)$/, 'bun'],
  [/^\.git(ignore|attributes|modules|keep|config)$/, 'git', 'orange'],
  [/^vercel\.json$/, 'vercel'],
  [/^netlify\.toml$/, 'netlify', 'cyan'],
  [/^readme(\.(md|mdx|markdown|txt))?$/, 'info', 'blue'],
  [/^(licen[cs]e|copying)(\.(md|markdown|txt))?$/, 'license', 'yellow'],
];

const EXTENSION_RULES: readonly FileRule[] = [
  [/\.astro$/, 'astro', 'astro'],
  [/\.[cm]?ts$/, 'typescript', 'blue'],
  [/\.[jt]sx$/, 'react', 'cyan'],
  [/\.[cm]?js$/, 'javascript', 'yellow'],
  [/\.(json|jsonc|json5)$/, 'json', 'yellow'],
  [/\.(md|markdown)$/, 'markdown', 'blue'],
  [/\.mdx$/, 'markdown', 'yellow'],
  [/\.vue$/, 'vue', 'green'],
  [/\.svelte$/, 'svelte', 'orange'],
  [/\.py$/, 'python', 'blue'],
  [/\.php$/, 'php', 'purple'],
  [/\.(sh|zsh|bash|fish)$/, 'terminal', 'green'],
  [/\.svg$/, 'vector', 'orange'],
  [/\.(woff2?|ttf|otf|eot)$/, 'font', 'red'],
  [/\.pdf$/, 'pdf', 'red'],
  [/\.(zip|tar|gz|tgz|bz2|xz|rar|7z)$/, 'archive', 'grey'],
  [/\.(csv|tsv)$/, 'table', 'green'],
];

// Asked after pictures, video and audio: the types that keep a plain icon.
const PLAIN_RULES: readonly FileRule[] = [
  [/\.lock$/, 'braces'],
  [/\.(css|scss|sass|less|html?|toml|ya?ml|xml)$/, 'code'],
  [/\.(txt|log)$/, 'text'],
];

const MEDIA_LOOKS = {
  image: { glyph: 'image', hue: 'purple' },
  video: { glyph: 'video', hue: 'orange' },
  audio: { glyph: 'audio', hue: 'purple' },
} as const satisfies Record<string, FileLook>;

/** Longer names are read from their end, where the extension is. */
const FILE_NAME_LENGTH_MAX = 255;

/** What a file looks like, by its name or its path (only the last segment counts). */
export function fileLookOf(path: string): FileLook {
  const name = path
    .slice(path.lastIndexOf('/') + 1)
    .slice(-FILE_NAME_LENGTH_MAX)
    .toLowerCase();
  const named = matchingRule(NAMED_RULES, name) ?? matchingRule(EXTENSION_RULES, name);
  if (named !== undefined) {
    return named;
  }
  const media = mediaKindOf(name);
  if (media !== undefined) {
    return MEDIA_LOOKS[media];
  }
  return matchingRule(PLAIN_RULES, name) ?? { glyph: 'file', hue: undefined };
}

function matchingRule(rules: readonly FileRule[], name: string): FileLook | undefined {
  const rule = rules.find(([pattern]) => pattern.test(name));
  return rule === undefined ? undefined : { glyph: rule[1], hue: rule[2] };
}

/** Astro's mark runs to the edges of its drawing, so it is drawn at this share of the box to look the others' size. */
const ASTRO_BOX_SHARE = 0.75;

/** A file's icon in a square box of the Central size at or above `size`, in its type's colour. */
export function FileTypeIcon(props: { readonly name: string; readonly size?: number; readonly className?: string | undefined }) {
  const box = centralIconSize(props.size ?? 14);
  const look = fileLookOf(props.name);
  assert(look.glyph === 'astro' || look.glyph in FILE_GLYPHS, 'FileTypeIcon: every look has a drawing');
  return (
    <span
      className={props.className === undefined ? 'file-type-icon' : `file-type-icon ${props.className}`}
      style={{ width: box, height: box }}
      data-file-type={look.glyph}
      data-file-hue={look.hue}
    >
      <FileGlyphDrawing glyph={look.glyph} box={box} />
    </span>
  );
}

function FileGlyphDrawing({ glyph, box }: { readonly glyph: FileGlyph; readonly box: number }) {
  if (glyph === 'astro') {
    return <AstroIcon size={Math.round(box * ASTRO_BOX_SHARE)} />;
  }
  const Icon = FILE_GLYPHS[glyph];
  return <Icon size={box} />;
}

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
      return <FileTypeIcon name={props.name} />;
    default: {
      const exhaustive: never = props.kind;
      return exhaustive;
    }
  }
}
