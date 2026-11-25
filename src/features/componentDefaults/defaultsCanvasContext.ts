import { resolveSourceImport } from '../../editor/importPaths';
import { assert } from '../../../shared/core/assert';
import { mapModuleSpecifiers } from '../../../shared/page/frontmatterSource';
import { componentFile, type DefaultsSnapshot } from '../../../shared/properties/componentDefaults';
import { defaultsCanvasSource, type DefaultsCanvasSession } from '../../../shared/properties/defaultsCanvas';
import { canvasContext, canvasNodeAt, renderDefaultsInstance, type CanvasModel } from './defaultsCanvasModel';

export interface DefaultsContext {
  readonly file: string;
  readonly source: string;
  readonly model: CanvasModel;
  readonly path: string;
}

// Copy the current context and splice just the instance. The authored file is never written.
export function prepareDefaultsCanvas(
  file: string,
  snapshot: DefaultsSnapshot,
  context: DefaultsContext,
): { readonly session: DefaultsCanvasSession; readonly source: string } {
  defaultsCanvasSource(context.source);
  const node = canvasNodeAt(context.model.nodes, context.path);
  if (!node || node.kind !== 'component' || node.start === undefined || node.end === undefined) {
    throw new Error('Select a component instance to set its defaults.');
  }
  const specifier = context.model.imports.find((entry) => entry.name === node.name)?.path;
  const component = specifier && resolveSourceImport(context.file, specifier, snapshot.catalog);
  if (!component) {
    throw new Error('This component does not resolve to a project Astro file.');
  }
  componentFile(component);
  const existing = new Map<string, string>();
  for (const entry of context.model.imports) {
    const resolved = resolveSourceImport(context.file, entry.path, snapshot.catalog);
    if (resolved) {
      existing.set(resolved, entry.name);
    }
  }
  const rendered = renderDefaultsInstance(component, snapshot, existing, context.source);
  assert(node.start < node.end, 'The defaults instance has a nonempty source range');
  assert(node.end <= context.source.length, 'The defaults instance belongs to its source');
  const body = context.source.slice(0, node.start) + rendered.body + context.source.slice(node.end);
  const source = rebaseCanvasSource(body, context.file, rendered.declarations);
  return {
    source: defaultsCanvasSource(source),
    session: {
      file,
      component,
      snapshot,
      targetPath: context.path,
      context: canvasContext(context.model.nodes, context.path),
    },
  };
}

function rebaseCanvasSource(source: string, from: string, declarations: string): string {
  const fence = /^(\uFEFF?)---\r?\n(?:---|([\s\S]*?)\r?\n---)(?=\r?\n|$)/.exec(source);
  const rebase = (specifier: string) => {
    if (!specifier.startsWith('.')) {
      return specifier;
    }
    const resolved = resolveSourceImport(from, specifier);
    if (!resolved) {
      throw new Error('A preview import points outside the project.');
    }
    return '../../' + resolved;
  };
  if (!fence) {
    return `---\n${declarations}\n---\n${source}`;
  }
  const frontmatter = mapModuleSpecifiers(fence[2] ?? '', rebase);
  return `${fence[1] ?? ''}---\n${frontmatter}\n${declarations}\n---` + source.slice(fence[0].length);
}
