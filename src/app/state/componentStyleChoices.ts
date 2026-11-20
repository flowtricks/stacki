// The "Move styles" choices of Create component, gathered when its dialog opens, and the stylesheets the move
// itself reads when Create is pressed: the page's own `<style>` tags outside the markup, the project's
// stylesheets less the ones it locks, which other files use each class (main, component:classUsage), and the
// classes on the rest of the page. The decisions are pure and live in src/editor/componentStyles.ts; this file
// only reads what they need, so the list and the move always read the same sources.

import { assert } from '../../../shared/core/assert';
import { record, text } from '../../../shared/core/boundary';
import { CLASS_USAGE_LIMITS } from '../../../shared/properties/classUsage';
import { stylesheetLockMatcher } from '../../../shared/properties/styleKeepList';
import {
  classesOutside,
  movableSheets,
  moveStyleCandidates,
  pageStyleNodes,
  planStyleMove,
  layeredRules,
  tagIndentedRules,
  templateLayerOf,
  templateRulesDepth,
  type MovableSheet,
  type StyleMovePlan,
  type MoveStyleCandidate,
  type StyleHomeSource,
} from '../../editor/componentStyles';
import type { EditorModel, EditorNode } from '../../editor/pageView';
import { subjectOf } from '../../editor/pasteDependencies';
import { readKeepList } from '../../features/selectors/selectorsBridge';
import { isUtilityClassName } from '../../features/style/model/defaultSelector';
import { readStyleFiles } from '../../features/style/stylePanelBridge';
import { readClassUsage } from '../../ipc/appBridge';
import { readText } from '../../ipc/bridge';
import { projectRelativePath } from '../../lib/projectPath';
import type { Translator } from '../../lib/i18n/localeContext';
import type { PageStateSnapshot } from '../../editor/pageState';
import type { StepFiles } from '../appTypes';
import type { MovedSheet, StyleSheetCalls } from '../model/componentCreation';
import { clearStyleMove, recordStyleMove } from '../../ipc/appBridge';
import type { StyleMoveJournal } from '../../../shared/properties/styleMoveJournal';
import { styleTransport } from '../../ipc/editorEnvironment';
import { carriedStyleNode, stylesOf } from '../model/contextPaste';
import { styleSettings } from './appContextPaste';

export interface MoveStyleRead {
  readonly projectPath: string;
  /** The open page's absolute path: main leaves it out when it looks for other uses. */
  readonly pagePath: string;
  readonly model: EditorModel;
  /** The element that becomes the component. */
  readonly node: EditorNode;
}

/** The classes of the markup whose CSS may move with it, each checked when nothing else uses it. */
export async function loadMoveStyleCandidates(read: MoveStyleRead): Promise<readonly MoveStyleCandidate[]> {
  const sheets = await readMovableSheets(read.projectPath);
  const sources: readonly StyleHomeSource[] = [
    { home: { kind: 'page' }, styles: stylesOf(pageStyleNodes(read.model.nodes, read.node.id)) },
    // A stylesheet is global CSS: every rule in it can reach the markup.
    ...sheets.map((sheet): StyleHomeSource => ({
      home: { kind: 'stylesheet', rel: sheet.rel },
      styles: [{ css: sheet.css, scope: 'global', defineVars: undefined }],
    })),
  ];
  // A utility is never offered, so main is not asked about it. Past the bound, a class gets no answer and is offered unchecked.
  const markup = subjectOf(read.node).classes;
  const classes = [...markup].filter((name) => !isUtilityClassName(name)).slice(0, CLASS_USAGE_LIMITS.classesMax);
  assert(classes.length <= CLASS_USAGE_LIMITS.classesMax, 'loadMoveStyleCandidates: the question is within its bound');
  const usage = await readClassUsage(read.projectPath, read.pagePath, classes);
  const candidates = moveStyleCandidates(read.node, sources, classesOutside(read.model.nodes, read.node.id), usage, isUtilityClassName);
  assert(candidates.length <= markup.size, 'loadMoveStyleCandidates: every candidate is a class of the markup');
  return candidates;
}

