// The app's half of the context-aware paste (src/editor/pasteDependencies.ts holds the plan):
// what a copy remembers of the file it came from, the import specifiers re-aimed for the file
// it lands in, the one gesture that writes everything (one undo step), and the words of the
// summary toast and its "What changed" list.

import { assert } from '../../../shared/core/assert';
import type { ImportDecl } from '../../../shared/page/pageNode';
import type { ScanComponent } from '../../../shared/properties/projectScan';
import { NEW_STYLE_TAG_RULES_TOKEN, templateFrame, type NewStyleTagSettings } from '../../../shared/properties/newStyleTag';
import type { Translator } from '../../lib/i18n/localeContext';
import { frontmatterGesture, insertGesture, sequence, type InsertPlace } from '../../editor/editGestures';
import type { EditGesture } from '../../editor/pageEdits';
import type { EditorModel, EditorNode } from '../../editor/pageView';
import { withStatements } from '../../editor/frontmatterMove';
import type { PasteBlocker, PasteBundle, PasteChange, PasteFileRole, PasteSource, PasteTarget } from '../../editor/pasteDependencies';
import type { PasteStyleSource } from '../../editor/pasteStyles';
import { fileLayoutOf, styleBlockInner } from '../../features/style/model/firstStyleBlock';
import type { ImportPaths } from '../../ipc/appBridge';
import { chooseImportPath } from './pageModelGestures';
import { frontmatterOf, newId } from './nodeFactory';
import { styleTagNode } from './pageGestures';

export const CONTEXT_PASTE_LIMITS = {
  /** Lines of "What changed" the dialog lists; the rest are counted. */
  changesListedMax: 40,
} as const satisfies Record<string, number>;

/** What a copy remembers of its file, taken at copy time: by paste time the file may be closed. */
export function pasteSourceOf(
  model: EditorModel,
  file: { readonly path: string | undefined; readonly role: PasteFileRole; readonly name: string },
  copied: EditorNode,
): PasteSource {
  const rendered = model.nodes.filter((node) => !isStyleOrScript(node) && !(node.kind === 'text' && node.value.trim() === '') && node.kind !== 'comment');
  return {
    path: file.path,
    role: file.role,
    componentName: file.role === 'component' ? file.name : undefined,
    frontmatter: model.extraFrontmatter,
    imports: model.imports,
    styles: stylesOf(model.nodes),
    copiedRoot: rendered.length === 1 && rendered[0]?.id === copied.id,
  };
}

/** The open file as a paste source names it: a component by its name, anything else as a page. */
export function copiedFile(open: { readonly kind: string; readonly path?: string | undefined; readonly name: string } | undefined): {
  readonly path: string | undefined;
  readonly role: PasteFileRole;
  readonly name: string;
} {
  return { path: open?.path, role: open?.kind === 'component' ? 'component' : 'page', name: open?.name ?? '' };
}

/** The file being pasted into, as shown now. */
export function pasteTargetOf(model: EditorModel, file: { readonly path: string | undefined; readonly role: PasteFileRole }): PasteTarget {
  return {
    path: file.path,
    role: file.role,
    frontmatter: model.extraFrontmatter,
    imports: model.imports,
    styles: stylesOf(model.nodes).map((style) => style.css),
  };
}

function isStyleOrScript(node: EditorNode): boolean {
  return node.kind === 'raw' && (node.name === 'style' || node.name === 'script');
}

// Every `<style>` of the file, top level or nested: Astro hoists them all.
function stylesOf(nodes: readonly EditorNode[]): readonly PasteStyleSource[] {
  const out: PasteStyleSource[] = [];
  const pending = [...nodes];
  while (pending.length > 0) {
    const node = pending.pop();
    assert(node !== undefined, 'A non-empty list has a last node');
    if (node.kind === 'raw' && node.name === 'style') {
      const defineVars = node.props?.['define:vars'];
      out.push({
        css: node.inner,
        scope: node.props?.['is:global'] === undefined ? 'scoped' : 'global',
        defineVars: defineVars?.type === 'expr' ? defineVars.value : undefined,
      });
    }
    pending.push(...(node.children ?? []));
  }
  return out.reverse();
}

/**
 * The bundle's imports with specifiers for the target: a project component from where it lives
 * (in the target's alias style), any other relative path re-aimed from the source's folder.
 */
