// Writing clip-path to the designer's styles: which style an element's
// clip-path belongs to, finding or creating it, the cascade's winner, and the
// write itself (ClipPath.tsx).

import type { ApiNullable, BreakpointId, StyleHandle, StyleTargetOptions, WebflowStyleEditor, WebflowStyleLookup } from './webflowDesigner';
import { type StylePropertyRead, type ClipPathStyleOrigin } from './clipPathTypes';
import { STYLE_LOOKUP_TIMEOUT_MS, STYLE_PROPERTY_LOOKUP_TIMEOUT_MS, SHAPE_STRETCH_PROPERTY, SHAPE_CONTAIN_PROPERTY } from './clipPathConstants';
import { parseClipPathInput } from './shapeFunctionModel';
import { isNoneClipPathValue } from './svgContours';
import {
  type StyleHandleList,
  isStyleHandle,
  canWriteClipPathValue,
  getStyleHandles,
  addUniqueStyleHandle,
  readOptional,
  readOptionalWithTimeout,
  addStyleHandles,
  getElementPrimaryStyleHandles,
  CLIP_PATH_LIMITS,
  getStyleNamePath,
  getElementClassStyleHandles,
} from './clipPathStyleRead';

export function normalizeStylePropertyValue(value: unknown) {
  return typeof value === 'string' ? value : undefined;
}

export function hasClipPathDeclaration(value: string | undefined) {
  return Boolean(value && value.trim());
}

export function styleOptionsForBreakpoint(breakpoint: BreakpointId | undefined): StyleTargetOptions | undefined {
  return breakpoint && breakpoint !== 'main' ? { breakpoint } : undefined;
}

export function inheritedBreakpointChain(breakpoint: BreakpointId | undefined) {
  if (breakpoint === 'xxl') {
    return ['xxl', 'xl', 'large', 'main'] as const;
  }
  if (breakpoint === 'xl') {
    return ['xl', 'large', 'main'] as const;
  }
  if (breakpoint === 'large') {
    return ['large', 'main'] as const;
  }
  if (breakpoint === 'medium') {
    return ['medium', 'main'] as const;
  }
  if (breakpoint === 'small') {
    return ['small', 'medium', 'main'] as const;
  }
  if (breakpoint === 'tiny') {
    return ['tiny', 'small', 'medium', 'main'] as const;
  }
  return ['main'] as const;
}

export function clipPathStyleOriginFromSource(sourceBreakpoint: BreakpointId | undefined, activeBreakpoint: BreakpointId): ClipPathStyleOrigin {
  if (!sourceBreakpoint) {
    return 'none';
  }
  return sourceBreakpoint === activeBreakpoint ? 'current' : 'inherited';
}

export async function readStylePropertyDeclarationAt(style: StyleHandle, property: string, options?: StyleTargetOptions) {
  let propertiesWereRead = false;

  try {
    const properties = await readOptionalWithTimeout(() => style.getProperties?.(options), STYLE_PROPERTY_LOOKUP_TIMEOUT_MS);
    propertiesWereRead = true;
    const raw = normalizeStylePropertyValue(properties?.[property]);
    if (hasClipPathDeclaration(raw)) {
      return raw;
    }
  } catch {
    // Fall back to direct property lookup when the property map is unavailable.
  }

  try {
    const raw = normalizeStylePropertyValue(await readOptionalWithTimeout(() => style.getProperty?.(property, options), STYLE_PROPERTY_LOOKUP_TIMEOUT_MS));
    if (!hasClipPathDeclaration(raw)) {
      return undefined;
    }
    if (property === 'clip-path' && propertiesWereRead && isNoneClipPathValue(raw)) {
      return undefined;
    }
    return raw;
  } catch {
    return undefined;
  }
}

export async function readStylePropertyDeclarationWithSource(
  style: StyleHandle,
  property: string,
  options?: StyleTargetOptions,
): Promise<StylePropertyRead | undefined> {
  for (const breakpoint of inheritedBreakpointChain(options?.breakpoint || 'main')) {
    const value = await readStylePropertyDeclarationAt(style, property, styleOptionsForBreakpoint(breakpoint));
    if (value && hasClipPathDeclaration(value)) {
      return { value, breakpoint };
    }
  }
  return undefined;
}

export async function readStylePropertyDeclaration(style: StyleHandle, property: string, options?: StyleTargetOptions) {
  return (await readStylePropertyDeclarationWithSource(style, property, options))?.value || undefined;
}

export async function readClipPathDeclarationWithSource(style: StyleHandle, options?: StyleTargetOptions) {
  return readStylePropertyDeclarationWithSource(style, 'clip-path', options);
}

export function parseStoredShapeVariant(value: string | undefined) {
  const parsed = parseClipPathInput(value || '');
  return parsed?.kind === 'shape' ? parsed : undefined;
}

export async function readPastedShapeMetadata(style: StyleHandle, options?: StyleTargetOptions) {
  const [stretchValue, containValue] = await Promise.all([
    readStylePropertyDeclaration(style, SHAPE_STRETCH_PROPERTY, options),
    readStylePropertyDeclaration(style, SHAPE_CONTAIN_PROPERTY, options),
  ]);
  const stretch = parseStoredShapeVariant(stretchValue);
  const contain = parseStoredShapeVariant(containValue);

  return stretch && contain ? { source: 'style', stretch, contain } : undefined;
}

