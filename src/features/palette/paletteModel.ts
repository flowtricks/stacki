import type { ScanComponent } from '../../../shared/properties/projectScan';
import type { TrailingSlash } from '../../editor/pageState';
import { count, list, optional, pathText, record, text } from '../../../shared/core/boundary';
import { assert } from '../../../shared/core/assert';

export interface ComponentUsageFile {
  readonly rel: string;
  readonly path: string;
  readonly kind: 'layout' | 'page' | 'component' | 'file';
  readonly count: number;
}

export type ComponentUsageResult =
  { readonly kind: 'error'; readonly message: string } | { readonly kind: 'ready'; readonly files: readonly ComponentUsageFile[] };

export interface ComponentPreviewMessage {
  readonly status: 'empty' | 'ready';
  /** Why an empty preview is empty, in the route's words (missing data, nothing rendered). */
  readonly reason?: string;
}

/** The longest reason a preview page may give; a longer one is cut, never trusted to fit. */
export const previewReasonCharsMax = 500;

export function parseComponentPreviewMessage(input: unknown): ComponentPreviewMessage | undefined {
  if (typeof input !== 'object' || input === null) {
    return undefined;
  }
  if (!('type' in input) || input.type !== 'avb:component-preview') {
    return undefined;
  }
  if (!('status' in input)) {
    return undefined;
  }
  if (input.status === 'ready') {
    return { status: input.status };
  }
  if (input.status === 'empty') {
    const reason = 'reason' in input && typeof input.reason === 'string' ? input.reason.trim().slice(0, previewReasonCharsMax) : '';
    return reason === '' ? { status: 'empty' } : { status: 'empty', reason };
  }
  return undefined;
}

export function parseComponentUsage(input: unknown): ComponentUsageResult {
  const value = record(input);
  const error = optional(text)(value['error']);
  if (error !== undefined) {
    if (value['files'] !== undefined) {
      throw new Error('Component usage: error result cannot contain files');
    }
    return { kind: 'error', message: error };
  }
  const files = list(parseUsageFile)(value['files']);
  const total = optional(count)(value['total']);
  const seen = new Set<string>();
  let sum = 0;
  for (const file of files) {
    if (seen.has(file.rel)) {
      throw new Error(`Component usage: duplicate file ${file.rel}`);
    }
    seen.add(file.rel);
    sum += file.count;
    if (!Number.isSafeInteger(sum)) {
      throw new Error('Component usage: total exceeds safe integer range');
    }
  }
  if (total !== undefined && total !== sum) {
    throw new Error('Component usage: total does not match files');
  }
  return { kind: 'ready', files };
}

export function groupPaletteComponents(components: readonly ScanComponent[]): readonly (readonly [string, readonly ScanComponent[]])[] {
  const groups = new Map<string, ScanComponent[]>();
  for (const component of components) {
    const folder = component.folder;
    const group = groups.get(folder);
    if (group) {
      group.push(component);
    } else {
      groups.set(folder, [component]);
    }
  }
  return [...groups.entries()].sort(([left], [right]) => {
    if (left === '') {
      return -1;
    }
    if (right === '') {
      return 1;
    }
    return left.localeCompare(right);
  });
}

export function prettyComponentName(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
}

/** How the preview route lays a component out; see ComponentPreviewLayout in the route. `popup` is what it always did. */
export type PreviewLayout = 'popup' | 'page';

export function componentPreviewURL(
  devURL: string,
  component: ScanComponent,
  trailingSlash: TrailingSlash,
  options: { readonly layout: PreviewLayout } = { layout: 'popup' },
): string {
  // A basename cannot distinguish components in different folders or a layout
  // from a component. Match the scan's folder convention without exposing an absolute path.
  const base = component.isLayout ? 'src' : 'src/components';
  const file =
    component.origin?.kind === 'package' ? packagePreviewPath(component) : [base, component.folder, `${component.name}.astro`].filter(Boolean).join('/');
  const query = new URLSearchParams({ c: component.name, p: file });
  // The popup layout is the route's default, so its URL stays exactly as it was.
  if (options.layout === 'page') {
    query.set('layout', 'page');
  }
  // Astro 5 returns a 404 when an injected page violates the project's slash policy.
  const route = trailingSlash === 'always' ? '/__avb/preview/' : '/__avb/preview';
  return `${devURL.replace(/\/+$/, '')}${route}?${query}`;
}

function packagePreviewPath(component: ScanComponent): string {
  assert(component.origin?.kind === 'package', 'Package previews require package origin');
  const file = component.path.replaceAll('\\', '/');
  const index = file.lastIndexOf(`node_modules/${component.origin.package}/`);
  assert(index >= 0, 'Package preview identity retains its installed path');
  return file.slice(index);
}

export function usageFileLabel(file: ComponentUsageFile): string {
  const base = file.rel.replace(/^src\//, '').replace(/\.astro$/, '');
  if (file.kind === 'page') {
    return base.replace(/^pages\//, '');
  }
  return prettyComponentName(base.split('/').pop() ?? '');
}

function parseUsageFile(input: unknown): ComponentUsageFile {
  const value = record(input);
  const kind = parseUsageKind(value['kind']);
  const instanceCount = count(value['count']);
  if (instanceCount === 0) {
    throw new Error('Component usage: files must contain an instance');
  }
  return {
    rel: pathText(value['rel']),
    path: pathText(value['path']),
    kind,
    count: instanceCount,
  };
}

function parseUsageKind(input: unknown): ComponentUsageFile['kind'] {
  if (input === 'layout' || input === 'page' || input === 'component' || input === 'file') {
    return input;
  }
  throw new Error('Component usage: unknown file kind');
}