export async function bundleImportsFor(
  bundle: Pick<PasteBundle, 'imports'>,
  context: {
    readonly insertables: readonly ScanComponent[];
    readonly sourcePath: string | undefined;
    readonly targetModel: Pick<EditorModel, 'imports'>;
    readonly resolveImportPath: (componentPath: string) => Promise<ImportPaths>;
    readonly rebase: (fromPath: string, spec: string) => Promise<string | undefined>;
  },
): Promise<readonly ImportDecl[]> {
  const out: ImportDecl[] = [];
  for (const entry of bundle.imports) {
    const original = entry.imported ?? entry.name;
    const component = entry.named === true ? undefined : context.insertables.find((candidate) => candidate.name === original || candidate.name === entry.name);
    if (component !== undefined && entry.path.endsWith('.astro')) {
      out.push({ ...withoutSlot(entry), path: chooseImportPath(context.targetModel, await context.resolveImportPath(component.path)), quote: "'" });
    } else if (context.sourcePath !== undefined && entry.path.startsWith('.')) {
      out.push({ ...withoutSlot(entry), path: (await context.rebase(context.sourcePath, entry.path)) ?? entry.path });
    } else {
      out.push(withoutSlot(entry));
    }
  }
  assert(out.length === bundle.imports.length, 'Every carried import has a specifier');
  return out;
}

// A carried import is new to the target, so it has no source slot there.
function withoutSlot(entry: ImportDecl): ImportDecl {
  const fresh: ImportDecl = { name: entry.name, path: entry.path, quote: entry.quote };
  return {
    ...fresh,
    ...(entry.named === undefined ? {} : { named: entry.named }),
    ...(entry.imported === undefined ? {} : { imported: entry.imported }),
    ...(entry.typeOnly === undefined ? {} : { typeOnly: entry.typeOnly }),
  };
}

/** The target's frontmatter with the bundle's imports and statements added. */
export function withBundleFrontmatter(imports: readonly ImportDecl[], statements: readonly string[]): (model: EditorModel) => EditorModel {
  return (model) => {
    const added = imports.filter((entry) => !model.imports.some((existing) => existing.name === entry.name));
    const extraFrontmatter =
      statements.length === 0
        ? model.extraFrontmatter
        : withStatements(
            model.extraFrontmatter,
            statements.map((statement, index) => ({ name: String(index), statement })),
          );
    return { ...model, imports: [...model.imports, ...added], extraFrontmatter };
  };
}

/** The new style tag holding the carried rules, shaped by the project's template, or undefined when there are none. */
export function carriedStyleNode(bundle: Pick<PasteBundle, 'styles'>, settings: NewStyleTagSettings, source: string): EditorNode | undefined {
  if (bundle.styles.rules.length === 0) {
    return undefined;
  }
  const css = withinTemplate(settings.content, bundle.styles.rules.join('\n\n'));
  const node = styleTagNode(newId(), styleBlockInner(css, fileLayoutOf(source)), settings.scope);
  if (bundle.styles.defineVars === undefined || node.kind !== 'raw') {
    return node;
  }
  return { ...node, props: { ...node.props, 'define:vars': { type: 'expr', value: bundle.styles.defineVars } } };
}

// The template's rules go where the template says (newStyleTag.ts): at the placeholder, inside a
// last wrapping at-rule, or after it all.
function withinTemplate(content: string, rules: string): string {
  if (content.trim() === '') {
    return rules;
  }
  if (content.includes(NEW_STYLE_TAG_RULES_TOKEN)) {
    return content.replace(NEW_STYLE_TAG_RULES_TOKEN, rules);
  }
  const frame = templateFrame(content);
  if (frame.ok && frame.frame.wrappers.length > 0) {
    const close = content.lastIndexOf('}');
    assert(close >= 0, 'A template ending in a block has its closing brace');
    return `${content.slice(0, close).replace(/\s*$/, '')}\n${rules}\n${content.slice(close)}`;
  }
  return `${content.replace(/\s*$/, '')}\n\n${rules}`;
}

/**
 * Frontmatter, the markup and its styles as ONE gesture, so one Undo takes the whole paste back.
 * The style tag is planned against the page before the markup lands, so its anchor is a node the
 * file already has.
 */
