// Design mode (experimental, removable: docs/design-mode/REMOVE.md): "Unlink component", Figma's detach.
//
// The instance becomes the plain elements it renders, in the shown frame's version of the page, in the site's copy
// only (the fence keeps it there: docs/design-mode/REMOVE.md). In order:
//
// 1. The page is saved and read as the editor holds it, with the instance located in it.
// 2. The page is read as the dev server renders it now (designLiveCanvas.ts requestPageHtml), and is used only when
//    its stamps say it was rendered from exactly the page and component text read in 1.
// 3. The markup is made from that rendering (designUnlinkMarkup.ts) and written in the instance's place, with the
//    imports it needs (designUnlinkSource.ts), as one step of the editor's own history: ⌘Z takes it back, ⌘⇧Z redoes
//    it, and the Navigator, Style and Settings panels show the new elements at once.
// 4. The page is rendered again and compared with the rendering from 2 (designUnlinkCheck.ts). Anything but the
//    same page is undone, the step dropped from redo too, and the person is told why in a toast.
//
// Every refusal is a toast in plain words; nothing is written for one.
import type { ShellView } from '../App';
import { selectCanvasPath } from '../shell/AppPanes';
import { parsePageSource, readText } from '../../ipc/bridge';
import { resolveProjectImport } from '../../ipc/appBridge';
import { cleanError } from '../../lib/cleanError';
import { projectRelativePath } from '../../lib/projectPath';
import type { ImportDecl, PageNode } from '../../../shared/page/pageNode';
import { assert } from '../../../shared/core/assert';
import { LIMITS } from '../../../shared/core/limits';
import type { DesignFrameId } from '../../../shared/ipc/designSession';
import type { DesignNodeAt } from '../../../shared/ipc/designSnapshot';
import { requestPageHtml } from './designLiveCanvas';
import { compareRenders } from './designUnlinkCheck';
import { unlinkMarkup, type UnlinkRefusal } from './designUnlinkMarkup';
import {
  editedPage,
  frontmatterOf,
  importStatementOf,
  pageImportOf,
  propBindings,
  rebasedSpec,
  slotChildren,
  type OwnImport,
  type PageImport,
} from './designUnlinkSource';
import { designView } from './designStore';
import type { DesignOpsContext } from './designFrameOps';
import type { DesignWordKey } from './i18n/en';

/** Why an unlink was not made, each told in its own words. */
type Outcome = 'done' | 'busy' | 'not-instance' | 'in-list' | 'unreadable' | 'not-same' | UnlinkRefusal;

const OUTCOME_WORDS: Readonly<Record<Exclude<Outcome, 'done'>, DesignWordKey>> = {
  busy: 'unlink.busy',
  'not-instance': 'unlink.notInstance',
  'in-list': 'unlink.inList',
  unreadable: 'unlink.unreadable',
  'not-same': 'unlink.notSame',
  'not-rendered': 'unlink.notRendered',
  script: 'unlink.script',
  'inline-style': 'unlink.inlineStyle',
  island: 'unlink.island',
  picture: 'unlink.picture',
  'slot-twice': 'unlink.slotTwice',
  unsupported: 'unlink.unsupported',
};

/** Reads of the rendered page while the dev server catches up with a write, and the wait between them. */
const RENDER_READS_MAX = 60;
const RENDER_READ_PAUSE_MS = 250;
/** How long the panels may take to take up a pick made on the canvas, and to read a write back. */
const PICK_WAIT_MS_MAX = 3_000;
const SAVE_WAIT_MS_MAX = 10_000;
const POLL_MS = 20;
/** Extensions whose import can bring styles into a page, or that are a framework's component. */
const STYLED_IMPORT = /\.(astro|css|scss|sass|less|styl|stylus|pcss|postcss|vue|svelte|jsx|tsx)(\?.*)?$/i;

let running: 'idle' | 'running' = 'idle';

