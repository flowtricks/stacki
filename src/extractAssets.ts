// The CSS and JS that travel with an extracted component.
//
// Making a component out of a piece of a page moves its markup. The styles and the
// script that piece depends on live in the page's own `<style>` and `<script>`
// blocks, and left there they would be the one thing still in index.astro that
// belongs to the component. So they move too: after extraction the page holds the
// chain of components and nothing else.
//
// "Belongs to the component" is decided by class names, because that is what CSS
// and query-selector scripts address elements by:
//
//   a rule moves when every class it mentions is used inside the piece and NOT
//   anywhere else on the page. A class used both inside and out cannot move
//   without breaking the outside use, so its rules stay and are counted, for the
//   caller to say so.
//
// Rules that mention no class (`h1 { … }`, `:root { --x }`, `body`) are page-wide
// by nature and stay. Selector lists are split: `.a, .b` with only `.a` movable
// moves `.a` and leaves `.b`.

import postcss from 'postcss';
import type { AtRule, Container, Root, Rule } from 'postcss';

import type { Attr } from '../shared/page-node';
import { namesIn } from './classAttr';

/** Classes and ids an element tree uses, from static attributes only. */
export interface Tokens {
  readonly classes: ReadonlySet<string>;
  readonly ids: ReadonlySet<string>;
}

export interface SplitStyles {
  /** CSS that moves into the component ('' when nothing does). */
  readonly moved: string;
  /** What the page keeps. */
  readonly kept: string;
  /** Selectors held back because they use a class the page uses elsewhere too. */
  readonly held: number;
}

export interface SplitScript {
  readonly moves: boolean;
}

/** The part of a page-model node this module reads. */
export interface TreeNode {
  readonly id: string;
  readonly kind?: string | undefined;
  readonly name?: string | undefined;
  readonly inner?: string | undefined;
  readonly props?: Readonly<Record<string, Attr>> | undefined;
  readonly children?: readonly TreeNode[] | null | undefined;
}

// Deeper than any page; bounds the walk so a malformed tree cannot recurse forever.
const TREE_DEPTH_MAX = 200;

/**
 * The classes and ids used by `nodes` and everything under them. With `skipId`,
 * the subtree rooted at that node is left out — that is "the rest of the page".
 */
export function tokensOf(nodes: readonly TreeNode[], skipId?: string): Tokens {
  const classes = new Set<string>();
  const ids = new Set<string>();
  const walk = (list: readonly TreeNode[], depth: number): void => {
    if (depth > TREE_DEPTH_MAX) {
      throw new Error('Page tree is too deep to scan.');
    }
    for (const node of list) {
      if (node.id === skipId) {
        continue;
      }
      for (const key of ['class', 'class:list']) {
        namesIn(node.props?.[key]).forEach((name) => classes.add(name));
      }
      const id = node.props?.['id'];
      if (id && id.type === 'string' && id.value.trim()) {
        ids.add(id.value.trim());
      }
      walk(node.children ?? [], depth + 1);
    }
  };
  walk(nodes, 0);
  return { classes, ids };
}

// A generous bound: a stylesheet block with more selectors than this is not one
// a person wrote by hand, and the walk stays finite on anything else.
const SELECTORS_MAX = 20000;

const CLASS_TOKEN = /\.(-?[_a-zA-Z][\w-]*)/g;