export function contextPasteGesture(
  shown: EditorModel,
  pasted: { readonly node: EditorNode; readonly place: InsertPlace; readonly style: EditorNode | undefined },
  frontmatter: (model: EditorModel) => EditorModel,
): EditGesture {
  const options = { coalesceKey: undefined, urgency: true };
  const withImports = frontmatter(shown);
  const insert = insertGesture(withImports, pasted.node, pasted.place, { urgency: true });
  const markup = pasted.style === undefined ? insert : sequence(insert, insertGesture(withImports, pasted.style, undefined, { urgency: true }));
  return frontmatterOf(withImports) === frontmatterOf(shown) ? markup : sequence(frontmatterGesture(shown, options, frontmatter), markup);
}

/** A component instance for option (a): the source component, its props passed as the bundle filled them. */
export function instanceNode(name: string): EditorNode {
  assert(/^[A-Z][\w.]*$/.test(name), 'A component instance is named like a component');
  return { id: newId(), kind: 'component', name, props: {}, children: undefined };
}

/** How many of each thing the paste brought, for the toast's one line. */
export function pasteCounts(changes: readonly PasteChange[]): { readonly imports: number; readonly variables: number; readonly styles: number } {
  const count = (kinds: readonly PasteChange['kind'][]): number => changes.filter((change) => kinds.includes(change.kind)).length;
  return { imports: count(['import']), variables: count(['variable', 'prop-default', 'prop-placeholder', 'filled']), styles: count(['style']) };
}

/** The toast's line, or undefined when the paste brought nothing. */
export function pasteSummary(changes: readonly PasteChange[], translate: Translator): string | undefined {
  const counts = pasteCounts(changes);
  const parts = [
    counts.imports > 0 ? translate('editor.paste.countImports', { count: counts.imports }) : '',
    counts.variables > 0 ? translate('editor.paste.countVariables', { count: counts.variables }) : '',
    counts.styles > 0 ? translate('editor.paste.countStyles', { count: counts.styles }) : '',
  ].filter((part) => part !== '');
  const attention = changes.some((change) => change.kind === 'prop-placeholder' || change.kind === 'filled');
  if (parts.length === 0) {
    return attention ? translate('editor.paste.filledOnly') : undefined;
  }
  return translate(attention ? 'editor.paste.broughtCheck' : 'editor.paste.brought', { list: parts.join(', ') });
}

/** One plain sentence per change, for "What changed". */
export function pasteChangeLines(changes: readonly PasteChange[], translate: Translator): readonly string[] {
  const lines = changes.map((change): string => {
    switch (change.kind) {
      case 'import':
        return translate('editor.paste.change.import', { name: change.name, path: change.path });
      case 'variable':
        return translate('editor.paste.change.variable', { name: change.name });
      case 'prop-default':
        return translate('editor.paste.change.propDefault', { name: change.name, value: change.value });
      case 'prop-placeholder':
        return translate('editor.paste.change.propPlaceholder', { name: change.name, value: change.value });
      case 'filled':
        return translate('editor.paste.change.filled', { name: change.name, value: change.value });
      case 'renamed':
        return translate('editor.paste.change.renamed', { from: change.from, to: change.to });
      case 'slot':
        return translate('editor.paste.change.slot', { count: change.count });
      case 'style':
        return translate('editor.paste.change.style', { selector: change.selector });
      case 'style-left':
        return translate('editor.paste.change.styleLeft', { selector: change.selector });
      default: {
        const exhaustive: never = change;
        return exhaustive;
      }
    }
  });
  if (lines.length <= CONTEXT_PASTE_LIMITS.changesListedMax) {
    return lines;
  }
  const more = lines.length - CONTEXT_PASTE_LIMITS.changesListedMax;
  return [...lines.slice(0, CONTEXT_PASTE_LIMITS.changesListedMax), translate('editor.paste.change.more', { count: more })];
}

/** Why the paste needs a choice, in a designer's words: one line per value that cannot travel. */
export function blockerLines(blockers: readonly PasteBlocker[], translate: Translator): readonly string[] {
  return blockers.map((blocker) => translate(`editor.paste.blocked.${blockerKey(blocker.reason)}`, { name: blocker.name }));
}

function blockerKey(
  reason: PasteBlocker['reason'],
): 'awaits' | 'effect' | 'exported' | 'astro' | 'importMeta' | 'environment' | 'changed' | 'volatile' | 'unreadable' {
  switch (reason) {
    case 'import-meta':
      return 'importMeta';
    case 'awaits':
    case 'effect':
    case 'exported':
    case 'astro':
    case 'environment':
    case 'changed':
    case 'volatile':
    case 'unreadable':
      return reason;
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}