/** Unlinks the instance `nodeId` of the open page. One at a time: a second ask while one runs is let go. */
export async function unlinkComponent(context: DesignOpsContext, nodeId: string): Promise<void> {
  if (running === 'running') {
    return;
  }
  running = 'running';
  try {
    const outcome = await unlinkSteps(context, nodeId);
    if (outcome !== 'done') {
      context.app().showToast(context.words()(OUTCOME_WORDS[outcome]), 'warning');
    }
  } catch (error: unknown) {
    context.app().showToast(context.words()('toast.failed', { detail: cleanError(error) }), 'error');
  } finally {
    running = 'idle';
  }
}

/** Unlinks the node picked in a frame by a right-click, once the panels have taken up that pick. */
export async function unlinkPicked(context: DesignOpsContext, frame: DesignFrameId, node: DesignNodeAt): Promise<void> {
  const deadline = performance.now() + PICK_WAIT_MS_MAX;
  while (context.app().pathFor(context.app().selectedId) !== node.path || designView().switching !== undefined) {
    const selection = designView().selection;
    if (performance.now() >= deadline || selection.kind !== 'element' || selection.frame !== frame) {
      context.app().showToast(context.words()('toast.frameUnread'), 'warning');
      return;
    }
    await pause(POLL_MS);
  }
  const selected = context.app().selectedId;
  assert(selected !== undefined, 'unlinkPicked: the pick is selected');
  await unlinkComponent(context, selected);
}

/** Whether the node at a page path of the open page is a component instance that may be offered for unlinking. */
export function offersUnlink(app: ShellView, path: string): boolean {
  const state = app.pageState;
  if (!state?.editable) {
    return false;
  }
  const node = nodeAt(state.model.nodes, path);
  return node !== undefined && node.kind === 'component' && node.dynamicTag !== true && node.name !== 'Fragment';
}

async function unlinkSteps(context: DesignOpsContext, nodeId: string): Promise<Outcome> {
  if (designView().switching !== undefined) {
    return 'busy';
  }
  await context.app().flushSave();
  const app = context.app();
  const state = app.pageState;
  const page = app.currentPage;
  if (!state?.editable || state.origin === undefined || page === undefined || page.kind === 'route' || state.origin.source !== state.source) {
    return 'busy';
  }
  const origin = state.origin;
  const located = locate(origin.model.nodes, nodeId);
  const instance = located?.node;
  if (located === undefined || instance === undefined || instance.kind !== 'component' || instance.dynamicTag === true || instance.name === 'Fragment') {
    return 'not-instance';
  }
  if (instance.start === undefined || instance.end === undefined) {
    return 'unsupported';
  }
  if (located.inLoop) {
    return 'in-list';
  }
  const props = instance.props ?? {};
  if (Object.keys(props).some((name) => name.startsWith('client:') || name.startsWith('server:'))) {
    return 'island';
  }
  const path = located.path.join('.');
  if (props['slot'] !== undefined || app.pathFor(nodeId) !== path) {
    return 'unsupported';
  }
  const decl = origin.model.imports.find((entry) => entry.name === instance.name && entry.typeOnly !== true);
  if (decl === undefined) {
    return 'not-instance';
  }
  const projectPath = app.project.path;
  const file = await resolveProjectImport(projectPath, page.path, decl.path);
  if (file === undefined) {
    return 'unreadable';
  }
  if (!file.endsWith('.astro')) {
    return 'island';
  }
  const componentText = await readText(projectPath, file);
  const component = await parsePageSource(file, componentText);
  if (!component.editable) {
    return 'unsupported';
  }
  if (holdsRaw(component.model.nodes, 'script')) {
    return 'script';
  }
  // Markers and stamps name files from the project's folder.
  const pageFile = projectRelativePath(projectPath, page.path, window.avb.platform);
  const componentFile = projectRelativePath(projectPath, file, window.avb.platform);
  const before = await renderedPage([
    { file: pageFile, text: origin.source },
    { file: componentFile, text: componentText },
  ]);
  if (before === undefined) {
    return 'busy';
  }
  const pageFrontmatter = frontmatterOf(origin.source);
  const chosen = new Map<string, PageImport | undefined>();
  const tagFor = (name: string): string | undefined => {
    if (!chosen.has(name)) {
      const imported = component.model.imports.find((entry) => entry.name === name && entry.typeOnly !== true);
      const taken = [...chosen.values()].map((entry) => entry?.local ?? '').join(' ');
      chosen.set(
        name,
        imported === undefined
          ? undefined
          : pageImportOf(imported, rebasedSpec(imported.path, componentFile, pageFile), origin.model.imports, `${pageFrontmatter} ${taken}`, decl.quote),
      );
    }
    return chosen.get(name)?.local;
  };
  const made = unlinkMarkup({
    document: before,
    instancePath: path,
    instanceProps: props,
    children: slotChildren(origin.source, instance),
    component: { file: componentFile, nodes: component.model.nodes, bindings: propBindings(frontmatterOf(componentText)) },
    tagFor,
  });
  if (!made.ok) {
    return made.error;
  }
  const added = [...made.value.kept].flatMap((name) => {
    const statement = chosen.get(name)?.statement;
    return statement === undefined ? [] : [statement];
  });
  const statement = importStatementOf(origin.source, decl);
  const rest = origin.source.slice(0, instance.start) + origin.source.slice(instance.end);
  const ownImport = ownImportAfter(statement === undefined ? rest : rest.replace(statement, ''), decl, component.model);
  const next = editedPage(origin.source, { start: instance.start, end: instance.end }, made.value.markup, {
    statement,
    ownImport: statement === undefined ? 'keep' : ownImport,
    bare: `import ${decl.quote}${decl.path}${decl.quote};`,
    added,
  });
  if (next === undefined) {
    return 'unsupported';
  }
  return writeAndCheck(context, { origin: origin.source, next: next.source, at: next.markupAt, path, before, pageFile });
}