export async function findClipPathStyle(styles: StyleHandleList | undefined, options?: StyleTargetOptions) {
  const styleHandles = getStyleHandles(styles);
  if (!styleHandles.length) {
    return undefined;
  }

  const reads = await Promise.all(
    styleHandles.map(async (style) => {
      try {
        const declaration = await readClipPathDeclarationWithSource(style, options);
        return {
          style,
          raw: declaration?.value || undefined,
          breakpoint: declaration?.breakpoint || undefined,
        };
      } catch {
        return { style, raw: undefined, breakpoint: undefined };
      }
    }),
  );

  const declaredClipPath = [...reads].reverse().find(({ raw }) => hasClipPathDeclaration(raw));
  return declaredClipPath || reads[0];
}

export async function debugStyleSummary(style: StyleHandle, options?: StyleTargetOptions) {
  const [path, properties, directClipPath, inheritedClipPath] = await Promise.all([
    getStyleNamePath(style),
    readOptionalWithTimeout(() => style.getProperties?.(options), STYLE_PROPERTY_LOOKUP_TIMEOUT_MS),
    readOptionalWithTimeout(() => style.getProperty?.('clip-path', options), STYLE_PROPERTY_LOOKUP_TIMEOUT_MS),
    readClipPathDeclarationWithSource(style, options),
  ]);
  return {
    id: style.id || undefined,
    path,
    name: path[path.length - 1] || undefined,
    canSet: Boolean(style.setProperty),
    canRemove: Boolean(style.removeProperty),
    propertiesClipPath: normalizeStylePropertyValue(properties?.['clip-path']),
    directClipPath: normalizeStylePropertyValue(directClipPath),
    inheritedClipPath,
  };
}

export async function debugStyleSummaries(styles: StyleHandleList | undefined, options?: StyleTargetOptions) {
  return Promise.all(getStyleHandles(styles).map((style) => debugStyleSummary(style, options)));
}

export async function resolveWritableClipPathStyleForElement(
  element: unknown | undefined,
  webflowApi: WebflowStyleLookup,
  value: string,
  options?: StyleTargetOptions,
) {
  if (!element) {
    return undefined;
  }

  const primaryStyles = await getElementPrimaryStyleHandles(element);
  const primaryMatch = await findClipPathStyle(primaryStyles, options);
  const classStyles = await getElementClassStyleHandles(element, webflowApi, primaryStyles);
  const classMatch = classStyles.length ? await findClipPathStyle([...classStyles, ...primaryStyles], options) : undefined;
  const candidates: StyleHandle[] = [];
  const seenRefs = new Set<StyleHandle>();
  const seenIds = new Set<string>();

  const addCandidate = (style: ApiNullable<StyleHandle> | undefined) => {
    if (isStyleHandle(style)) {
      addUniqueStyleHandle(candidates, style, seenRefs, seenIds);
    }
  };

  if (classMatch && (hasClipPathDeclaration(classMatch.raw) || !primaryMatch)) {
    addCandidate(classMatch.style);
  }
  addCandidate(primaryMatch?.style);
  addCandidate(classMatch?.style);
  addStyleHandles(candidates, primaryStyles, seenRefs, seenIds);
  addStyleHandles(candidates, classStyles, seenRefs, seenIds);

  return candidates.find((style) => canWriteClipPathValue(style, value)) || undefined;
}

// Resolve the style for an exact class path — `['clip-path']` → standalone
// `.clip-path`, `['hero','clip-path']` → combo `.hero.clip-path` — creating it
// (and any missing parent in the combo chain) when it doesn't exist yet. Used
// when the user has picked specific class tags, so edits land on those exact
// selectors rather than the element's most-specific combo.
// Find the style whose full name-path is EXACTLY `names` (e.g. `['clip-path']`
// → standalone `.clip-path`, not the combo `.hero.clip-path` that also ends in
// `clip-path`). getStyleByName can hand back a combo whose leaf matches, so we
// verify the resolved path before trusting it. Read-only (never creates).
export async function findStyleForClassPath(names: string[], api: WebflowStyleLookup): Promise<StyleHandle | undefined> {
  if (!names.length) {
    return undefined;
  }
  const candidate = names.length === 1 ? names[0] : names;
  if (!candidate) {
    return undefined;
  }
  const existing = await readOptionalWithTimeout(() => api.getStyleByName?.(candidate), STYLE_LOOKUP_TIMEOUT_MS);
  if (!isStyleHandle(existing)) {
    return undefined;
  }
  const path = await getStyleNamePath(existing);
  return path.length === names.length && path.every((name, index) => name === names[index]) ? existing : undefined;
}

