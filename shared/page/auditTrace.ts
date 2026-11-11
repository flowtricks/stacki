// Where a rendered head value is authored. The rendered `<meta name="description">`
// on a page is written by a component deep inside its layout (BaseHead), from a
// prop the layout passed down (often through `{...rest}`), which the page set on
// its `<Layout description="…">`. Editing it means going to the outermost place
// the value is written as a literal — the page's instance, so its prop shows in
// Settings — or, when nothing passes it, to the default inside the component, or
// to the site constant the default reads.
//
// The trace is static and only locates: whether a value is present or missing is
// decided from the rendered head, never from here.
import { assert } from '../core/assert';
import { attrState, nodeChildren, nodeProps } from './auditMarkup';
import type { AuditFileInput } from './auditStatic';
import type { PageNode, PairedNode } from './pageNodeTypes';

/** Where to go to edit a value. */
export type Authored =
  /** An element or a component instance; `prop` is the prop to edit on an instance. */
  | { readonly kind: 'node'; readonly file: string; readonly path: readonly number[]; readonly tag: string; readonly prop: string | undefined }
  /** A component's frontmatter: a literal default. */
  | { readonly kind: 'file'; readonly file: string }
  /** A constant the value reads, by the module spec the file imports it from. */
  | { readonly kind: 'constant'; readonly from: string; readonly name: string; readonly module: string };

/** One component instance on the way from the page to the value's element. */
interface Hop {
  readonly caller: AuditFileInput;
  readonly path: readonly number[];
  readonly tag: string;
  readonly callee: AuditFileInput;
}

/** Instances one trace follows: a layout inside a layout inside a page is three. */
const HOPS_MAX = 6;
const NODES_MAX = 20_000;

export interface TraceInput {
  readonly page: AuditFileInput;
  readonly files: ReadonlyMap<string, AuditFileInput>;
  /** The project-relative file a component tag in `from` renders, or undefined. */
  readonly resolve: (from: AuditFileInput, tag: string) => string | undefined;
  /** The element that holds the value, and how: an attribute, or its text (a `<title>`). */
  readonly leaf: { readonly file: string; readonly path: readonly number[]; readonly attr: string | undefined };
}

export function traceAuthored(input: TraceInput): Authored | undefined {
  assert(input.leaf.path.length > 0, 'traceAuthored: the value has an element');
  const leafFile = input.files.get(input.leaf.file);
  const element = leafFile === undefined ? undefined : nodeAt(leafFile.nodes, input.leaf.path);
  if (leafFile === undefined || element === undefined || (element.kind !== 'element' && element.kind !== 'raw')) {
    return undefined;
  }
  const here: Authored = { kind: 'node', file: leafFile.file, path: input.leaf.path, tag: element.name, prop: undefined };
  const value = valueOf(element, input.leaf.attr);
  if (value === undefined || value.kind === 'literal') {
    return here;
  }
  const prop = propBehind(leafFile, value.code);
  if (prop === undefined) {
    const constant = importedIdentifier(leafFile, value.code);
    return constant ?? here;
  }
  const hops = instanceChain(input, leafFile.file);
  assert(hops === undefined || hops.length <= HOPS_MAX, 'traceAuthored: the chain is bounded');
  return hops === undefined ? { kind: 'file', file: leafFile.file } : climb(hops, leafFile, prop);
}

// Up the instances, outermost last: each passes the prop on, sets it, or leaves the callee's default.
function climb(hops: readonly Hop[], leafFile: AuditFileInput, start: string): Authored | undefined {
  let name = start;
  let callee = leafFile;
  // Whose default supplies the value when nothing above passes it: the leaf, or the last
  // component that passed it down under its own prop. A spread passes the caller's props
  // through without making the caller's default apply.
  let holder = { file: leafFile, name: start };
  for (let index = hops.length - 1; index >= 0; index--) {
    const hop = hops[index];
    assert(hop !== undefined, 'climb: the hop exists');
    assert(hop.callee.file === callee.file, 'climb: each hop renders the file below it');
    const props = nodeProps(nodeAt(hop.caller.nodes, hop.path) ?? hopNodeMissing());
    const passed = attrState(props, name.toLowerCase());
    const instance: Authored = { kind: 'node', file: hop.caller.file, path: hop.path, tag: hop.tag, prop: name };
    if (passed.tag === 'value') {
      return instance; // A literal on this instance.
    }
    const written = Object.entries(props ?? {}).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
    if (written !== undefined && written.type === 'expr') {
      const next = propBehind(hop.caller, written.value);
      if (next === undefined) {
        return importedIdentifier(hop.caller, written.value) ?? instance;
      }
      name = next;
      callee = hop.caller;
      holder = { file: hop.caller, name: next };
      continue;
    }
    if (passed.tag === 'dynamic' && spreadsProps(hop.caller, props)) {
      callee = hop.caller; // `{...rest}` of the caller's own props: the same name, one level up.
      continue;
    }
    return defaultOf(holder.file, holder.name) ?? instance;
  }
  // The page itself takes no props: the outermost instance is where a literal belongs.
  const outermost = hops[0];
  return outermost === undefined
    ? undefined
    : (defaultOf(holder.file, holder.name) ?? { kind: 'node', file: outermost.caller.file, path: outermost.path, tag: outermost.tag, prop: name });
}