/** Writes the unlinked page as one step and keeps it only when it renders as the page did; else takes it back. */
async function writeAndCheck(
  context: DesignOpsContext,
  edit: { readonly origin: string; readonly next: string; readonly at: number; readonly path: string; readonly before: Document; readonly pageFile: string },
): Promise<Outcome> {
  const app = context.app();
  if (app.pageState?.source !== edit.origin) {
    return 'busy';
  }
  const history = app.historyRef.current;
  // Its own step, never folded into code typed just before it.
  history.lastKey = undefined;
  const previous = history.past.at(-1);
  await app.changeCodeSource(edit.next, edit.at);
  const step = context.app().historyRef.current.past.at(-1);
  if (step !== undefined && step !== previous && step.kind === 'edits') {
    step.label = context.words()('menu.unlink');
  }
  await context.app().flushSave();
  const saved = await savedAs(context, edit.next);
  const after = saved ? await renderedPage([{ file: edit.pageFile, text: edit.next }]) : undefined;
  const verdict = after === undefined ? { kind: 'different' as const, detail: 'not rendered' } : compareRenders(edit.before, after);
  if (verdict.kind === 'same') {
    selectCanvasPath(context.app(), edit.path, { outside: false, occurrence: 0 });
    return 'done';
  }
  // Taken back as the person's own ⌘Z would, and not left for ⌘⇧Z to bring back.
  if (step !== undefined && step !== previous && context.app().historyRef.current.past.at(-1) === step) {
    await context.app().undo();
    const future = context.app().historyRef.current.future;
    if (future.at(-1) === step) {
      future.pop();
    }
  }
  return 'not-same';
}

/** Whether the editor has read `source` back as the page it saved. */
async function savedAs(context: DesignOpsContext, source: string): Promise<boolean> {
  const deadline = performance.now() + SAVE_WAIT_MS_MAX;
  while (performance.now() < deadline) {
    const state = context.app().pageState;
    if (state?.editable && state.origin?.source === source && state.source === source) {
      return true;
    }
    await pause(POLL_MS);
  }
  return false;
}

/**
 * The page as the dev server renders it, once its stamps say each of `files` was rendered from exactly `text`;
 * undefined when it never does within the bound. Parsed inert: nothing in it loads or runs.
 */
async function renderedPage(files: readonly { readonly file: string; readonly text: string }[]): Promise<Document | undefined> {
  const wanted = await Promise.all(files.map(async (entry) => ({ file: entry.file, checksum: await sha256(entry.text) })));
  for (let read = 0; read < RENDER_READS_MAX; read += 1) {
    const page = await requestPageHtml();
    if (page.ok) {
      const stamps = stampsOf(page.html);
      if (wanted.every((entry) => stamps.get(entry.file) === entry.checksum)) {
        return new DOMParser().parseFromString(page.html, 'text/html');
      }
    } else if (page.failure === 'too-large' || page.failure === 'not-a-page') {
      return undefined;
    }
    await pause(RENDER_READ_PAUSE_MS);
  }
  return undefined;
}