/** The class names a selector mentions, ignoring strings and attribute brackets. */
export function classesInSelector(selector: string): readonly string[] {
  const bare = selector.replace(/\[[^\]]*\]/g, '').replace(/(["'])(?:\\.|(?!\1).)*\1/g, '');
  return [...bare.matchAll(CLASS_TOKEN)].map((match) => match[1] ?? '').filter(Boolean);
}

/** The classes movable with the piece: used inside it, never outside it. */
export function movableClasses(inside: Tokens, outside: Tokens): ReadonlySet<string> {
  return new Set([...inside.classes].filter((name) => !outside.classes.has(name)));
}

type Verdict = 'moves' | 'stays' | 'held';

function verdictFor(
  selector: string,
  inside: Tokens,
  movable: ReadonlySet<string>,
): Verdict {
  const classes = classesInSelector(selector);
  if (classes.length === 0) {
    return 'stays';
  }
  if (classes.every((name) => movable.has(name))) {
    return 'moves';
  }
  // Every class belongs to the piece, but some are also used outside it.
  return classes.every((name) => inside.classes.has(name)) ? 'held' : 'stays';
}

class Splitter {
  held = 0;
  private seen = 0;

  constructor(
    private readonly inside: Tokens,
    private readonly movable: ReadonlySet<string>,
  ) {}

  // Moves what belongs out of `source` into `target`, both containers of the same
  // kind (root, or the shell of a media query).
  split(source: Container, target: Container): void {
    for (const child of [...(source.nodes ?? [])]) {
      if (child.type === 'rule') {
        this.splitRule(child, target);
      } else if (child.type === 'atrule' && this.isConditional(child)) {
        this.splitConditional(child, target);
      }
    }
  }

  private isConditional(atRule: AtRule): boolean {
    return /^(media|supports|container|layer)$/i.test(atRule.name) && Boolean(atRule.nodes);
  }

  private splitRule(rule: Rule, target: Container): void {
    const moving: string[] = [];
    const staying: string[] = [];
    for (const selector of rule.selectors) {
      this.seen += 1;
      if (this.seen > SELECTORS_MAX) {
        throw new Error('Too many selectors to split safely.');
      }
      const verdict = verdictFor(selector, this.inside, this.movable);
      if (verdict === 'moves') {
        moving.push(selector);
      } else {
        staying.push(selector);
        if (verdict === 'held') {
          this.held += 1;
        }
      }
    }
    if (moving.length === 0) {
      return;
    }
    const clone = rule.clone();
    clone.selectors = moving;
    clone.raws.before = '\n\n';
    target.append(clone);
    if (staying.length === 0) {
      rule.remove();
    } else {
      rule.selectors = staying;
    }
  }

  private splitConditional(atRule: AtRule, target: Container): void {
    const shell = atRule.clone({ nodes: [] });
    shell.raws.before = '\n\n';
    this.split(atRule, shell);
    if ((shell.nodes ?? []).length > 0) {
      target.append(shell);
    }
    if ((atRule.nodes ?? []).length === 0) {
      atRule.remove();
    }
  }
}

function animationNames(root: Container): Set<string> {
  const names = new Set<string>();
  root.walkDecls(/^(-webkit-)?animation(-name)?$/i, (decl) => {
    for (const word of decl.value.split(/[\s,]+/)) {
      if (/^-?[_a-zA-Z][\w-]*$/.test(word)) {
        names.add(word);
      }
    }
  });
  return names;
}

// A keyframes block goes with the rules that run it, unless something staying
// behind runs it too.
function carryKeyframes(page: Root, moved: Root): void {
  const usedByMoved = animationNames(moved);
  const usedByPage = animationNames(page);
  for (const node of [...page.nodes]) {
    if (node.type !== 'atrule' || !/keyframes$/i.test(node.name)) {
      continue;
    }
    const name = node.params.trim();
    if (usedByMoved.has(name) && !usedByPage.has(name)) {
      const clone = node.clone();
      clone.raws.before = '\n\n';
      moved.append(clone);
      node.remove();
    }
  }
}

function tidy(root: Root): string {
  const css = root.toString().trim();
  return css ? `${css}\n` : '';
}

/**
 * Splits one `<style>` block's CSS into what moves with the piece and what stays.
 * Unparseable CSS is left entirely where it is: moving half of something the
 * parser could not read is how styles get lost.
 */
export function splitStyles(css: string, inside: Tokens, outside: Tokens): SplitStyles {
  let page: Root;
  try {
    page = postcss.parse(css);
  } catch {
    return { moved: '', kept: css, held: 0 };
  }
  const moved = postcss.root();
  const splitter = new Splitter(inside, movableClasses(inside, outside));
  splitter.split(page, moved);
  carryKeyframes(page, moved);
  const movedText = tidy(moved);
  return {
    moved: movedText,
    kept: movedText ? tidy(page) : css,
    held: splitter.held,
  };
}

/**
 * Whether a `<script>` block is about the piece: it names one of its movable
 * classes or ids, and names nothing the rest of the page uses. A script that
 * reaches both is the page's to keep — copying it would run it twice.
 */
export function scriptBelongsTo(script: string, inside: Tokens, outside: Tokens): SplitScript {
  const mentions = (name: string): boolean =>
    new RegExp(`(^|[^\\w-])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\w-]|$)`).test(script);
  const names = [...inside.classes, ...inside.ids].filter(
    (name) => !outside.classes.has(name) && !outside.ids.has(name),
  );
  const touchesInside = names.some(mentions);
  const touchesOutside = [...outside.classes, ...outside.ids].some(mentions);
  return { moves: touchesInside && !touchesOutside };
}

/** A `<style>` or `<script>` block as the page model holds it. */
export interface RawBlock {
  readonly id: string;
  readonly kind: 'raw';
  readonly name: string;
  readonly props: Readonly<Record<string, Attr>>;
  readonly inner: string;
}

export interface AssetPlan {
  /** New blocks for the component file, in order (styles, then scripts). */
  readonly moved: readonly RawBlock[];
  /** What each page block becomes: its remaining text, or null to delete it. */
  readonly edits: ReadonlyArray<{ readonly id: string; readonly inner: string | null }>;
  /** Selectors kept on the page because their class is used elsewhere too. */
  readonly held: number;
}

const BLOCKS_MAX = 200;

function rawBlocksOutside(nodes: readonly TreeNode[], pieceId: string): TreeNode[] {
  const found: TreeNode[] = [];
  const walk = (list: readonly TreeNode[], depth: number): void => {
    if (depth > TREE_DEPTH_MAX || found.length > BLOCKS_MAX) {
      throw new Error('Page tree is too large to scan.');
    }
    for (const node of list) {
      if (node.id === pieceId) {
        continue;
      }
      if (node.kind === 'raw' && (node.name === 'style' || node.name === 'script')) {
        found.push(node);
      }
      walk(node.children ?? [], depth + 1);
    }
  };
  walk(nodes, 0);
  return found;
}

/**
 * What to take out of the page's `<style>`/`<script>` blocks when `pieceId` becomes
 * a component. `makeId` names the new blocks; the plan is data, so the caller
 * applies it inside its own model edit and the component file gets `moved`.
 * Only blocks without a `src` are touched — an external script is not ours.
 */
export function planAssets(
  nodes: readonly TreeNode[],
  pieceId: string,
  makeId: () => string,
): AssetPlan {
  const piece = findTreeNode(nodes, pieceId);
  const inside = tokensOf(piece ? [piece] : []);
  const outside = tokensOf(nodes, pieceId);
  const styles: RawBlock[] = [];
  const scripts: RawBlock[] = [];
  const edits: Array<{ id: string; inner: string | null }> = [];
  let held = 0;
  for (const block of rawBlocksOutside(nodes, pieceId)) {
    const inner = block.inner ?? '';
    const props = block.props ?? {};
    if (block.name === 'style') {
      const split = splitStyles(inner, inside, outside);
      held += split.held;
      if (split.moved) {
        styles.push({ id: makeId(), kind: 'raw', name: 'style', props, inner: `\n${split.moved}` });
        edits.push({ id: block.id, inner: split.kept.trim() ? `\n${split.kept.trim()}\n` : null });
      }
    } else if (!props['src'] && scriptBelongsTo(inner, inside, outside).moves) {
      scripts.push({ id: makeId(), kind: 'raw', name: 'script', props, inner });
      edits.push({ id: block.id, inner: null });
    }
  }
  return { moved: [...styles, ...scripts], edits, held };
}

function findTreeNode(nodes: readonly TreeNode[], id: string): TreeNode | null {
  const pending = [...nodes];
  for (let step = 0; step < 100000 && pending.length > 0; step += 1) {
    const node = pending.pop();
    if (node === undefined) {
      break;
    }
    if (node.id === id) {
      return node;
    }
    pending.push(...(node.children ?? []));
  }
  return null;
}
