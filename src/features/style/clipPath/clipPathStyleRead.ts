// Reading clip-path from the designer's styles: style handles, an element's
// classes, lookup candidates, and the declaration at a breakpoint with where
// it came from (ClipPath.tsx).

import type { ApiNullable, ElementAttributeHandle, StyleHandle, StyleTargetOptions, WebflowStyleLookup } from './webflowDesigner';
import { type StyleLookupDiagnostic, type PastedShapeSvgCache } from './clipPathTypes';
import {
  isElementStyleSource,
  STYLE_LOOKUP_TIMEOUT_MS,
  STYLE_PATH_LOOKUP_TIMEOUT_MS,
  SHAPE_STRETCH_PROPERTY,
  SHAPE_CONTAIN_PROPERTY,
  CLIP_PATH_DEBUG,
} from './clipPathConstants';
import { formatClipPath } from './clipPathFormat';
import { isNoneClipPathValue } from './svgContours';

export async function writePastedShapeMetadata(style: StyleHandle, cache: PastedShapeSvgCache | undefined, options?: StyleTargetOptions) {
  const writeProperty = async (property: string, nextValue: string) => {
    try {
      await style.setProperty?.(property, nextValue, options);
    } catch {
      // Some Webflow style handles may reject custom properties.
    }
  };

  const removeProperty = async (property: string) => {
    try {
      await style.removeProperty?.(property, options);
    } catch {
      // Metadata is only an enhancement for restoring the fit toggle.
    }
  };

  if (!cache) {
    await Promise.all([removeProperty(SHAPE_STRETCH_PROPERTY), removeProperty(SHAPE_CONTAIN_PROPERTY)]);
    return;
  }

  await Promise.all([
    writeProperty(SHAPE_STRETCH_PROPERTY, formatClipPath(cache.stretch)),
    writeProperty(SHAPE_CONTAIN_PROPERTY, formatClipPath(cache.contain)),
  ]);
}

export async function writeClipPathToStyle(
  style: StyleHandle,
  value: string,
  options: {
    shapeSvgCache?: PastedShapeSvgCache | undefined;
    styleOptions?: StyleTargetOptions;
  } = {},
) {
  const styleOptions = options.styleOptions;
  if (isNoneClipPathValue(value)) {
    if (styleOptions) {
      await style.setProperty?.('clip-path', 'none', styleOptions);
    } else if (style.removeProperty) {
      await style.removeProperty('clip-path', styleOptions);
    } else {
      await style.setProperty?.('clip-path', 'none', styleOptions);
    }

    await writePastedShapeMetadata(style, undefined, styleOptions);
    return;
  }

  await style.setProperty?.('clip-path', value, styleOptions);
  await writePastedShapeMetadata(style, options.shapeSvgCache || undefined, styleOptions);
}

// The styles an element reports, as the Designer API delivers them: the list, or
// null, holding handles or nulls.
export type StyleHandleList = ApiNullable<Array<ApiNullable<StyleHandle>>>;

export function isStyleHandle(style: ApiNullable<StyleHandle> | undefined): style is StyleHandle {
  return Boolean(style?.getProperty || style?.getProperties || style?.setProperty || style?.removeProperty);
}

export function debugClipPath(label: string, details?: unknown) {
  if (!CLIP_PATH_DEBUG) {
    return;
  }
  try {
    console.log(`[Moden ClipPath debug] ${label}\n${JSON.stringify(details, null, 2)}`);
  } catch {
    console.log(`[Moden ClipPath debug] ${label}`, details);
  }
}

export function canWriteClipPathValue(style: ApiNullable<StyleHandle> | undefined, value: string) {
  if (!style) {
    return false;
  }
  return isNoneClipPathValue(value) ? Boolean(style.setProperty || style.removeProperty) : Boolean(style.setProperty);
}

export function getStyleHandles(styles: StyleHandleList | undefined) {
  return Array.isArray(styles) ? styles.filter(isStyleHandle) : [];
}

export function addUniqueStyleHandle(styles: StyleHandle[], style: StyleHandle, seenRefs: Set<StyleHandle>, seenIds: Set<string>) {
  if (style.id) {
    if (seenIds.has(style.id)) {
      return;
    }
    seenIds.add(style.id);
  } else if (seenRefs.has(style)) {
    return;
  }

  seenRefs.add(style);
  styles.push(style);
}

export async function readOptional<T>(reader: (() => Promise<T> | undefined) | undefined) {
  if (!reader) {
    return undefined;
  }

  try {
    return await reader();
  } catch {
    return undefined;
  }
}