function hopNodeMissing(): PageNode {
  assert(false, 'climb: a hop names a node of its caller');
  throw new Error('unreachable');
}

/** The value an element holds: a literal, or the code an expression writes. */
function valueOf(element: PageNode, attr: string | undefined): { readonly kind: 'literal' } | { readonly kind: 'code'; readonly code: string } | undefined {
  if (attr !== undefined) {
    const written = Object.entries(nodeProps(element) ?? {}).find(([key]) => key.toLowerCase() === attr)?.[1];
    if (written === undefined) {
      return undefined;
    }
    return written.type === 'expr' ? { kind: 'code', code: written.value } : { kind: 'literal' };
  }
  const expression = nodeChildren(element).find((child) => child.kind === 'expr');
  return expression?.kind === 'expr' ? { kind: 'code', code: expression.value.replace(/^\{|\}$/g, '') } : { kind: 'literal' };
}

/** A prop of `file` that `code` reads, directly or through one local constant (`pageTitle = title ? …`). */
export function propBehind(file: AuditFileInput, code: string): string | undefined {
  const props = destructuredProps(file.frontmatter);
  const direct = identifiers(code).find((name) => props.names.has(name));
  if (direct !== undefined) {
    return props.names.get(direct);
  }
  for (const name of identifiers(code)) {
    const local = new RegExp(`(?:const|let)\\s+${name}\\s*(?::[^=]+)?=\\s*([^;]+)`).exec(file.frontmatter)?.[1];
    const behind = local === undefined ? undefined : identifiers(local).find((candidate) => props.names.has(candidate));
    if (behind !== undefined) {
      return props.names.get(behind);
    }
  }
  return undefined;
}

function identifiers(code: string): readonly string[] {
  const stripped = code.replace(/(['"`])(?:(?!\1)[^\\]|\\.)*\1/g, ' ');
  return [...stripped.matchAll(/(?<![.\w$])[A-Za-z_$][\w$]*/g)].map((match) => match[0]).filter((name) => name !== 'Astro');
}

interface Destructured {
  /** Local name → the prop key it reads. */
  readonly names: ReadonlyMap<string, string>;
  /** Prop key → its default's code. */
  readonly defaults: ReadonlyMap<string, string>;
  readonly rest: string | undefined;
}

/** `const { title, description = SITE_DESCRIPTION, heading: label, ...rest } = Astro.props`. */
export function destructuredProps(frontmatter: string): Destructured {
  const names = new Map<string, string>();
  const defaults = new Map<string, string>();
  let rest: string | undefined;
  for (const match of frontmatter.matchAll(/(?:const|let)\s*\{([^}]*)\}\s*=\s*Astro\.props/g)) {
    for (const part of topLevelParts(match[1] ?? '')) {
      const entry = part.trim();
      if (entry.startsWith('...')) {
        rest = entry.slice(3).trim();
        continue;
      }
      const [binding = '', fallback] = splitOnce(entry, '=');
      const [key = '', local] = splitOnce(binding, ':');
      if (key.trim().length > 0) {
        names.set((local ?? key).trim(), key.trim());
        if (fallback !== undefined) {
          defaults.set(key.trim(), fallback.trim());
        }
      }
    }
  }
  assert(names.size <= NODES_MAX, 'destructuredProps: bounded');
  return { names, defaults, rest };
}

function splitOnce(text: string, separator: string): readonly [string, string | undefined] {
  const at = text.indexOf(separator);
  return at === -1 ? [text, undefined] : [text.slice(0, at), text.slice(at + 1)];
}

// Commas outside brackets and strings.
function topLevelParts(text: string): readonly string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | undefined;
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index] ?? '';
    if (quote !== undefined) {
      quote = char === quote && text[index - 1] !== '\\' ? undefined : quote;
    } else if (char === '"' || char === "'" || char === '`') {
      quote = char;
    } else if ('([{'.includes(char)) {
      depth += 1;
    } else if (')]}'.includes(char)) {
      depth -= 1;
    } else if (char === ',' && depth === 0) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.filter((part) => part.trim().length > 0);
}

