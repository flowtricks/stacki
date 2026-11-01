// Who an element is and where it is read: its serialized id, its class tokens
// as CSS, the host bridge's api, the snapshot a selection is read from, and
// the breakpoint the canvas shows (webflow.ts).

import { findNode, getHost, onHostChange, propText, type HostNode } from './host';
import type { BreakpointId, ElementSnapshot } from './styleTypes';

export type AnyElement = unknown;

// ───────────────────────────── Identity helpers ─────────────────────────────

export function serializeElementId(id: unknown): string {
  if (id === undefined) {
    return '';
  }
  // An element id handed through the Designer-shaped API may spell "none" as null.
  if (id === null) {
    return '';
  }
  if (typeof id === 'string') {
    return id;
  }
  if (typeof id === 'object' && 'id' in id && typeof id.id === 'string') {
    return id.id;
  }
  try {
    return JSON.stringify(id);
  } catch {
    return String(id);
  }
}

// Kept from the Webflow build so a name typed in the class field compiles the
// same way it would there — lowercased, spaces to hyphens, digits prefixed.
export function webflowClassToCss(name: string): string {
  const compiled = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\-_\s]/g, '')
    .replace(/\s+/g, '-');
  return /^[0-9]/.test(compiled) ? `_${compiled}` : compiled;
}

// The panel drives itself off two Designer events: which element is selected
// and which breakpoint is active. Both come from the app, so this exposes just
// those — enough for the panel to run, and nothing that implies a Designer is
// present (native styling still reports unavailable further down).
export type Unsub = () => void;

export function webflowApi() {
  return {
    getSelectedElement: async (): Promise<AnyElement> => nodeById(getHost().selectedId),
    subscribe: (event: string, callback: (value: unknown) => void): Unsub => {
      if (event === 'selectedelement') {
        let last = getHost().selectedId;
        return onHostChange(() => {
          const now = getHost().selectedId;
          if (now === last) {
            return;
          }
          last = now;
          callback(nodeById(now));
        });
      }
      if (event === 'mediaquery') {
        let last = getHost().device;
        return onHostChange(() => {
          const now = getHost().device;
          if (now === last) {
            return;
          }
          last = now;
          void getCurrentBreakpoint().then(callback);
        });
      }
      return () => {};
    },
  };
}

export const nodeById = (id: string | undefined): HostNode | undefined => (id ? findNode(getHost().nodes, id) : undefined);

// A node's classes. `class="a b"` is readable straight from the source, but
// `class:list={[…]}` / `class={expr}` are expressions with no class text at
// all — for those the only truth is what the page rendered. The preview reports
// that for the selected element, so merge it in: a static class inside a
// class:list shows up, and a computed one (`gap-${gap}`) shows the value THIS
// instance resolved to. Source order first, then anything only the DOM knows.
// The string literals in an expression-valued class attribute. `class:list={[
// "container", gap !== "8" && `gap-${gap}`, ...rest ]}` yields `container` — a
// literal is a class this element always has, so it can be shown straight away
// instead of waiting on the canvas. Template literals with a `${}` hole are
// skipped: only the rendered element knows what they became. Values that aren't
// class-shaped (selectors, URLs, sentences) are dropped.
export const CLASS_RE = /^[A-Za-z_-][A-Za-z0-9_-]*$/;
export const literalClasses = (node: HostNode | undefined, name: string): string[] => {
  const prop = node?.props?.[name];
  if (!prop || prop.type !== 'expr') {
    return [];
  }
  const out: string[] = [];
  for (const [, quote, body] of String(prop.value ?? '').matchAll(/(['"`])([^'"`]*)\1/g)) {
    const literalBody = body ?? '';
    if (quote === '`' && literalBody.includes('${')) {
      continue;
    }
    for (const tok of literalBody.split(/\s+/)) {
      if (CLASS_RE.test(tok)) {
        out.push(tok);
      }
    }
  }
  return out;
};

export const classTokens = (node: HostNode | undefined): string[] => {
  // A class can be named in more than one place (`class` plus `class:list`, or
  // twice within one list) — the element still carries it once.
  const authored = [
    ...new Set([
      ...propText(node, 'class').split(/\s+/).filter(Boolean),
      // `class:list={[…]}`, and `class={…}` when it's an expression.
      ...literalClasses(node, 'class:list'),
      ...literalClasses(node, 'class'),
    ]),
  ];
  const host = getHost();
  // Rendered classes describe the selected element only — attributing them to
  // any other node (an ancestor being matched, say) would be wrong.
  if (!node || node.id !== host.selectedId) {
    return authored;
  }
  const out = [...authored];
  for (const cls of host.renderedClasses || []) {
    if (cls && !out.includes(cls)) {
      out.push(cls);
    }
  }
  return out;
};

// Elements reach the panel through the Designer-shaped API as `unknown`; one is
// read as a node only when it carries a node's identity.
export function isHostNode(value: unknown): value is HostNode {
  if (typeof value === 'object' && value !== null) {
    if ('id' in value && 'kind' in value) {
      return typeof value.id === 'string' && typeof value.kind === 'string';
    }
  }
  return false;
}

export async function buildSnapshot(element: AnyElement): Promise<ElementSnapshot> {
  const node = typeof element === 'string' ? nodeById(element) : isHostNode(element) ? element : undefined;
  const classes = classTokens(node);
  const attributes: Record<string, string> = {};
  for (const [key, value] of Object.entries(node?.props || {})) {
    if (value && value.type === 'string') {
      attributes[key] = String(value.value ?? '');
    } else if (value && value.type === 'bare') {
      attributes[key] = '';
    }
  }
  const id = propText(node, 'id');
  if (id) {
    attributes['id'] = id;
  }
  if (classes.length) {
    attributes['class'] = classes.join(' ');
  }
  return {
    // A component instance renders markup we can't see from here, so it has
    // no tag of its own — selectors match it by class only.
    tag: node?.kind === 'element' ? String(node.name || '').toLowerCase() : undefined,
    webflowType: node?.kind === 'component' ? 'Component' : node?.kind || 'Element',
    id: id || undefined,
    classes,
    classList: classes,
    attributes,
  };
}

export async function resolveIdentityElement(selected: AnyElement): Promise<AnyElement> {
  return selected;
}

// ───────────────────────────── Breakpoints ─────────────────────────────

// The canvas has three widths; they map onto the scale the panel already
// speaks so its breakpoint controls need no changes.
export async function getCurrentBreakpoint(): Promise<BreakpointId> {
  const device = getHost().device;
  if (device === 'tablet') {
    return 'medium';
  }
  if (device === 'phone') {
    return 'small';
  }
  return 'main';
}