/** The move as Create performs it: the plan, read fresh from disk, and the new tag that holds what it carries. */
export interface MovedStyles {
  readonly plan: StyleMovePlan;
  /** The component's new `<style>`, shaped by the project's template; undefined when nothing is carried. */
  readonly style: EditorNode | undefined;
}

/** Plans moving the `chosen` classes' CSS from what is on disk now, not from what the dialog read when it opened. */
export async function planMovedStyles(read: Omit<MoveStyleRead, 'pagePath'>, chosen: readonly string[]): Promise<MovedStyles> {
  assert(chosen.length > 0, 'planMovedStyles: something is chosen');
  const [sheets, settings] = await Promise.all([readMovableSheets(read.projectPath), styleSettings(read.projectPath)]);
  const planned = planStyleMove(read.node, new Set(chosen), pageStyleNodes(read.model.nodes, read.node.id), sheets);
  // Each @layer once: the template's wrapper supplies its own, and the rules that sat in the same layer share one block.
  const plan = { ...planned, carried: { ...planned.carried, rules: layeredRules(planned.carried.rules, templateLayerOf(settings.content)) } };
  // A new file has no layout of its own to follow yet, so the tag is laid out as the Style panel lays out a first one:
  // the rules re-indented inside the template's wrapper. Only the tag's copy is; the plan's rules stay as read, since
  // they are what the sources give up.
  const rules = tagIndentedRules(plan.carried.rules, templateRulesDepth(settings.content));
  const style = carriedStyleNode({ styles: { ...plan.carried, rules } }, settings, '');
  assert((style === undefined) === (plan.carried.rules.length === 0), 'planMovedStyles: a tag exactly when rules are carried');
  return { plan, style };
}

/** How long Create waits for the page that now uses the component to be on disk before the sheets give up its rules. */
export const MOVE_STYLE_LIMITS = {
  pageSaveWaitMs: 20_000,
  pageSavePollMs: 50,
} as const satisfies Record<string, number>;

/**
 * The component file's text as read back from disk when it holds every rule the move carried, or undefined: read
 * before any source loses one, and what the move's journal records as the component's text.
 */
export async function heldMovedStyles(projectPath: string, rel: string, rules: readonly string[]): Promise<string | undefined> {
  assert(rules.length > 0, 'heldMovedStyles: a move carries rules');
  let source: string;
  try {
    source = await readText(projectPath, rel);
  } catch {
    return undefined;
  }
  // Compared without whitespace: the template and the tag's layout re-indent the rules, and nothing else differs.
  const squashed = source.replace(/\s+/g, '');
  const held = rules.every((rule) => squashed.includes(rule.replace(/\s+/g, '')));
  assert(source.length > 0 || !held, 'heldMovedStyles: an empty file holds nothing');
  return held ? source : undefined;
}

/** A move's journal while it runs: what is learnt is recorded, and the journal goes once the move is whole or undone. */
export interface MoveJournal {
  /** Records the page's text as saved, using the component. */
  readonly pageSaved: (text: string) => Promise<void>;
  readonly clear: () => Promise<void>;
}

/**
 * Records a move's plan in main's journal (shared/properties/styleMoveJournal.ts) right after the component is written
 * and read back, before the page or any stylesheet is: from here on, a crash leaves a journal that says exactly what
 * is done and what is left, and the next opening of the project offers to finish or undo it.
 */
export async function startMoveJournal(move: {
  readonly projectPath: string;
  readonly name: string;
  readonly component: { readonly path: string; readonly rel: string; readonly text: string };
  readonly page: { readonly path: string; readonly before: string };
  readonly sheets: readonly MovedSheet[];
}): Promise<MoveJournal> {
  const base = {
    version: 1 as const,
    id: crypto.randomUUID(),
    startedAt: Date.now(),
    component: move.name,
  };
  const files = (pageAfter: string | undefined): StyleMoveJournal['files'] => [
    { role: 'component', path: move.component.path, rel: move.component.rel, before: undefined, after: move.component.text },
    {
      role: 'page',
      path: move.page.path,
      rel: projectRelativePath(move.projectPath, move.page.path, window.avb.platform),
      before: move.page.before,
      after: pageAfter,
    },
    ...move.sheets.map((sheet) => ({ role: 'sheet' as const, path: sheet.path, rel: sheet.rel, before: sheet.before, after: sheet.after })),
  ];
  await recordStyleMove(move.projectPath, { ...base, files: files(undefined) });
  return {
    pageSaved: (text) => recordStyleMove(move.projectPath, { ...base, files: files(text) }),
    clear: () => clearStyleMove(move.projectPath, base.id),
  };
}