/** Whether an instance passes the caller's own props on: `{...Astro.props}` or `{...rest}` of them. */
function spreadsProps(caller: AuditFileInput, props: Readonly<Record<string, { readonly type: string; readonly value?: string }>> | undefined): boolean {
  const rest = destructuredProps(caller.frontmatter).rest;
  return Object.values(props ?? {}).some((value) => value.type === 'spread' && (value.value === 'Astro.props' || (rest !== undefined && value.value === rest)));
}

// Where a prop nobody passes gets its value: a literal default in the component, or a constant it imports.
function defaultOf(file: AuditFileInput, prop: string): Authored | undefined {
  const fallback = destructuredProps(file.frontmatter).defaults.get(prop);
  if (fallback === undefined) {
    return undefined;
  }
  return importedIdentifier(file, fallback) ?? { kind: 'file', file: file.file };
}

function importedIdentifier(file: AuditFileInput, code: string): Authored | undefined {
  for (const name of identifiers(code)) {
    const decl = file.imports.find((entry) => entry.name === name);
    if (decl !== undefined && !decl.path.endsWith('.astro')) {
      return { kind: 'constant', from: file.file, name, module: decl.path };
    }
  }
  return undefined;
}

/** The instances from the page down to `target`, breadth first; undefined when the page does not render it. */
function instanceChain(input: TraceInput, target: string): readonly Hop[] | undefined {
  if (target === input.page.file) {
    return [];
  }
  const queue: { readonly file: AuditFileInput; readonly hops: readonly Hop[] }[] = [{ file: input.page, hops: [] }];
  const seen = new Set<string>([input.page.file]);
  for (let visited = 0; visited < queue.length; visited++) {
    const entry = queue[visited];
    assert(entry !== undefined, 'instanceChain: the queue holds an entry');
    if (entry.hops.length >= HOPS_MAX) {
      continue;
    }
    for (const { node, path } of components(entry.file.nodes)) {
      const file = input.resolve(entry.file, node.name);
      const callee = file === undefined ? undefined : input.files.get(file);
      if (callee === undefined) {
        continue;
      }
      const hops = [...entry.hops, { caller: entry.file, path, tag: node.name, callee }];
      if (callee.file === target) {
        return hops;
      }
      if (!seen.has(callee.file)) {
        seen.add(callee.file);
        queue.push({ file: callee, hops });
      }
    }
  }
  return undefined;
}

function components(nodes: readonly PageNode[]): readonly { readonly node: PairedNode; readonly path: readonly number[] }[] {
  const found: { node: PairedNode; path: readonly number[] }[] = [];
  const pending = nodes.map((node, index) => ({ node, path: [index] as readonly number[] })).reverse();
  for (let visited = 0; pending.length > 0; visited++) {
    assert(visited < NODES_MAX, 'components: a file stays inside the tree bound');
    const entry = pending.pop();
    assert(entry !== undefined, 'components: the stack holds an entry');
    if (entry.node.kind === 'component') {
      found.push({ node: entry.node, path: entry.path });
    }
    pending.push(
      ...nodeChildren(entry.node)
        .map((child, index) => ({ node: child, path: [...entry.path, index] }))
        .reverse(),
    );
  }
  return found;
}

/** The node at a structural path, or undefined where the path leaves the tree. */
export function nodeAt(nodes: readonly PageNode[], path: readonly number[]): PageNode | undefined {
  let list = nodes;
  let node: PageNode | undefined;
  for (const index of path) {
    node = list[index];
    if (node === undefined) {
      return undefined;
    }
    list = nodeChildren(node);
  }
  return node;
}