/** Each file's checksum as the page's stamps name it (shared/page/previewToken.ts); a file stamped two ways is left out. */
function stampsOf(html: string): ReadonlyMap<string, string> {
  const stamps = new Map<string, string>();
  const twice = new Set<string>();
  for (const match of html.matchAll(/avb-d:([0-9a-f]{64}):([^"<>]+?)(?=-->|")/g)) {
    const checksum = match[1] ?? '';
    const file = match[2] ?? '';
    if (stamps.has(file) && stamps.get(file) !== checksum) {
      twice.add(file);
    }
    stamps.set(file, checksum);
  }
  for (const file of twice) {
    stamps.delete(file);
  }
  return stamps;
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * What becomes of the unlinked component's import: kept while anything else on the page names it; else a bare
 * import, which keeps its styles in the page; removed only when the component can bring none.
 */
function ownImportAfter(
  rest: string,
  decl: ImportDecl,
  component: { readonly nodes: readonly PageNode[]; readonly imports: readonly ImportDecl[] },
): OwnImport {
  const name = decl.name.replace(/\$/g, '\\$');
  if (new RegExp(`(^|[^\\w$])${name}($|[^\\w$])`).test(rest)) {
    return 'keep';
  }
  const styled =
    holdsRaw(component.nodes, 'style') ||
    component.imports.some((entry) => entry.typeOnly !== true && (STYLED_IMPORT.test(entry.path) || !/^(\.|@\/|~\/|\/|astro:)/.test(entry.path)));
  return styled ? 'bare' : 'remove';
}

/** Whether a template holds a `<script>` or `<style>` anywhere. */
function holdsRaw(nodes: readonly PageNode[], name: 'script' | 'style'): boolean {
  const pending: PageNode[] = [...nodes];
  for (let visited = 0; visited < pending.length; visited += 1) {
    assert(visited <= LIMITS.treeNodesMax, 'holdsRaw: bounded by the tree');
    const node = pending[visited];
    if (node === undefined) {
      continue;
    }
    if (node.kind === 'raw' && node.name.toLowerCase() === name) {
      return true;
    }
    if ('children' in node && Array.isArray(node.children)) {
      const children: readonly PageNode[] = node.children;
      pending.push(...children);
    }
  }
  return false;
}

/** A node of a located page by its id: where it is, as indexes from the root, and whether a loop repeats it. */
function locate(
  nodes: readonly PageNode[],
  nodeId: string,
): { readonly node: PageNode; readonly path: readonly number[]; readonly inLoop: boolean } | undefined {
  const pending: { readonly node: PageNode; readonly path: readonly number[]; readonly inLoop: boolean }[] = nodes.map((node, index) => ({
    node,
    path: [index],
    inLoop: false,
  }));
  for (let visited = 0; visited < pending.length; visited += 1) {
    assert(visited <= LIMITS.treeNodesMax, 'locate: bounded by the tree');
    const entry = pending[visited];
    if (entry === undefined) {
      continue;
    }
    if (entry.node.id === nodeId) {
      return entry;
    }
    const node = entry.node;
    if ('children' in node && Array.isArray(node.children)) {
      const children: readonly PageNode[] = node.children;
      children.forEach((child, index) => pending.push({ node: child, path: [...entry.path, index], inLoop: entry.inLoop || node.kind === 'map' }));
    }
  }
  return undefined;
}

function nodeAt(nodes: readonly PageNode[], path: string): PageNode | undefined {
  let list: readonly PageNode[] = nodes;
  let found: PageNode | undefined;
  for (const step of path.split('.').slice(0, LIMITS.treeDepthMax)) {
    found = list[Number(step)];
    if (found === undefined) {
      return undefined;
    }
    list = 'children' in found && Array.isArray(found.children) ? found.children : [];
  }
  return found;
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
