import { usePropertySaveGuard } from './usePropertySaveGuard';
import ComponentPropertiesPanel from './panels/ComponentPropertiesPanel';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { SetStateAction } from 'react';
import type { Attr, ImportDecl, PageModel, PageNode, PairedNode } from '../shared/page-node';
import type { ScanComponent, ScanPage, ScanResult } from '../shared/scan';
import type { WireCommitInfo, WireInjectedRoute } from '../shared/ipc-results';
import WelcomeScreen from './panels/WelcomeScreen';
import PagesPanel from './panels/PagesPanel';
import PalettePanel from './panels/PalettePanel';
import StructurePanel from './panels/StructurePanel';
import { isFragmentNode } from './panels/structureModel';
import { isInlineRun, noteIndexAbove, noteText, noteValue, selectionAfterDelete } from './treeSelection.js';
import { canvasClickAction } from './canvasClick.js';
import { liveClassesById as classesByNodeId, rendersOwnElement } from './liveClasses.js';
import { setSoundEnabled } from './ui/sound.js';
import { createPreviewWatch } from './previewRecovery.js';
import { tellCanvas } from './canvasQuery.js';
import { renameAttr } from './attrOrder.js';
import { parsePageSource as parseSourcePage, readPage, readSymbol, scanProject } from './bridge';
import { checkoutGitBranch, readGitInfo } from './gitChipBridge';
import { LIMITS } from '../shared/limits';
import { assert } from '../shared/assert';
import PreviewPane from './panels/PreviewPane';
import GitChip from './panels/GitChip';
import HistoryPanel, { relativeTime } from './panels/HistoryPanel';
import { ConfirmHost, confirmDialog } from './ui/ConfirmDialog';
import { mergeBranchAction, deleteBranchAction } from './gitActions.js';
import LeftRail from './ui/LeftRail';
import { lazyPanel } from './ui/lazyPanel';
import PageSwitcher from './ui/PageSwitcher';
import DynamicPicker from './ui/DynamicPicker';
import {
  ASTRO_ASSETS,
  ASTRO_ASSETS_MODULE,
  PLACEHOLDER_PROPS,
  astroAsset as astroAssetDef,
} from './astroAssets.js';
import InsertSearch from './ui/InsertSearch';
import AssetsPanel from './panels/AssetsPanel';
import { getElementSchema, GLOBAL_ATTRS, HTML_TAGS, VOID_TAGS } from './elementSchemas.js';
import { insertTargetFor as placeInsert } from './insertTarget.js';
import { isInlineOnly } from './ui/RichContent';
import { onAssetRequest, clearAssetRequest } from './assetPick.js';
import { isDataBound } from './bindings.js';
import { thenBranch } from './branches.js';
import { keepsSlot } from './slotAttr.js';
import { createFileSaver, createPageSaver, scanContainsFile } from './pagePersistence.js';
import { ancestorChain, createTreeIndex, isDescendantOf, nodeAtPath, pathOfNode } from './editorTree.js';
import { readFrontmatter, writeFrontmatter } from '../electron/frontmatter';
import { renameLoopVar, parseLoopHead, disconnectDependentLoops, loopVarsAt, stripLostBindings } from './loopBindings.js';
import {
  namesUsedIn,
  neededFrontmatter,
  unusedDeclarations,
  withStatements,
  withoutDeclarations,
} from './frontmatterMove.js';
import { hasClass, namesIn, withClass } from './classAttr.js';
import { toComponentName } from './componentName.js';
import { resolveInstanceProps } from './instanceProps.js';
import { propsForExtraction } from './extractProps.js';
import TerminalDock from './panels/TerminalDock';
import { cleanError, stripAnsi } from './cleanError.js';
import { elementLabel } from './classNames.js';
import {
  autoQueryName,
  collectionsInScope,
  findImportOf,
  markedQueries,
  namesInScope,
  queriesInScope,
  QUERY_MARK,
  referencesInScope,
  removeMarkedQuery,
} from './dataSuggest.js';
import {
  PreviewIcon,
  RefreshIcon,
  ExternalIcon,
  ChevronLeftIcon,
  ElementComponentIcon,
  TerminalIcon,
} from './ui/Icons';
import type { PickedAsset } from './ui/AssetField';
import type { InlineNode } from './ui/RichContent';
import type { Rename, TagOption } from './panels/propNodeEditors';
import type { FieldDefinition, PropValues } from './panels/propRules';
import type { OverlayInfo } from './panels/PreviewOverlays';
import type { PreviewCrumb } from './panels/PreviewToolbar';
import type { AstroAsset } from './astroAssets';
import type { ComponentCreationSource } from './panels/PaletteDialogs';
import type { DevDiagnosis } from './panels/DevOffline';
import type { PreviewDevice } from './panels/PreviewToolbar';
import type { SpacingHover } from './panels/PreviewOverlays';
import type { VariableSelection } from './variablesBridge';
import type { InsertTarget } from './insertTarget';
import type { InsertItem } from './ui/InsertSearch';
import { toRecord } from '../shared/record';
import { projectRelativePath } from './projectPath.js';
import { currentDesktopPlatform, shortcutLabel } from './shortcutLabel.js';
import { sourceNodeAtOffset } from './codePanelModel.js'
import {
  codeWindowFor,
  FRONTMATTER_SUBJECT,
  type CodeSubject,
  type FrontmatterSubject,
} from './codeWindowTarget';
import {
  cloneEditorModel,
  findEditorNodeById as findNodeById,
  findEditorParentList as findParentList,
  nodeId,
  toEditorPageState,
  type AppHistory,
  type AssetPick,
  type CodeWindowState,
  type CollectionSamples,
  type CurrentPage,
  type DevStatus,
  type DynamicEntry,
  type EditorModel,
  type EditorNode,
  type EditorPageState,
  type GitInfo,
  type InjectedRoute,
  type ItemIndexes,
  type LeftTab,
  type NodeStates,
  type NodeClipboard,
  type OpenFile,
  type PageSnapshot,
  type PageStateSnapshot,
  type PreviewCommitInfo,
  type ProjectIdentity,
  type RightTab,
  type RightTabIndicator,
  type ScanRequest,
  type ToastKind,
  type ToastMessage,
  type TrailingSlash,
  type UndoCommand,
} from './appTypes';
import {
  addRecentProject,
  closeProject,
  copyEditorSelection,
  diagnoseProject,
  createProjectPage,
  createProjectPageFolder,
  createProjectComponent,
  deleteProjectPage,
  deleteProjectPageFolder,
  findImportPath,
  installProjectDependencies,
  moveProjectPage,
  onAppProgress,
  onCmsInventoryChanged,
  onDevExit,
  onDevLog,
  onFilesChanged,
  onPageMaybeChanged,
  onSoundSettingChanged,
  openExternalURL,
  openProject,
  pendingProject,
  previewProjectCommit,
  probeProjectPreview,
  projectHasNodeModules,
  readProjectClasses,
  readContentCollections,
  readDynamicPaths,
  readInjectedRoutes,
  readProjectAsset,
  readSampleEntry,
  readComponentUsage,
  readAppSettings,
  rebaseProjectImport,
  renameProjectPageFolder,
  resolveProjectImport,
  restoreProjectFile,
  restoreProjectVersion,
  runNativeEdit,
  startProjectPreview,
  stopProjectCommitPreview,
  watchProject,
  writeProjectFile,
  writeProjectPage,
  writeProjectPageRaw,
  type AppCollection,
} from './appBridge';

// Each optional editor owns its loading boundary so opening it keeps the
// canvas and neighboring panels visible and interactive.
const PropsPanel = lazyPanel(() => import('./panels/PropsPanel'));
const StylePanel = lazyPanel(() => import('./panels/StylePanel'));
const CodeWindow = lazyPanel(() => import('./ui/CodeWindow'));
const CmsPanel = lazyPanel(() => import('./panels/CmsPanel'));
const CmsView = lazyPanel(() => import('./panels/CmsView'));
const ContentView = lazyPanel(() => import('./panels/ContentView'));
const VariablesPanel = lazyPanel(() => import('./panels/VariablesPanel'));
const VariablesView = lazyPanel(() => import('./panels/VariablesView'));
const CodePanel = lazyPanel(() => import('./panels/CodePanel'))

let idCounter = 1000;
const newId = () => nodeId(`c${idCounter++}`);

// Placeholder copy for newly inserted text elements, so they're visible on the
// canvas straight away instead of collapsing to a zero-height box.
const LOREM =
  'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Suspendisse varius ' +
  'enim in eros elementum tristique. Duis cursus, mi quis viverra ornare, eros ' +
  'dolor interdum nulla, ut commodo diam libero vitae erat. Aenean faucibus nibh ' +
  'et justo cursus id rutrum lorem imperdiet. Nunc ut sem vitae risus tristique ' +
  'posuere.';
const DEFAULT_TEXT = {
  h1: 'Heading',
  h2: 'Heading',
  h3: 'Heading',
  h4: 'Heading',
  h5: 'Heading',
  h6: 'Heading',
  p: LOREM,
};

