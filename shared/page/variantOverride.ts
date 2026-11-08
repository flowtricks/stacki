// A hover preview of one component prop: the canvas renders the page as if one
// instance had a different value for one prop, and nothing is written.
//
// Desktop's dev server answers a page request that carries VARIANT_HEADER by
// rendering it inside a scope (electron/previewServer/previewMarkers.ts), and
// every marked component checks that scope as its frontmatter starts
// (withVariantOverride): the instance whose marker path is the override's
// target sees the overridden prop, every other instance renders as written.
// The renderer asks for it (src/app/shell/desktopPropPreview.ts) and the canvas
// fetches and shows it (electron/previewClient/morphClient.ts). The source,
// the undo history and every other client are untouched, so a preview can only
// ever be dismissed or replaced by the real rendering of a real write.
//
// The override crosses two boundaries — a postMessage into the canvas and an
// HTTP header into the dev server — so both ends parse it with this module.

import { assert } from '../core/assert';

/** The request header that carries a preview override, URI-encoded JSON. */
export const VARIANT_HEADER = 'x-avb-variant';

export const VARIANT_LIMITS = {
  // A project-relative file path, or a marker path with its file namespace.
  pathCharsMax: 1_000,
  propCharsMax: 100,
  // An option of a union prop: a word, never a document.
  valueCharsMax: 500,
  // The encoded header: every field at its bound, encoded, with room to spare.
  headerCharsMax: 16_000,
} as const;

/** One instance's one prop, as the preview renders it. `value` undefined renders the prop unset. */
export interface VariantOverride {
  readonly component: string;
  readonly target: string;
  readonly prop: string;
  readonly value: string | number | undefined;
}

/** What the renderer tells the canvas: show a rendering, drop it, or keep it for the write that follows. */
export type VariantMessage = { readonly kind: 'show'; readonly override: VariantOverride } | { readonly kind: 'cancel' } | { readonly kind: 'commit' };

export const VARIANT_MESSAGE_TYPES = {
  show: 'avb:variant',
  cancel: 'avb:variant-cancel',
  commit: 'avb:variant-commit',
} as const;

// A prop name as a component declares one; never a key that reaches the prototype.
const PROP_NAME = /^[A-Za-z_$][\w$-]*$/;
const FORBIDDEN_PROPS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

function boundedText(value: unknown, charsMax: number): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  if (value.length === 0) {
    return undefined;
  }
  return value.length <= charsMax ? value : undefined;
}

/** An override from untrusted input, or undefined when any part of it is not one. */
export function parseVariantOverride(input: unknown): VariantOverride | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return undefined;
  }
  const component = boundedText(Reflect.get(input, 'component'), VARIANT_LIMITS.pathCharsMax);
  const target = boundedText(Reflect.get(input, 'target'), VARIANT_LIMITS.pathCharsMax);
  const prop = boundedText(Reflect.get(input, 'prop'), VARIANT_LIMITS.propCharsMax);
  if (component === undefined || target === undefined || prop === undefined) {
    return undefined;
  }
  if (!PROP_NAME.test(prop)) {
    return undefined;
  }
  if (FORBIDDEN_PROPS.has(prop)) {
    return undefined;
  }
  const raw: unknown = Reflect.get(input, 'value');
  let value: string | number | undefined;
  if (raw === undefined) {
    value = undefined;
  } else if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) {
      return undefined;
    }
    value = raw;
  } else if (typeof raw === 'string') {
    if (raw.length > VARIANT_LIMITS.valueCharsMax) {
      return undefined;
    }
    value = raw;
  } else {
    return undefined;
  }
  return { component, target, prop, value };
}

/** A canvas message from the renderer, or undefined when it is not a preview message. */
export function parseVariantMessage(input: unknown): VariantMessage | undefined {
  if (typeof input !== 'object' || input === null) {
    return undefined;
  }
  const type: unknown = Reflect.get(input, 'type');
  if (type === VARIANT_MESSAGE_TYPES.cancel) {
    return { kind: 'cancel' };
  }
  if (type === VARIANT_MESSAGE_TYPES.commit) {
    return { kind: 'commit' };
  }
  if (type === VARIANT_MESSAGE_TYPES.show) {
    const override = parseVariantOverride(Reflect.get(input, 'override'));
    return override === undefined ? undefined : { kind: 'show', override };
  }
  return undefined;
}

/** The header value for an override: JSON (an unset value is an absent key), URI-encoded so it is ASCII. */
export function variantHeaderValue(override: VariantOverride): string {
  const encoded = encodeURIComponent(JSON.stringify(override));
  assert(encoded.length <= VARIANT_LIMITS.headerCharsMax, 'variantHeaderValue: the header is bounded');
  assert(parseVariantHeader(encoded) !== undefined, 'variantHeaderValue: the header parses back');
  return encoded;
}

/** The override a request header carries, or undefined when it carries none or a malformed one. */
export function parseVariantHeader(header: unknown): VariantOverride | undefined {
  if (typeof header !== 'string' || header.length > VARIANT_LIMITS.headerCharsMax) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(header));
    return parseVariantOverride(parsed);
  } catch {
    return undefined; // Malformed URI encoding or JSON: no override, an ordinary render.
  }
}

/** The global the dev server's scope lives on, shared by its middleware and every component module. */
export const VARIANT_SCOPE_GLOBAL = '__avbVariantScope';

/**
 * The statement a marked component runs first: when the request is a preview
 * of this component's instance at the override's target, that instance's prop
 * becomes the override's value before the frontmatter reads `Astro.props`.
 * One line, so the component's own line numbers move by one at most.
 */
export function variantOverrideStatement(component: string): string {
  assert(component.length > 0, 'variantOverrideStatement: names a component');
  assert(component.length <= VARIANT_LIMITS.pathCharsMax, 'variantOverrideStatement: the path is bounded');
  const scope = `globalThis[${JSON.stringify(VARIANT_SCOPE_GLOBAL)}]`;
  return (
    `{ const __avbVariant = ${scope} && ${scope}.getStore(); const __avbPath = Astro.props["data-avb-p"]; ` +
    `if (__avbVariant && __avbVariant.component === ${JSON.stringify(component)} && typeof __avbPath === "string" && __avbPath.split(" ")[0] === __avbVariant.target) { ` +
    `if (__avbVariant.value === undefined) { delete Astro.props[__avbVariant.prop]; } else { Astro.props[__avbVariant.prop] = __avbVariant.value; } } }`
  );
}

/** `marked` with the override statement as its frontmatter's first line (a frontmatter is added when it has none). */
export function withVariantOverride(marked: string, component: string): string {
  const statement = variantOverrideStatement(component);
  const opening = /^---\r?\n/.exec(marked);
  const result = opening === null ? `---\n${statement}\n---\n${marked}` : `${opening[0]}${statement}\n${marked.slice(opening[0].length)}`;
  assert(result.startsWith('---'), 'withVariantOverride: the frontmatter fence stays first');
  assert(result.includes(marked.slice(opening === null ? 0 : opening[0].length)), 'withVariantOverride: the marked text is kept whole');
  return result;
}