// Like findStyleForClassPath, but creates the exact standalone/combo (and any
// missing parent in the chain) when it doesn't exist yet.
export async function resolveOrCreateStyleForClassPath(names: string[], api: WebflowStyleEditor, depth = 0): Promise<StyleHandle | undefined> {
  if (!names.length) {
    return undefined;
  }
  if (depth > CLIP_PATH_LIMITS.styleDepthMax) {
    return undefined;
  }

  const existing = await findStyleForClassPath(names, api);
  if (existing) {
    return existing;
  }
  if (!api.createStyle) {
    return undefined;
  }

  if (names.length === 1) {
    const name = names[0];
    if (!name) {
      return undefined;
    }
    const created = await readOptional(() => api.createStyle?.(name));
    return isStyleHandle(created) ? created : undefined;
  }

  const parent = await resolveOrCreateStyleForClassPath(names.slice(0, -1), api, depth + 1);
  if (!isStyleHandle(parent)) {
    return undefined;
  }
  const name = names[names.length - 1];
  if (!name) {
    return undefined;
  }
  const created = await readOptional(() => api.createStyle?.(name, { parent }));
  return isStyleHandle(created) ? created : undefined;
}

// Resolve which selector's clip-path actually wins the CSS cascade for this
// element: highest specificity first (combo `.a.b` beats standalone `.b`), then
// — for equal specificity — the one defined LATEST in the stylesheet (created
// last in Webflow). Stylesheet order, NOT the element's class-application order,
// is the tiebreaker, mirroring how the browser resolves it. Candidates are the
// element's own combo chain plus each class's standalone style.
export async function resolveCascadeWinnerClipPathStyle(
  classNames: string[],
  primaryStyles: StyleHandle[],
  options: StyleTargetOptions | undefined,
  api: WebflowStyleLookup,
): Promise<
  | {
      style: StyleHandle;
      raw: string;
      breakpoint: BreakpointId;
      namePath: string[];
    }
  | undefined
> {
  const declaring = await readDeclaringCascadeCandidates(classNames, primaryStyles, options, api);
  if (!declaring.length) {
    return undefined;
  }

  const maxSpecificity = Math.max(...declaring.map((entry) => entry.specificity));
  const topTier = declaring.filter((entry) => entry.specificity === maxSpecificity);
  const winner = await latestInStylesheet(topTier, api);
  if (!winner) {
    return undefined;
  }
  return {
    style: winner.style,
    raw: winner.raw,
    breakpoint: winner.breakpoint,
    namePath: winner.namePath,
  };
}

// A style whose clip-path could win the cascade, with what the cascade compares.
export type CascadeCandidate = {
  style: StyleHandle;
  raw: string;
  breakpoint: BreakpointId;
  namePath: string[];
  specificity: number;
};

// The candidates (element combo chain + each class's standalone) that declare a
// clip-path. Each one's clip-path and name-path are read IN PARALLEL — this runs on
// the polling path, so sequential round-trips to the Designer would block the read
// loop.
export async function readDeclaringCascadeCandidates(
  classNames: string[],
  primaryStyles: StyleHandle[],
  options: StyleTargetOptions | undefined,
  api: WebflowStyleLookup,
): Promise<CascadeCandidate[]> {
  const standalones = await Promise.all(classNames.map((name) => findStyleForClassPath([name], api)));
  const candidates: StyleHandle[] = [];
  const seenRefs = new Set<StyleHandle>();
  const seenIds = new Set<string>();
  addStyleHandles(candidates, primaryStyles, seenRefs, seenIds);
  for (const standalone of standalones) {
    if (standalone) {
      addUniqueStyleHandle(candidates, standalone, seenRefs, seenIds);
    }
  }

  const reads = await Promise.all(
    candidates.map(async (style): Promise<CascadeCandidate | undefined> => {
      const declaration = await readClipPathDeclarationWithSource(style, options);
      if (!declaration) {
        return undefined;
      }
      if (!hasClipPathDeclaration(declaration.value)) {
        return undefined;
      }
      const namePath = await getStyleNamePath(style);
      return {
        style,
        raw: declaration.value,
        breakpoint: declaration.breakpoint,
        namePath,
        specificity: namePath.length,
      };
    }),
  );
  return reads.filter((entry): entry is CascadeCandidate => entry !== undefined);
}

// Among equally specific candidates, the one defined latest in the stylesheet wins.
// The (potentially large) full style list is fetched only when there's a real tie.
export async function latestInStylesheet(topTier: CascadeCandidate[], api: WebflowStyleLookup): Promise<CascadeCandidate | undefined> {
  const firstWinner = topTier[0];
  if (!firstWinner) {
    return undefined;
  }
  if (topTier.length <= 1) {
    return firstWinner;
  }
  const allStyles = (await readOptionalWithTimeout(() => api.getAllStyles?.(), STYLE_LOOKUP_TIMEOUT_MS)) || [];
  const orderById = new Map<string, number>();
  allStyles.forEach((style, index) => {
    if (style?.id) {
      orderById.set(style.id, index);
    }
  });
  const orderOf = (entry: CascadeCandidate) => (entry.style.id ? (orderById.get(entry.style.id) ?? -1) : -1);
  let winner = firstWinner;
  for (const entry of topTier.slice(1)) {
    if (orderOf(entry) > orderOf(winner)) {
      winner = entry;
    }
  }
  return winner;
}
