// Fixes that need more than the one element a static check looks at: they are
// planned once the runner knows where a rendered finding came from, or what the
// person chose.
//
// - Per-instance ids: an id written inside a component (an inline SVG's
//   `<clipPath id="clip0_901_5">`) repeats on every page that uses the
//   component twice. The fix gives each render its own numbered key in the frontmatter
//   and writes the id, and every `url(#…)` / `#…` reference to it in that file,
//   as expressions that append it.
// - A missing h1: when the page uses a heading component whose props include
//   a tag prop (`Tag`, `tag`, `as`, `level`), its most prominent heading — the
//   first at the smallest level — is set to h1.
// - A broken link: its href set to the route the person picked.
import { assert } from '../core/assert';
import { labelText, type AuditEdit, type AuditFix } from './auditFindings';
import { attrState, nodeChildren, nodeProps, openingTag, patchedAttributes } from './auditMarkup';
import type { AuditFileInput } from './auditStatic';
import type { Attr, PageNode } from './pageNodeTypes';

/** The frontmatter statement that gives each render of a component its own key. */
export const INSTANCE_KEY_NAME = 'instanceKey';
/** A counter kept for the whole build: each render takes the next number, so keys are unique per instance and the
 * same for the same build order — deterministic output, and nothing random to mismatch if markup ever hydrates.
 * Astro runs frontmatter inside each render, so the count lives on globalThis, under a name no project uses. */
export const INSTANCE_KEY_CODE = [
  'const instanceCounter = globalThis as { stackiInstanceCount?: number };',
  `const ${INSTANCE_KEY_NAME} = (instanceCounter.stackiInstanceCount = (instanceCounter.stackiInstanceCount ?? 0) + 1);`,
].join('\n');

/** Attributes that refer to an id: `url(#id)` in presentation attributes, `#id` in links. */
const ID_REFERENCE_ATTRIBUTES: readonly string[] = [
  'clip-path',
  'mask',
  'filter',
  'fill',
  'stroke',
  'marker-start',
  'marker-mid',
  'marker-end',
  'href',
  'xlink:href',
  'style',
];
const NODES_MAX = 20_000;

interface Located {
  readonly node: PageNode;
  readonly path: readonly number[];
}

function located(nodes: readonly PageNode[]): readonly Located[] {
  const found: Located[] = [];
  const pending: Located[] = nodes.map((node, index) => ({ node, path: [index] })).reverse();
  for (let visited = 0; pending.length > 0; visited++) {
    assert(visited < NODES_MAX, 'located: a file stays inside the tree bound');
    const entry = pending.pop();
    assert(entry !== undefined, 'located: the stack holds an entry');
    found.push(entry);
    pending.push(
      ...nodeChildren(entry.node)
        .map((child, index) => ({ node: child, path: [...entry.path, index] }))
        .reverse(),
    );
  }
  return found;
}

function samePath(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((index, position) => index === right[position]);
}

/** Template literal text for `value` with the instance key appended to the id `id` everywhere it occurs. */
function keyedTemplate(value: string, id: string): string {
  const escaped = value.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
  return `\`${escaped.split(`#${id}`).join(`#${id}-\${${INSTANCE_KEY_NAME}}`)}\``;
}