export async function readOptionalWithTimeout<T>(reader: (() => Promise<T> | undefined) | undefined, timeoutMs: number) {
  if (!reader) {
    return undefined;
  }

  let timeoutId: number | undefined = undefined;
  try {
    return await Promise.race([
      reader(),
      new Promise<undefined>((resolve) => {
        timeoutId = window.setTimeout(() => resolve(undefined), timeoutMs);
      }),
    ]);
  } catch {
    return undefined;
  } finally {
    if (timeoutId !== undefined) {
      window.clearTimeout(timeoutId);
    }
  }
}

export function selectedElementKey(element: unknown) {
  if (!isElementStyleSource(element)) {
    return undefined;
  }
  const id = element.id;
  if (!id) {
    return undefined;
  }
  if (typeof id === 'string') {
    return id;
  }

  try {
    return JSON.stringify(id);
  } catch {
    return String(id);
  }
}

export function addStyleHandles(styles: StyleHandle[], nextStyles: StyleHandleList | undefined, seenRefs: Set<StyleHandle>, seenIds: Set<string>) {
  getStyleHandles(nextStyles).forEach((style) => {
    addUniqueStyleHandle(styles, style, seenRefs, seenIds);
  });
}

export async function getElementPrimaryStyleHandles(element: unknown) {
  if (!isElementStyleSource(element)) {
    return [];
  }
  const source = element;
  const styles: StyleHandle[] = [];
  const seenRefs = new Set<StyleHandle>();
  const seenIds = new Set<string>();

  addStyleHandles(styles, await readOptional(() => source.getStyles?.()), seenRefs, seenIds);

  const selectedStyle = await readOptional(() => source.getStyle?.());
  if (isStyleHandle(selectedStyle)) {
    addUniqueStyleHandle(styles, selectedStyle, seenRefs, seenIds);
  }

  return styles;
}

export function addClassNamesFromValue(classNames: Set<string>, value: unknown) {
  if (typeof value !== 'string') {
    return;
  }

  value
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .forEach((className) => classNames.add(className));
}

export function addClassNamesFromAttributes(classNames: Set<string>, attributes: ApiNullable<Array<ElementAttributeHandle>> | undefined) {
  if (!Array.isArray(attributes)) {
    return;
  }

  attributes.forEach((attribute) => {
    if (typeof attribute?.name === 'string' && attribute.name.toLowerCase() === 'class') {
      addClassNamesFromValue(classNames, attribute.value);
    }
  });
}

export async function addClassNamesFromStyleHandles(classNames: Set<string>, styles: StyleHandleList | undefined) {
  const styleNames = await Promise.all(getStyleHandles(styles).map((style) => readOptionalWithTimeout(() => style.getName?.(), STYLE_LOOKUP_TIMEOUT_MS)));

  styleNames.filter((name): name is string => typeof name === 'string' && Boolean(name.trim())).forEach((name) => classNames.add(name.trim()));
}

export async function getElementClassNames(element: unknown, styles?: StyleHandleList | undefined) {
  if (!isElementStyleSource(element)) {
    return [];
  }
  const source = element;
  const classNames = new Set<string>();
  await addClassNamesFromStyleHandles(classNames, styles);
  if (classNames.size) {
    return [...classNames];
  }

  const [attributeClass, resolvedAttributeClass, customAttributeClass, attributes, resolvedAttributes, customAttributes] = await Promise.all([
    readOptionalWithTimeout(() => source.getAttributeValue?.('class'), STYLE_LOOKUP_TIMEOUT_MS),
    readOptionalWithTimeout(() => source.getResolvedAttributeValue?.('class'), STYLE_LOOKUP_TIMEOUT_MS),
    readOptionalWithTimeout(() => source.getCustomAttribute?.('class'), STYLE_LOOKUP_TIMEOUT_MS),
    readOptionalWithTimeout(() => source.getAttributes?.(), STYLE_LOOKUP_TIMEOUT_MS),
    readOptionalWithTimeout(() => source.getResolvedAttributes?.(), STYLE_LOOKUP_TIMEOUT_MS),
    readOptionalWithTimeout(() => source.getAllCustomAttributes?.(), STYLE_LOOKUP_TIMEOUT_MS),
  ]);

  addClassNamesFromValue(classNames, attributeClass);
  addClassNamesFromValue(classNames, resolvedAttributeClass);
  addClassNamesFromValue(classNames, customAttributeClass);
  addClassNamesFromAttributes(classNames, attributes);
  addClassNamesFromAttributes(classNames, resolvedAttributes);
  addClassNamesFromAttributes(classNames, customAttributes);

  return [...classNames];
}

