// Goal: find every JSX element that would show the browser's native tooltip (a `title` attribute) on the same pointer rest
// that shows one of the app's own tooltips. Chromium draws a `title` for the element under the pointer and for every
// descendant of it that has no `title` of its own, so a row label with `title={name}` also titles the (i) mark inside it,
// and both tips appear at once with the native box on top (the Audits settings rows did exactly that).
// Method: parse each .tsx file with the TypeScript compiler, walk the JSX trees, and report an element whose `title` is
// not empty when it either contains a custom-tooltip component in its own JSX children, or is a direct child of a
// TipAnchor (whose wrapper shows the tip for what it wraps). A `title` passed to a component that only renders a native
// title is not reported: there is no custom tip there to collide with. The scan is lexical: a custom tip rendered by a
// child component in another file is not seen, which is why the tooltip components also blank an inherited title at
// runtime (`title=""` on their trigger).
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

/** The components that draw the app's own tooltip. Their trigger must not also carry or inherit a native title. */
export const CUSTOM_TIP_COMPONENTS: ReadonlySet<string> = new Set(['InfoHint', 'InfoLabel', 'TipAnchor', 'TipButton', 'Tooltip']);

export interface TitleCollision {
  /** Repository-relative path, written with `/`. */
  readonly file: string;
  /** One-based line of the element that carries the `title`. */
  readonly line: number;
  /** The tag of that element. */
  readonly tag: string;
  /** Which custom tip it collides with, and how. */
  readonly reason: 'contains-custom-tip' | 'inside-tip-anchor';
}

const FILES_MAX = 8000;
const NODES_MAX = 2_000_000;

/** Every .tsx file under `root`, sorted, repository-relative. */
export function listTsxFiles(repository: string, root: string): readonly string[] {
  const found: string[] = [];
  const pending: string[] = [path.join(repository, root)];
  while (pending.length > 0) {
    if (found.length > FILES_MAX) {
      throw new Error(`nativeTitleScan: more than ${FILES_MAX} files under ${root}`);
    }
    const directory = pending.pop();
    if (directory === undefined) {
      break;
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(full);
      } else if (entry.name.endsWith('.tsx')) {
        found.push(path.relative(repository, full).split(path.sep).join('/'));
      }
    }
  }
  return found.sort();
}

/** The collisions in one file's text. */
export function scanText(file: string, text: string): readonly TitleCollision[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const collisions: TitleCollision[] = [];
  for (const node of descendants(source)) {
    if (ts.isJsxElement(node)) {
      checkElement(node, source, collisions);
    }
  }
  return collisions;
}

/** The collisions in every .tsx file under the roots. */
export function scanRepository(repository: string, roots: readonly string[]): readonly TitleCollision[] {
  const collisions: TitleCollision[] = [];
  for (const root of roots) {
    for (const file of listTsxFiles(repository, root)) {
      collisions.push(...scanText(file, readFileSync(path.join(repository, file), 'utf8')));
    }
  }
  return collisions;
}

function checkElement(element: ts.JsxElement, source: ts.SourceFile, collisions: TitleCollision[]): void {
  const tag = element.openingElement.tagName.getText(source);
  // Only a DOM element's `title` is the native tooltip; a component's `title` prop is usually a heading (Section, SettingsSection).
  if (isIntrinsic(tag) && hasNativeTitle(element.openingElement)) {
    if (containsCustomTip(element)) {
      collisions.push({ file: source.fileName, line: lineOf(element, source), tag, reason: 'contains-custom-tip' });
    }
  }
  if (tag === 'TipAnchor') {
    for (const child of element.children) {
      const opening = openingOf(child);
      if (opening !== undefined && hasNativeTitle(opening)) {
        collisions.push({ file: source.fileName, line: lineOf(child, source), tag: opening.tagName.getText(source), reason: 'inside-tip-anchor' });
      }
    }
  }
}

// A `title` that is present and not the empty string; `title=""` is how an element blanks an inherited title.
function hasNativeTitle(opening: ts.JsxOpeningLikeElement): boolean {
  for (const attribute of opening.attributes.properties) {
    if (ts.isJsxAttribute(attribute) && attribute.name.getText() === 'title') {
      const initializer = attribute.initializer;
      if (initializer !== undefined && ts.isStringLiteral(initializer)) {
        return initializer.text.length > 0;
      }
      return true;
    }
  }
  return false;
}

function containsCustomTip(element: ts.JsxElement): boolean {
  for (const child of element.children) {
    for (const node of descendants(child)) {
      const opening = ts.isJsxElement(node) ? node.openingElement : ts.isJsxSelfClosingElement(node) ? node : undefined;
      if (opening !== undefined && CUSTOM_TIP_COMPONENTS.has(opening.tagName.getText())) {
        return true;
      }
    }
  }
  return false;
}

// Every node under `root`, root included, walked with an explicit stack (AGENTS.md §10: iterate, do not recurse).
function descendants(root: ts.Node): readonly ts.Node[] {
  const found: ts.Node[] = [];
  const pending: ts.Node[] = [root];
  while (pending.length > 0) {
    if (found.length > NODES_MAX) {
      throw new Error(`nativeTitleScan: more than ${NODES_MAX} nodes in one file`);
    }
    const node = pending.pop();
    if (node === undefined) {
      break;
    }
    found.push(node);
    ts.forEachChild(node, (child) => {
      pending.push(child);
    });
  }
  return found;
}

function isIntrinsic(tag: string): boolean {
  const first = tag.charAt(0);
  return first.length > 0 && first === first.toLowerCase() && !tag.includes('.');
}

function openingOf(node: ts.JsxChild): ts.JsxOpeningLikeElement | undefined {
  if (ts.isJsxElement(node)) {
    return node.openingElement;
  }
  if (ts.isJsxSelfClosingElement(node)) {
    return node;
  }
  return undefined;
}

function lineOf(node: ts.Node, source: ts.SourceFile): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}
