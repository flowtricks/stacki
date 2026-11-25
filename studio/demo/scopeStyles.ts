// Astro's scoping, redone in the browser for a `<style>` block edited on a baked
// page. There is no compiler here, so this mirrors its output: every compound
// selector gains `[data-astro-cid-…]`. The bake's parity test runs this over real
// blocks and compares it with what Astro produced, so a drift fails loudly.
import { assert } from '../vendor/stacki/shared/core/assert';
import postcss, { type ChildNode, type Container, type Rule } from 'postcss';
import selectorParser, { type Node as SelectorNode, type Root, type Selector } from 'postcss-selector-parser';

type CompoundNode = Exclude<SelectorNode, Selector | Root>;

const NESTING_DEPTH_MAX = 64;
const UNSCOPED_TAGS: ReadonlySet<string> = new Set(['html', 'body', ':root', ':host']);
const KEYFRAMES = /keyframes$/i;

function isGlobal(node: SelectorNode): boolean {
  return node.type === 'pseudo' && node.value === ':global';
}

function isScopeless(compound: readonly SelectorNode[]): boolean {
  const first = compound[0];
  if (first === undefined) {
    return true;
  }
  if (first.type === 'nesting') {
    return true;
  }
  return first.type === 'tag' ? UNSCOPED_TAGS.has(first.value) : first.type === 'pseudo' && UNSCOPED_TAGS.has(first.value);
}

function scopeCompound(selector: Selector, compound: readonly CompoundNode[], attribute: string): void {
  if (isScopeless(compound) || compound.some(isGlobal)) {
    return;
  }
  const scope = selectorParser().astSync(`[${attribute}]`).first.first;
  assert(scope.type === 'attribute', 'A bracketed name parses as an attribute');
  // After the first simple selector, as the compiler writes it: `.a.b:hover` becomes
  // `.a[scope].b:hover`. A compound opening with a pseudo takes the scope in front.
  const first = compound[0];
  if (first === undefined) {
    return;
  }
  if (first.type === 'pseudo') {
    selector.insertBefore(first, scope);
  } else {
    selector.insertAfter(first, scope);
  }
}

function unwrapGlobals(selector: Selector): void {
  selector.walkPseudos((pseudo) => {
    if (pseudo.value === ':global') {
      const inner = pseudo.nodes[0];
      if (inner === undefined) {
        pseudo.remove();
      } else {
        pseudo.replaceWith(...inner.nodes);
      }
    }
  });
}

function scopeSelector(selector: Selector, attribute: string): void {
  let compound: CompoundNode[] = [];
  for (const node of [...selector.nodes, undefined]) {
    if (node === undefined || node.type === 'combinator') {
      scopeCompound(selector, compound, attribute);
      compound = [];
    } else if (node.type !== 'comment' && node.type !== 'root') {
      compound.push(node);
    }
  }
  unwrapGlobals(selector);
}

function scopeRule(rule: Rule, attribute: string): void {
  rule.selector = selectorParser((root) => {
    for (const selector of root.nodes) {
      scopeSelector(selector, attribute);
    }
  }).processSync(rule.selector);
}

function scopeContainer(container: Container<ChildNode>, attribute: string, depth: number): void {
  if (depth > NESTING_DEPTH_MAX) {
    throw new Error('A style block nests deeper than scoping walks');
  }
  for (const node of container.nodes ?? []) {
    if (node.type === 'rule') {
      scopeRule(node, attribute);
      scopeContainer(node, attribute, depth + 1);
    } else if (node.type === 'atrule' && !KEYFRAMES.test(node.name) && node.nodes !== undefined) {
      scopeContainer(node, attribute, depth + 1);
    }
  }
}

/** The block as Astro would compile it for `scope`. Unparseable CSS throws. */
export function scopeStyles(css: string, scope: string): string {
  const root = postcss.parse(css);
  scopeContainer(root, `data-astro-cid-${scope}`, 0);
  return root.toString();
}