export function getStyleLookupCandidates(classNames: string[]) {
  const candidates: Array<string | string[]> = [];
  const seen = new Set<string>();

  const addCandidate = (candidate: string | string[]) => {
    const key = Array.isArray(candidate) ? candidate.join('\u0000') : candidate;
    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    candidates.push(candidate);
  };

  classNames.forEach((className) => {
    addCandidate(className);
  });
  for (let endIndex = 1; endIndex < classNames.length; endIndex += 1) {
    addCandidate(classNames.slice(0, endIndex + 1));
  }

  return candidates;
}

export function getStandaloneStyleLookupCandidates(classNames: string[]) {
  return [...new Set(classNames)];
}

// How far up a style's parent chain the editor reads. A Webflow combo class nests
// one level per class in the combo, so 20 is far past any real selector; a chain
// longer than that is treated as unreadable rather than followed.
export const CLIP_PATH_LIMITS = { styleDepthMax: 20 } as const;

export async function getStyleNamePath(style: StyleHandle, depth = 0): Promise<string[]> {
  if (depth > CLIP_PATH_LIMITS.styleDepthMax) {
    return [];
  }

  const parent = await readOptionalWithTimeout(() => style.getParent?.(), STYLE_PATH_LOOKUP_TIMEOUT_MS);
  const parentPath = isStyleHandle(parent) ? await getStyleNamePath(parent, depth + 1) : [];
  const name = await readOptionalWithTimeout(() => style.getName?.(), STYLE_PATH_LOOKUP_TIMEOUT_MS);

  return typeof name === 'string' && name.trim() ? [...parentPath, name] : parentPath;
}

export async function lookupStyleByNameCandidate(webflowApi: WebflowStyleLookup, candidate: string | string[]) {
  const timeout = Symbol('timeout');
  let timeoutId: number | undefined = undefined;

  try {
    const result = await Promise.race([
      webflowApi.getStyleByName?.(candidate),
      new Promise<typeof timeout>((resolve) => {
        timeoutId = window.setTimeout(() => resolve(timeout), STYLE_LOOKUP_TIMEOUT_MS);
      }),
    ]);

    if (result === timeout) {
      return { candidate, source: 'getStyleByName' as const, timedOut: true, found: false };
    }

    if (!isStyleHandle(result)) {
      return { candidate, source: 'getStyleByName' as const, found: false };
    }

    return {
      candidate,
      source: 'getStyleByName' as const,
      found: true,
      style: result,
      id: result.id || undefined,
    };
  } catch {
    return { candidate, source: 'getStyleByName' as const, found: false };
  } finally {
    if (timeoutId !== undefined) {
      window.clearTimeout(timeoutId);
    }
  }
}

export async function getClassStyleHandlesWithDiagnostics(classNames: string[], webflowApi: WebflowStyleLookup) {
  if (!classNames.length) {
    const diagnostics: StyleLookupDiagnostic[] = [];
    return { styles: [], diagnostics };
  }

  const styles: StyleHandle[] = [];
  const seenRefs = new Set<StyleHandle>();
  const seenIds = new Set<string>();
  const candidates = getStandaloneStyleLookupCandidates(classNames);
  const diagnostics: StyleLookupDiagnostic[] = [];

  if (webflowApi.getStyleByName) {
    const lookupResults = await Promise.all(candidates.map((candidate) => lookupStyleByNameCandidate(webflowApi, candidate)));
    lookupResults.forEach((result) => {
      diagnostics.push({
        candidate: result.candidate,
        source: result.source,
        found: result.found,
        ...(result.timedOut !== undefined ? { timedOut: result.timedOut } : {}),
        ...(result.id !== undefined ? { id: result.id } : {}),
      });
      if ('style' in result && isStyleHandle(result.style)) {
        addUniqueStyleHandle(styles, result.style, seenRefs, seenIds);
      }
    });
  }

  return { styles, diagnostics };
}

export async function getElementClassStyleHandles(element: unknown, webflowApi: WebflowStyleLookup, elementStyles?: StyleHandleList | undefined) {
  const { styles } = await getClassStyleHandlesWithDiagnostics(await getElementClassNames(element, elementStyles), webflowApi);
  return styles;
}