/** The fix that makes the id at `path` in a component unique per render, or undefined when it cannot be made safely. */
export function instanceIdFix(input: AuditFileInput, path: readonly number[], expectedId?: string): AuditFix | undefined {
  assert(path.length > 0, 'instanceIdFix: names an element');
  if (input.kind === 'page') {
    return undefined; // A page renders once: its duplicate is a second element, not a second render.
  }
  const nodes = located(input.nodes);
  const target = nodes.find((entry) => samePath(entry.path, path));
  if (target === undefined || (target.node.kind !== 'element' && target.node.kind !== 'raw')) {
    return undefined;
  }
  const id = attrState(nodeProps(target.node), 'id');
  if (id.tag !== 'value' || !/^[\w-]+$/.test(id.value)) {
    return undefined;
  }
  if (expectedId !== undefined && id.value !== expectedId) {
    return undefined; // The rendered id came from somewhere else (a component's inlined markup).
  }
  const edits: AuditEdit[] = [{ tag: 'frontmatter-append', code: INSTANCE_KEY_CODE }];
  edits.push({ tag: 'attributes', path, expect: target.node.name, patch: { id: { type: 'expr', value: `\`${id.value}-\${${INSTANCE_KEY_NAME}}\`` } } });
  for (const entry of nodes) {
    const props = nodeProps(entry.node);
    if (props === undefined || (entry.node.kind !== 'element' && entry.node.kind !== 'raw')) {
      continue;
    }
    const patch: Record<string, Attr> = {};
    for (const [name, value] of Object.entries(props)) {
      const refers = value.type === 'string' && ID_REFERENCE_ATTRIBUTES.includes(name.toLowerCase()) && new RegExp(`#${id.value}(?![\\w-])`).test(value.value);
      if (refers) {
        patch[name] = { type: 'expr', value: keyedTemplate(value.value, id.value) };
      } else if (value.type !== 'string' && value.type !== 'bare' && value.value.includes(`#${id.value}`)) {
        return undefined; // An expression refers to it: rewriting that is a judgement, not a rule.
      }
    }
    if (Object.keys(patch).length > 0) {
      edits.push({ tag: 'attributes', path: entry.path, expect: entry.node.name, patch });
    }
  }
  assert(edits.length >= 2, 'instanceIdFix: the key and the id at least');
  const after = openingTag(
    target.node.name,
    patchedAttributes(nodeProps(target.node), { id: { type: 'expr', value: `\`${id.value}-\${${INSTANCE_KEY_NAME}}\`` } }),
  );
  return {
    ...labelText('audits.fix.makeIdsUnique'),
    before: openingTag(target.node.name, nodeProps(target.node)),
    after: `${INSTANCE_KEY_CODE}\n${after}`,
    file: input.file,
    edits,
  };
}

/** Prop names a heading component takes its level by. */
export const HEADING_TAG_PROPS: readonly string[] = ['Tag', 'tag', 'as', 'level'];

/** The fix that makes the page's most prominent heading component an h1, or undefined when there is none. */
export function headingPromotionFix(page: AuditFileInput, headingProps: ReadonlyMap<string, string>): AuditFix | undefined {
  assert(page.kind === 'page', 'headingPromotionFix: a page is promoted, not a component');
  let best: { readonly entry: Located; readonly level: number; readonly prop: string } | undefined;
  for (const entry of located(page.nodes)) {
    if (entry.node.kind !== 'component') {
      continue;
    }
    const prop = headingProps.get(entry.node.name);
    if (prop === undefined) {
      continue;
    }
    const state = attrState(nodeProps(entry.node), prop.toLowerCase());
    const level = state.tag === 'value' ? /^h?([1-6])$/i.exec(state.value.trim())?.[1] : undefined;
    if (level === undefined) {
      continue;
    }
    const number = Number.parseInt(level, 10);
    if (best === undefined || number < best.level) {
      best = { entry, level: number, prop };
    }
  }
  if (best === undefined || best.entry.node.kind !== 'component') {
    return undefined;
  }
  const props = nodeProps(best.entry.node);
  const written = attrState(props, best.prop.toLowerCase());
  const value = written.tag === 'value' && /^\d$/.test(written.value.trim()) ? '1' : 'h1';
  const patch = { [best.prop]: { type: 'string', value } satisfies Attr };
  assert(best.level >= 1, 'headingPromotionFix: a heading level is at least 1');
  return {
    ...labelText('audits.fix.makeHeadingH1'),
    before: openingTag(best.entry.node.name, props),
    after: openingTag(best.entry.node.name, patchedAttributes(props, patch)),
    file: page.file,
    edits: [{ tag: 'attributes', path: best.entry.path, expect: best.entry.node.name, patch }],
  };
}

/** The fix that points a link at `route`. */
export function linkFix(input: { readonly file: string; readonly path: readonly number[]; readonly href: string }, route: string): AuditFix {
  assert(route.startsWith('/'), 'linkFix: a route is site-relative');
  assert(input.path.length > 0, 'linkFix: names the link');
  const patch = { href: { type: 'string', value: route } satisfies Attr };
  return {
    ...labelText('audits.fix.linkTo', { route }),
    before: `<a href="${input.href}">`,
    after: `<a href="${route}">`,
    file: input.file,
    edits: [{ tag: 'attributes', path: input.path, expect: 'a', patch }],
  };
}