/** How the end of a move went: whole (journal cleared), the page not saved yet, or a stylesheet write that failed. */
export type MoveFinish = { readonly kind: 'whole' } | { readonly kind: 'unsaved' } | { readonly kind: 'failed'; readonly message: string };

/**
 * The end of a move, once the page edit is committed: waits until the page is saved using the component, records its
 * saved text, takes the rules out of the stylesheets, and clears the journal. Anything short of whole leaves the
 * journal, so the move is found and resolved when the project opens again; the rules are then in two places, never none.
 */
export async function finishMovedStyles(move: {
  readonly projectPath: string;
  readonly pagePath: string;
  readonly journal: MoveJournal;
  readonly sheetFiles: StepFiles | undefined;
  readonly read: () => PageStateSnapshot;
}): Promise<MoveFinish> {
  if (!(await pageSaved(move.pagePath, move.read))) {
    return { kind: 'unsaved' };
  }
  try {
    await move.journal.pageSaved(await readText(move.projectPath, move.pagePath));
    await move.sheetFiles?.redoAfterPage();
    await move.journal.clear();
  } catch (error: unknown) {
    return { kind: 'failed', message: error instanceof Error ? error.message : String(error) };
  }
  return { kind: 'whole' };
}

/** The stylesheet calls of a move: reads through the style transport, writes that main refuses unless the sheet is unchanged. */
export function sheetCalls(translate: Translator): StyleSheetCalls {
  return {
    read: async (path) => text(record(await styleTransport.readStyleFile(path))['css']),
    write: async (path, css, expected) => {
      await styleTransport.writeStyleFile({ filePath: path, css, expected, announce: true });
    },
    changed: (rels) => translate('shell.component.sheetsChanged', { files: rels.join(', ') }),
  };
}

/**
 * Waits until the open page `path` is saved, with nothing left to write, and says whether it was. A refused or
 * conflicted save, another page opened, or the wait running out all mean no: the caller then leaves every rule where
 * it also is, rather than take it from a source while the page on disk may not use the component yet.
 */
export async function pageSaved(path: string, read: () => PageStateSnapshot): Promise<boolean> {
  const polls = Math.ceil(MOVE_STYLE_LIMITS.pageSaveWaitMs / MOVE_STYLE_LIMITS.pageSavePollMs);
  for (let poll = 0; poll < polls; poll++) {
    const { currentPage, pageState } = read();
    if (currentPage?.path !== path || pageState === undefined) {
      return false;
    }
    const tag = pageState.save.tag;
    if (tag === 'clean') {
      return true;
    }
    if (tag === 'failed' || tag === 'conflicted') {
      return false;
    }
    assert(tag === 'dirty' || tag === 'saving', 'pageSaved: a page still writing is dirty or saving');
    await new Promise((resolve) => setTimeout(resolve, MOVE_STYLE_LIMITS.pageSavePollMs));
  }
  return false;
}

/** The project's stylesheets as they are on disk now, less the ones it locks (.stacki/styles.json). */
export async function readMovableSheets(projectPath: string): Promise<readonly MovableSheet[]> {
  const listed = await readStyleFiles(projectPath);
  if (!listed.ok) {
    throw new Error(listed.error);
  }
  const [stored, sheets] = await Promise.all([
    readKeepList(projectPath),
    Promise.all(
      listed.value.map(async (file): Promise<MovableSheet> => ({
        path: file.path,
        rel: file.rel,
        css: text(record(await styleTransport.readStyleFile(file.path))['css']),
      })),
    ),
  ]);
  const movable = movableSheets(sheets, stylesheetLockMatcher(stored.keepList));
  assert(movable.length <= listed.value.length, 'readMovableSheets: no sheet is read that was not listed');
  return movable;
}