function defaultText(tag: string): string | undefined {
  switch (tag) {
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
    case 'p':
      return DEFAULT_TEXT[tag];
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Tree helpers (model.nodes is a tree of {id, kind, name?, props?, children?})
// ---------------------------------------------------------------------------

// Whether a subtree reads anything from the file it currently sits in — an
// expression, a conditional, a loop, or a prop written as code. Moved into a
// component, those names aren't in scope any more: `{title}` in a page reads
// the page's `title`, and in Card.astro it reads nothing at all. Not something
// to refuse over (the fix is a prop, and only the author knows its name) but
// very much something to say out loud.
function usesPageScope(node: PageNode | null | undefined): boolean {
  if (!node) {return false;}
  if (['expr', 'cond', 'map', 'branch'].includes(node.kind)) {return true;}
  const props = 'props' in node ? node.props : undefined;
  for (const value of Object.values(props || {})) {
    if (value && value.type === 'expr') {return true;}
  }
  const children = 'children' in node ? node.children : undefined;
  return (children || []).some(usesPageScope);
}

// Loops and conditionals render their children straight through, so a `slot`
// under one is still read by whatever component sits above it.
const SLOT_TRANSPARENT = new Set(['map', 'cond', 'branch', 'chunk-group']);

// The component (or layout) whose slots a node's `slot` attribute names,
// looking past those pass-through wrappers. Null when the node lands in a
// plain element or at the page root — nothing there reads a slot name.
function slotHostOf(model: Pick<PageModel, 'nodes'>, id: string): PairedNode | null {
  const parents = (ancestorChain(model.nodes, id) || []).slice(0, -1);
  const node = parents.reverse().find((parent) => !SLOT_TRANSPARENT.has(parent.kind));
  return node?.kind === 'component' ? node : null;
}

// What we know about a placed component, which may be imported under a local
// name of its own (`import Layout from '../layouts/BaseLayout.astro'`) — so
// fall back to the file the import points at. Null means "no definition
// scanned", which is never the same answer as "has no slots".
function definitionOf(
  model: Pick<PageModel, 'imports'>,
  node: Pick<PairedNode, 'name'>,
  insertables: readonly ScanComponent[],
): ScanComponent | null {
  const byName = insertables.find((c) => c.name === node.name);
  if (byName) {return byName;}
  const imp = (model.imports || []).find((i) => i.name === node.name);
  const base = imp?.path.split('/').pop()?.replace(/\.astro$/i, '');
  return (base && insertables.find((c) => c.name === base)) || null;
}

// First element with this tag, depth-first. Used to land the selection on a
// layout's <body> when it is opened: the html/head wrapper above it is not
// what anyone came to edit, and <body> is the page's real root.
function findElementByTag(
  nodes: readonly PageNode[] | null | undefined,
  tag: string,
): PairedNode | null {
  for (const n of nodes || []) {
    if (n.kind === 'element' && String(n.name).toLowerCase() === tag) {return n;}
    if ('children' in n && Array.isArray(n.children)) {
      const found = findElementByTag(n.children, tag);
      if (found) {return found;}
    }
  }
  return null;
}

// Start a component on its rendered markup, looking through control flow and
// fragments because those wrappers have no element to style. Layouts keep
// their <body> selection; files without rendered markup still get a fallback.
function openingSelection(nodes: readonly PageNode[] | null | undefined): PageNode | null {
  const list = Array.isArray(nodes) ? nodes : [];
  const firstRendered = (children: readonly PageNode[] | null | undefined): PageNode | null => {
    for (const node of children || []) {
      const markup = node.kind === 'element' || node.kind === 'component';
      if (SLOT_TRANSPARENT.has(node.kind) || (markup && ['Fragment', 'slot'].includes(node.name))) {
        const child = firstRendered('children' in node ? node.children : undefined);
        if (child) {return child;}
      } else if (markup && !['head', 'script', 'style', 'link', 'meta', 'title', 'base', 'template'].includes(node.name)) {
        return node;
      }
    }
    return null;
  };
  return findElementByTag(list, 'body') || firstRendered(list) || outermostNode(list);
}

// The outermost thing a page renders: its layout wrapper when it has one,
// otherwise the first real node. A doctype line, a leading comment or stray
// whitespace isn't what the page is about, so those are skipped — but any
// node beats selecting nothing.
function outermostNode(nodes: readonly PageNode[] | null | undefined): PageNode | null {
  const list: readonly PageNode[] = nodes ?? [];
  return list.find((n) => n.kind === 'element' || n.kind === 'component') || list[0] || null;
}

interface OpenFileOptions {
  readonly nextStack: SetStateAction<readonly OpenFile[]>;
  readonly selectionPath: string | null;
}

// Returning from a component should land on the instance that opened it. The
// path is stored with the child stack entry because node ids can change when
// the parent file is parsed again during the return trip.
function openFileSelection(
  entry: OpenFile,
  result: EditorPageState,
  selectionPath: string | null,
): PageNode | null {
  if (!result.editable) {return null;}
  if (selectionPath) {
    const localPath = selectionPath.split('|').at(-1);
    assert(localPath !== undefined, 'A stored component path must have a local path');
    const selected = nodeAtPath(result.model.nodes, localPath.split('.').map(Number));
    if (selected) {return selected;}
  }
  return entry.kind === 'component'
    ? openingSelection(result.model.nodes)
    : outermostNode(result.model.nodes);
}

function collectUsedNames(model: PageModel): Set<string> {
  const used = new Set<string>();
  const walk = (list: readonly PageNode[]): void => {
    for (const node of list) {
      if ('name' in node && node.name) {used.add(node.name);}
      if ('children' in node && Array.isArray(node.children)) {walk(node.children);}
    }
  };
  walk(model.nodes);
  return used;
}

// Comments in the frontmatter are prose about the page, and prose names the
// things the page is built from — `// Hero copy` is talk about <Hero>, not a
// use of it. Only whole-line `//` comments go: a trailing one can't be told
// from the `//` inside a URL without really parsing, and cutting a string in
// half there would hide a reference that is real.
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

// Everything in the file that is code rather than markup: the frontmatter, a
// loop's head, a condition's test, an expression node, and any prop whose
// value is an expression. An imported name can be used in any of them without
// ever appearing as a tag.
//
// <style> and <script> bodies are pointedly not code for this purpose. Both
// are their own scope in Astro — CSS never sees a frontmatter binding, and a
// <script> is a separate module — so a name inside one is a coincidence, not
// a use. Reading them meant a `.Hero` class or a `/* Hero */` note pinned
// <Hero>'s import in place for good. What those blocks genuinely share comes
// in through `define:vars`, which is a prop expression and is still read.
function codeText(model: PageModel): string {
  const parts = [stripComments(model.extraFrontmatter || '')];
  const walk = (list: readonly PageNode[]): void => {
    for (const node of list) {
      if (node.kind === 'expr' || node.kind === 'raw-line') {parts.push(node.value || '');}
      if (node.kind === 'map') {parts.push(node.head || '');}
      if (node.kind === 'cond') {parts.push(node.test || '');}
      const props = 'props' in node ? node.props : undefined;
      for (const v of Object.values(props || {})) {
        if (v && (v.type === 'expr' || v.type === 'spread')) {parts.push(String(v.value ?? ''));}
      }
      if ('children' in node && Array.isArray(node.children)) {walk(node.children);}
    }
  };
  walk(model.nodes);
  return parts.join('\n');
}

// How long a pending save waits, by urgency. See scheduleSave.
function saveDelay(urgency: boolean | 'live'): number {
  if (urgency === true) {
    return 0;
  }
  if (urgency === 'live') {
    return 120;
  }
  return 300;
}

// A route is stored the way it identifies a page — slashless, so /de/hotel
// and /de/hotel/ are the same entry however a link was typed. A URL is a
// different thing: Astro's dev server serves exactly one of those spellings,
// and answers the other with a 404 help page. So the project's trailingSlash
// is applied on the way from one to the other, never before.
function routeToPath(route: string, trailingSlash: TrailingSlash): string {
  if (!route || route === '/') {return route || '/';}
  // An extension means a file, not a directory-style route: /rss.xml keeps
  // its shape under every setting, which is also how Astro checks it.
  if (trailingSlash === 'always') {return /\.[^/]+$/.test(route) ? route : route + '/';}
  if (trailingSlash === 'never') {return route.replace(/\/$/, '');}
  return route; // 'ignore' — the default, and it serves either
}

function parseTrailingSlash(value: string): TrailingSlash {
  if (value === 'always' || value === 'never' || value === 'ignore') {
    return value;
  }
  throw new Error(`Unknown trailing-slash mode: ${value}`);
}

// Imports the app is willing to remove once nothing refers to them: a
// component file of any flavour Astro renders, an image, and Astro's own
// <Image>/<Picture>. All three are reachable only as a tag or from an
// expression, both of which the check below reads in full. A stylesheet, a
// data module or a utility is left alone — those get imported for effects
// this file can't see, and dropping one that is still doing its job breaks
// the page.
const COMPONENT_IMPORT_RE = /\.(astro|jsx|tsx|vue|svelte)$/i;
const ASSET_IMPORT_RE = /\.(png|jpe?g|gif|webp|avif|svg)$/i;

function prunableImport(i: ImportDecl): boolean {
  return (
    COMPONENT_IMPORT_RE.test(i.path) ||
    ASSET_IMPORT_RE.test(i.path) ||
    i.path === ASTRO_ASSETS_MODULE
  );
}

function pruneImports(model: EditorModel): void {
  const used = collectUsedNames(model);
  // A name can be referenced as code rather than as a tag — inside a
  // `<Fragment set:html>` chunk, a frontmatter const, a prop expression. The
  // test is deliberately loose (a bare word anywhere in the code counts),
  // because the cost of a false positive is a stray import and the cost of a
  // false negative is deleting something the page still needs.
  const code = codeText(model);
  const mentioned = (name: string): boolean =>
    new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(code);
  model.imports = model.imports.filter(
    (i) => !prunableImport(i) || used.has(i.name) || mentioned(i.name)
  );
}

// Chooses an import path matching the page's existing style: if it already
// imports via a src alias (e.g. "@/components/X.astro"), reuse that alias
// root for the new import; otherwise fall back to a relative path.
function chooseImportPath(
  model: Pick<PageModel, 'imports'>,
  paths: { readonly relative: string; readonly srcRelative: string | null },
): string {
  const { relative, srcRelative } = paths;
  if (srcRelative) {
    for (const imp of model.imports) {
      if (imp.path.startsWith('.')) {continue;}
      for (const marker of ['/components/', '/layouts/']) {
        const idx = imp.path.indexOf(marker);
        if (idx > 0) {return imp.path.slice(0, idx + 1) + srcRelative;}
      }
    }
  }
  return relative;
}

// Whether the props panel would offer this node a Content field — the rich
// inline editor over its words. The same test PropsPanel makes: children that
// are all text and simple inline tags, or an element still empty and able to
// hold text. Kept in step with it by hand; the two disagreeing would mean a
// double-click that focuses a field which isn't there.
function holdsInlineText(node: PageNode | null | undefined): boolean {
  if (!node || node.kind !== 'element') {return false;}
  if (VOID_TAGS.has(String(node.name).toLowerCase())) {return false;}
  const kids = node.children;
  return isInlineOnly(kids) || !Array.isArray(kids) || kids.length === 0;
}

export default function App() {
  const propertySave = usePropertySaveGuard();
  const [project, setProject] = useState<ProjectIdentity | null>(null);
  const [scan, setScan] = useState<ScanResult>({
    pages: [],
    pageFolders: [],
    layouts: [],
    components: [],
  });
  const [projectClasses, setProjectClasses] = useState<readonly string[]>([]);
  const [currentPage, setCurrentPage] = useState<CurrentPage | null>(null);
  // Drill-down trail: [page, component, nested component, …]. The last entry
  // is what's on screen; anything before it is what Back/Escape returns to.
  const [editStack, setEditStack] = useState<readonly OpenFile[]>([]);
  const [pageState, setPageState] = useState<EditorPageState | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Classes the selected element actually carries on the page, reported by the
  // preview. An expression-valued class attribute (`class:list={[…]}`,
  // `class={x}`) has no readable text in the source, so this is what lets the
  // style panel show the classes this instance resolved to.
  const [selectedClasses, setSelectedClasses] = useState<readonly string[]>([]);
  // Which selection the classes above describe, and a counter that lets the
  // effect below re-check the moment a report lands rather than on a timer.
  const classesForRef = useRef<string | null>(null);
  const [classesTick, setClassesTick] = useState(0);
  const [hoverNodeId, setHoverNodeId] = useState<string | null>(null);
  // Paths the page reports as having actually rendered something. Null until
  // the page has said anything, which is not the same as "nothing rendered".
  const [renderedPaths, setRenderedPaths] = useState<readonly string[] | null>(null);
  // Nodes the page says are there but taking no part: display:none, and
  // pointer-events:none. Marked in the navigator (see StructurePanel).
  const [nodeStates, setNodeStates] = useState<NodeStates | null>(null);
  // path -> the classes that node rendered with, for labelling rows whose
  // class is an expression the source can't resolve.
  const [nodeClasses, setNodeClasses] = useState<
    Readonly<Record<string, readonly string[]>
  > | null
  >(null);
  const [devUrl, setDevUrl] = useState<string | null>(null);
  const [trailingSlash, setTrailingSlash] = useState<TrailingSlash>('ignore');
  const [devStatus, setDevStatus] = useState<DevStatus>('off');
  const [devLog, setDevLog] = useState('');
  const [devDiag, setDevDiag] = useState<DevDiagnosis | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  // Concrete paths behind a dynamic route, and which one the canvas is showing.
  const [dynamicPaths, setDynamicPaths] = useState<readonly DynamicEntry[]>([]);
  // Routes the dev server serves that aren't files here — pages an integration
  // injected. A project can consist entirely of these (a site whose pages ship
  // in a package), in which case they are the only pages there are to show.
  const [injectedRoutes, setInjectedRoutes] = useState<readonly InjectedRoute[]>([]);
  // One sampled entry per collection the open file reads by name, for the
  // binding picker. Keyed by collection; a name present with a null value has
  // been asked for and has no answer, which stops it being asked again.
  const [collectionSamples, setCollectionSamples] = useState<CollectionSamples>({});
  // Every collection the project has, so data anywhere in the site is
  // reachable from the picker — not only what this page already reads.
  const [collections, setCollections] = useState<readonly AppCollection[]>([]);
  const sampleAskedRef = useRef(new Set<string>());
  const [dynamicIndex, setDynamicIndex] = useState(0);
  // Which item of each loop's list the data picker reads as `service`, `post`,
  // … — keyed by the item's own name. See bindContext below.
  const [itemIndex, setItemIndex] = useState<ItemIndexes>({});
  const [dynamicError, setDynamicError] = useState<string | null>(null);
  const [leftTab, setLeftTab] = useState<LeftTab>('navigator');
  useEffect(() => {
    if (leftTab !== 'navigator') {
      setHoverNodeId(null);
    }
  }, [leftTab]);
  const componentPropertiesOpen = currentPage?.kind === 'component';
  useEffect(() => {
    if (!componentPropertiesOpen) {
      setLeftTab((tab) => ( tab === 'properties' ? 'navigator' : tab));
    }
  }, [componentPropertiesOpen]);
  const [cmsRel, setCmsRel] = useState<string | null>(null);
  // Content collection open in the schema-driven editor. Only one of the two
  // is ever open: they edit the same kind of thing in two different ways.
  const [contentName, setContentName] = useState<string | null>(null);
  // Which stylesheet group the variables sheet is showing: { file, index }.
  const [varsGroup, setVarsGroup] = useState<VariableSelection | null>(null);
  const [cmsTick, setCmsTick] = useState(0); // bumped on save, refreshes counts
  const [cmsSettings, setCmsSettings] = useState(false); // editing that collection's fields
  const [inPreview, setInPreview] = useState(false); // interactive full-site preview
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  // The path the canvas is on, kept where the preview toggle can read it: it's
  // derived at the bottom of this component (a dynamic page's entry is picked
  // there), long after the callbacks up here are defined.
  const livePathRef = useRef<string | null>(null);
  const [termOpen, setTermOpen] = useState(false); // bottom terminal dock
  const [codeWin, setCodeWin] = useState<CodeWindowState | null>(null);
  const codeEditVersionRef = useRef(0)
  const openCodeWindowRef = useRef<(() => boolean) | null>(null);
  const selectionKeysRef = useRef<readonly string[]>([]);
  const [fileText, setFileText] = useState(''); // loaded text for kind:'file'
  // Breakpoint lives here, not in PreviewPane: a re-mount of that pane must
  // not silently drop the user out of the view they picked (which would
  // reload every preview iframe and flash the canvas white).
  const [device, setDevice] = useState<PreviewDevice>('desktop');
  // Bumped every time the page itself makes the selection, so the navigator
  // scrolls the row into view — a counter, not the id, so clicking the same
  // element twice still reveals it.
  const [revealTick, setRevealTick] = useState(0);
  const [rightTab, setRightTab] = useState<RightTab>('style');
  // ⌘Enter asks the props panel to open Settings and take the caret into the
  // class field — a counter, so pressing it again re-focuses.
  // Git state, read here so the History panel and the title-bar chip cannot
  // disagree about which branch is checked out. The chip still refreshes it on
  // its own schedule; this is the copy the panel reads.
  const [gitInfo, setGitInfo] = useState<GitInfo | null>(null);
  // The commit being previewed, or null for the working tree. See phase 4:
  // while this is set the canvas points at a separate server and the editor is
  // read-only.
  const [previewRef, setPreviewRef] = useState<string | null>(null);
  const [previewInfo, setPreviewInfo] = useState<PreviewCommitInfo | null>(null);
  const [classFocus, setClassFocus] = useState(0);
  const [contentFocus, setContentFocus] = useState(0);
  // Sliding highlight behind the active Style/Settings tab, measured from the
  // buttons so it tracks their real geometry (and any panel resize).
  const rightTabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const [rightTabInd, setRightTabInd] = useState<RightTabIndicator | null>(null);
  // The asset request a field is waiting on, and the tab to go back to once
  // it's answered — "Choose Image…" borrows the left panel rather than
  // opening a window over the canvas.
  const [assetPick, setAssetPick] = useState<AssetPick | null>(null);
  const tabBeforePick = useRef<LeftTab>(null);
  // Bumped by ⌘⇧A: the Components panel opens its naming dialog when it changes.
  const [createRequest, setCreateRequest] = useState(0);

  // A layout is just a component that lives in src/layouts — it can be
  // placed on a page like any other. Every lookup that answers "what do we
  // know about the component named X" has to search both lists, or a placed
  // layout would come back with no props, no slots and no rest support.
  // Components win a name collision: they're the more likely intent.
  const insertables = useMemo(
    () => [...scan.components, ...scan.layouts],
    [scan.components, scan.layouts]
  );

  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const devLogRef = useRef('');
  const pageStateRef = useRef<PageStateSnapshot>({ currentPage: null, pageState: null });
  pageStateRef.current = { currentPage, pageState };
  const selectedIdRef = useRef<string | null>(null);
  selectedIdRef.current = selectedId;

  // A report from the canvas about what the selected element's classes really
  // are. It is always about whatever is selected right now — the canvas is
  // asked for the tracked path — so this records which element it answered
  // for, which is what lets the panel tell a fresh answer from a stale one.
  const receiveClasses = useCallback((list: readonly string[]) => {
    classesForRef.current = selectedIdRef.current;
    setSelectedClasses(list);
    setClassesTick((n) => n + 1);
  }, []);
  const editStackRef = useRef<readonly OpenFile[]>([]);
  editStackRef.current = editStack;
  const inPreviewRef = useRef(false);
  inPreviewRef.current = inPreview;
  const previewPathRef = useRef<string | null>(null);
  const previewIframeRef = useRef<HTMLIFrameElement | null>(null);

  // ----------------------------------------------------------------
  // Toasts & events
  // ----------------------------------------------------------------

  // Why the dev server isn't running (missing Node, a Node too old for the
  // project's Astro, uninstalled deps). Only asked for once it has failed —
  // the answer is what the offline pane explains instead of a raw log.
  // projectRef is declared further down, but this only reads it when called.
  const diagnose = useCallback(() => {
    const p = projectRef.current?.path;
    if (!p) {return;}
    diagnoseProject(p)
      .then((d) => setDevDiag(d))
      .catch(() => setDevDiag(null));
  }, []);

  // `picked` is passed as literal true by the pick itself — the Cancel button
  // hands this its click event, which must not read as a pick.
  const endAssetPick = useCallback((picked: unknown) => {
    clearAssetRequest();
    setAssetPick(null);
    setLeftTab((t) => {
      if (t !== 'assets') {return t;}
      // Answering the field ends the errand: show the element it belongs to
      // rather than leaving the user parked in the asset browser — including
      // when the browser is where they started, which used to strand them.
      // Cancelling changed nothing, so that goes back where they came from.
      return picked === true ? 'navigator' : tabBeforePick.current || 'navigator';
    });
    tabBeforePick.current = null;
    // The navigator opens on the element that was just given an asset, not
    // wherever it happened to be scrolled.
    if (picked === true) {setRevealTick((n) => n + 1);}
  }, []);

  useEffect(() => {
    return onAssetRequest((req) => {
      if (!req) {return;} // cleared from this side already
      setAssetPick({
        ...req,
        // The entry rides along: which root it came from decides whether the
        // field writes a URL, an import, or a path relative to its own file.
        onPick: (rel, entry) => {
          req.onPick(rel, entry);
          endAssetPick(true);
        },
      });
      setLeftTab((t) => {
        if (t !== 'assets') {tabBeforePick.current = t;}
        return 'assets';
      });
    });
  }, [endAssetPick]);

  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const showToast = useCallback((msg: string, kind: ToastKind = 'info') => {
    setToast({ msg, kind });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 5000);
  }, []);
  useEffect(() => () => clearTimeout(toastTimer.current), []);

  useEffect(() => {
    const offProgress = onAppProgress((message) => setBusy(message));
    const offExit = onDevExit((log) => {
      setDevStatus('off');
      setDevUrl(null);
      if (log) {
        devLogRef.current = log;
        setDevLog(log);
      }
      diagnose();
    });
    const offLog = onDevLog((chunk) => {
      devLogRef.current = stripAnsi(devLogRef.current + chunk).slice(-4000);
      setDevLog(devLogRef.current);
    });
    return () => {
      offProgress();
      offExit();
      offLog();
    };
  }, []);

  // ----------------------------------------------------------------
  // Recovering the preview after a compile error
  // ----------------------------------------------------------------
  //
  // See src/previewRecovery.js for what this is for and why it asks the server
  // rather than reading the error screen or the log.
  //
  // The route is read through `livePathRef` rather than named as a dependency:
  // it is assigned far below this hook, so a dep array mentioning it reads it
  // before its declaration and the whole app throws (see test/app-renders.js,
  // which is here because that has happened before). The ref is current by the
  // time a probe actually runs, and the watch has no reason to be rebuilt just
  // because the route changed.
  useEffect(() => {
    if (!devUrl) {return undefined;}
    // Both of these arrive with the main process, which does not reload when the
    // renderer does (see VITE_DEV_SERVER_URL): a renderer newer than the bridge
    // would call undefined and take the app down with it. Absent means there is
    // nothing to ask, which is the same answer as having no dev server.
    if (typeof window.avb.probeDevPage !== 'function' || typeof window.avb.onPageMaybeChanged !== 'function') {
      return undefined;
    }
    const watch = createPreviewWatch({
      probe: () => probeProjectPreview(devUrl + (livePathRef.current || '/')),
      onRecover: () => setRefreshKey((k) => k + 1),
    });
    // Every write the app makes, plus every change made outside it.
    const offWrite = onPageMaybeChanged((event) => {
      watch.poke();
      // A change from outside the app — an editor, a script, a checkout. The
      // canvas normally hears about it over the dev server's HMR socket, and
      // when that socket has gone quiet (a dev server restarted under a canvas
      // that stayed open, a machine that slept) nothing says so: the page just
      // stops updating and the only way to see an edit is the refresh button.
      // The app's own watcher saw this change, so it says it directly too.
      if (event.external) {tellCanvas({ type: 'avb:patch-now' });}
    });
    return () => {
      offWrite();
      watch.stop();
    };
  }, [devUrl]);

  // ----------------------------------------------------------------
  // Project lifecycle
  // ----------------------------------------------------------------

  const scanRequestRef = useRef<ScanRequest | null>(null);
  const rescan = useCallback(async (projectPath: string): Promise<ScanResult> => {
    // The bridge parses the payload against the scan contract before any of
    // this code sees it.
    let request = { projectPath, promise: scanProject(projectPath), applied: false };
    scanRequestRef.current = request;
    let chain = 0;
    while (true) {
      chain += 1;
      // Each continue requires a strictly newer request for the same project;
      // a live cap hit means the chain stopped converging — a bug, not load.
      if (chain > LIMITS.rescanChainMax) {
        throw new Error(`rescan chain exceeded ${LIMITS.rescanChainMax} hops for ${projectPath}`);
      }
      let result: ScanResult | undefined;
      let failure: unknown;
      try {
        result = await request.promise;
      } catch (err) {
        failure = err;
      }
      const latest = scanRequestRef.current;
      // Mutations and watcher events can scan together. Older callers need
      // the latest snapshot too, especially before deciding a file was deleted.
      if (latest !== request && latest?.projectPath === projectPath) {
        request = latest;
        continue;
      }
      if (failure !== undefined) {throw failure;}
      if (!result) {
        throw new Error('Project scan completed without a result');
      }
      if (latest === request && !request.applied) {
        request.applied = true;
        setScan(result);
        if (result.trailingSlash) {setTrailingSlash(parseTrailingSlash(result.trailingSlash));}
        const appliedRequest = request;
        readProjectClasses(projectPath).then((classes) => {
          if (scanRequestRef.current === appliedRequest) {setProjectClasses(classes || []);}
        }).catch(() => {});
      }
      return result;
    }
  }, []);

  const startPreview = useCallback(
    async (projectPath: string) => {
      setDevStatus('starting');
      try {
        const started = await startProjectPreview(projectPath);
        const { url, trailingSlash: resolved } = started;
        setDevUrl(url);
        if (resolved) {setTrailingSlash(parseTrailingSlash(resolved));}
        setDevStatus('on');
        setDevDiag(null);
        if ('external' in started && started.external) {
          showToast(
            `Reusing the dev server already running for this project (${url}) — canvas outlines need the app's own server, so stop that one to enable them.`,
            'info'
          );
        }
      } catch (err) {
        setDevStatus('off');
        setBusy(null);
        showToast(`Preview failed to start — see the log in the preview area.`, 'error');
        const msg = cleanError(err);
        devLogRef.current = msg;
        setDevLog(msg);
        diagnose();
      }
    },
    [showToast, diagnose]
  );

  const loadProject = useCallback(
    async (projectPath: string) => {
      const name = projectPath.split(/[\\/]/).filter(Boolean).pop() ?? projectPath;
      setProject({ path: projectPath, name });
      setLeftTab('navigator');
      // Every project opens on desktop — a breakpoint left over from the
      // last project isn't a choice the user made about this one.
      setDevice('desktop');
      void addRecentProject(projectPath).catch(() => {});
      const result = await rescan(projectPath);

      const hasDeps = await projectHasNodeModules(projectPath);
      if (!hasDeps) {
        try {
          await installProjectDependencies(projectPath);
        } catch (err) {
          showToast(cleanError(err), 'error');
        }
        setBusy(null);
      }
      startPreview(projectPath);
      void watchProject(projectPath).catch(() => {});

      const first =
        result.pages.find((p) => p.name === 'index.astro') || result.pages[0] || null;
      if (first) {selectPage(first);}
    },
    [rescan, startPreview] // eslint-disable-line react-hooks/exhaustive-deps
  );

  // A window can come up owing a project: one was picked from the menu and the
  // window reloaded to let go of the last one, or (in dev) the code was reloaded
  // under a project that was open. Null on a cold start and after a window
  // somebody closed, both of which belong on the welcome screen.
  const reopenedRef = useRef(false);
  useEffect(() => {
    if (reopenedRef.current || !window.avb.pendingProject) {return;}
    reopenedRef.current = true;
    pendingProject()
      .then((path) => {
        if (path) {
          return loadProject(path);
        }
        return undefined;
      })
      .catch(() => {});
  }, [loadProject]);


  // ----------------------------------------------------------------
  // Page loading & saving
  // ----------------------------------------------------------------

  const fileSaverRef = useRef<ReturnType<typeof createFileSaver> | null>(null);
  if (!fileSaverRef.current) {
    fileSaverRef.current = createFileSaver({
      onError: (err) => showToast(`Save failed: ${cleanError(err)}`, 'error'),
    });
  }
  const pageSaverRef = useRef<(() => Promise<void>) | null>(null);
  if (!pageSaverRef.current) {
    pageSaverRef.current = createPageSaver({
      readCurrent: () => pageStateRef.current,
      write: async (pagePath, state) => {
        if (state.editable) {
          const written = await writeProjectPage(pagePath, state.model);
          return written ? toEditorPageState(written) : undefined;
        }
        const written = await writeProjectPageRaw(pagePath, state.source);
        return written ? toEditorPageState(written) : undefined;
      },
      markSaved: (saved, written) => {
        if (pageStateRef.current.pageState !== saved) {
          return;
        }
        if (written?.editable && saved.editable) {
          const selected = selectedIdRef.current;
          const trail = selected ? pathOfNode(saved.model.nodes, selected) : null;
          const next = trail ? nodeAtPath(written.model.nodes, trail) : null;
          if (selected === 'frontmatter') {
            setSelectedId('frontmatter');
          } else {
            setSelectedId(next?.id ?? null);
          }
        }
        setPageState(written ? { ...written, dirty: false } : { ...saved, dirty: false });
      },
    });
  }
  const fileSaver = fileSaverRef.current;
  const pageSaver = pageSaverRef.current;
  const flushSave = useCallback(() => {
    clearTimeout(saveTimer.current);
    return Promise.all([pageSaver(), fileSaver.flush()]);
  }, [fileSaver, pageSaver]);

  // Only the most recent navigation is allowed to install its read result.
  const pageLoadRef = useRef(0);

  // Leaving a project. Main lets go of everything the project had running and
  // starts the window over — forty pieces of state, an undo stack, a canvas
  // holding a page, a watcher and a dev server all belong to the project that
  // was open, and a fresh renderer is the only way to be certain none of it is
  // still here when the next one opens. `next` is the project to open after,
  // which main holds for the window that comes back: a choice made before a
  // reload has to survive it. Anything unsaved goes to disk first.
  const leaveProject = useCallback(
    async (next: string | null = null) => {
      await flushSave();
      await closeProject(next);
    },
    [flushSave]
  );

  useEffect(() => {
    const offClose = window.avb.onMenu('closeProject', () => {
      if (projectRef.current) {void leaveProject(null);}
    });
    const offOpen = window.avb.onMenu('openProject', async () => {
      const picked = await openProject();
      const next = !picked.canceled && 'projectPath' in picked ? picked.projectPath : null;
      if (!next) {return;}
      // Nothing open yet: this IS the welcome screen's own button.
      if (!projectRef.current) {
        loadProject(next);
        return;
      }
      void leaveProject(next);
    });
    return () => {
      offClose?.();
      offOpen?.();
    };
  }, [leaveProject, loadProject]);

  // Opens any .astro file for editing — a page, or a component drilled into.
  // `currentPage` is simply whatever is being edited, so saving, undo, the
  // navigator, and the props panel all follow without special cases.
  const openFile = useCallback(
    async (entry: OpenFile, options: OpenFileOptions) => {
      codeEditVersionRef.current += 1
      const request = ++pageLoadRef.current;
      try {
        await flushSave();
      } catch (err) {
        if (request === pageLoadRef.current) {showToast(`Save failed: ${cleanError(err)}`, 'error');}
        return;
      }
      if (request !== pageLoadRef.current) {return;}
      const beforeRead = pageStateRef.current;
      let result: EditorPageState;
      try {
        result = toEditorPageState(await readPage(entry.path));
      } catch (err) {
        if (request === pageLoadRef.current) {showToast(`Couldn’t open ${entry.name}: ${cleanError(err)}`, 'error');}
        return;
      }
      if (request !== pageLoadRef.current) {return;}
      // The existing editor stays mounted while reading. Save anything typed
      // in that interval before handing the editor to the destination file.
      try {
        await flushSave();
      } catch (err) {
        if (request === pageLoadRef.current) {showToast(`Save failed: ${cleanError(err)}`, 'error');}
        return;
      }
      if (request !== pageLoadRef.current) {return;}
      const latest = pageStateRef.current;
      // Reopening the same file must not replace an edit made during the read
      // with the older snapshot that read returned.
      if (
        latest.currentPage?.path === entry.path &&
        latest.pageState &&
        latest.pageState !== beforeRead.pageState
      ) {
        result = latest.pageState;
      }
      const nextState = result;
      // Publish path, model and stack together. Clearing the model first would
      // unmount the inspector and resize the whole preview during every drill.
      pageStateRef.current = { currentPage: entry, pageState: nextState };
      setEditStack(options.nextStack);
      setCurrentPage(entry);
      setPageState(nextState);
      setHoverNodeId(null);
      const start = openFileSelection(entry, result, options.selectionPath);
      setSelectedId(start?.id ?? null);
      dropPageHistory(); // page snapshots don't apply to another page; commands stay
    },
    [flushSave, showToast]
  );

  // What's typed in the URL bar while it's being edited; null means "show the
  // real one". Kept separate so the bar keeps tracking the canvas until you
  // actually start typing.
  const [urlDraft, setUrlDraft] = useState<string | null>(null);

  const selectPage = useCallback(
    async (page: ScanResult['pages'][number]) => {
      // Opening a page from the switcher leaves any component drill-down.
      const entry: OpenFile = { ...page, kind: 'page' };
      await openFile(entry, { nextStack: [entry], selectionPath: null });
    },
    [openFile]
  );

  // An injected route has no file in this project to open — its source lives
  // in a dependency — so this points the canvas at it and leaves the editor
  // empty rather than pretending there is a model behind it.
  const selectRoute = useCallback(
    async (entry: WireInjectedRoute) => {
      const request = ++pageLoadRef.current;
      await flushSave();
      if (request !== pageLoadRef.current) {return;}
      setEditStack([]);
      setCurrentPage({ kind: 'route', name: entry.route, route: entry.route, from: entry.from });
      setPageState(null);
      setSelectedId(null);
      setHoverNodeId(null);
    },
    [flushSave]
  );

  // Enter in the URL bar. A route names a page file, so this switches the
  // editor to it rather than pointing the canvas somewhere the panels know
  // nothing about — the model and the canvas showing different pages is the
  // one state the app can't represent.
  const goToUrl = useCallback(
    (typed: string) => {
      setUrlDraft(null);
      const raw = String(typed || '').trim();
      if (!raw) {return;}
      // Accept a full URL or a bare path.
      let route = raw;
      const m = raw.match(/^https?:\/\/[^/]+(\/.*)?$/i);
      if (m) {route = m[1] || '/';}
      if (!route.startsWith('/')) {route = '/' + route;}
      route = route.replace(/\?.*$|#.*$/, '');
      const norm = (value: string): string => (
        value !== '/' ? value.replace(/\/$/, '') : value);
      const page = (scan.pages || []).find((p) => norm(p.route) === norm(route));
      if (page) {
        selectPage(page);
        return;
      }
      showToast(`No page matches ${route}`, 'error');
    },
    [scan.pages, showToast, selectPage]
  );


  // Re-reads whatever is open straight from disk. A git checkout rewrites the
  // working tree wholesale, and the file watcher can't be relied on for it:
  // events for files the app itself wrote moments earlier are suppressed (so
  // its own save isn't echoed back), which is exactly the case when you edit,
  // switch branch, and expect to see the other branch's content.
  const reloadFromDisk = useCallback(async () => {
    const proj = projectRef.current;
    const { currentPage: open, pageState: state } = pageStateRef.current;
    const request = pageLoadRef.current;
    const stillCurrent = () => request === pageLoadRef.current &&
      pageStateRef.current.currentPage === open && pageStateRef.current.pageState === state;
    if (!proj) {return;}
    const result = await rescan(proj.path);
    if (!open || open.kind === 'route' || !stillCurrent()) {return;}
    // The open file may not exist on the branch just switched to.
    const stillThere = scanContainsFile(result, open.path);
    if (stillThere) {
      const fresh = toEditorPageState(await readPage(open.path));
      if (!stillCurrent()) {return;}
      setPageState({ ...fresh, dirty: false });
      setSelectedId(null);
      dropPageHistory(); // page snapshots don't apply to another page; commands stay
    } else {
      const next = result.pages[0] || null;
      if (next) {
        const entry: OpenFile = { ...next, kind: 'page' };
        await openFile(entry, { nextStack: [entry], selectionPath: null });
      } else {
        setEditStack([]);
        setCurrentPage(null);
        setPageState(null);
        setSelectedId(null);
      }
    }
    setRefreshKey((k) => k + 1); // the preview is showing the old branch too
  }, [rescan, openFile]);

  const completePropertySave = useCallback(async () => {
    // A floating source window may hold a pre-rename consumer. It was flushed
    // before the transaction; close it so later typing cannot restore stale source.
    setCodeWin(null);
    await reloadFromDisk();
  }, [reloadFromDisk]);

  // Drill into a component: its own file becomes the edited document, and the
  // stack remembers what to come back to (pages and components alike, so
  // nesting works to any depth).
  const openComponent = useCallback(
    async (name: string, hostPath: string | null, hostOcc = 0, filePath: string | null = null) => {
      // A tag is only a local binding — `import Layout from
      // '@/layouts/BaseLayout.astro'` renders as <Layout> — so follow the
      // page's own import first, and fall back to matching by filename.
      const { currentPage: host, pageState: state } = pageStateRef.current;
      const request = pageLoadRef.current;
      const spec = (state?.editable ? state.model.imports : []).find(
        (item) => item.name === name,
      )?.path;
      let comp = null;
      // A caller that already knows the file means THAT file — the instances
      // popup names a component by where it lives, and two folders can hold
      // the same basename.
      if (filePath) {
        comp =
          scan.components.find((c) => c.path === filePath) ||
          scan.layouts.find((l) => l.path === filePath) ||
          { name, path: filePath };
      }
      if (!comp && spec && host?.path) {
        const projectPath = projectRef.current?.path;
        if (!projectPath) {return;}
        const file = await resolveProjectImport(projectPath, host.path, spec);
        if (request !== pageLoadRef.current || pageStateRef.current.currentPage !== host) {return;}
        if (file && /\.astro$/i.test(file)) {
          const fileName = file.split('/').pop();
          assert(fileName !== undefined, 'Resolved component path has a filename');
          comp = { name: fileName.replace(/\.astro$/i, ''), path: file };
        } else if (file) {
          // A framework island (.jsx/.svelte/…) has no Astro tree to show.
          showToast(`<${name}> is a ${file.split('.').pop()} component — edit it in code.`, 'error');
          return;
        }
      }
      comp =
        comp ||
        scan.components.find((c) => c.name === name) ||
        scan.layouts.find((l) => l.name === name);
      if (!comp) {
        showToast(`Can't find a file for <${name}>.`, 'error');
        return;
      }
      const stack = editStackRef.current;
      // The canvas keeps showing the page, so remember which instance was
      // opened — that region stays lit while the rest dims. Drilling deeper
      // keeps the outermost instance as the focus: a nested component's
      // internals aren't addressable in the page's own markers.
      //
      // Which copy of it, too: a component rendered inside a loop is on the
      // page once per item, and opening one card means that card. Without the
      // occurrence every instance stayed lit, and editing one looked like
      // editing all of them.
      //
      // A layout is the exception: it wraps <html>, so the instance IS the
      // page and there is nothing around it to dim. Its path still names the
      // focus — clicks route by it, and one in the page's own content still
      // means "I'm done in here" — but the lit region would be the page's slot
      // content, which is the one part of the canvas the layout does NOT own.
      // Dimming the header, the sidebar and the footer while lighting the page
      // body said the opposite of what opening a layout does.
      const top = stack[stack.length - 1];
      const hostNode = hostPath
        ? nodeAtPath(
            state?.editable ? state.model.nodes : [],
            (String(hostPath).split('|').at(-1) ?? '').split('.').map(Number)
          )
        : null;
      const focusPath = top?.focusPath ?? hostPath ?? null;
      const nested = top?.focusPath != null;
      const focusOcc = nested ? top.focusOcc ?? 0 : hostOcc;
      const focusWhole = nested ? !!top.focusWhole : hostNode?.id === 'layout';
      const entry: OpenFile = {
        kind: 'component',
        name: comp.name,
        path: comp.path,
        focusPath,
        focusOcc,
        focusWhole,
        hostKey: hostPath ?? null,
      };
      await openFile(entry, {
        nextStack: (stackBeforeOpen) =>
          stackBeforeOpen.some((openEntry) => openEntry.path === comp.path)
            ? stackBeforeOpen
            : [...stackBeforeOpen, entry],
        selectionPath: null,
      });
    },
    [scan.components, scan.layouts, openFile, showToast]
  );

  // Back out one level: to the parent component if nested, else to the page.
  const closeComponent = useCallback(async () => {
    const stack = editStackRef.current;
    if (stack.length < 2) {return;}
    const closing = stack.at(-1);
    assert(closing, 'Component stack must contain the component being closed');
    const next = stack.slice(0, -1);
    const parent = next.at(-1);
    assert(parent, 'Component stack must retain its parent');
    await openFile(parent, {
      nextStack: next,
      selectionPath: closing.hostKey ?? null,
    });
  }, [openFile]);

  // ----------------------------------------------------------------
  // Undo / redo
  //
  // One stack for the whole app, so ⌘Z means "undo the last thing I did"
  // wherever focus happens to be. Two kinds of entry live in it:
  //
  //   snapshot — the page model (or raw source) before an edit. Cheap to take
  //              and restores structure exactly, but only meaningful for the
  //              page it came from, so these are dropped when a page closes.
  //   command  — an {undo, redo} pair for anything outside the page model:
  //              a CSS file, a CMS entry, an asset rename. Each records how to
  //              put things back, so these survive page switches.
  // ----------------------------------------------------------------

  // Previewing an old version points the canvas at a second dev server running
  // against a checkout of that commit, and makes the editor read-only. The
  // read-only part is not decoration: the files behind that server are a
  // disposable checkout, so anything typed into them would be thrown away the
  // moment the preview ends, with nothing to say it had happened.
  const previewCommit = useCallback(
    async (commit: WireCommitInfo) => {
      if (!project) {return;}
      assert(commit.hash, 'Previewed commit must have a hash');
      setBusy('Getting that version ready…');
      try {
        const r = await previewProjectCommit(project.path, commit.hash);
        setPreviewRef(commit.hash);
        setPreviewInfo({ url: r.url, subject: commit.subject, when: commit.when });
      } catch (err) {
        showToast(cleanError(err), 'error');
      } finally {
        setBusy(null);
      }
    },
    [project, showToast]
  );

  // Named apart from exitPreview below, which is the app's own interactive
  // preview mode — a different thing entirely.
  const exitCommitPreview = useCallback(async () => {
    setPreviewRef(null);
    setPreviewInfo(null);
    if (project) {await stopProjectCommitPreview(project.path).catch(() => {});}
  }, [project]);

  // Leaving the project (or closing it) must not leave a second server and a
  // checkout behind inside it.
  useEffect(() => {
    if (!project) {return undefined;}
    return () => {
      void stopProjectCommitPreview(project.path).catch(() => {});
    };
  }, [project?.path]); // eslint-disable-line react-hooks/exhaustive-deps

  const refreshGit = useCallback(async () => {
    if (!project) {return null;}
    const result = await readGitInfo(project.path);
    if (!result.ok) {
      showToast(result.error, 'error');
      return null;
    }
    setGitInfo(result.value);
    return result.value;
  }, [project, showToast]);

  useEffect(() => {
    refreshGit();
  }, [refreshGit, refreshKey]);

  const historyRef = useRef<AppHistory>({ past: [], future: [], lastPush: 0, lastKey: null });

  const snapshotOf = (state: EditorPageState): PageSnapshot =>
    state.editable
      ? { kind: 'model', model: cloneEditorModel(state.model) }
      : { kind: 'source', source: state.source };

  // Records the state *before* a mutation. Consecutive edits with the same
  // coalesceKey within 800 ms collapse into one undo step (typing bursts,
  // dropdown hover-scrubs); structural edits (no key) always get their own.
  const pushHistory = useCallback((coalesceKey: string | null = null) => {
    const state = pageStateRef.current.pageState;
    if (!state) {return;}
    const h = historyRef.current;
    const now = Date.now();
    const coalesce =
      coalesceKey !== null && coalesceKey === h.lastKey && now - h.lastPush < 800 && h.past.length > 0;
    if (!coalesce) {
      h.past.push(snapshotOf(state));
      if (h.past.length > 100) {h.past.shift();}
    }
    h.future = [];
    h.lastKey = coalesceKey;
    h.lastPush = now;
  }, []);

  // Records an already-performed change from outside the page model. `undo`
  // and `redo` are async and do the work themselves (rewrite the file, restore
  // the entry, rename back). Consecutive commands sharing a coalesceKey inside
  // the same burst collapse into one step, so a slider drag or a run of live
  // CSS writes is a single ⌘Z — the first one's `undo` (the oldest state) is
  // kept and the newest `redo` replaces the previous.
  const pushCommand = useCallback((cmd: Omit<UndoCommand, 'kind'>) => {
    const h = historyRef.current;
    const now = Date.now();
    const prev = h.past[h.past.length - 1];
    const coalesce =
      cmd.coalesceKey != null &&
      cmd.coalesceKey === h.lastKey &&
      now - h.lastPush < 800 &&
      prev?.kind === 'cmd' &&
      prev.coalesceKey === cmd.coalesceKey;
    if (coalesce) {
      prev.redo = cmd.redo;
      if (cmd.label !== undefined) {
        prev.label = cmd.label;
      }
    } else {
      h.past.push({ kind: 'cmd', ...cmd });
      if (h.past.length > 100) {h.past.shift();}
    }
    h.future = [];
    h.lastKey = cmd.coalesceKey ?? null;
    h.lastPush = now;
  }, []);
  const pushCommandRef = useRef<((command: Omit<UndoCommand, 'kind'>) => void) | null>(null);
  pushCommandRef.current = pushCommand;

  // Snapshots belong to one page, so they're dropped when that page closes;
  // commands carry their own inverse and stay.
  const dropPageHistory = useCallback(() => {
    const h = historyRef.current;
    h.past = h.past.filter((e) => e.kind === 'cmd');
    h.future = h.future.filter((e) => e.kind === 'cmd');
    h.lastKey = null;
    h.lastPush = 0;
  }, []);

  const applySnapshot = useCallback((entry: PageSnapshot) => {
    codeEditVersionRef.current += 1
    setPageState((s) => {
      if (!s) {return s;}
      if (entry.kind === 'model') {
        return { ...s, editable: true, model: cloneEditorModel(entry.model), dirty: true };
      }
      return { ...s, source: entry.source, dirty: true };
    });
    // Clear selection if the restored model no longer has the selected node.
    if (entry.kind === 'model') {
      setSelectedId((id) =>
        id && id !== 'layout' && !findNodeById(entry.model.nodes || [], id) ? null : id
      );
    }
    scheduleSaveRef.current?.(true);
  }, []);

  const scheduleSaveRef = useRef<((urgency?: boolean | 'live') => void) | null>(null);

  // Undo and redo rewrite files and the page model under whatever is reading
  // them; bumping this tells the style panel to re-read rather than wait for
  // its own polling to notice.
  const [historyTick, setHistoryTick] = useState(0);

  const undo = useCallback(async () => {
    if (propertySave.saving.current) { return; }
    setHistoryTick((n) => n + 1);
    const h = historyRef.current;
    if (!h.past.length) {return;}
    h.lastKey = null;
    h.lastPush = 0;
    const entry = h.past.pop();
    if (!entry) {return;}
    if (entry.kind === 'cmd') {
      h.future.push(entry);
      try {
        await entry.undo();
      } catch (err) {
        showToast(`Couldn’t undo${entry.label ? ` ${entry.label}` : ''}: ${cleanError(err)}`, 'error');
      }
      return;
    }
    const state = pageStateRef.current.pageState;
    if (!state) {return;} // its page is gone — nothing to restore onto
    h.future.push(snapshotOf(state));
    applySnapshot(entry);
  }, [applySnapshot, showToast, propertySave.saving]);

  const redo = useCallback(async () => {
    if (propertySave.saving.current) { return; }
    setHistoryTick((n) => n + 1);
    const h = historyRef.current;
    if (!h.future.length) {return;}
    h.lastKey = null;
    h.lastPush = 0;
    const entry = h.future.pop();
    if (!entry) {return;}
    if (entry.kind === 'cmd') {
      h.past.push(entry);
      try {
        await entry.redo();
      } catch (err) {
        showToast(`Couldn’t redo${entry.label ? ` ${entry.label}` : ''}: ${cleanError(err)}`, 'error');
      }
      return;
    }
    const state = pageStateRef.current.pageState;
    if (!state) {return;}
    h.past.push(snapshotOf(state));
    applySnapshot(entry);
  }, [applySnapshot, showToast, propertySave.saving]);

  // Discrete edits (dropdown, checkbox, drag, delete) save immediately;
  // typing batches keystrokes for 300 ms so the preview doesn't rebuild
  // per character. The timeout-0 for immediate saves lets React commit the
  // state update first so flushSave sees the new model.
  //
  // 'live' is the third case: a style-panel scrub or mid-typing write, which
  // arrives already debounced (100 ms at the field) and is watched on the
  // canvas as it happens. Making it wait out the typing pause too put nearly
  // half a second between the drag and the result. It still coalesces, just
  // over the gap between two ticks rather than the gap between two words.
  const scheduleSave = useCallback(
    (immediate: boolean | 'live' = false) => {
      clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(
        () => {
          flushSave().catch((err) => showToast(`Save failed: ${cleanError(err)}`, 'error'));
        },
        saveDelay(immediate)
      );
    },
    [flushSave, showToast]
  );
  scheduleSaveRef.current = scheduleSave;

  const mutateModel = useCallback(
    (
      fn: (model: EditorModel) => EditorModel,
      immediate: boolean | 'live' = false,
      coalesceKey: string | null = null,
    ) => {
      if (propertySave.saving.current) { return; }
      codeEditVersionRef.current += 1
      pushHistory(coalesceKey);
      setPageState((s) => {
        if (!s || !s.editable) {return s;}
        const model = fn(cloneEditorModel(s.model));
        return { ...s, model, dirty: true };
      });
      scheduleSave(immediate);
    },
    [scheduleSave, pushHistory, propertySave.saving]
  );

  const setRawSource = useCallback(
    (source: string) => {
      if (propertySave.saving.current) { return; }
      codeEditVersionRef.current += 1
      pushHistory('raw-source');
      setPageState((s) => (s ? { ...s, source, dirty: true } : s));
      scheduleSave();
    },
    [scheduleSave, pushHistory, propertySave.saving]
  );

  const changeCodeSource = useCallback(
    async (source: string, position: number) => {
      const open = pageStateRef.current.currentPage;
      if (!open || open.kind === 'route') {
        return;
      }
      const version = codeEditVersionRef.current + 1;
      codeEditVersionRef.current = version;
      try {
        const parsed = toEditorPageState(await parseSourcePage(open.path, source));
        if (version !== codeEditVersionRef.current) {
          return;
        }
        if (pageStateRef.current.currentPage?.path !== open.path) {
          return;
        }
        pushHistory('code-source');
        if (parsed.editable) {
          const inFrontmatter =
            parsed.model.bodyStart !== undefined && position < parsed.model.bodyStart;
          const selected = sourceNodeAtOffset(parsed.model.nodes, position);
          setSelectedId(inFrontmatter ? 'frontmatter' : selected?.id ?? null);
        } else {
          setSelectedId(null);
        }
        setPageState({ ...parsed, dirty: true });
        scheduleSave('live');
      } catch (error: unknown) {
        if (version === codeEditVersionRef.current) {
          showToast(`Couldn’t update code: ${cleanError(error)}`, 'error');
        }
      }
    },
    [pushHistory, scheduleSave, showToast],
  );

  // ----------------------------------------------------------------
  // External file changes → refresh panels
  // ----------------------------------------------------------------

  useEffect(() => {
    let changeVersion = 0;
    const pendingFiles = new Set<string>();
    const off = onFilesChanged(async ({ files }) => {
      const proj = projectRef.current;
      if (!proj) {return;}
      for (const file of files) {pendingFiles.add(file);}
      const request = ++changeVersion;

      // Retain all paths until the latest scan AND read finish. A newer event
      // for another file must not cancel a still-unread change to this page.
      let scanResult;
      try {
        scanResult = await rescan(proj.path);
      } catch {
        return;
      }
      if (request !== changeVersion) {return;}

      const { currentPage: page, pageState: state } = pageStateRef.current;
      if (!page || page.kind === 'route') { pendingFiles.clear(); return; }
      // Chunk .html files feed the open page's Fragment subtrees — treat a
      // change to any of them like a change to the page itself.
      const affectsPage =
        pendingFiles.has(page.path) || [...pendingFiles].some((f) => f.toLowerCase().endsWith('.html'));
      if (!affectsPage) { pendingFiles.clear(); return; }

      // Current page deleted externally.
      if (!scanContainsFile(scanResult, page.path)) {
        pendingFiles.clear();
        pageLoadRef.current++;
        setCurrentPage(null);
        setPageState(null);
        setSelectedId(null);
        return;
      }

      // Hot-reload the current page's model unless the user has unsaved
      // edits in flight (their pending save would win anyway).
      if (!state || state.dirty) { pendingFiles.clear(); return; }

      let result: EditorPageState;
      try {
        result = toEditorPageState(await readPage(page.path));
      } catch {
        return;
      }

      // The read may finish after a selection switch or a fresh edit. Neither
      // may be overwritten by the disk snapshot requested before it.
      const latest = pageStateRef.current;
      if (request !== changeVersion) {return;}
      pendingFiles.clear();
      if (latest.currentPage?.path !== page.path || latest.pageState !== state) {return;}

      // Re-select the node at the same tree position (ids regenerate).
      const selId = selectedIdRef.current;
      let nextSelected = selId;
      if (selId && selId !== 'layout' && selId !== 'frontmatter') {
        if (state?.editable && result.editable) {
          const trail = pathOfNode(state.model.nodes, selId);
          nextSelected = trail ?nodeAtPath(result.model.nodes, trail)?.id ?? null : null;
        } else {
          nextSelected = null;
        }
      }
      codeEditVersionRef.current += 1
      setPageState(result);
      setSelectedId(nextSelected);
    });
    return () => { changeVersion++; off(); };
  }, [rescan]);

  // ----------------------------------------------------------------
  // Model operations
  // ----------------------------------------------------------------

  const projectRef = useRef<ProjectIdentity | null>(null);
  projectRef.current = project;

  const resolveImportPath = useCallback(async (targetPath: string) => {
    const page = pageStateRef.current.currentPage;
    const projectPath = projectRef.current?.path;
    if (!page?.path || !projectPath) {
      throw new Error('An open project page is required to resolve an import');
    }
    return findImportPath(projectPath, page.path, targetPath);
  }, []);

  // target: {parentId: string|null, index: number} | null (append at end)
  const addComponent = useCallback(
    async (componentName: string, target: InsertTarget | null) => {
      const comp = insertables.find((c) => c.name === componentName);
      const page = pageStateRef.current.currentPage;
      if (!comp || !page) {return;}
      const paths = await resolveImportPath(comp.path);
      const id = newId();
      mutateModel((model) => {
        if (!model.imports.some((i) => i.name === comp.name)) {
          model.imports.push({
            name: comp.name,
            path: chooseImportPath(model, paths),
            quote: "'",
          });
        }
        // A component whose default slot sits in a text context arrives with a
        // word in it, the way an inserted <h1> or <p> does — something on the
        // canvas to aim at. A wrapper whose slot holds blocks (ButtonWrapper,
        // Section) comes in empty: a stray "Text" there is only ever deleted.
        const takesText = (comp.slots || []).includes('default') && !!comp.slotText;
        const node: EditorNode = {
          id,
          kind: 'component',
          name: comp.name,
          props: {},
          children: takesText ? [{ id: newId(), kind: 'text', value: 'Text' }] : null,
        };
        insertIntoModel(model, node, target);
        return model;
      }, true);
      setSelectedId(id);
    },
    [insertables, mutateModel, resolveImportPath]
  );

  // The page values a subtree reads — the props it would need once it's a file
  // of its own. Asked twice (once to show in the dialog, once to act on) and
  // both times of the live model, so nothing can drift between them.
  const propsNeededFor = useCallback((model: EditorModel, node: EditorNode) => {
    if (!model || !node) {return [];}
    const scope = namesInScope(model.extraFrontmatter || '', model.imports || []);
    for (const v of loopVarsAt(model.nodes, node.id)) {scope.add(v);}
    // An imported component is carried across as an import, not passed as a prop.
    for (const imp of model.imports || []) {scope.delete(imp.name);}
    return propsForExtraction(node, scope);
  }, []);

  // Where a component is used, for the palette's instance count. Asked of the
  // project (not the open file) so it covers pages and components alike; the
  // component's own file is left out — a file is not one of its own users.
  const componentUsage = useCallback(async (comp: ScanComponent) => {
    if (!projectRef.current?.path) {return { files: [] };}
    try {
      return await readComponentUsage(projectRef.current.path, comp.name, comp.path);
    } catch (err) {
      // Reported, never swallowed into an empty list: "we couldn't look" and
      // "it isn't used anywhere" are opposite answers, and the second one is
      // the sort of thing somebody acts on.
      return { error: cleanError(err) };
    }
  }, []);

  // The instances in the file that's already open — those a click can select
  // rather than navigate to.
  const pageInstancesOf = useCallback(
    (name: string) => {
      const state = pageStateRef.current.pageState;
      const model = state?.editable ? state.model : null;
      if (!model) {return [];}
      const out: { readonly id: string }[] = [];
      const walk = (list: readonly EditorNode[]): void => {
        for (const n of list || []) {
          if (n.kind === 'component' && n.name === name) {out.push({ id: n.id });}
          if (Array.isArray(n.children)) {walk(n.children);}
        }
      };
      walk(model.nodes);
      return out;
    },
    []
  );

  // Turn what's selected into a component of its own: write the file, then
  // replace the element in the page with an instance of it. The markup MOVES —
  // the page ends up with `<Card />` where the element was — so this is one
  // edit to two files, and the component file is written first: a page that
  // imports a file that isn't there yet is a broken page, however briefly.
  const createComponentFromSelection = useCallback(
    async (name: string, options: { readonly withProps?: boolean } = {}) => {
      const { withProps = true } = options;
      const page = pageStateRef.current.currentPage;
      const state = pageStateRef.current.pageState;
      const model = state?.editable ? state.model : null;
      const node = model && selectedIdRef.current ? findNodeById(model.nodes, selectedIdRef.current) : null;
      const projectPath = projectRef.current?.path;
      if (!page?.path || !model || !node || !projectPath) {return;}
      const props = withProps ? propsNeededFor(model, node) : [];
      let created;
      try {
        created = await createProjectComponent({
          projectPath,
          pagePath: page.path,
          name,
          nodes: node,
          imports: model.imports || [],
          props,
        });
      } catch (err) {
        showToast(cleanError(err), 'error');
        return;
      }
      const paths = await findImportPath(projectPath, page.path, created.path);
      const id = newId();
      mutateModel((m) => {
        const found = findParentList(m, node.id);
        if (!found) {return m;}
        if (!m.imports.some((i) => i.name === name)) {
          m.imports.push({ name, path: chooseImportPath(m, paths), quote: "'" });
        }
        // The instance passes each value straight back in under its own name.
        // That's what reconnects it: `title` meant the page's title where this
        // markup used to sit, and it still does, one level out.
        found.list[found.index] = {
          id,
          kind: 'component',
          name,
          props: Object.fromEntries(props.map((p) => [p, { type: 'expr', value: p }])),
          children: null,
        };
        return m;
      }, true);
      setSelectedId(id);
      await rescan(projectPath);
      // Anything left reading the page's scope can't be reconnected on its own
      // — an expression naming something that isn't a value the page holds, or
      // props turned off. The person who just moved it knows what it needs.
      const stranded = usesPageScope(node) && !props.length;
      showToast(
        stranded
          ? `Created ${created.rel} — it reads page data, so it will need props.`
          : props.length
            ? `Created ${created.rel} with ${props.length} prop${props.length === 1 ? '' : 's'}.`
            : `Created ${created.rel}`
      );
    },
    [mutateModel, propsNeededFor, rescan, showToast]
  );

  const moveNode = useCallback(
    (nodeId: string, target: InsertTarget | null) => {
      mutateModel((model) => {
        const found = findParentList(model, nodeId);
        if (!found) {return model;}
        const node = found.list[found.index];
        assert(node, 'Moved node must exist in its parent list');

        // Prevent dropping a node into its own subtree.
        if (target?.parentId) {
          if (target.parentId === nodeId) {return model;}
          if (isDescendantOf(node, target.parentId)) {return model;}
        }

        // Capture target list before removal to fix up indices.
        const sameList =
          (target?.parentId == null && found.list === model.nodes) ||
          (target?.parentId != null &&
            findNodeById(model.nodes, target.parentId)?.children === found.list);

        const before = loopVarsAt(model.nodes, nodeId);

        // Take the node's note with it. Both come out in one splice, so the
        // drop index has to be shifted by however many were actually removed.
        const noteAt = noteIndexAbove(found.list, found.index);
        const note = noteAt === -1 ? null : found.list[noteAt];
        const removeAt = note ? noteAt : found.index;
        const removedCount = note ? 2 : 1;

        found.list.splice(removeAt, removedCount);
        let index = target?.index ?? Number.MAX_SAFE_INTEGER;
        if (sameList && index > removeAt) {
          // A drop that landed *between* the note and its element collapses
          // onto where the pair used to start.
          index = Math.max(removeAt, index - removedCount);
        }
        insertIntoModel(model, node, target ? { ...target, index } : null);
        // Put the note back directly above wherever the node landed — let
        // insertIntoModel decide placement, then follow it.
        if (note) {
          const landed = findParentList(model, nodeId);
          if (landed) {landed.list.splice(landed.index, 0, note);}
        }

        // `slot` is a word addressed to the component the node sat inside, and
        // means nothing anywhere else (src/slotAttr.js).
        const slot = node.props?.['slot'];
        const slotName = slot?.type === 'string' ? slot.value : null;
        if (slotName) {
          const host = slotHostOf(model, nodeId);
          const definition = host ? definitionOf(model, host, insertables) : null;
          if (!keepsSlot({ slotName, host, definition }) && node.props) {
            delete node.props['slot'];
          }
        }

        // Left a loop? Anything still reading its item would throw.
        const after = loopVarsAt(model.nodes, nodeId);
        const lost = before.filter((v) => !after.includes(v));
        const removed = stripLostBindings(node, lost);
        if (removed) {
          showToast(
            `Removed ${removed} binding${removed === 1 ? '' : 's'} that referenced ${lost.join(
              ', '
            )}.`,
            'info'
          );
        }
        return model;
      }, true);
    },
    [insertables, mutateModel, showToast]
  );

  // What the last delete took out of the frontmatter, to say so once the model
  // has settled — a toast raised inside a mutation would fire twice under
  // StrictMode and once per retry.
  const droppedRef = useRef<readonly string[] | null>(null);

  const removeNode = useCallback(
    (nodeId: string) => {
      const state = pageStateRef.current.pageState;
      const target = state?.editable ? findNodeById(state.model.nodes, nodeId) : null;
      if (target?.kind === 'chunk-group') {
        showToast('This section comes from the page frontmatter — remove it from the code instead.', 'error');
        return;
      }
      // Worked out against the tree as it stands, before the node is gone.
      const nextId = state?.editable ? selectionAfterDelete(state.model, nodeId) : null;
      mutateModel((model) => {
        const found = findParentList(model, nodeId);
        if (found) {
          // Delete the node's note with it, or it would re-attach to whatever
          // now follows and read as that element's description.
          const noteAt = noteIndexAbove(found.list, found.index);
          if (noteAt === -1) {found.list.splice(found.index, 1);}
          else {found.list.splice(noteAt, 2);}
        }
        pruneImports(model);
        // The code the deleted markup was the only reader of goes with it: a
        // `const jobs = […]` nothing lists any more is left behind otherwise,
        // and a page collects them one deletion at a time. Only what nothing
        // else mentions — another declaration included — and never an export,
        // which is the page's own interface to Astro.
        const dead = unusedDeclarations(model);
        if (dead.length) {
          model.extraFrontmatter = withoutDeclarations(
            model.extraFrontmatter,
            dead.map((d) => d.name)
          );
          droppedRef.current = dead.map((d) => d.name);
        }
        return model;
      }, true);
      if (droppedRef.current?.length) {
        const names = droppedRef.current;
        droppedRef.current = null;
        showToast(
          `Also removed ${names
            .map((n) => `\`${n}\``).join(', ')} from the frontmatter — nothing was reading ${names.length === 1 ? 'it' : 'them'} any more.`,
          'info'
        );
      }
      // Only the selection that just vanished moves — deleting some other row
      // (navigator menu, canvas) leaves what you were working on alone.
      setSelectedId((id) => (id === nodeId ? nextId : id));
    },
    [mutateModel, showToast]
  );

  // ----------------------------------------------------------------
  // Clipboard: copy / paste / duplicate nodes
  // ----------------------------------------------------------------

  const nodeClipboardRef = useRef<NodeClipboard | null>(null);

  const cloneWithNewIds = (node: EditorNode): EditorNode => {
    const clone = structuredClone(node);
    const walk = (n: EditorNode): void => {
      n.id = newId();
      if (Array.isArray(n.children)) {
        n.children.forEach(walk);
      }
    };
    walk(clone);
    return clone;
  };

  const copyNode = useCallback(
    (nodeId: string) => {
      const state = pageStateRef.current.pageState;
      if (!state?.editable) {
        return;
      }
      const node = findNodeById(state.model.nodes, nodeId);
      if (!node) {
        return;
      }
      nodeClipboardRef.current = {
        node: structuredClone(node),
        // The loop variables this subtree may reference; pasting somewhere
        // they don't exist has to drop those bindings.
        vars: loopVarsAt(state.model.nodes, nodeId),
        // And the code behind it. A `<Card options={jobs}/>` is not just its
        // markup: `jobs` is a const on the page it was copied from, and pasted
        // into another page it names nothing at all. Taken now rather than at
        // paste time, because by then this page may not even be open.
        frontmatter: state.model.extraFrontmatter || '',
        imports: (state.model.imports || []).map((i) => ({
          name: i.name,
          path: i.path,
        })),
        pagePath: pageStateRef.current.currentPage?.path || null,
      };
      showToast(`Copied ${node.name || 'text'}`, 'success');
    },
    [showToast]
  );

  const duplicateNode = useCallback(
    (nodeId: string) => {
      const state = pageStateRef.current.pageState;
      if (!state?.editable) {
        return;
      }
      const src = findNodeById(state.model.nodes, nodeId);
      if (!src) {
        return;
      }
      if (src.kind === 'chunk-group' || src.chunkFile) {
        showToast(
          'Chunk sections are defined in the page frontmatter and cannot be duplicated here.',
          'error'
        );
        return;
      }
      const clone = cloneWithNewIds(src);
      mutateModel((model) => {
        const found = findParentList(model, nodeId);
        if (!found) {
          return model;
        }
        found.list.splice(found.index + 1, 0, clone);
        return model;
      }, true);
      setSelectedId(clone.id);
    },
    [mutateModel]
  );

  // Pastes into the current selection when it can host children (a non-void
  // element, or a component with a default slot), otherwise after it (same
  // parent), or at the end of the page. Imports for components in the pasted
  // subtree are added if the target page is missing them (cross-page paste).
  const pasteNode = useCallback(async () => {
    const clip = nodeClipboardRef.current;
    const state = pageStateRef.current.pageState;
    if (!clip || !state?.editable) {
      return;
    }

    // Everything the subtree reads: the components it renders and every name in
    // the code hanging off it — `options={jobs}`, a loop's `posts.map`, a
    // condition's test.
    const names = namesUsedIn([clip.node]);
    const knows = (nm: string): boolean =>
      state.model.imports.some((i) => i.name === nm) ||
      new RegExp(`\\b${nm.replace(/\$/g, '\\$')}\\b`).test(state.model.extraFrontmatter || '');
    const missing = [...names].filter((nm) => !knows(nm));
    // A component this project has is imported from where it actually lives,
    // whatever the page it was copied from called it.
    const resolved: {
      readonly name: string;
      readonly paths: Awaited<ReturnType<typeof findImportPath>>;
    }[] = [];
    const byScan = new Set<string>();
    for (const nm of missing) {
      const target = insertables.find((c) => c.name === nm);
      if (target) {
        byScan.add(nm);
        resolved.push({
          name: nm,
          paths: await resolveImportPath(target.path),
        });
      }
    }

    // And what is left is the page's own code: an import of something that is
    // not a component (an image, `getCollection`), or a `const` it declared.
    // Both come across, and a declaration brings whatever it reads in turn.
    const carried = neededFrontmatter({
      names: missing.filter((nm) => !byScan.has(nm)),
      frontmatter: clip.frontmatter || '',
      imports: clip.imports || [],
      has: knows,
    });
    const carriedImports: ImportDecl[] = [];
    for (const imp of carried.imports) {
      // A relative path means something different from another page's folder.
      const rebased =
        clip.pagePath && String(imp.path || '').startsWith('.')
          ? await rebaseProjectImport(
              clip.pagePath,
              pageStateRef.current.currentPage?.path ?? null,
              imp.path
            )
          : { path: imp.path };
      carriedImports.push({
        name: imp.name,
        path: rebased.path || imp.path,
        quote: "'",
      });
    }

    const clone = cloneWithNewIds(clip.node);
    const selId = selectedIdRef.current;
    const acceptsChildren = (n: EditorNode): boolean => {
      if (n.id === 'layout') {
        return true;
      }
      if (n.kind === 'element') {
        return !VOID_TAGS.has(String(n.name).toLowerCase());
      }
      if (n.kind === 'component') {
        return (insertables.find((c) => c.name === n.name)?.slots || []).includes('default');
      }
      return false;
    };
    mutateModel((model) => {
      for (const r of resolved) {
        if (!model.imports.some((i) => i.name === r.name)) {
          model.imports.push({
            name: r.name,
            path: chooseImportPath(model, r.paths),
            quote: "'",
          });
        }
      }
      for (const imp of carriedImports) {
        if (!model.imports.some((i) => i.name === imp.name)) {
          model.imports.push(imp);
        }
      }
      if (carried.statements.length) {
        model.extraFrontmatter = withStatements(model.extraFrontmatter, carried.statements);
      }
      if (selId) {
        const sel = findNodeById(model.nodes, selId);
        if (sel && acceptsChildren(sel)) {
          if (!Array.isArray(sel.children)) {
            sel.children = [];
          }
          sel.children.push(clone);
          return model;
        }
        const found = findParentList(model, selId);
        if (found) {
          found.list.splice(found.index + 1, 0, clone);
          return model;
        }
      }
      model.nodes.push(clone);
      return model;
    }, true);

    // Pasted outside the loop it was copied from? Its bindings would throw.
    mutateModel((model) => {
      const landed = findNodeById(model.nodes, clone.id);
      if (!landed) {
        return model;
      }
      const inScope = loopVarsAt(model.nodes, clone.id);
      const lost = (clip.vars || []).filter((v) => !inScope.includes(v));
      const removed = stripLostBindings(landed, lost);
      if (removed) {
        showToast(
          `Removed ${removed} binding${removed === 1 ? '' : 's'} that referenced ${lost.join(', ')}.`,
          'info'
        );
      }
      return model;
    }, true);
    setSelectedId(clone.id);
    const brought = [
      ...carriedImports.map((i) => i.name),
      ...carried.statements.map((s) => s.name),
    ];
    if (brought.length) {
      showToast(
        `Brought ${brought.map((n) => `\`${n}\``).join(', ')} across from the page it was copied from.`,
        'info'
      );
    }
  }, [mutateModel, insertables, resolveImportPath, showToast]);

  // ----------------------------------------------------------------
  // Insert palette (⌘F / ⌘E) — quick-add components, tags, loops, …
  // ----------------------------------------------------------------

  // ⌘J / ⌃` toggle the terminal dock, the two bindings people already have in
  // their fingers. Both carry a modifier, so they still work while a text field
  // or the terminal itself has focus — unlike the rail's bare-letter shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const mod = e.metaKey || e.ctrlKey;
      const isToggle =
        (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'j') ||
        (e.ctrlKey && !e.metaKey && !e.altKey && e.key === '`');
      if (!isToggle) {return;}
      e.preventDefault();
      setTermOpen((v) => !v);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const [insertOpen, setInsertOpen] = useState(false);

  // Open requests from the app menu (⌘E accelerator) and from canvas
  // Interface sound. The menu owns the setting, so the app reads it once on
  // load and takes the menu's word for it afterwards; nothing in here decides
  // to make a noise on its own.
  useEffect(() => {
    let live = true;
    readAppSettings().then((settings) => {
      if (live) {setSoundEnabled(settings.sound);}
    }).catch(() => {});
    const off = onSoundSettingChanged((enabled) => setSoundEnabled(enabled));
    return () => {
      live = false;
      off?.();
    };
  }, []);

  // iframes (which forward ⌘F/⌘E when they hold keyboard focus).
  useEffect(() => {
    const openIfEditable = () => {
      if (pageStateRef.current.pageState?.editable && !inPreviewRef.current) {
        setInsertOpen(true);
      }
    };
    const offMenu = window.avb.onMenu('insert', openIfEditable);
    const onMsg = (event: MessageEvent<unknown>): void => {
      const message = toRecord(event.data);
      if (message?.['type'] !== 'avb:shortcut') {return;}
      if (message['name'] === 'insert') {openIfEditable();}
      // Arrow keys pressed while the canvas iframe holds focus: replay them
      // on the app window so tree navigation behaves the same whether the
      // selection was made on the canvas or in the navigator.
      else if (message['name'] === 'arrow' && typeof message['key'] === 'string') {
        window.dispatchEvent(
          new KeyboardEvent('keydown', { key: message['key'], bubbles: true, cancelable: true })
        );
      }
      // Delete / ⌘D from the canvas. Replayed on the document rather than
      // handled here so they go through the same guards as a keypress in the
      // app — one definition of what those keys do, and the handler's own
      // "am I typing in a field" check still sees a non-field target.
      else if (message['name'] === 'key' && typeof message['key'] === 'string') {
        document.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: message['key'],
            metaKey: message['meta'] === true,
            ctrlKey: message['meta'] === true,
            bubbles: true,
            cancelable: true,
          })
        );
      }
    };
    window.addEventListener('message', onMsg);
    return () => {
      offMenu();
      window.removeEventListener('message', onMsg);
    };
  }, []);

  // Where a new node goes — see insertTarget.js. The rule lives there so the
  // "why did that land next to the section instead of in it?" answer can be
  // read, and tested, without a running app.
  const insertTargetFor = useCallback(
    (model: EditorModel, selId: string | null, item: InsertItem) =>
      placeInsert(model, selId, item, insertables),
    [insertables]
  );

  const insertItem = useCallback(
    (item: InsertItem) => {
      setInsertOpen(false);
      const state = pageStateRef.current.pageState;
      if (!state?.editable) {return;}
      const target = insertTargetFor(state.model, selectedIdRef.current, item);

      if (item.type === 'component') {
        addComponent(item.name, target);
        return;
      }

      // <Image>/<Picture> need `import { … } from 'astro:assets'` — a named
      // import of a virtual module, so there is no file path to resolve the
      // way a project component's is.
      if (item.type === 'astroAsset') {
        const assetId = newId();
        mutateModel((model) => {
          if (!model.imports.some((i) => i.name === item.name && !i.typeOnly)) {
            model.imports.push({
              name: item.name,
              imported: item.name,
              path: ASTRO_ASSETS_MODULE,
              named: true,
              quote: "'",
            });
          }
          insertIntoModel(
            model,
            // Self-closing, and already valid: Astro throws on an <Image>
            // with no src, so a bare one would swap the canvas for a stack
            // trace the moment it landed. See PLACEHOLDER_PROPS.
            {
              id: assetId,
              kind: 'component',
              name: item.name,
              props: { ...PLACEHOLDER_PROPS },
              children: null,
            },
            target
          );
          return model;
        }, true);
        setSelectedId(assetId);
        return;
      }

      const id = newId();
      let node: EditorNode | null = null;
      if (item.type === 'element') {
        const placeholder = defaultText(item.tag);
        node = {
          id,
          kind: 'element',
          name: item.tag,
          props: {},
          children: VOID_TAGS.has(item.tag)
            ? null
            : placeholder
              ? [{ id: newId(), kind: 'text', value: placeholder }]
              : [],
        };
      } else if (item.type === 'map') {
        // No source until one is picked in the props panel. An empty literal
        // renders nothing; a placeholder name would throw "x is not defined"
        // and take the preview down the moment the loop lands on the page.
        node = { id, kind: 'map', head: '[].map((item) => (', children: [] };
      } else if (item.type === 'cond') {
        // `true` until a real test is typed: the then branch renders, so the
        // condition is visible on the canvas the moment it lands.
        //
        // Just the then. Most conditions never want an else, and one that does
        // is a switch away in the props panel — where turning it back off
        // brings the markup home rather than dropping it. Until then there is
        // nothing to choose between, so the tree shows what is inside the
        // condition directly (see branches.js) instead of a row saying "then".
        node = {
          id,
          kind: 'cond',
          op: '&&',
          test: 'true',
          children: [{ id: newId(), kind: 'branch', name: 'then', children: [] }],
        };
      } else if (item.type === 'comment') {
        node = { id, kind: 'comment', value: ' Comment ' };
      } else if (item.type === 'text') {
        node = { id, kind: 'text', value: 'Text' };
      } else if (item.type === 'expr') {
        node = { id, kind: 'expr', value: '{/* code */}' };
      } else if (item.type === 'doctype') {
        node = { id, kind: 'raw-line', value: '<!doctype html>' };
      } else if (item.type === 'style' || item.type === 'script') {
        node = { id, kind: 'raw', name: item.type, props: {}, inner: '' };
      }
      if (!node) {return;}
      mutateModel((model) => {
        insertIntoModel(model, node, target);
        return model;
      }, true);
      setSelectedId(id);
    },
    [insertTargetFor, addComponent, mutateModel]
  );

  // True while the CMS covers the canvas: the page-editing shortcuts below
  // would act on a selection the user can't see.
  const cmsOpenRef = useRef(false);
  cmsOpenRef.current = leftTab === 'cms' && (!!cmsRel || !!contentName);

  // Keyboard: ⌘Z undoes, ⇧⌘Z / ⌘Y redoes (app-wide, even inside fields —
  // field edits live in the same history); Delete/Backspace removes, ⌘C
  // copies, ⌘D duplicates, ⌘V pastes — unless the user is typing in a field.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      const mod = e.metaKey || e.ctrlKey;

      // Undo/redo take priority over native field undo so history stays
      // consistent no matter where focus is. Handled before the CMS check
      // below and without requiring an open page: the stack also holds CSS,
      // CMS and asset changes, which are undoable from anywhere.
      if (mod && (e.key.toLowerCase() === 'z' || e.key.toLowerCase() === 'y')) {
        const h = historyRef.current;
        const wantsRedo = e.key.toLowerCase() === 'y' || e.shiftKey;
        if (!(wantsRedo ? h.future : h.past).length) {return;} // let the field's own undo have it
        e.preventDefault();
        if (wantsRedo) {void redo();}
        else {void undo();}
        return;
      }

      if (cmsOpenRef.current) {return;}

      // ⌘F / ⌘E open the insert palette (works from anywhere except the
      // code editor, which keeps its own find).
      if (mod && (e.key.toLowerCase() === 'f' || e.key.toLowerCase() === 'e')) {
        if (!pageStateRef.current.pageState?.editable) {return;}
        const el = e.target;
        if (el instanceof HTMLElement && el.closest('.cm-editor')) {return;}
        e.preventDefault();
        setInsertOpen(true);
        return;
      }

      // ⌘⇧A makes a component out of the selection: the Components panel opens
      // with the naming dialog up, the same thing its create button does.
      // Before the "am I typing" guard, so it works wherever focus happens to
      // be — it acts on the selected element, not on the field.
      if (mod && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'a') {
        if (!pageStateRef.current.pageState?.editable) {return;}
        if (!selectedIdRef.current || selectedIdRef.current === 'frontmatter') {return;}
        const el = e.target;
        if (el instanceof HTMLElement && el.closest('.cm-editor')) {return;}
        e.preventDefault();
        setLeftTab('components');
        setCreateRequest((n) => n + 1);
        return;
      }

      // ⌘Enter goes straight to the class field: Settings tab, Settings group
      // open, caret in the class input. Before the "am I typing" guard below,
      // so it also works from another field in the panel.
      if (mod && !e.altKey && !e.shiftKey && e.key === 'Enter') {
        if (!selectedIdRef.current) {return;}
        const el = e.target;
        if (el instanceof HTMLElement && el.closest('.cm-editor')) {return;}
        e.preventDefault();
        setRightTab('settings');
        setClassFocus((n) => n + 1);
        return;
      }

      const t = e.target;
      if (
        t instanceof HTMLElement &&
        (t.closest('input, textarea, select, [contenteditable="true"]') || t.isContentEditable)
      ) {
        return;
      }
      const state = pageStateRef.current.pageState;
      if (!state?.editable) {return;}
      const selId = selectedIdRef.current;
      const hasNodeSel = !!selId && selId !== 'frontmatter';

      // Enter opens the floating editor for a selection that has one
      // (frontmatter, <style>, <script>) — same as its "Edit code" button.
      // Not gated on hasNodeSel: frontmatter is exactly one of these.
      if (!mod && !e.altKey && !e.shiftKey && e.key === 'Enter') {
        // On a focused control Enter means "activate this", not "open the
        // selection" — leave those alone (including the Edit code button
        // itself, which would otherwise fire twice).
        if (t instanceof HTMLElement && t.closest('button, a, [role="button"]')) {return;}
        if (openCodeWindowRef.current?.()) {e.preventDefault();}
        return;
      }

      // S / D swap the right panel — plain keys, so they only fire outside
      // fields (the check above) and never collide with ⌘D (duplicate).
      if (!mod && !e.altKey && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        setRightTab('style');
        return;
      }
      if (!mod && !e.altKey && (e.key === 'd' || e.key === 'D')) {
        e.preventDefault();
        setRightTab('settings');
        return;
      }

      if (!mod && (e.key === 'Delete' || e.key === 'Backspace')) {
        if (!hasNodeSel) {return;}
        e.preventDefault();
        removeNode(selId);
      } else if (mod && e.key.toLowerCase() === 'c') {
        // Let native copy win when actual text is selected.
        if (!hasNodeSel || String(window.getSelection() || '')) {return;}
        e.preventDefault();
        copyNode(selId);
      } else if (mod && e.key.toLowerCase() === 'd') {
        if (!hasNodeSel) {return;}
        e.preventDefault();
        duplicateNode(selId);
      } else if (mod && e.key.toLowerCase() === 'v') {
        if (!nodeClipboardRef.current) {return;}
        e.preventDefault();
        pasteNode();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [removeNode, copyNode, duplicateNode, pasteNode, undo, redo]);

  // Application-menu shortcuts: on macOS the native menu consumes ⌘Z/⌘C/⌘V
  // before the DOM sees them, so those arrive here via IPC instead. Copy and
  // paste route to the focused text field when one is active, otherwise to
  // the selected node.
  useEffect(() => {
    const inEditable = (): boolean => {
      const el = document.activeElement;
      return (
        el instanceof HTMLElement &&
        (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
      );
    };
    const offs = [
      // ⌘Z is a menu accelerator, so the key never reaches the page: whatever
      // this decides is the only undo there is.
      //
      // Typing has its own, and the field is the only thing that knows what was
      // typed — a rename half-finished in a text box is not an entry on the
      // app's stack. So a field gets its own undo handed back to it.
      //
      // Everything else is the app's. It used to run only while a page was open
      // and the CMS was closed, which left every view that ISN'T a page unable
      // to undo anything it had recorded: the variables panel, the assets
      // panel, the CMS itself. A command carries its own inverse and needs no
      // page — and a snapshot without one is dropped rather than applied, which
      // undo already does.
      window.avb.onMenu('undo', () => {
        if (inEditable()) {
          runNativeEdit('undo');
          return;
        }
        undo();
      }),
      window.avb.onMenu('redo', () => {
        if (inEditable()) {
          runNativeEdit('redo');
          return;
        }
        redo();
      }),
      window.avb.onMenu('copy', () => {
        if (inEditable() || String(window.getSelection() || '')) {
          runNativeEdit('copy');
          return;
        }
        const selId = selectedIdRef.current;
        if (selId && pageStateRef.current.pageState?.editable && !cmsOpenRef.current) {
          copyNode(selId);
        }
      }),
      window.avb.onMenu('paste', () => {
        if (inEditable()) {
          runNativeEdit('paste');
          return;
        }
        if (nodeClipboardRef.current && pageStateRef.current.pageState?.editable && !cmsOpenRef.current) {
          pasteNode();
        }
      }),
      // ⇧⌘C — the selection's file:line trail, for pasting into an AI chat.
      // Copies markup coordinates, not markup: ⌘C already does the node.
      window.avb.onMenu('copySelection', async () => {
        // The lines are read off the file on disk, and typing is saved on a
        // 300 ms debounce — land the pending edit first or they're one edit old.
        await flushSave();
        const projectPath = projectRef.current?.path;
        if (!projectPath) {return;}
        const copied = await copyEditorSelection(projectPath, [...selectionKeysRef.current]);
        if (copied) {showToast('Selection copied — paste it into your AI chat.');}
        else {showToast('Nothing selected to copy.', 'error');}
      }),
    ];
    return () => offs.forEach((off) => off());
  }, [undo, redo, copyNode, pasteNode, flushSave, showToast]);

  // ----------------------------------------------------------------
  // Interactive preview mode — browse the site inside the app; on exit,
  // the editor follows whichever page was navigated to.
  // ----------------------------------------------------------------

  const enterPreview = useCallback(() => {
    if (!devUrl) {return;}
    // Whatever the canvas is showing — which for a dynamic page is one entry's
    // URL, not its pattern. Opening /blog/[...id] asks the dev server for a
    // route no page produces, and it answers with the site's 404, while the
    // URL field (built from the same entry) went on claiming otherwise.
    const path =
      livePathRef.current ||
      routeToPath(pageStateRef.current.currentPage?.route || '/', trailingSlash);
    previewPathRef.current = path;
    setPreviewSrc(devUrl + path);
    setInPreview(true);
  }, [devUrl, trailingSlash]);

  const exitPreview = useCallback(() => {
    setInPreview(false);
    const raw = previewPathRef.current;
    if (!raw) {return;}
    let p = raw.split('?')[0]?.split('#')[0] ?? '';
    if (p.length > 1 && p.endsWith('/')) {p = p.slice(0, -1);}
    const page = scan.pages.find((pg) => pg.route === (p || '/'));
    if (page && page.path !== pageStateRef.current.currentPage?.path) {
      selectPage(page);
    }
  }, [scan.pages, selectPage]);

  // Track navigation inside the preview iframe (the preload posts
  // avb:navigated from every loaded frame).
  useEffect(() => {
    const onMsg = (e: MessageEvent<unknown>): void => {
      const message = toRecord(e.data);
      if (message?.['type'] !== 'avb:navigated' || !inPreviewRef.current) {return;}
      const ifr = previewIframeRef.current;
      if (ifr && e.source === ifr.contentWindow) {
        const path = message['path'];
        if (typeof path === 'string') {previewPathRef.current = path;}
      }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, []);

  // Escape exits preview mode.
  useEffect(() => {
    // Escape leaves either kind of looking-not-working. An older version takes
    // precedence: it is the one covering everything, so it is the one Escape
    // is about while it is up.
    if (!inPreview && !previewRef) {return undefined;}
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (previewRef) {exitCommitPreview();}
        else {exitPreview();}
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [inPreview, exitPreview, previewRef, exitCommitPreview]);

  // Escape backs out of a drilled-into component, one level at a time.
  useEffect(() => {
    if (inPreview || editStack.length < 2) {return;}
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') {return;}
      const t = e.target;
      // Let fields, menus, and dialogs consume their own Escape first.
      if (
        t instanceof HTMLElement &&
        (t.closest('input, textarea, select, [contenteditable="true"]') ||
          t.closest('.modal-overlay, .dd-popup, .insert-overlay, .code-window'))
      ) {
        return;
      }
      e.preventDefault();
      closeComponent();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [inPreview, editStack.length, closeComponent]);

  // The route list is written by the dev server as it resolves its routes, so
  // it is read once the server is up — and again after a rescan, since adding
  // a page of your own changes what the list holds.
  useEffect(() => {
    if (!project || devStatus !== 'on') {
      setInjectedRoutes([]);
      return;
    }
    let live = true;
    readInjectedRoutes(project.path)
      .then((routes) => live && setInjectedRoutes(routes))
      .catch(() => live && setInjectedRoutes([]));
    return () => {
      live = false;
    };
  }, [project, devStatus, scan.pages.length]);

  // A dynamic page ([slug].astro) has a route pattern, not a URL. Ask the dev
  // server which concrete paths its getStaticPaths produces, so the canvas can
  // show one of them instead of a 404. Static pages never reach the fetch.
  useEffect(() => {
    const entry = editStack[0] || currentPage;
    const route = entry?.route;
    if (!project || !entry || !route?.includes('[') || devStatus !== 'on' || !devUrl) {
      setDynamicPaths([]);
      return undefined;
    }
    let live = true;
    if (!entry.path) {return undefined;}
    readDynamicPaths(project.path, entry.path, devUrl)
      .then((r) => {
        if (!live) {return;}
        setDynamicPaths(r?.entries || []);
        // Keep showing the same entry across reloads where we can — the
        // params are what identify it, not its position in the list.
        setDynamicIndex((i) => (i < (r?.entries || []).length ? i : 0));
        if (r?.error) {setDynamicError(r.error);}
        else {setDynamicError(null);}
      })
      .catch(() => live && setDynamicPaths([]));
    return () => {
      live = false;
    };
    // Frontmatter rather than the whole pageState: getStaticPaths lives there,
    // and depending on the model would re-run a collection query on every
    // keystroke in the page body.
  }, [
    project,
    editStack,
    currentPage,
    devStatus,
    devUrl,
    pageState?.editable ? pageState.model.extraFrontmatter : undefined,
  ]);

  // What one entry of each collection this file reads actually holds — the
  // sample values the binding picker shows beside a field's name. Only the dev
  // server can run the project's loaders, so without one the picker falls back
  // to whatever the source alone says.
  useEffect(() => {
    setCollectionSamples({});
    sampleAskedRef.current = new Set();
  }, [project?.path]);
  useEffect(() => {
    if (!project?.path) {return undefined;}
    let live = true;
    readContentCollections(project.path)
      .then((value) => live && setCollections(value))
      .catch(() => {});
    const off = onCmsInventoryChanged(() => {
      readContentCollections(project.path)
        .then((value) => live && setCollections(value))
        .catch(() => {});
    });
    return () => {
      live = false;
      off?.();
    };
  }, [project?.path]);
  useEffect(() => {
    if (!devUrl || devStatus !== 'on') {return undefined;}
    const frontmatter = pageState?.editable ? pageState.model.extraFrontmatter : '';
    // The entry on the canvas, which is what a reference in this file resolves
    // AGAINST — this post's author, not the collection's first.
    const props =
      currentPage?.kind === 'component' ? null : dynamicPaths[dynamicIndex]?.props || null;
    const wanted: { readonly key: string; readonly name: string; readonly id?: string }[] = [
      ...collectionsInScope(frontmatter).map((name) => ({ key: name, name })),
      ...referencesInScope(frontmatter, props).map((r) => ({
        key: r.key,
        name: r.collection,
        id: r.id,
      })),
    ].filter((w) => !(w.key in collectionSamples));
    if (!wanted.length) {return undefined;}
    let live = true;
    Promise.all(
      wanted.map((w) =>
        readSampleEntry(devUrl, w.name, w.id).then(
          (entry) => [w.key, entry] as const,
        )
      )
    )
      .then((pairs) => {
        if (live) {setCollectionSamples((prev) => ({ ...prev, ...Object.fromEntries(pairs) }));}
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [
    pageState?.editable ? pageState.model.extraFrontmatter : undefined,
    devUrl,
    devStatus,
    collectionSamples,
    dynamicPaths,
    dynamicIndex,
    currentPage,
  ]);

  // Takes back the queries it wrote, once the page stops using them: delete the
  // last chip reading a collection and its `const … = await getCollection(…)`
  // goes too, rather than leaving a query fetching content for nobody.
  //
  // Three things keep this safe. Only queries carrying Stacki's own marker are
  // considered, so a hand-written one is never touched. "Used" is tested
  // against the whole node tree as text, which over-detects rather than
  // under-detects — the wrong answer here is deleting something live. And it
  // waits for a pause in typing, because a half-typed name reads as unused.
  useEffect(() => {
    const current = pageState?.editable ? pageState.model : undefined;
    if (!current?.extraFrontmatter?.includes(QUERY_MARK)) {return undefined;}
    const timer = setTimeout(() => {
      const focused = document.activeElement;
      if (focused?.closest?.('.props-field, .rich-content, .bind-input, .expr-input, .attr-editor'))
        {return;}
      const fm = current.extraFrontmatter || '';
      const markup = JSON.stringify(current.nodes || []);
      const dead = markedQueries(fm).filter((q) => {
        const word = new RegExp(`\\b${q.name}\\b`);
        const elsewhere = fm.slice(0, q.start) + fm.slice(q.end);
        return !word.test(elsewhere) && !word.test(markup);
      });
      if (!dead.length) {return;}
      mutateModel((m) => {
        let next = m.extraFrontmatter || '';
        for (const q of dead) {next = removeMarkedQuery(next, q.name);}
        m.extraFrontmatter = next;
        // The import goes with the last query that needed it — but only when
        // nothing else in the file mentions it, so an import someone else put
        // there and still uses stays put.
        if (!/\bgetCollection\b/.test(next) && !/\bgetCollection\b/.test(JSON.stringify(m.nodes || []))) {
          m.imports = m.imports.filter(
            (i) => !(i.name === 'getCollection' && i.path === 'astro:content')
          );
        }
        return m;
      });
    }, 2000);
    return () => clearTimeout(timer);
  }, [pageState?.editable ? pageState.model : undefined, mutateModel]);

  // The welcome screen's thumbnails are taken in the main process now, from
  // the project's home page rendered in a window of its own (see
  // electron/thumbs.js). Photographing this window was what put the editor's
  // own panels — and whatever page and scroll position the user left — into
  // the picture that is supposed to show the site.


  // The comment sitting directly above a node. The navigator folds it into
  // that node's row rather than giving it one of its own, and the props panel
  // edits it there — so a section's label and its note stay together.
  const commentAbove = (model: EditorModel | null, nodeId: string | null): EditorNode | null => {
    if (!model || !nodeId) {return null;}
    const found = findParentList(model, nodeId);
    if (!found || found.index === 0) {return null;}
    const prev = found.list[found.index - 1];
    return prev && prev.kind === 'comment' ? prev : null;
  };

  // Write (or clear) that comment. Empty text removes the node entirely, so
  // clearing the field doesn't leave `<!---->` behind.
  const setComment = useCallback(
    (nodeId: string, text: string) => {
      mutateModel(
        (model) => {
          const found = findParentList(model, nodeId);
          if (!found) {return model;}
          const { list, index } = found;
          const prev = index > 0 ? list[index - 1] : null;
          const existing = prev && prev.kind === 'comment' ? prev : null;
          const body = String(text ?? '').trim();
          if (!body) {
            if (existing) {list.splice(index - 1, 1);}
            return model;
          }
          // The parser keeps the raw text between the delimiters, so it is
          // padded to serialize as `<!-- text -->` the way a hand-written one
          // reads — and a note written as a divider keeps its rule, to the
          // same width, so a column of them stays lined up.
          const value = noteValue(existing?.value, body);
          assert(value !== null, 'A nonempty comment produces a serialized value');
          if (existing) {existing.value = value;}
          else {list.splice(index, 0, { id: newId(), kind: 'comment', value });}
          return model;
        },
        false,
        `comment:${nodeId}`
      );
    },
    [mutateModel]
  );

  // Typing a bare class in the style panel's selector box puts it on the
  // element too — a rule for a class the element doesn't carry would never
  // apply. Where it goes depends on how the element's classes are written: a
  // plain `class`, a `class:list`, a template literal (see classAttr.js). An
  // element whose class is some other expression is code we would have to
  // understand to extend, so that one is said out loud rather than dropped.
  const addClassToNode = useCallback(
    (nodeId: string, className: string) => {
      const clean = String(className || '').trim();
      if (!nodeId || !clean) {return;}
      let refused = false;
      mutateModel((model) => {
        const node = findNodeById(model.nodes, nodeId);
        if (!node) {return model;}
        if (hasClass(node.props, clean)) {return model;}
        const edit = withClass(node.props, clean);
        if (!edit) {
          refused = true;
          return model;
        }
        if (!node.props) {node.props = {};}
        node.props[edit.key] = edit.value;
        return model;
      }, true);
      if (refused) {
        showToast(`Add ${clean} to this element yourself — its class comes from code Stacki can't edit safely.`);
      }
    },
    [mutateModel, showToast]
  );

  const setProp = useCallback(
    (nodeId: string, propName: string, value: Attr | undefined, immediate = false) => {
      mutateModel(
        (model) => {
          const node = findNodeById(model.nodes, nodeId);
          if (!node) {return model;}
          if (!node.props) {node.props = {};}
          if (value === undefined) {delete node.props[propName];}
          else {node.props[propName] = value;}
          return model;
        },
        immediate,
        `prop:${nodeId}:${propName}`
      );
    },
    [mutateModel]
  );

  // Several props in one edit, so picking an image and getting its width and
  // height back is a single undo rather than three.
  const setProps = useCallback(
    (nodeId: string, patch: PropValues, immediate = true) => {
      mutateModel(
        (model) => {
          const node = findNodeById(model.nodes, nodeId);
          if (!node) {return model;}
          if (!node.props) {node.props = {};}
          for (const [name, value] of Object.entries(patch)) {
            if (value === undefined) {delete node.props[name];}
            else {node.props[name] = value;}
          }
          return model;
        },
        immediate,
        `props:${nodeId}:${Object.keys(patch).join(',')}`
      );
    },
    [mutateModel]
  );

  // Writes an asset pick into a prop. The root decides the form:
  //
  //   public/  served as-is → a URL string, src="/hero.png"
  //   src/     built and optimised → an ESM import, src={hero}
  //
  // The src/ form is the one Astro wants for <Image>: it carries the file's
  // real dimensions, so nothing has to be typed in and MissingImageDimension
  // can't happen. An element gets `hero.src` instead — a plain <img> needs the
  // URL out of the imported object, not the object.
  const setAssetProp = useCallback(
    async (nodeId: string, propName: string, picked: PickedAsset & { readonly abs?: string }) => {
      const { pageState: state, currentPage: page } = pageStateRef.current;
      if (!state?.editable || !page?.path || !picked?.rel) {return;}
      const withoutRoot = picked.rel.split('/').slice(1).join('/');
      if (picked.root !== 'src') {
        setProp(nodeId, propName, { type: 'string', value: '/' + withoutRoot }, true);
        return;
      }
      const projectPath = projectRef.current?.path;
      if (!projectPath) {return;}
      const abs = picked.abs || `${projectPath}/${picked.rel}`;
      const paths = await findImportPath(projectPath, page.path, abs);
      mutateModel((model) => {
        const node = findNodeById(model.nodes, nodeId);
        if (!node) {return model;}
        const spec = chooseImportPath(model, paths);
        // Reuse the binding if this file is already imported — importing the
        // same asset twice under two names is just noise.
        let local = (model.imports || []).find((i) => !i.named && i.path === spec)?.name;
        if (!local) {
          const base = withoutRoot.split('/').pop()?.replace(/\.[^.]+$/, '') ?? 'asset';
          let candidate = base.replace(/[^A-Za-z0-9_$]/g, '_').replace(/^(\d)/, '_$1') || 'asset';
          const taken = new Set((model.imports || []).map((i) => i.name));
          let n = 2;
          while (taken.has(candidate)) {candidate = `${base}${n++}`;}
          local = candidate;
          model.imports.push({ name: local, path: spec, quote: "'" });
        }
        if (!node.props) {node.props = {};}
        node.props[propName] = {
          type: 'expr',
          value: node.kind === 'element' ? `${local}.src` : local,
        };
        // Picking a second image over a first leaves the first one's import
        // behind with nothing pointing at it.
        pruneImports(model);
        return model;
      }, true);
    },
    [mutateModel, setProp]
  );

  // Renames an attribute in place, preserving its value and position.
  const renameProp = useCallback(
    (nodeId: string, oldName: string, newName: string) => {
      mutateModel((model) => {
        const node = findNodeById(model.nodes, nodeId);
        renameAttr(node, oldName, newName);
        return model;
      }, true);
    },
    [mutateModel]
  );

  // Switches a plain element's tag. Attributes that belonged to the old
  // tag's built-in schema but aren't valid for the new one are dropped
  // (loading="eager" on img → div); global, data-* and aria-* attributes
  // and anything custom stay.
  // Renaming a node's tag can change what kind of node it is. Astro decides
  // that by case: `<div>` is an element, `<AstroLogo>` is a component — and a
  // component is only real if something in the frontmatter provides it, so a
  // capitalised name is only accepted when it names a project component or an
  // existing import. Typing `div` over a component turns it back.
  const changeNodeKind = useCallback(
    async (nodeId: string, newTag: string) => {
      const name = String(newTag || '').trim();
      if (!/^[A-Z][\w$]*$/.test(name)) {return false;}
      const state = pageStateRef.current.pageState;
      if (!state?.editable) {return false;}
      const already = (state.model.imports || []).some((i) => i.name === name);
      const comp = insertables.find((c) => c.name === name);
      const asset = ASTRO_ASSETS.some((a) => a.name === name);
      if (!already && !comp && !asset) {return false;} // nothing provides it
      const paths = comp && !already ? await resolveImportPath(comp.path) : null;
      mutateModel((model) => {
        const node = findNodeById(model.nodes, nodeId);
        if (!node || node.name === name) {return model;}
        if (!model.imports.some((i) => i.name === name)) {
          if (paths) {
            model.imports.push({ name, path: chooseImportPath(model, paths), quote: "'" });
          }
          else if (asset) {
            model.imports.push({
              name,
              imported: name,
              path: ASTRO_ASSETS_MODULE,
              quote: "'",
              named: true,
            });
          }
        }
        // Attributes that belonged to the old element's tag mean nothing to a
        // component; class, data- and aria- carry over the way they do for a
        // tag change.
        if (node.kind === 'element') {
          const oldNames = new Set(getElementSchema(node.name).map((f) => f.name));
          for (const attr of Object.keys(node.props || {})) {
            if (oldNames.has(attr) && !GLOBAL_ATTRS.has(attr) && !/^(data-|aria-)/.test(attr)) {
              delete node.props?.[attr];
            }
          }
        }
        node.kind = 'component';
        node.name = name;
        delete node.dynamicTag;
        if (asset) {node.astroAsset = true;}
        else {delete node.astroAsset;}
        if (node.children === null) {node.children = [];}
        pruneImports(model);
        return model;
      }, true);
      return true;
    },
    [insertables, mutateModel, resolveImportPath]
  );

  const changeElementTag = useCallback(
    (nodeId: string, newTag: string) => {
      const tag = String(newTag || '').trim().toLowerCase();
      if (!/^[a-z][a-z0-9-]*$/.test(tag)) {return;}
      mutateModel((model) => {
        const node = findNodeById(model.nodes, nodeId);
        if (!node || node.name === tag) {return model;}
        // A component becoming a plain tag keeps only what a tag understands:
        // its props were the component's API, and they'd serialize as junk
        // attributes on a <div>.
        const wasComponent = node.kind !== 'element';
        const oldNames = wasComponent
          ? new Set(Object.keys(node.props || {}))
          : new Set(getElementSchema(node.name).map((f) => f.name));
        if (wasComponent) {
          node.kind = 'element';
          delete node.astroAsset;
          delete node.dynamicTag;
        }
        const newNames = new Set(getElementSchema(tag).map((f) => f.name));
        for (const attr of Object.keys(node.props || {})) {
          if (
            oldNames.has(attr) &&
            !newNames.has(attr) &&
            !GLOBAL_ATTRS.has(attr) &&
            !/^(data-|aria-)/.test(attr)
          ) {
            delete node.props?.[attr];
          }
        }
        node.name = tag;
        // Void elements can't have children; paired tags serialize as a pair.
        if (VOID_TAGS.has(tag)) {node.children = null;}
        else if (node.children === null) {node.children = [];}
        pruneImports(model);
        return model;
      }, true);
    },
    [mutateModel]
  );

  // `renames` (loop editor only) carries the variable names this edit is
  // changing, so references below the node follow along. A rename touches
  // many nodes at once, so it saves immediately and gets its own history
  // entry instead of coalescing with the keystrokes around it.
  // `immediate` skips the typing coalesce for an edit that arrives already committed
  // (the style panel writing a <style> block): waiting 300 ms there just delays the
  // canvas, since the next keystroke it was batching with never comes.
  const setNodeText = useCallback(
    (
      nodeId: string,
      value: string,
      renames: readonly Rename[] | undefined = undefined,
      immediate: boolean | 'live' = false,
    ) => {
      const renaming = (renames || []).some((r) => r.from && r.to && r.from !== r.to);
      mutateModel(
        (model) => {
          const node = findNodeById(model.nodes, nodeId);
          if (!node) {return model;}
          if (node.kind === 'map') {
            const prev = parseLoopHead(node.head);
            node.head = value;
            for (const { from, to } of renames || []) {
              if (from && to && from !== to) {renameLoopVar(node.children || [], from, to);}
            }
            // Renames above already re-pointed the children, so compare the
            // data sources and orphan-proof what reads from this item.
            const next = parseLoopHead(value);
            if (prev && next && prev.data !== next.data) {
              const vars = [next.item, next.index].filter(Boolean);
              if (vars.length) {disconnectDependentLoops(node.children || [], vars);}
            }
          } else if (node.kind === 'cond') {
            node.test = value;
          } else if (node.kind === 'raw') {node.inner = value;}
          else if (node.kind === 'text' || node.kind === 'expr' || node.kind === 'comment') {
            node.value = value;
          }
          return model;
        },
        renaming || immediate,
        renaming ? undefined : `text:${nodeId}`
      );
    },
    [mutateModel]
  );

  // The code editor and file writer share the same frontmatter model, so
  // editing code preserves named imports, interleaved statements and spacing.
  const setFrontmatter = useCallback(
    (code: string) => {
      mutateModel(
        (model) => {
          Object.assign(model, readFrontmatter(code));
          return model;
        },
        false,
        'frontmatter'
      );
    },
    [mutateModel]
  );

  // Adds or removes a condition's else branch. Removing keeps the markup that
  // was in it — it moves to the then branch rather than being deleted — so the
  // button can't quietly throw work away.
  const toggleElseBranch = useCallback(
    (nodeId: string, want: boolean) => {
      mutateModel(
        (model) => {
          const node = findNodeById(model.nodes, nodeId);
          if (!node || node.kind !== 'cond') {return model;}
          const kids = node.children || (node.children = []);
          if (!kids[0]) {kids[0] = { id: newId(), kind: 'branch', name: 'then', children: [] };}
          if (want && kids.length < 2) {
            kids[1] = { id: newId(), kind: 'branch', name: 'else', children: [] };
            node.op = '?';
          } else if (!want && kids.length > 1) {
            const elseBranch = kids[1];
            const thenBranchNode = kids[0];
            assert(elseBranch !== undefined, 'Else branch exists before removal');
            assert(thenBranchNode !== undefined, 'Then branch exists before merging');
            const rescued = elseBranch.children || [];
            kids.length = 1;
            thenBranchNode.children = [...(thenBranchNode.children || []), ...rescued];
            node.op = '&&';
          }
          return model;
        },
        true,
        undefined
      );
    },
    [mutateModel]
  );

  // Replaces the frontmatter's non-import code (its declarations), leaving the
  // import list alone. What the props panel edits when you open the source
  // behind a `{data}` prop — the imports aren't in play there, so they don't
  // need re-extracting.
  const setExtraFrontmatter = useCallback(
    (code: string) => {
      mutateModel(
        (model) => {
          model.extraFrontmatter = code;
          return model;
        },
        false,
        'frontmatter'
      );
    },
    [mutateModel]
  );

  // Sets the text content of a component (single text child convenience).
  // Where each node's loose text last sat, so emptying the Content field and
  // typing again restores its place rather than appending.
  const textSlotRef = useRef<Record<string, number>>({});

  const setNodeContent = useCallback(
    (nodeId: string, value: string) => {
      mutateModel(
        (model) => {
          const node = findNodeById(model.nodes, nodeId);
          if (!node || node.kind === 'text') {return model;}
          if (!Array.isArray(node.children)) {node.children = [];}
          const at = node.children.findIndex((c) => c.kind === 'text');
          // Emptying the field takes the text node out rather than leaving an
          // empty one behind for the serializer to puzzle over — but where it
          // sat is remembered, so clearing the field and typing again puts the
          // words back among the children instead of after all of them.
          if (at !== -1 && !value) {
            textSlotRef.current[nodeId] = at;
            node.children.splice(at, 1);
          } else if (at !== -1) {
            const textNode = node.children[at];
            assert(textNode !== undefined, 'Text child index remains valid');
            textNode.value = value;
          } else if (value) {
            const back = textSlotRef.current[nodeId];
            const idx =
              back !== undefined && Number.isInteger(back) && back <= node.children.length
                ? back
                : node.children.length;
            node.children.splice(idx, 0, { id: newId(), kind: 'text', value });
          }
          return model;
        },
        false,
        `content:${nodeId}`
      );
    },
    [mutateModel]
  );

  // Replaces a node's inline children wholesale (rich Content field edits).
  // Nodes arrive from the editor without ids — assign fresh ones.
  const setNodeInline = useCallback(
    (nodeId: string, kids: readonly InlineNode[]) => {
      const withIds = (list: readonly InlineNode[]): EditorNode[] =>
        list.map((node): EditorNode => {
          if (node.kind === 'text' || node.kind === 'expr') {
            return { ...node, id: newId() };
          }
          const props = Object.fromEntries(
            Object.entries(node.props ?? {}).filter(
              (entry): entry is [string, Attr] => entry[1] !== null,
            ),
          );
          return {
            id: newId(),
            kind: 'element',
            name: node.name,
            props,
            children: node.children === null ? null : withIds(node.children),
          };
        });
      mutateModel(
        (model) => {
          const node = findNodeById(model.nodes, nodeId);
          if (!node || node.kind === 'text') {return model;}
          node.children = withIds(kids);
          return model;
        },
        false,
        `content:${nodeId}`
      );
    },
    [mutateModel]
  );

  // Set/replace/remove the `layout:` key in a markdown page's YAML
  // frontmatter, leaving every other key and its formatting alone. The
  // frontmatter text stays the single source of truth — editing it by hand in
  // the frontmatter editor and picking a layout here write to the same place.
  const withLayoutField = (frontmatter: string, layoutPath: string | null): string => {
    const fm = frontmatter ?? '';
    if (/^[ \t]*layout[ \t]*:/m.test(fm)) {
      return layoutPath
        ? fm.replace(/^[ \t]*layout[ \t]*:.*$/m, `layout: ${layoutPath}`)
        : fm.replace(/^[ \t]*layout[ \t]*:.*(\n|$)/m, '');
    }
    if (!layoutPath) {return fm;}
    // First, so it reads as the page's frame rather than one field among many.
    return fm ? `layout: ${layoutPath}\n${fm}` : `layout: ${layoutPath}`;
  };

  const isMarkdownFormatRef = useRef(false);
  isMarkdownFormatRef.current =
    pageState?.editable === true &&
    (pageState.model.format === 'md' || pageState.model.format === 'mdx');

  const layoutSeq = useRef(0);
  const changeLayout = useCallback(
    async (layoutName: string) => {
      const seq = ++layoutSeq.current;
      // A markdown page has no wrapper node to swap — Astro reads its layout
      // from the `layout:` frontmatter key, as a path relative to the file.
      // Same picker, different place to write the answer.
      if (isMarkdownFormatRef.current) {
        const layout = layoutName ? scan.layouts.find((l) => l.name === layoutName) : null;
        if (layoutName && !layout) {return;}
        // A file-relative path, not an alias: `layout:` is resolved by Astro
        // against the page, and every project has that whether or not it has
        // configured `@/…`.
        const rel = layout ? (await resolveImportPath(layout.path)).relative : null;
        if (seq !== layoutSeq.current) {return;}
        mutateModel((model) => {
          model.extraFrontmatter = withLayoutField(model.extraFrontmatter, rel);
          model.layoutPath = rel;
          return model;
        }, true);
        return;
      }
      if (!layoutName) {
        // Unwrap: replace the wrapper node with its children.
        mutateModel((model) => {
          const found = findParentList(model, 'layout');
          if (found) {
            const node = found.list[found.index];
            assert(node !== undefined, 'Layout index identifies a node');
            const kids = Array.isArray(node.children) ? node.children : [];
            found.list.splice(found.index, 1, ...kids);
          }
          pruneImports(model);
          return model;
        }, true);
        setSelectedId((id) => (id === 'layout' ? null : id));
        return;
      }
      const layout = scan.layouts.find((l) => l.name === layoutName);
      if (!layout) {return;}
      const paths = await resolveImportPath(layout.path);
      if (seq !== layoutSeq.current) {return;} // superseded by a newer change
      mutateModel((model) => {
        const existing = findNodeById(model.nodes, 'layout');
        if (existing) {
          existing.name = layout.name;
        } else {
          // No wrapper yet — wrap the whole page in the new layout.
          model.nodes = [
            {
              id: nodeId('layout'),
              kind: 'component',
              name: layout.name,
              props: {},
              children: model.nodes,
            },
          ];
        }
        if (!model.imports.some((i) => i.name === layout.name)) {
          model.imports.push({
            name: layout.name,
            path: chooseImportPath(model, paths),
            quote: "'",
          });
        }
        pruneImports(model);
        return model;
      }, true);
    },
    [scan.layouts, mutateModel, resolveImportPath]
  );

  // ----------------------------------------------------------------
  // Page management
  // ----------------------------------------------------------------

  const createPage = useCallback(
    async (name: string, layoutName: string | null) => {
      const projectPath = projectRef.current?.path;
      if (!projectPath) {return;}
      const layout = scan.layouts.find((l) => l.name === layoutName) || null;
      try {
        const pagePath = await createProjectPage(projectPath, name, layout);
        const result = await rescan(projectPath);
        const page = result.pages.find((p) => p.path === pagePath);
        if (page) {selectPage(page);}
        showToast(`Created ${name}.astro`, 'success');
      } catch (err) {
        showToast(cleanError(err), 'error');
      }
    },
    [scan.layouts, rescan, selectPage, showToast]
  );

  const deletePage = useCallback(
    async (page: ScanPage) => {
      if (
        !(await confirmDialog({
          title: `Delete ${page.name}?`,
          body: 'This removes the file from disk. It can be brought back from History if it was saved in a version.',
          confirmLabel: 'Delete page',
          danger: true,
        }))
      ) {
        return;
      }
      const projectPath = projectRef.current?.path;
      if (!projectPath) {return;}
      await deleteProjectPage(page.path);
      const result = await rescan(projectPath);
      if (currentPage?.path === page.path) {
        const next = result.pages[0] || null;
        if (next) {selectPage(next);}
        else {
          setCurrentPage(null);
          setPageState(null);
        }
      }
      showToast(`Deleted ${page.name}`, 'success');
    },
    [currentPage, rescan, selectPage, showToast]
  );

  // Moves/renames a page (drag between folders, inline rename). `to` is the
  // new path relative to src/pages including the extension.
  const movePageTo = useCallback(
    async (page: ScanPage, to: string) => {
      const projectPath = projectRef.current?.path;
      if (!projectPath) {return;}
      try {
        const newPath = await moveProjectPage(projectPath, page.path, to);
        const result = await rescan(projectPath);
        if (pageStateRef.current.currentPage?.path === page.path) {
          const np = result.pages.find((p) => p.path === newPath);
          if (np) {selectPage(np);}
        }
      } catch (err) {
        showToast(cleanError(err), 'error');
      }
    },
    [rescan, selectPage, showToast]
  );

  // Creates an (empty) folder with a placeholder name; the panel opens an
  // inline rename right after. Returns the created folder's name.
  const createPageFolder = useCallback(async () => {
    const existing = new Set(scan.pageFolders || []);
    let name = 'new-folder';
    for (let i = 2; existing.has(name); i++) {name = `new-folder-${i}`;}
    const projectPath = projectRef.current?.path;
    if (!projectPath) {return null;}
    try {
      await createProjectPageFolder(projectPath, name);
      await rescan(projectPath);
      return name;
    } catch (err) {
      showToast(cleanError(err), 'error');
      return null;
    }
  }, [scan, rescan, showToast]);

  const renamePageFolder = useCallback(
    async (from: string, to: string) => {
      const projectPath = projectRef.current?.path;
      if (!projectPath) {return;}
      try {
        await renameProjectPageFolder(projectPath, from, to);
        const result = await rescan(projectPath);
        // Re-select the current page if it lived inside the renamed folder.
        const cur = pageStateRef.current.currentPage;
        if (cur && !result.pages.some((p) => p.path === cur.path)) {
          const newName = cur.name.startsWith(from + '/')
            ? to + cur.name.slice(from.length)
            : null;
          const np = newName && result.pages.find((p) => p.name === newName);
          if (np) {selectPage(np);}
        }
      } catch (err) {
        showToast(cleanError(err), 'error');
      }
    },
    [rescan, selectPage, showToast]
  );

  const deletePageFolder = useCallback(
    async (dir: string, pageCount: number) => {
      const inside = pageCount
        ? `the ${pageCount} page${pageCount === 1 ? '' : 's'} inside it and `
        : '';
      if (
        !(await confirmDialog({
          title: `Delete the folder “${dir}”?`,
          body: `This removes ${inside}the folder from disk.`,
          confirmLabel: 'Delete folder',
          danger: true,
        }))
      ) {
        return;
      }
      const projectPath = projectRef.current?.path;
      if (!projectPath) {return;}
      try {
        await deleteProjectPageFolder(projectPath, dir);
        const result = await rescan(projectPath);
        const cur = pageStateRef.current.currentPage;
        if (cur && !result.pages.some((p) => p.path === cur.path)) {
          const next = result.pages[0] || null;
          if (next) {selectPage(next);}
          else {
            setCurrentPage(null);
            setPageState(null);
          }
        }
      } catch (err) {
        showToast(cleanError(err), 'error');
      }
    },
    [rescan, selectPage, showToast]
  );

  // ----------------------------------------------------------------
  // Selection helpers
  // ----------------------------------------------------------------

  const model = pageState?.editable ? pageState.model : null;
  const tree = useMemo(() => createTreeIndex(model?.nodes), [model?.nodes]);
  const selectedAncestors = useMemo(
    () => (selectedId ? tree.ancestors(selectedId) || [] : []),
    [tree, selectedId],
  );

  // The frontmatter as one editable code block (imports + everything else,
  // matching how the file is serialized).
  const frontmatterCode = useMemo(() => ( model ? writeFrontmatter(model) : ''), [model]);

  // One entry of a collection, asked for when someone opens it in the picker.
  // The ref is what stops a row that has no answer from asking again forever.
  const requestCollectionSample = (name: string): void => {
    if (!name || !devUrl || devStatus !== 'on') {return;}
    if (sampleAskedRef.current.has(name)) {return;}
    sampleAskedRef.current.add(name);
    readSampleEntry(devUrl, name)
      .then((entry) => setCollectionSamples((prev) => ({ ...prev, [name]: entry })))
      .catch(() => {});
  };

  // Binding to a collection this page doesn't read yet: the query that fetches
  // it is written here, and the binding then names it like any other value.
  // A query already targeting that collection is reused — one page asking the
  // same content twice is a page doing the same work twice.
  const ensureCollectionQuery = (collection: string): string => {
    const fm = model?.extraFrontmatter || '';
    const existing = queriesInScope(fm).get(collection);
    if (existing) {return existing;}
    const name = autoQueryName(collection, namesInScope(fm, model?.imports));
    mutateModel((m) => {
      if (!m.imports.some((i) => i.name === 'getCollection' && i.path === 'astro:content')) {
        m.imports.push({
          name: 'getCollection',
          imported: 'getCollection',
          path: 'astro:content',
          quote: "'",
          named: true,
        });
      }
      const cur = m.extraFrontmatter || '';
      const gap = cur && !cur.endsWith('\n') ? '\n' : '';
      // No trailing newline: the serializer ends the line, and one added here
      // would be left behind as a blank line when the query is taken back.
      m.extraFrontmatter = `${cur}${gap}const ${name} = await getCollection('${collection}'); // ${QUERY_MARK}`;
      return m;
    });
    return name;
  };

  const selectedNode:
    | EditorNode | (FrontmatterSubject & { readonly value: string }) | null =
    model && selectedId
      ? selectedId === 'frontmatter'
        ? { id: 'frontmatter', kind: 'frontmatter', value: frontmatterCode }
        : tree.node(selectedId)
      : null;
  // What the Components panel's create button would act on: the name to suggest
  // for the selected element, or why there's nothing to make a component from.
  const createFrom = useMemo<ComponentCreationSource>(() => {
    if (!pageState?.editable) {
      return { kind: 'unavailable', reason: 'Open a page to make components from it.' };
    }
    if (!selectedNode) {
      return { kind: 'unavailable', reason: 'Select an element on the canvas first.' };
    }
    const node = selectedNode;
    if (node.kind === 'text' || node.kind === 'expr') {
      return {
        kind: 'unavailable',
        reason: 'Select the element around this, not the text itself.',
      };
    }
    if (node.kind === 'frontmatter') {
      return { kind: 'unavailable', reason: 'Select an element on the canvas first.' };
    }
    if (node.id === 'layout') {
      return { kind: 'unavailable', reason: 'A layout is already a component of its own.' };
    }
    if (node.kind !== 'element' && node.kind !== 'component') {
      return { kind: 'unavailable', reason: 'Select an element on the canvas first.' };
    }
    // Its first class is the name it already goes by — `.project-card` is a
    // better guess at a component name than `Div`. The tag is the fallback.
    const first = namesIn(node.props?.['class'])[0] || namesIn(node.props?.['class:list'])[0] || '';
    return {
      kind: 'ready',
      name: toComponentName(first) || toComponentName(node.name) || 'Component',
      label: `<${node.name}>`,
      // The page values it reads, which the new component can take as props.
      props: propsNeededFor(pageState.model, node),
    };
  }, [pageState?.editable, selectedNode, model, propsNeededFor]);

  // Rendered classes describe one element, and the canvas can only say what the
  // NEW selection's are a frame or two later. Two ways to spend that gap, and
  // both used to be wrong in one direction:
  //
  //   clear at once   the selector field empties and then refills, so every
  //                   click on the canvas flickers through a blank panel.
  //   keep the old    the field is briefly wrong rather than briefly empty,
  //                   which is steadier to look at — but if the report never
  //                   comes (an element the page doesn't render has no classes
  //                   to report) the wrong ones would sit there for good.
  //
  // So: keep the old ones, and only fall back to empty if nothing has arrived
  // by the time the gap stops being a gap. In practice the report lands first
  // and the timer never fires.
  useEffect(() => {
    if (classesForRef.current === selectedId) {return undefined;}
    const t = setTimeout(() => setSelectedClasses((prev) => (prev.length ? [] : prev)), 600);
    return () => clearTimeout(t);
  }, [selectedId, classesTick]);

  const layoutNode = tree.node('layout');
  // The page may import its layout under any local name (e.g. `import Layout
  // from '../layouts/BaseLayout.astro'`) — resolve the wrapper back to a
  // scanned layout file name for display, pickers, and schema lookup.
  const currentLayoutName = (() => {
    // Markdown names its layout by path in frontmatter rather than wrapping
    // the page in a node, so the picker reads it from there.
    if (isMarkdownFormatRef.current) {
      // Read back out of the frontmatter text, not a cached field: editing
      // that text by hand has to move the picker too.
      const m = (model?.extraFrontmatter || '').match(/^[ \t]*layout[ \t]*:[ \t]*(.+?)[ \t]*$/m);
      const base = m?.[1]?.replace(/^['"]|['"]$/g, '')
        .split('/')
        .pop()
        ?.replace(/\.astro$/i, '');
      return base && scan.layouts.some((l) => l.name === base) ? base : '';
    }
    if (!layoutNode) {
      return '';
    }
    if (!model) {
      return '';
    }
    const imp = (model.imports || []).find((i) => i.name === layoutNode.name);
    const base = imp?.path
      .split('/')
      .pop()
      ?.replace(/\.astro$/i, '');
    if (base && scan.layouts.some((l) => l.name === base)) {
      return base;
    }
    return layoutNode.name ?? '';
  })();
  // A component whose Props extends HTMLAttributes<"tag"> also accepts that
  // element's built-in attributes — merge them in after its own props.
  const schemaFor = (
    entry: ScanComponent | AstroAsset | undefined | null
  ): readonly FieldDefinition[] => {
    if (!entry) {
      return [];
    }
    const own = entry.schema || [];
    const ownNames = new Set(own.map((f) => f.name));
    const extendsTag = 'extendsTag' in entry ? entry.extendsTag : undefined;
    const inherited = extendsTag
      ? getElementSchema(extendsTag).filter((f) => !ownNames.has(f.name))
      : [];
    // A component that spreads `...rest` passes class straight through to
    // whatever it renders, so styling one is a normal thing to want — give it
    // the same class field an element has rather than making the user add it
    // by hand in Attributes.
    const passesClass =
      entry.hasRest &&
      !own.some((f) => /^class(Name|es)?$/i.test(f.name)) &&
      !inherited.some((f) => f.name === 'class');
    return [
      ...own,
      ...(passesClass ? [{ name: 'class', type: 'string', optional: true }] : []),
      ...inherited,
    ];
  };
  // Every element takes a class, and it's the field people reach for most —
  // but it lives in the global attributes, not in any tag's own schema, so it
  // only appeared once something had already set one. Given first place, right
  // under the tag, on anything that renders an element.
  const withClassField = (fields: readonly FieldDefinition[]): readonly FieldDefinition[] =>
    fields.some((f) => f.name === 'class')
      ? fields
      : [{ name: 'class', type: 'string', optional: true }, ...fields];

  const selectedSchema: readonly FieldDefinition[] = (() => {
    if (!selectedNode) {
      return [];
    }
    if (selectedId === 'layout') {
      return schemaFor(scan.layouts.find((layout) => layout.name === currentLayoutName));
    }
    if (selectedNode.kind === 'element') {
      return withClassField(getElementSchema(selectedNode.name));
    }
    if (selectedNode.kind !== 'component') {
      return [];
    }
    if (selectedNode.dynamicTag) {
      return withClassField([]);
    }
    return schemaFor(
      selectedNode.astroAsset
        ? astroAssetDef(selectedNode.name)
        : insertables.find((component) => component.name === selectedNode.name)
    );
  })();

  // Slots offered by the selected node's parent (the component or layout the
  // node is slotted into) — turns the `slot` attribute into a dropdown.
  let slotOptions: readonly string[] | null = null;
  if (model && selectedNode && selectedId !== 'layout') {
    const parent = selectedId ? tree.parent(selectedId) : null;
    if (parent) {
      if (parent.id === 'layout') {
        slotOptions = scan.layouts.find((l) => l.name === currentLayoutName)?.slots || null;
      } else if (parent.kind === 'component') {
        slotOptions = insertables.find((c) => c.name === parent.name)?.slots || null;
      }
    }
  }

  // In-scope data at the selection: the file's frontmatter declarations and
  // imports, plus the item/index variables of every enclosing loop. Feeds the
  // loop editor's source list and the content editor's expression chips.
  const loopContext =
    model && selectedNode
      ? {
          frontmatter: model.extraFrontmatter || '',
          imports: model.imports || [],
          ancestorHeads: selectedAncestors
            .slice(0, -1)
            .filter((n) => n.kind === 'map')
            .map((n) => n.head),
        }
      : null;

  // What the instance being edited is given.
  //
  // A component opened from the canvas is being looked at in one place, with
  // one set of props — and the panel knew them only by name and type, so a
  // field showing `{heading}` could not say what heading was. The instance
  // says: it is in the file this one was opened from, at the focused path, and
  // the page's own scope is what its expressions come to.
  const [instanceProps, setInstanceProps] = useState<Readonly<Record<string, unknown>> | null>(
    null
  );
  const focusOf = currentPage?.kind === 'component' ? currentPage.focusPath : null;
  const hostFile = editStack.length > 1 ? editStack[0] : null;
  useEffect(() => {
    if (!focusOf || !hostFile?.path) {
      setInstanceProps(null);
      return undefined;
    }
    let dropped = false;
    void (async () => {
      try {
        const read = toEditorPageState(await readPage(hostFile.path));
        if (dropped || !read.editable) {
          return;
        }
        const hostModel = read.model;
        const trail = (String(focusOf).split('|').pop() ?? '').split('.').map(Number);
        const instance = nodeAtPath(hostModel.nodes, trail);
        if (!instance) {
          setInstanceProps(null);
          return;
        }
        // The scope at the instance: the file's frontmatter, and the loops
        // around it — `project` inside `projects.map(…)` is what its props are
        // written against.
        const chain = ancestorChain(hostModel.nodes, instance.id) || [];
        setInstanceProps(
          resolveInstanceProps(instance, {
            frontmatter: hostModel.extraFrontmatter || '',
            imports: hostModel.imports || [],
            ancestorHeads: chain
              .slice(0, -1)
              .filter((n) => n.kind === 'map')
              .map((n) => n.head),
            collectionSamples,
            collections,
          })
        );
      } catch {
        if (!dropped) {
          setInstanceProps(null);
        }
      }
    })();
    return () => {
      dropped = true;
    };
  }, [focusOf, hostFile?.path, collectionSamples, collections, scan]);

  // Link settings (href fields): pages to link to and the ids on this page
  // that anchor links can target.
  const linkContext = useMemo(
    () => ({
      pages: scan.pages,
      sectionIds: tree.sectionIds,
      projectPath: project?.path ?? '',
    }),
    [scan.pages, tree, project?.path]
  );

  // A class the source can't resolve — `class:list={["button_wrap", …]}` —
  // leaves a node named after its tag, or after a variable in the case of a
  // dynamic `<Tag>`. The page reports what each node rendered with, so the
  // breadcrumb and the canvas chip can say the same thing the navigator does.
  const liveLabel = (n: EditorNode, fromSource: string): string => {
    if (fromSource && fromSource !== n.name) {
      return fromSource;
    }
    const live = liveClassesById?.get(n.id);
    return live?.[0] ?? fromSource;
  };

  // What the Tag field offers: every HTML tag, the project's components,
  // Astro's own, and anything this page's frontmatter already imports — which
  // is how `<AstroLogo />` from an imported .svg becomes reachable.
  // Each option carries what it is, so the list can wear the same icons the
  // insert palette does — a tag, a component, a layout, one of Astro's.
  const tagOptions = React.useMemo<readonly TagOption[]>(() => {
    const out: TagOption[] = [];
    const seen = new Set<string>();
    const add = (name: string, kind: string): void => {
      if (!name || seen.has(name)) {
        return;
      }
      seen.add(name);
      out.push({ name, kind });
    };
    for (const t of HTML_TAGS) {
      add(t, 'element');
    }
    for (const c of insertables) {
      add(c.name, c.isLayout ? 'layout' : 'component');
    }
    for (const a of ASTRO_ASSETS) {
      add(a.name, 'astroAsset');
    }
    for (const i of model?.imports || []) {
      add(i.name, 'component');
    }
    return out;
  }, [insertables, model]);

  // Breadcrumb trail for the canvas toolbar: page → ancestors → selection.
  const crumbLabel = (n: EditorNode): string => {
    if (n.id === 'layout') {
      return currentLayoutName || n.name || 'layout';
    }
    switch (n.kind) {
      case 'text':
        return 'text';
      case 'comment':
        return 'comment';
      case 'expr':
        return 'code';
      case 'map': {
        const at = n.head.indexOf('.map');
        return at > 0 ? n.head.slice(0, at + 4) : 'loop';
      }
      case 'cond':
        return `if ${n.test}`;
      case 'branch':
        return n.name === 'else' ? 'else' : 'then';
      case 'element':
      case 'raw':
        // First class wins; fall back to the bare tag when the element has
        // none. Reads `class:list` too, so a component's inner elements are
        // named the same way the navigator names them.
        return liveLabel(n, elementLabel(n));
      case 'component':
      case 'raw-line':
      case 'chunk-group':
        // `<Tag>` from `const Tag = tag` renders a real element and its name
        // is a variable, so the class it rendered with names it better.
        if (n.dynamicTag) {
          return liveLabel(n, elementLabel(n));
        }
        return n.name || n.kind;
    }
  };
  // Floating code window target value: page frontmatter, a raw node's inner
  // content, or a text file from public/ (loaded into fileText).
  const isFileWin = codeWin?.kind === 'file';
  const codeWinNode =
    codeWin && !isFileWin && codeWin.targetId && codeWin.targetId !== 'frontmatter' && model
      ? tree.node(codeWin.targetId)
      : null;
  const codeWinValue = !codeWin
    ? null
    : isFileWin
    ? fileText
    : codeWin.targetId === 'frontmatter'
    ? model
      ? frontmatterCode
      : null
    : codeWinNode?.kind === 'raw'
    ? codeWinNode.inner
    : null;

  // Returns whether the subject actually has a code editor, so the Enter
  // shortcut below knows whether it handled the key.
  const openCodeWindowFor = (subject: CodeSubject | null): boolean => {
    const codeWindow = subject === null ? undefined : codeWindowFor(subject);
    if (codeWindow === undefined) {
      return false;
    }
    setCodeWin(codeWindow);
    return true;
  };
  const openCodeWindow = (): boolean => openCodeWindowFor(selectedNode);
  // A navigator double-click names its row instead of reading `selectedNode`
  // (see `openCode` in StructureTree). An id the tree no longer holds, a row
  // removed between the click and the render, opens nothing.
  const openCodeWindowById = (id: string): void => {
    openCodeWindowFor(id === 'frontmatter' ? FRONTMATTER_SUBJECT : tree.node(id));
  };
  // Read by the keydown effect, which is set up long before this exists.
  openCodeWindowRef.current = openCodeWindow;

  // Opens a public/ text file in the floating editor.
  const openAssetFile = useCallback(
    async ({ rel, name }: { readonly rel: string; readonly name: string }) => {
      const projectPath = projectRef.current?.path;
      if (!projectPath) {
        return;
      }
      try {
        const text = await readProjectAsset(projectPath, rel);
        setFileText(text);
        setCodeWin({
          kind: 'file',
          rel,
          title: name,
          language: /\.css$/i.test(name) ? 'css' : 'javascript',
        });
      } catch (err) {
        showToast(cleanError(err), 'error');
      }
    },
    [showToast]
  );

  // Opens the file an imported symbol is defined in, on its declaration —
  // `{FOOTER_LINKS}` on the page, the array itself in src/consts.ts. Values
  // declared in this file's own frontmatter never come here: those are edited
  // in place, in the panel (see the props panel's source popup).
  const openSymbolFile = useCallback(
    async (name: string) => {
      const projectPath = projectRef.current?.path;
      if (!projectPath) {
        return false;
      }
      const imp = findImportOf(frontmatterCode, name);
      if (!imp) {
        return false;
      }
      const stack = editStackRef.current;
      const fromFile = stack[stack.length - 1]?.path || currentPage?.path;
      if (!fromFile) {
        return false;
      }
      try {
        const r = await readSymbol(projectPath, fromFile, imp.spec, name);
        if (!r?.ok) {
          showToast(
            r?.reason === 'too-large'
              ? 'That file is too large to edit in the app.'
              : `Couldn't find where ${name} is defined (${imp.spec}).`,
            'error'
          );
          return false;
        }
        setFileText(r.text);
        setCodeWin({
          kind: 'file',
          area: 'src',
          rel: r.rel,
          title: r.rel,
          language: /\.css$/i.test(r.rel) ? 'css' : 'javascript',
          revealLine: r.line,
        });
        return true;
      } catch (err) {
        showToast(cleanError(err), 'error');
        return false;
      }
    },
    [frontmatterCode, currentPage, showToast]
  );

  // File edits stream to disk (debounced) — the dev server picks them up.
  const setAssetFileText = useCallback(
    (text: string) => {
      setFileText(text);
      if (!codeWin || codeWin.kind !== 'file') {
        return;
      }
      const { rel, area } = codeWin;
      if (!rel) {
        return;
      }
      // Source files live anywhere in the project; assets are rooted in public/.
      const projectPath = projectRef.current?.path;
      const saver = fileSaverRef.current;
      if (!projectPath || !saver) {
        return;
      }
      saver.schedule(`${projectPath}|${area || 'public'}|${rel}`, () =>
        writeProjectFile(area ?? 'public', projectPath, rel, text)
      );
    },
    [codeWin]
  );

  // Close the window if its target disappears (page switch, node deleted).
  useEffect(() => {
    if (codeWin && !isFileWin && codeWinValue === null) {
      setCodeWin(null);
    }
  }, [codeWin, isFileWin, codeWinValue]);

  const editedRel =
    editStack.length > 1 && project?.path
      ? projectRelativePath(
          project.path,
          editStack[editStack.length - 1]?.path ?? '',
          window.avb.platform
        )
      : null;

  // The reported classes, keyed by node id — same walk as the render report,
  // so a path only has to be resolved once.
  const liveClassesById = React.useMemo(
    () =>
      nodeClasses && model
        ? classesByNodeId(nodeClasses, model.nodes, editedRel ? `${editedRel}|` : '')
        : null,
    [nodeClasses, model, editedRel]
  );

  // The file being edited, relative to src/ — how the CMS addresses a page's
  // own data (`pages/index.astro#rotatingWords`).
  const openEditableFile =
    editStack[editStack.length - 1] ?? (currentPage?.kind === 'route' ? undefined : currentPage);
  const openFileSrcRel = (() => {
    const p = openEditableFile?.path;
    if (!p || !project?.path) {
      return null;
    }
    const rel = projectRelativePath(project.path, p, window.avb.platform);
    return rel.startsWith('src/') ? rel.slice(4) : rel;
  })();

  // A marker path may arrive namespaced (src/…/Card.astro|0.1). The index trail
  // after the pipe is what addresses a node in the open file's tree.
  const trailOf = (path: string): number[] => (path.split('|').pop() ?? '').split('.').map(Number);
  // An edit renumbers paths, so a report from before it describes nodes that
  // have since moved. Drop it and show nothing until the page has re-rendered
  // and said so again — a marker on the wrong row is worse than none.
  useEffect(() => {
    setRenderedPaths(null);
    setNodeStates(null);
    setNodeClasses(null);
  }, [model]);

  // What the spacing box is pointing at, drawn over the selected element on the
  // canvas — see spacingBands.js.
  const [spacingHover, setSpacingHover] = useState<SpacingHover | null>(null);

  const crumbs: PreviewCrumb[] = [];
  if (currentPage) {
    crumbs.push({
      id: null,
      label: currentPage.name.replace(/\.(astro|md)$/i, ''),
    });
  }
  if (model && selectedId === 'frontmatter') {
    crumbs.push({ id: 'frontmatter', label: 'Frontmatter' });
  } else if (model && selectedId) {
    const chain = selectedAncestors;
    // A then has no row in the navigator, so the trail doesn't name it either —
    // "if command › then › hero-command" said "then" to no one (see
    // branches.js).
    crumbs.push(
      ...chain
        .filter((n, i) => n !== thenBranch(chain[i - 1]))
        .map((n) => ({ id: n.id, label: crumbLabel(n) }))
    );
  }

  // Canvas outlines: nodes are addressed by their index path in the tree
  // (matching the marker paths the dev server's plugin injects).
  // While a component is open the tree is that component's file, not the
  // page, so ask in that file's namespace — the plugin marks every .astro
  // under src with one. The canvas still shows the page, where those markers
  // appear once per instance, so every instance outlines.
  // Which nodes put nothing on the page, as ids. A node counts as rendering if
  // it rendered something itself OR anything under it did: a layout wraps
  // <html>, so its own markers are split across <head> and <body> and never
  // pair up, but its children measure fine — without the ancestor closure it
  // would read as empty. Everything left over really did produce nothing,
  // including nodes inside a component that never evaluated its slot, whose
  // markers were never emitted at all.
  const emptyNodeIds = React.useMemo(() => {
    if (!renderedPaths || !model) {
      return null;
    }
    const prefix = editedRel ? `${editedRel}|` : '';
    const live = new Set<string>();
    for (const p of renderedPaths) {
      const local = prefix && p.startsWith(prefix) ? p.slice(prefix.length) : p;
      const parts = local.split('.');
      for (let i = parts.length; i > 0; i--) {
        live.add(parts.slice(0, i).join('.'));
      }
    }
    // Only kinds where "renders nothing" is a fact about the page. A comment,
    // the frontmatter row or a doctype line never renders and saying so on
    // every one of them would be noise.
    const MARKABLE = new Set(['element', 'component', 'map']);
    // …and neither <Fragment> nor <slot> ever puts an element on the page, so
    // there is nothing for the page to report about them and nothing to carry
    // their path. What they hold answers for them: children of either are
    // marked, and a live child makes its ancestors live. `<Fragment set:html>`
    // has no children to speak up, which is exactly the case where the panel
    // cannot tell — and saying "renders nothing" is the wrong half to guess.
    const answers = (node: EditorNode): boolean =>
      MARKABLE.has(node.kind) && rendersOwnElement(node);
    const ids = new Set<string>();
    // An inline run — words with <a>, <strong>, <span> among them — is written
    // as one line, and markers inside it would render as spaces, so nothing in
    // there carries one. The page therefore says nothing about those nodes,
    // which is not the same as saying they rendered nothing: `unmarked` keeps
    // a link sitting in a sentence from being reported as invisible.
    const walk = (
      list: readonly EditorNode[],
      trail: readonly number[],
      unmarked: boolean
    ): void => {
      list.forEach((n, i) => {
        const t = [...trail, i];
        if (!unmarked && answers(n) && !live.has(t.join('.'))) {
          ids.add(n.id);
        }
        if (Array.isArray(n.children)) {
          walk(n.children, t, unmarked || isInlineRun(n.children));
        }
      });
    };
    walk(model.nodes, [], false);
    return ids;
  }, [renderedPaths, model, editedRel]);

  // The reported paths as node ids, so the navigator can mark rows without
  // knowing anything about index paths.
  const stateIds = React.useMemo(() => {
    const empty = { hidden: new Set<string>(), inert: new Set<string>() };
    if (!nodeStates || !model) {
      return empty;
    }
    const prefix = editedRel ? `${editedRel}|` : '';
    const local = (path: string): string =>
      prefix && path.startsWith(prefix) ? path.slice(prefix.length) : path;
    const ids = (paths: readonly string[]): ReadonlySet<string> => {
      const set = new Set<string>();
      for (const p of paths || []) {
        const id = tree.byPath.get(local(p))?.id;
        if (id) {
          set.add(id);
        }
      }
      return set;
    };
    return { hidden: ids(nodeStates.hidden), inert: ids(nodeStates.inert) };
  }, [nodeStates, model, editedRel, tree]);

  const pathFor = (id: string | null): string | null => {
    if (!model || !id) {
      return null;
    }
    const path = tree.path(id);
    if (path === null) {
      return null;
    }
    return editedRel ? `${editedRel}|${path}` : path;
  };
  // The right panel stays on whichever tab the user picked, whatever gets
  // selected next. (S / D switch it by hand.)

  // What ⇧⌘C copies: the route an editor would take to reach the selection —
  // the page, the instance of each component drilled into on the way down,
  // then the node itself — so an agent reading it lands on the markup the user
  // is looking at, not on some other use of the same component. With nothing
  // selected the open file alone still says where the user is.
  //
  // Deliberately "<file>#<index path>" rather than a marker path: a marker is
  // namespaced only when it names a component, and every entry here needs to
  // say which file it belongs to. The file is the one open at that level of the
  // stack, so it's read from the stack rather than parsed out of the key.
  // Through a ref because the menu handler is bound long before this is in scope.
  const relOf = (abs: string | undefined): string | null =>
    abs && project?.path ? projectRelativePath(project.path, abs, window.avb.platform) : null;
  const openRel = relOf(currentPage?.path);
  const leafPath = selectedId ? tree.path(selectedId) : null;
  selectionKeysRef.current = !openRel
    ? []
    : [
        ...editStack
          .slice(1)
          .map((entry, i) => {
            const host = relOf(editStack[i]?.path);
            return entry.hostKey && host ? `${host}#${trailOf(entry.hostKey).join('.')}` : null;
          })
          .filter((key): key is string => key !== null),
        selectedId === 'frontmatter'
          ? `${openRel}#frontmatter`
          : leafPath !== null
          ? `${openRel}#${leafPath}`
          : `${openRel}#`,
      ];

  // Position the Style/Settings highlight: on tab change, when the panel first
  // appears, and whenever the tab strip's width changes.
  useLayoutEffect(() => {
    const measure = () => {
      const el = rightTabRefs.current[rightTab];
      setRightTabInd(el ? { left: el.offsetLeft, width: el.offsetWidth } : null);
    };
    measure();
    const strip = rightTabRefs.current[rightTab]?.parentElement;
    if (!strip || typeof ResizeObserver === 'undefined') {
      return;
    }
    const ro = new ResizeObserver(measure);
    ro.observe(strip);
    return () => ro.disconnect();
  }, [rightTab, pageState?.editable]);

  const overlayInfo = (p: string): OverlayInfo | null => {
    if (!model || !p) {
      return null;
    }
    const n = nodeAtPath(model.nodes, trailOf(p));
    if (!n) {
      return null;
    }
    const label = n.id === 'layout' ? currentLayoutName || n.name || 'layout' : crumbLabel(n);
    // Fragments group inline content rather than referring to another component.
    // Their outlines use ordinary element styling, as dynamic tags already do.
    const kind = isFragmentNode(n)
      ? 'element'
      : n.kind === 'component' && !n.dynamicTag
      ? 'component'
      : n.kind === 'map' || n.kind === 'cond' || n.kind === 'branch'
      ? 'map'
      : 'element';
    // The tag drives the overlay's icon, so it matches the Navigator row.
    const tag = n.kind === 'element' || n.kind === 'raw' ? n.name : null;
    return {
      label,
      kind,
      tag,
      astroAsset: !!n.astroAsset,
      dynamicTag: !!n.dynamicTag,
      nodeKind: n.kind,
      isLayout: n.id === 'layout',
      bound: kind === 'element' && isDataBound(n),
    };
  };

  // ----------------------------------------------------------------
  // Render
  // ----------------------------------------------------------------

  if (!project) {
    // welcome-mode floats the title bar over the start screen so the
    // interactive backdrop runs edge to edge, behind the window controls.
    return (
      <div className="app welcome-mode">
        <div className="titlebar">
          <span className="spacer" />
        </div>
        <WelcomeScreen onOpen={loadProject} showToast={showToast} />
        {busy && <BusyOverlay message={busy} />}
        {toast && <Toast toast={toast} />}
        <ConfirmHost />
      </div>
    );
  }

  // The canvas always renders the page — editing a component just dims
  // everything outside the instance being worked on.
  const pageEntry = editStack[0] || currentPage;
  const patternRoute = pageEntry?.route;
  const focusPath = currentPage?.kind === 'component' ? currentPage.focusPath ?? null : null;
  const focusOcc = currentPage?.kind === 'component' ? currentPage.focusOcc ?? 0 : 0;
  // The focus routes clicks either way; this says whether it also draws.
  const focusWhole = currentPage?.kind === 'component' && !!currentPage.focusWhole;
  // A dynamic page's route is a pattern, not a URL — /posts/[slug] is a 404.
  // Preview one of the entries it actually stands for; `dynamicEntry` is which.
  const dynamicEntry = dynamicPaths[dynamicIndex] || null;

  // What the binding picker shows: the names in scope, plus the DATA behind
  // them wherever the app can see it. Two sources, and between them a designer
  // gets real values rather than a list of identifiers:
  //   the entry on the canvas — getStaticPaths' props ARE Astro.props for a
  //     dynamic route, so `post.data.title` shows this post's actual title
  //   this file's own `interface Props` — no values, but every prop still says
  //     what it is, which is all a component outside a page can offer
  const editedEntry = insertables.find((c) => c.path === currentPage?.path) || null;
  const bindContext = loopContext && {
    ...loopContext,
    // Which item of a loop's list the picker reads the item's values as. A loop
    // hands `service` one entry of `times`, and the picker showed the first one
    // forever — so the fields under it were one service's, and the others could
    // only be taken on trust. Keyed by the item's own name, so two loops on a
    // page are two places.
    itemIndex,
    onStepItem: (name: string, dir: number, count: number) =>
      setItemIndex((cur) => ({
        ...cur,
        [name]: (((cur[name] ?? 0) + dir) % count + count) % count,
      })),
    // A component's frontmatter is not the page's, so the page's entry is not
    // its data. What it does have is the instance it was opened from, whose
    // props are its Astro.props — the values it is rendering with right now.
    propsSample: currentPage?.kind === 'component' ? instanceProps : dynamicEntry?.props || null,
    propsSchema: schemaFor(editedEntry),
    collectionSamples,
    collections,
    // Opening a collection in the picker asks for one entry of it; nothing is
    // fetched for collections nobody looks at.
    onNeedSample: requestCollectionSample,
    // Picking from a collection this page doesn't read yet writes the query
    // that fetches it, and answers with the name it ended up under.
    ensureQuery: ensureCollectionQuery,
    // Stepping through a dynamic route's entries from inside the picker. It is
    // the SAME index the canvas renders against, so moving it previews the page
    // against other content and re-reads the sample values at once — which is
    // the point: you are checking a layout against real data, not one post.
    entryNav:
      dynamicPaths.length > 1
        ? {
            index: dynamicIndex,
            count: dynamicPaths.length,
            label: dynamicEntry?.label || '',
            onStep: (dir: number) =>
              setDynamicIndex((i) => (i + dir + dynamicPaths.length) % dynamicPaths.length),
          }
        : null,
  };
  // With no page selected and none to select — a project whose routes all come
  // from an integration, before one is picked — the dev server is still serving
  // a site. Show its root rather than an empty canvas: something running should
  // look like it is running.
  const rootFallback = !patternRoute && !scan.pages.length && devStatus === 'on' ? '/' : null;
  const pageRoute = dynamicEntry ? dynamicEntry.route : patternRoute || rootFallback;
  const pageUrlPath = pageRoute ? routeToPath(pageRoute, trailingSlash) : null;
  livePathRef.current = pageUrlPath;
  const liveUrl = devUrl && pageUrlPath ? devUrl + pageUrlPath : null;
  // The old version is served by its own dev server, on the same route the
  // editor is on, so switching in and out is a like-for-like comparison.
  const oldVersionUrl = previewInfo && pageUrlPath ? previewInfo.url + pageUrlPath : null;
  const currentScanPage =
    currentPage?.path === undefined
      ? null
      : scan.pages.find((page) => page.path === currentPage.path) ?? null;
  const repository = gitInfo?.isRepo ? gitInfo : null;

  return (
    <div className="app">
      {propertySave.phase === 'saving' && (
        <div className="property-saving-overlay" role="status">
          Saving component properties…
        </div>
      )}
      <div className="titlebar">
        <button
          className="app-title project-back"
          title="Back to all projects"
          aria-label="Back to all projects"
          disabled={propertySave.phase === 'saving'}
          onClick={() => {
            void leaveProject(null).catch((error: unknown) => {
              showToast(`Could not return to projects: ${cleanError(error)}`, 'error');
            });
          }}
        >
          <ChevronLeftIcon size={13} />
          <span>{project.name}</span>
        </button>
        <span className="spacer" />
        {editStack.length > 1 ? (
          <button className="page-switch-btn comp-back" title="Back (Esc)" onClick={closeComponent}>
            <ChevronLeftIcon size={13} />
            <span className="comp-back-sep" />
            <ElementComponentIcon size={13} />
            <span className="page-switch-label">{currentPage?.name}</span>
          </button>
        ) : (
          <PageSwitcher pages={scan.pages} currentPage={currentScanPage} onSelect={selectPage} />
        )}
        <div className="url-group">
          <span
            className={`status-dot ${
              devStatus === 'on' ? 'on' : devStatus === 'starting' ? 'starting' : 'off'
            }`}
            title={`Dev server: ${devStatus}`}
          />
          <button
            className="ghost"
            title="Reload preview"
            disabled={!liveUrl}
            onClick={() => setRefreshKey((k) => k + 1)}
          >
            <RefreshIcon size={13} />
          </button>
          {/* A real input, not a label: the URL is something you copy out and
              something you type a route into. Focus selects it all, so one
              click and ⌘C gets the whole thing. */}
          <input
            className="url"
            spellCheck={false}
            value={urlDraft ?? liveUrl ?? ''}
            placeholder={
              devStatus === 'starting' ? 'Starting Astro dev server…' : 'Preview offline'
            }
            readOnly={!liveUrl}
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => setUrlDraft(e.target.value)}
            onBlur={() => setUrlDraft(null)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setUrlDraft(null);
                e.currentTarget.blur();
                return;
              }
              if (e.key !== 'Enter') {
                return;
              }
              e.currentTarget.blur();
              goToUrl(e.currentTarget.value);
            }}
          />
          {/* Which entry of a dynamic route the canvas is showing. The template
              is what gets edited either way — this only changes the data it's
              rendered against. */}
          {patternRoute?.includes('[') && (
            <DynamicPicker
              entries={dynamicPaths}
              index={dynamicIndex}
              onPick={setDynamicIndex}
              error={dynamicError}
              pattern={patternRoute}
            />
          )}
        </div>
        <span className="spacer" />
        {/* Both ways of viewing the site, kept together. */}
        <div className="titlebar-actions">
          <button
            className={`titlebar-btn ${termOpen ? 'on' : ''}`}
            title={`${termOpen ? 'Hide' : 'Show'} terminal (${shortcutLabel(
              'J',
              'primary',
              currentDesktopPlatform()
            )})`}
            onClick={() => setTermOpen((v) => !v)}
          >
            <TerminalIcon size={14} />
          </button>
          <button
            className="titlebar-btn"
            title="Open in browser"
            disabled={!liveUrl}
            onClick={() => {
              if (liveUrl) {
                void openExternalURL(liveUrl);
              }
            }}
          >
            <ExternalIcon size={14} />
          </button>
          {/* Two things put the canvas into a state you are looking at rather
              than working in — the interactive preview, and an older version —
              and this button is where both of them end. Lit for either, so it
              is never on while the only button that turns it off looks idle. */}
          <button
            className={`titlebar-btn preview-btn ${inPreview || previewRef ? 'on' : ''}`}
            title={
              previewRef
                ? 'Back to now (Esc)'
                : inPreview
                ? 'Exit preview (Esc)'
                : 'Preview the site'
            }
            disabled={!devUrl}
            onClick={() =>
              previewRef ? exitCommitPreview() : inPreview ? exitPreview() : enterPreview()
            }
          >
            <PreviewIcon size={15} />
          </button>
        </div>
        <GitChip
          project={project}
          showToast={showToast}
          flushSave={flushSave}
          onWorktreeChanged={reloadFromDisk}
        />
      </div>

      <div className="main">
        <LeftRail
          active={leftTab}
          componentOpen={componentPropertiesOpen}
          onSelect={(id) => setLeftTab((t) => (t === id ? null : id))}
        />

        {leftTab && (
          <div className={`panel left ${leftTab === 'code' ? 'code-panel-shell' : ''}`}>
            {leftTab === 'properties' && currentPage?.kind === 'component' && (
              <ComponentPropertiesPanel
                key={currentPage.path}
                projectPath={project.path}
                file={currentPage.path}
                name={currentPage.name}
                flushSave={flushSave}
                onSavePhase={propertySave.changePhase}
                onSaved={completePropertySave}
              />
            )}
            {leftTab === 'pages' && (
              <PagesPanel
                scan={scan}
                currentPage={currentScanPage}
                injectedRoutes={injectedRoutes}
                onSelectRoute={selectRoute}
                onSelect={selectPage}
                onCreate={createPage}
                onDelete={deletePage}
                onRescan={() => rescan(project.path)}
                onMovePage={movePageTo}
                onCreateFolder={createPageFolder}
                onRenameFolder={renamePageFolder}
                onDeleteFolder={deletePageFolder}
              />
            )}
            {leftTab === 'navigator' && (
              <StructurePanel
                pageState={pageState}
                currentPage={
                  currentPage?.kind === 'route'
                    ? { kind: 'route', route: currentPage.route }
                    : currentPage
                }
                layouts={scan.layouts}
                currentLayoutName={currentLayoutName}
                selectedId={selectedId}
                emptyNodeIds={emptyNodeIds ?? new Set<string>()}
                hiddenNodeIds={stateIds.hidden}
                inertNodeIds={stateIds.inert}
                liveClassesById={liveClassesById ?? new Map<string, readonly string[]>()}
                revealTick={revealTick}
                onSelect={setSelectedId}
                onHoverNode={setHoverNodeId}
                onOpenComponent={(name, id) => openComponent(name, pathFor(id))}
                onOpenCode={openCodeWindowById}
                onChangeLayout={changeLayout}
                onDropComponent={addComponent}
                onMoveNode={moveNode}
                onRemoveNode={removeNode}
                onCopyNode={copyNode}
                onDuplicateNode={duplicateNode}
                onPasteNode={pasteNode}
                hasClipboard={() => !!nodeClipboardRef.current}
                onRawChange={setRawSource}
              />
            )}
            {leftTab === 'components' && (
              <PalettePanel
                components={insertables}
                devUrl={devUrl}
                trailingSlash={trailingSlash}
                onInsert={(name) => addComponent(name, null)}
                onDragBegin={() => setLeftTab('navigator')}
                createFrom={createFrom}
                createRequest={createRequest}
                onCreateComponent={createComponentFromSelection}
                onUsage={componentUsage}
                pageInstances={pageInstancesOf}
                onSelectInstance={(id) => {
                  setLeftTab('navigator');
                  setSelectedId(id);
                }}
                onOpenUsage={(entry) => {
                  // A page is opened as a page; a component or layout is drilled
                  // into, the same as opening one from the canvas.
                  const page = scan.pages.find((p) => p.path === entry.path);
                  if (page) {
                    void selectPage(page);
                    return;
                  }
                  const name = entry.rel
                    .split('/')
                    .pop()
                    ?.replace(/\.astro$/, '');
                  if (name) {
                    void openComponent(name, null, 0, entry.path);
                  }
                }}
              />
            )}
            {leftTab === 'cms' && (
              <CmsPanel
                project={project}
                selectedRel={cmsRel}
                selectedContent={contentName}
                onSelectContent={(name) => {
                  setContentName(name);
                  if (name) {
                    setCmsRel(null);
                    setCmsSettings(false);
                  }
                }}
                currentFile={openFileSrcRel}
                refreshKey={cmsTick}
                onSelect={(r) => {
                  setCmsRel(r);
                  setCmsSettings(false);
                  if (r) {
                    setContentName(null);
                  }
                  // Closing a collection leaves nothing selected anywhere, so
                  // the right-hand panels show their empty state rather than
                  // the node that happened to be picked before.
                  if (!r) {
                    setSelectedId(null);
                  }
                }}
                onOpenSettings={(r) => {
                  setCmsRel(r);
                  setCmsSettings(true);
                }}
                showToast={showToast}
              />
            )}
            {leftTab === 'variables' && (
              <VariablesPanel project={project} selected={varsGroup} onSelect={setVarsGroup} />
            )}
            {leftTab === 'code' && currentPage && currentPage.kind !== 'route' && pageState && (
              <CodePanel
                source={pageState.source}
                relativePath={openRel ?? currentPage.name}
                model={model}
                selectedId={selectedId}
                onChange={(source, position) => {
                  void changeCodeSource(source, position);
                }}
                onSelect={setSelectedId}
                onOpenComponent={(name, id) => {
                  void openComponent(name, pathFor(id));
                }}
              />
            )}
            {leftTab === 'history' && (
              <HistoryPanel
                project={project}
                gitInfo={gitInfo}
                previewRef={previewRef}
                onOpenFile={(f) => {
                  // A page opens in the editor. Anything else has no canvas to
                  // show it on, so the row says where it is and does nothing —
                  // better than opening an empty editor onto a stylesheet.
                  const page = scan.pages.find((p) => p.path.endsWith(f.path));
                  if (page) {
                    selectPage(page);
                  } else {
                    showToast(`${f.path} isn’t a page — nothing to open on the canvas.`, 'info');
                  }
                }}
                onPreviewCommit={previewCommit}
                onExitPreview={exitCommitPreview}
                onRestoreFile={async (commit, file) => {
                  if (
                    !(await confirmDialog({
                      title: `Put ${file.label} back?`,
                      body: `It goes back to how it was in “${commit.subject}”, and lands as an unsaved change — so you can look at it and undo it like any other edit.`,
                      confirmLabel: 'Put it back',
                    }))
                  ) {
                    return;
                  }
                  try {
                    if (!commit.hash) {
                      throw new Error('History commit has no hash');
                    }
                    const r = await restoreProjectFile(project.path, commit.hash, file.path);
                    if (r.missing) {
                      showToast(r.message ?? 'That version no longer contains the file.', 'error');
                      return;
                    }
                    await refreshGit();
                    await reloadFromDisk();
                    showToast(`${file.label} is back to how it was`, 'success');
                  } catch (err) {
                    showToast(cleanError(err), 'error');
                  }
                }}
                onRestoreProject={async (commit) => {
                  if (
                    !(await confirmDialog({
                      title: `Take everything back to “${commit.subject}”?`,
                      body:
                        'Anything you haven’t saved is put aside first, so nothing is lost. Your saved ' +
                        'history stays exactly as it is — this lands as a set of unsaved changes you can ' +
                        'look over, keep, or undo.',
                      confirmLabel: 'Take it back',
                    }))
                  ) {
                    return;
                  }
                  setBusy('Going back…');
                  try {
                    if (!commit.hash) {
                      throw new Error('History commit has no hash');
                    }
                    const r = await restoreProjectVersion(project.path, commit.hash);
                    await refreshGit();
                    await reloadFromDisk();
                    showToast(
                      r?.parked
                        ? 'The project is back — your unsaved work is waiting on this branch'
                        : 'The project is back to how it was',
                      'success'
                    );
                  } catch (err) {
                    showToast(cleanError(err), 'error');
                  } finally {
                    setBusy(null);
                  }
                }}
                onSwitchBranch={async (b) => {
                  // Same as the chip: try it, and only say something if git
                  // could not carry the work across. Parking is what the chip's
                  // dialog offers after that, not a thing done pre-emptively.
                  try {
                    const result = await checkoutGitBranch(project.path, b, {
                      kind: 'switch',
                    });
                    if (!result.ok) {
                      throw new Error(result.error);
                    }
                    const r = result.value;
                    if (!r.ok) {
                      showToast(
                        `${
                          repository?.branch ?? 'This branch'
                        } and ${b} have different versions of ` +
                          `${
                            r.files[0] || 'a file'
                          } you have unsaved work in — switch from the branch button to decide what to do with it.`,
                        'error'
                      );
                      return;
                    }
                    await refreshGit();
                    await reloadFromDisk();
                    showToast(
                      r.restored ? `Picked your changes back up on ${b}` : `Switched to ${b}`,
                      'success'
                    );
                  } catch (err) {
                    showToast(cleanError(err), 'error');
                  }
                }}
                onMergeBranch={(b) =>
                  mergeBranchAction({
                    projectPath: project.path,
                    branch: b,
                    into: repository?.branch ?? '',
                    ...(repository?.trunk === undefined ? {} : { trunk: repository.trunk }),
                    run: (fn) =>
                      fn()
                        .then(async () => {
                          await refreshGit();
                          await reloadFromDisk();
                        })
                        .catch((err) => showToast(cleanError(err), 'error')),
                    showToast,
                    // Both branches changed the same files. The chooser lives
                    // on the branch chip, so this points there rather than
                    // being a second, different answer to the same question.
                    onConflict: (r) =>
                      showToast(
                        `${r.from} and ${r.branch} both changed ` +
                          `${
                            r.files.length === 1
                              ? r.files[0]?.path ?? 'a file'
                              : `${r.files.length} files`
                          }. ` +
                          'Open the branch button to choose which versions to keep.',
                        'info'
                      ),
                  })
                }
                onDeleteBranch={(b) =>
                  deleteBranchAction({
                    projectPath: project.path,
                    branch: b,
                    parked: (repository?.parked || []).includes(b),
                    run: (fn) =>
                      fn()
                        .then(refreshGit)
                        .catch((err) => showToast(cleanError(err), 'error')),
                    showToast,
                  })
                }
              />
            )}
            {leftTab === 'assets' && (
              <AssetsPanel
                project={project}
                showToast={showToast}
                onOpenFile={openAssetFile}
                pick={assetPick}
                onPickCancel={() => endAssetPick(false)}
                onRecordUndo={pushCommand}
              />
            )}
          </div>
        )}

        <div className="center">
          <PreviewPane
            spacingHover={spacingHover}
            devUrl={devUrl}
            devStatus={devStatus}
            devLog={devLog}
            devDiag={devDiag}
            route={pageUrlPath}
            refreshKey={refreshKey}
            crumbs={crumbs}
            onCrumb={(id) => setSelectedId(id)}
            onRefresh={() => setRefreshKey((k) => k + 1)}
            onRestart={() => startPreview(project.path)}
            pathScope={editedRel ? `${editedRel}|` : ''}
            selPath={pathFor(selectedId)}
            navHoverPath={pathFor(hoverNodeId)}
            overlayInfo={overlayInfo}
            focusPath={focusPath}
            focusOcc={focusOcc}
            focusWhole={focusWhole}
            device={device}
            onDevice={setDevice}
            onSelectPath={(p, info) => {
              // What the click MEANT — see canvasClick.js. The canvas answers
              // with a path or with null, and null has two causes that want
              // opposite things: a click the open file doesn't own, and a click
              // on something inside it the canvas couldn't name.
              const reveal = (node: EditorNode | null) => {
                if (!node) {
                  return;
                }
                setSelectedId(node.id);
                // Code and canvas are two views of the same selection. Keep
                // code open when it is already in use; every other panel gives
                // way to the navigator so the selected row is visible.
                setLeftTab((tab) => (tab === 'code' ? tab : 'navigator'));
                setRevealTick((t) => t + 1);
              };
              const { kind } = canvasClickAction({
                path: p,
                outside: !!info?.outside,
                focusPath,
                scope: editedRel ? `${editedRel}|` : '',
              });
              if (kind === 'nothing') {return;}
              if (kind === 'close') {
                closeComponent();
                return;
              }
              if (kind === 'layout') {
                reveal(model && findNodeById(model.nodes, 'layout'));
                return;
              }
              reveal(model && p ? nodeAtPath(model.nodes, trailOf(p)) : null);
            }}
            onSelectedClasses={receiveClasses}
            onRenderedPaths={setRenderedPaths}
            onNodeStates={setNodeStates}
            onNodeClasses={setNodeClasses}
            onOpenPath={(p, occ) => {
              // Double-clicking a component on the canvas drills into it. With no
              // path the click landed on chrome the layout renders itself (nav,
              // footer) — that markup belongs to the layout, so open the layout,
              // matching what a single click there selects.
              if (!p) {
                if (layoutNode?.name) {
                  openComponent(layoutNode.name, pathFor('layout'));
                }
                return;
              }
              const n = model && nodeAtPath(model.nodes, trailOf(p));
              if (!n) {
                return;
              }
              // Astro built-ins have no project component file to open.
              if (n.kind === 'component' && !n.astroAsset && n.name !== 'Fragment') {
                openComponent(n.name, p, occ);
                return;
              }
              // Nothing to drill into. But a double-click on a paragraph asks
              // to edit its words — that's what the gesture means everywhere
              // else — so it goes where the words are: Settings, caret in
              // Content. Only where that field exists; on a wrapper full of
              // elements the double-click has nothing to offer and does
              // nothing, rather than opening a panel to say so.
              if (holdsInlineText(n)) {
                setRightTab('settings');
                setContentFocus((t) => t + 1);
              }
            }}
          />

          {/* The CMS edits content, not layout — it covers the canvas rather
              than replacing it, so the preview keeps its loaded page. */}
          {varsGroup && leftTab === 'variables' && (
            <VariablesView
              project={project}
              selected={varsGroup}
              hidden={leftTab !== 'variables'}
              showToast={showToast}
              onRecordUndo={pushCommand}
              onClose={() => setVarsGroup(null)}
            />
          )}

          {contentName && (
            <ContentView
              project={project}
              name={contentName}
              hidden={leftTab !== 'cms'}
              showToast={showToast}
              onSaved={() => setCmsTick((t) => t + 1)}
              onClose={() => setContentName(null)}
            />
          )}

          {cmsRel && (
            <CmsView
              project={project}
              rel={cmsRel}
              hidden={leftTab !== 'cms'}
              settings={cmsSettings}
              showToast={showToast}
              onRecordUndo={pushCommand}
              onSaved={() => setCmsTick((t) => t + 1)}
              onCloseSettings={() => setCmsSettings(false)}
              onDeleted={() => {
                setCmsRel(null);
                setCmsSettings(false);
              }}
              onClose={() => setCmsRel(null)}
            />
          )}
        </div>

        {inPreview && previewSrc && (
          <div className="preview-mode">
            <iframe ref={previewIframeRef} src={previewSrc} title="Site preview (interactive)" />
          </div>
        )}

        {/* An old version covers the canvas rather than replacing what it
            points at. The editing canvas draws outlines from the model, and
            the model is read from the files on disk — which are the CURRENT
            ones. Pointed at an old server it would draw this version's boxes
            over that version's page: every outline in the wrong place, and
            every click editing a file that isn't what's on screen. An overlay
            cannot do that, because there is nothing to click. */}
        {oldVersionUrl && previewInfo && (
          <div className="preview-mode old-version">
            <div className="preview-banner">
              <span className="preview-banner-text">
                You’re looking at <strong>{previewInfo.subject}</strong> — how the site was{' '}
                {relativeTime(previewInfo.when ?? '')}. This is a look, not a place to work.
              </span>
              <button className="preview-banner-exit" onClick={exitCommitPreview}>
                Back to now
              </button>
            </div>
            <iframe src={oldVersionUrl} title="An earlier version of the site" />
          </div>
        )}

        {pageState?.editable && !previewRef && (
          <div className="panel right">
            <div className="right-tabs">
              {rightTabInd && <span className="right-tabs-indicator" style={rightTabInd} />}
              {(
                [
                  { id: 'style', label: 'Style' },
                  { id: 'settings', label: 'Settings' },
                ] as const
              ).map((t) => (
                <button
                  key={t.id}
                  ref={(el) => (rightTabRefs.current[t.id] = el)}
                  className={rightTab === t.id ? 'on' : ''}
                  onClick={() => setRightTab(t.id)}
                >
                  {t.label}
                </button>
              ))}
            </div>
            {rightTab === 'style' && (
              <StylePanel
                project={project}
                model={model}
                node={selectedNode}
                device={device}
                onWriteStyleNode={(nodeId, css, immediate) => {
                  // Editing a component: a <style> block of the PAGE is not in
                  // the model this writes into, and mutating nothing would look
                  // like a save. Report it instead — the panel holds the edit
                  // and writes it when the component closes.
                  const state = pageStateRef.current.pageState;
                  if (!state?.editable || !findNodeById(state.model.nodes, nodeId)) {
                    return false;
                  }
                  setNodeText(nodeId, css, undefined, immediate || 'live');
                  return true;
                }}
                onSelectNode={setSelectedId}
                onRecordUndo={pushCommand}
                onAddClass={(name) => {
                  if (selectedId) {
                    addClassToNode(selectedId, name);
                  }
                }}
                onSpacingHover={setSpacingHover}
                pathOf={pathFor}
                renderedClasses={selectedClasses}
                projectClasses={projectClasses}
                historyTick={historyTick}
                openFilePath={openEditableFile?.path ?? null}
                openFileKind={openEditableFile?.kind ?? null}
              />
            )}
            <div style={{ display: rightTab === 'settings' ? 'contents' : 'none' }}>
              <PropsPanel
                node={selectedNode}
                focusClass={classFocus}
                focusContent={contentFocus}
                isLayout={selectedId === 'layout'}
                layouts={scan.layouts}
                currentLayoutName={currentLayoutName}
                onChangeLayout={changeLayout}
                schema={selectedSchema}
                slotOptions={slotOptions}
                // Whether this component takes default slot content — the same
                // test used to decide what an insert or paste can go inside.
                takesSlotText={
                  selectedNode?.kind === 'component' &&
                  (insertables.find((c) => c.name === selectedNode.name)?.slots || []).includes(
                    'default'
                  )
                }
                loopContext={loopContext}
                bindContext={bindContext}
                linkContext={linkContext}
                projectClasses={projectClasses}
                allowAttrs={
                  selectedNode?.kind === 'element' ||
                  // A dynamic tag renders a real element, so it takes attributes
                  // even though it has no component file behind it.
                  (selectedNode !== null &&
                    selectedNode.kind !== 'frontmatter' &&
                    !!selectedNode.dynamicTag) ||
                  (selectedNode?.kind === 'component' &&
                    !!insertables.find((c) => c.name === selectedNode.name)?.hasRest)
                }
                comment={noteText(commentAbove(model, selectedId)?.value)}
                onSetComment={(text) => {
                  if (selectedId) {
                    setComment(selectedId, text);
                  }
                }}
                onSetProp={(propName, value, immediate) => {
                  if (selectedId) {
                    setProp(selectedId, propName, value, immediate);
                  }
                }}
                onSetProps={(nodeId, patch) => setProps(nodeId, patch)}
                onSetAssetProp={(nodeId, propName, picked) =>
                  setAssetProp(nodeId, propName, picked)
                }
                onRenameProp={(oldName, newName) => {
                  if (selectedId) {
                    renameProp(selectedId, oldName, newName);
                  }
                }}
                // A capital is a component name; anything else is a tag. The
                // component path answers whether the name resolves, so the
                // field can put the old value back when it doesn't.
                onChangeTag={(tag) =>
                  selectedId
                    ? /^[A-Z]/.test(tag)
                      ? changeNodeKind(selectedId, tag)
                      : changeElementTag(selectedId, tag)
                    : undefined
                }
                tagOptions={tagOptions}
                onSetText={(value, renames) =>
                  selectedId === 'frontmatter'
                    ? setFrontmatter(value)
                    : selectedId
                    ? setNodeText(selectedId, value, renames)
                    : undefined
                }
                onSetContent={(value) => {
                  if (selectedId) {
                    setNodeContent(selectedId, value);
                  }
                }}
                onSetInline={(kids) => {
                  if (selectedId) {
                    setNodeInline(selectedId, kids);
                  }
                }}
                onOpenCode={openCodeWindow}
                onSetFrontmatter={setExtraFrontmatter}
                frontmatterSource={frontmatterCode}
                onOpenSymbol={openSymbolFile}
                onToggleElse={(want) => {
                  if (selectedId) {
                    toggleElseBranch(selectedId, want);
                  }
                }}
                projectPath={project.path}
                filePath={editStack[editStack.length - 1]?.path || currentPage?.path || null}
              />
            </div>
          </div>
        )}
      </div>

      {/* Below `.main`, so it spans the full window rather than being boxed in
          by the panels. Always mounted but inert until opened: it spawns no
          shell until then, and once open it hides rather than unmounting, so
          toggling it doesn't discard the scrollback — see TerminalDock. */}
      <TerminalDock projectPath={project.path} open={termOpen} onClose={() => setTermOpen(false)} />

      {codeWin && codeWinValue !== null && (
        <CodeWindow
          title={codeWin.title}
          language={codeWin.language}
          value={codeWinValue}
          editorKey={isFileWin ? `file:${codeWin.rel}` : codeWin.targetId}
          revealLine={codeWin.revealLine}
          onChange={(value) =>
            isFileWin
              ? setAssetFileText(value)
              : codeWin.targetId === 'frontmatter'
              ? setFrontmatter(value)
              : codeWin.targetId
              ? setNodeText(codeWin.targetId, value)
              : undefined
          }
          onClose={() => setCodeWin(null)}
        />
      )}

      {insertOpen && (
        <InsertSearch
          components={insertables}
          allowSlot={currentPage?.kind === 'component'}
          onInsert={insertItem}
          onClose={() => setInsertOpen(false)}
        />
      )}

      {busy && <BusyOverlay message={busy} />}
      {toast && <Toast toast={toast} />}
      <ConfirmHost />
    </div>
  );
}

function insertIntoModel(model: EditorModel, node: EditorNode, target: InsertTarget | null): void {
  if (!target || target.parentId == null) {
    const index = target ? Math.min(target.index, model.nodes.length) : model.nodes.length;
    model.nodes.splice(index, 0, node);
    return;
  }
  const parent = findNodeById(model.nodes, target.parentId);
  if (!parent) {
    model.nodes.push(node);
    return;
  }
  if (!Array.isArray(parent.children)) {
    parent.children = [];
  }
  const index = Math.min(target.index, parent.children.length);
  parent.children.splice(index, 0, node);
}

function BusyOverlay({ message }: { readonly message: string }) {
  return (
    <div className="busy-overlay">
      <div className="spinner" />
      <div>{message}</div>
    </div>
  );
}

function Toast({ toast }: { readonly toast: ToastMessage }) {
  return <div className={`toast ${toast.kind}`}>{toast.msg}</div>;
}
