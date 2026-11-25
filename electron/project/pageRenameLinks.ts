import path from 'node:path';
import { assert } from '../../shared/core/assert';
import { pageURLPath, type PageRename } from '../../shared/properties/pageRename';

export interface LinkRenameContext {
  readonly change: PageRename;
  readonly origins: readonly string[];
  readonly file: string;
  readonly relative?: 'url';
}

/** Rewrite literal links without interpreting project JavaScript or changing external sites. */
export function renamePageLinks(source: string, context: LinkRenameContext): string {
  assert(source.length <= 5_000_000, 'Link rename: source size is bounded');
  assert(context.origins.length <= 32, 'Link rename: origin count is bounded');
  const quoted = source.replace(/(["'`])((?:\\[\s\S]|(?!\1)[^\\])*)\1/g, (_match: string, quote: string, value: string) => {
    const escaped = value.includes('\\/');
    const literal = escaped ? value.replace(/\\\//g, '/') : value;
    const next = renamePageLink(literal, context);
    return quote + (escaped ? next.replace(/\//g, '\\/') : next) + quote;
  });
  // Markdown destinations, unquoted HTML links and XML sitemap locations are not JS strings.
  const attributes = quoted.replace(
    /(\b(?:href|action)\s*=\s*)(["'])([^"']*)\2/g,
    (_match: string, prefix: string, quote: string, value: string) => prefix + quote + renamePageLink(value, { ...context, relative: 'url' }) + quote,
  );
  return attributes.replace(
    /(\]\(\s*|\b(?:href|src|action)=|<loc>)([^\s<>"'`)]+)/g,
    (_match: string, prefix: string, value: string) => prefix + renamePageLink(value, { ...context, relative: 'url' }),
  );
}

export function renamePageLink(value: string, context: LinkRenameContext): string {
  if (/[\r\n\s]/.test(value) || value.length > 32_768) {
    return value;
  }
  const absolute = /^(https?:\/\/[^/?#]+)(\/[^]*)$/.exec(value);
  if (absolute) {
    const origin = absolute[1];
    const suffix = absolute[2];
    if (origin === undefined || suffix === undefined || !context.origins.includes(origin)) {
      return value;
    }
    return origin + renameURLPath(suffix, context.change);
  }
  if (value.startsWith('//')) {
    return value;
  }
  if (value.startsWith('/')) {
    return renameURLPath(value, context.change);
  }
  if (context.relative !== 'url' || !context.file.startsWith('src/pages/')) {
    return value;
  }
  if (value.startsWith('#') || value.startsWith('?') || /^[a-z][a-z0-9+.-]*:/i.test(value)) {
    return value;
  }
  if (/\.(astro|mdx?|[cm]?[jt]sx?|css|json)(?:[?#]|$)/.test(value)) {
    return value;
  }
  const route = pageURLPath(context.file.slice('src/pages/'.length));
  const resolved = new URL(value, 'https://stacki.invalid' + route);
  const before = resolved.pathname + resolved.search + resolved.hash;
  const after = renameURLPath(before, context.change);
  // Root-relative links remain stable when the referring page itself also moves.
  const ownerMoved = renameURLPath(route, context.change) !== route;
  return before === after && !ownerMoved ? value : after;
}

function renameURLPath(value: string, change: PageRename): string {
  const boundary = value.search(/[?#]/);
  const pathname = boundary < 0 ? value : value.slice(0, boundary);
  const suffix = boundary < 0 ? '' : value.slice(boundary);
  const from = change.kind === 'folder' ? '/' + change.from : pageURLPath(change.from);
  const to = change.kind === 'folder' ? '/' + change.to : pageURLPath(change.to);
  if (change.kind === 'folder' && pathname.startsWith(from + '/')) {
    return to + pathname.slice(from.length) + suffix;
  }
  const trailing = pathname !== '/' && pathname.endsWith('/');
  const route = trailing ? pathname.slice(0, -1) : pathname;
  const next = renameRoutePattern(route, from, to, { descendants: change.kind === 'folder' });
  return next === undefined ? value : next + (trailing && next !== '/' ? '/' : '') + suffix;
}

function renameRoutePattern(route: string, from: string, to: string, options: { readonly descendants: boolean }): string | undefined {
  if (!from.includes('[')) {
    return route === from ? to : undefined;
  }
  const parameters = /\[(\.\.\.)?[^\]]+\]/g;
  const pattern = from
    .split(/(\[(?:\.\.\.)?[^\]]+\])/g)
    .map((part, index) => {
      if (index % 2 === 1) {
        return part.startsWith('[...') ? '(.+)' : '([^/]+)';
      }
      return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('');
  const match = new RegExp('^' + pattern + (options.descendants ? '(/.*)?' : '') + '$').exec(route);
  if (!match) {
    return undefined;
  }
  let index = 0;
  const next = to.replace(parameters, () => match[++index] ?? '');
  return next + (options.descendants ? (match[index + 1] ?? '') : '');
}

/** Preserve relative and aliased module references when either end of the import moves. */
export function renamePageImports(
  source: string,
  file: string,
  relocated: ReadonlyMap<string, string>,
  aliases: readonly (readonly [string, readonly string[]])[] = [],
): string {
  const rewrite = (specifier: string) => renameModulePath(specifier, file, relocated, aliases);
  const modules = source.replace(
    /((?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\(\s*)['"])([^'"]+)(['"])/g,
    (_match: string, prefix: string, specifier: string, quote: string) => prefix + rewrite(specifier) + quote,
  );
  return modules.replace(
    /^(\s*layout:\s*['"]?)([^'"\s]+)(['"]?\s*)$/gm,
    (_match: string, prefix: string, specifier: string, suffix: string) => prefix + rewrite(specifier) + suffix,
  );
}

function renameModulePath(
  specifier: string,
  file: string,
  relocated: ReadonlyMap<string, string>,
  aliases: readonly (readonly [string, readonly string[]])[],
): string {
  const relative = specifier.startsWith('./') || specifier.startsWith('../');
  const alias = aliases.find(([prefix]) => specifier === prefix || specifier.startsWith(prefix + '/'));
  const aliasTarget = alias?.[1][0];
  if (!relative && aliasTarget === undefined) {
    return specifier;
  }
  const target = relative
    ? path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier))
    : path.posix.normalize((aliasTarget ?? '') + specifier.slice(alias?.[0].length ?? 0));
  const suffix = ['', '.astro', '.md', '.mdx', '.ts', '.js', '/index.astro', '/index.ts', '/index.js'].find((extension) => relocated.has(target + extension));
  const nextFile = relocated.get(file) ?? file;
  const nextTarget = suffix === undefined ? target : relocated.get(target + suffix);
  assert(nextTarget !== undefined, 'A matched relocation has a destination');
  if (nextTarget === target && (!relative || nextFile === file)) {
    return specifier;
  }
  let next = path.posix.relative(path.posix.dirname(nextFile), nextTarget);
  if (suffix === '.ts' || suffix === '.js') {
    next = next.slice(0, -suffix.length);
  }
  return next.startsWith('.') ? next : './' + next;
}
