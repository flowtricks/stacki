// The text of a generated template page, one shape per data source. Pure: the
// plan (pageTemplatePlan.ts) decides what the project allows and hands this
// module checked values.
//
// Astro runs getStaticPaths in its own scope, so everything it needs is written
// inside it, and a secret is read there from `import.meta.env`, which keeps its
// value out of the file. Each page reads `const { entry } = Astro.props`, which
// is the shape the data picker samples through page:dynamicPaths, so an entry's
// fields can be bound as soon as the page opens.

import { assert } from '../../shared/core/assert';
import { LIMITS } from '../../shared/core/limits';
import {
  SANITY_API_VERSION,
  dataPathSegments,
  type ContentSlug,
  type SlugTreatment,
  type DataSource,
  type RouteParts,
  type SampleFieldKind,
  type TemplateField,
} from '../../shared/properties/pageTemplate';

export interface TemplatePageInput {
  readonly route: RouteParts;
  readonly source: DataSource;
  /** The layout's name and its import path relative to the page. */
  readonly layout: { readonly name: string; readonly importPath: string } | undefined;
  readonly collection: CollectionFacts | undefined;
  /** `explicit` writes `prerender = true`, which a server-output project needs for getStaticPaths to run. */
  readonly prerender: 'explicit' | 'inherited';
}

/** What a content collection's config says, for a `content-collection` source. */
export interface CollectionFacts {
  readonly body: 'rendered' | 'none';
  /** The schema field shown as the page's heading, when it has one. */
  readonly heading: string | undefined;
  /** Astro 5 replaced `entry.render()` and `entry.slug` with `render(entry)` and `entry.id`. */
  readonly api: 'current' | 'legacy';
}

const HEADING_FIELDS = ['title', 'name', 'heading'] as const;
const REQUEST_TIMEOUT_MS = 15_000;
// One helper, inside getStaticPaths because Astro gives that function no outer
// scope. It matches slugifyAddress (shared/properties/pageTemplate.ts), so the
// example the form showed is the address the build makes.
const SLUG_HELPER = [
  '  const toSlug = (value: unknown) =>',
  "    String(value ?? '')",
  "      .normalize('NFKD')",
  "      .replace(/[\\u0300-\\u036f]/g, '')",
  '      .toLowerCase()',
  "      .replace(/[^a-z0-9]+/g, '-')",
  "      .replace(/^-+|-+$/g, '');",
  '  const seen = new Map();',
] as const;

export function pageTemplateText(input: TemplatePageInput): string {
  const { source } = input;
  switch (source.kind) {
    case 'content-collection': {
      const facts = input.collection;
      assert(facts !== undefined, 'A content template is planned with its collection');
      return contentPageText(input, source, facts);
    }
    case 'sanity':
      return externalPageText(input, sanityRequestLines(source), {
        listAccess: 'body?.result',
        listLabel: 'result',
        slugPath: source.slugPath,
        slugTreatment: source.slugTreatment,
        fields: source.fields,
      });
    case 'http-json':
      return externalPageText(input, httpRequestLines(source), {
        listAccess: accessor('body', source.listPath),
        listLabel: source.listPath === '' ? 'the top of the reply' : source.listPath,
        slugPath: source.slugPath,
        slugTreatment: source.slugTreatment,
        fields: source.fields,
      });
    default: {
      const exhaustive: never = source;
      return exhaustive;
    }
  }
}

/** The field a template shows as its heading: the first with a heading's usual name. */
export function headingField(names: readonly string[]): string | undefined {
  return HEADING_FIELDS.find((name) => names.includes(name));
}

type ContentSource = Extract<DataSource, { readonly kind: 'content-collection' }>;

function contentPageText(input: TemplatePageInput, source: ContentSource, facts: CollectionFacts): string {
  const legacy = facts.api === 'legacy';
  const rendered = facts.body === 'rendered';
  const names = rendered && !legacy ? 'getCollection, render' : 'getCollection';
  const idField = legacy ? 'entry.slug' : 'entry.id';
  const name = quoted(source.collection);
  const frontmatter = [
    `import { ${names} } from 'astro:content';`,
    `import type { CollectionEntry } from 'astro:content';`,
    ...layoutImport(input),
    '',
    ...prerenderLines(input),
    'export async function getStaticPaths() {',
    ...contentPathLines(input.route.param, source.slug, { name, idField }),
    '}',
    '',
    'interface Props {',
    `  entry: CollectionEntry<${name}>;`,
    '}',
    '',
    'const { entry } = Astro.props;',
    ...(rendered ? [`const { Content } = await ${legacy ? 'entry.render()' : 'render(entry)'};`] : []),
  ];
  const heading = facts.heading === undefined ? [] : [`<h1>{entry.data${member(facts.heading)}}</h1>`];
  return pageText(input, frontmatter, [...heading, ...(rendered ? ['<Content />'] : [])]);
}

function contentPathLines(param: string, slug: ContentSlug, names: { readonly name: string; readonly idField: string }): readonly string[] {
  const entries = `  const entries = await getCollection(${names.name});`;
  if (slug.kind === 'entry-id') {
    return [entries, `  return entries.map((entry) => ({ params: { ${key(param)}: ${names.idField} }, props: { entry } }));`];
  }
  const value = `entry.data${member(slug.name)}`;
  if (slug.treatment === 'exact') {
    return [entries, `  return entries.map((entry) => ({ params: { ${key(param)}: ${value} }, props: { entry } }));`];
  }
  return [
    ...SLUG_HELPER,
    entries,
    '  return entries.map((entry) => {',
    `    const slug = toSlug(${value});`,
    "    if (slug === '') {",
    `      throw new Error(\`\${${names.idField}}: ${slug.name} has no letters or numbers for its page address.\`);`,
    '    }',
    '    if (seen.has(slug)) {',
    `      throw new Error(\`\${seen.get(slug)} and \${${names.idField}} would both be at \${slug}. Change ${slug.name} on one of them.\`);`,
    '    }',
    `    seen.set(slug, ${names.idField});`,
    `    return { params: { ${key(param)}: slug }, props: { entry } };`,
    '  });',
  ];
}

interface ListShape {
  readonly listAccess: string;
  readonly listLabel: string;
  readonly slugPath: string;
  readonly slugTreatment: SlugTreatment;
  readonly fields: readonly TemplateField[];
}

function externalPageText(input: TemplatePageInput, request: readonly string[], shape: ListShape): string {
  const slugified = shape.slugTreatment === 'slugified';
  const fields = uncovered(shape.fields);
  const tree = fieldTree(fields);
  const heading = headingField(shape.fields.filter((field) => field.kind === 'string').map((field) => field.path));
  const frontmatter = [
    ...layoutImport(input),
    ...(input.layout === undefined ? [] : ['']),
    ...prerenderLines(input),
    'export async function getStaticPaths() {',
    ...(slugified ? SLUG_HELPER : []),
    ...request,
    '  if (!response.ok) {',
    '    throw new Error(`${url} answered ${response.status}.`);',
    '  }',
    '  const body = await response.json();',
    `  const list = ${shape.listAccess};`,
    '  if (!Array.isArray(list)) {',
    `    throw new Error(${quoted(`Expected a list at ${shape.listLabel}.`)});`,
    '  }',
    `  const kinds = { ${fields.map((field) => `${key(field.path)}: ${quoted(runtimeKind(field.kind))}`).join(', ')} };`,
    '  return list.map((item, index) => {',
    ...itemSlugLines(shape),
    '    for (const [name, kind] of Object.entries(kinds)) {',
    "      const value = name.split('.').reduce((part, step) => part?.[step], item);",
    '      if (value !== undefined && value !== null && typeof value !== kind) {',
    '        throw new Error(`Item ${index}: ${name} is not a ${kind}.`);',
    '      }',
    '    }',
    `    const entry = ${entryLiteral(tree, 0)};`,
    `    return { params: { ${key(input.route.param)}: ${slugified ? 'slug' : 'String(slug)'} }, props: { entry } };`,
    '  });',
    '}',
    '',
    'interface Props {',
    '  entry: {',
    ...propLines(tree, 0),
    '  };',
    '}',
    '',
    'const { entry } = Astro.props;',
  ];
  return pageText(input, frontmatter, heading === undefined ? [] : [`<h1>{entry${member(heading)}}</h1>`]);
}

interface FieldNode {
  readonly key: string;
  readonly path: string;
  readonly kind: SampleFieldKind;
  readonly children: FieldNode[];
}

// A field inside one already kept whole adds nothing, and would write its key twice.
function uncovered(fields: readonly TemplateField[]): readonly TemplateField[] {
  return fields.filter((field) => !fields.some((other) => field.path.startsWith(`${other.path}.`)));
}

// The kept fields as the shape of `entry`. Fields arrive uncovered, so a kept
// field is always a leaf, and the objects above it hold only what was kept.
function fieldTree(fields: readonly TemplateField[]): readonly FieldNode[] {
  const roots: FieldNode[] = [];
  for (const field of fields) {
    const steps = dataPathSegments(field.path);
    assert(steps.ok, 'A field path was parsed at the boundary');
    let level = roots;
    steps.value.forEach((step, index) => {
      const path = steps.value.slice(0, index + 1).join('.');
      const found = level.find((node) => node.key === step);
      const node = found ?? { key: step, path, kind: path === field.path ? field.kind : 'object', children: [] };
      if (found === undefined) {
        level.push(node);
      }
      level = node.children;
    });
  }
  return roots;
}

function entryLiteral(nodes: readonly FieldNode[], depth: number): string {
  assert(depth <= LIMITS.treeDepthMax, 'entryLiteral: a field path is bounded');
  const parts = nodes.map((node) => {
    if (node.children.length > 0) {
      return `${key(node.key)}: ${entryLiteral(node.children, depth + 1)}`;
    }
    return `${key(node.key)}: ${node.path.includes('.') ? accessor('item', node.path) : `item${member(node.key)}`}`;
  });
  return `{ ${parts.join(', ')} }`;
}

function propLines(nodes: readonly FieldNode[], depth: number): readonly string[] {
  assert(depth <= LIMITS.treeDepthMax, 'propLines: a field path is bounded');
  const indent = ' '.repeat(4 + depth * 2);
  return nodes.flatMap((node) =>
    node.children.length > 0
      ? [`${indent}${key(node.key)}?: {`, ...propLines(node.children, depth + 1), `${indent}};`]
      : [`${indent}${key(node.key)}?: ${propType(node.kind)};`],
  );
}

function itemSlugLines(shape: ListShape): readonly string[] {
  const value = accessor('item', shape.slugPath);
  const path = shape.slugPath;
  const scalar = (name: string): readonly string[] => [
    `    const ${name} = ${value};`,
    `    if (typeof ${name} !== 'string' && typeof ${name} !== 'number') {`,
    `      throw new Error(\`Item \${index}: ${path} is not text or a number.\`);`,
    '    }',
  ];
  if (shape.slugTreatment === 'exact') {
    return [...scalar('slug'), "    if (slug === '') {", `      throw new Error(\`Item \${index}: ${path} is empty.\`);`, '    }'];
  }
  return [
    ...scalar('address'),
    '    const slug = toSlug(address);',
    "    if (slug === '') {",
    `      throw new Error(\`Item \${index}: ${path} has no letters or numbers for its page address.\`);`,
    '    }',
    '    if (seen.has(slug)) {',
    `      throw new Error(\`Items \${seen.get(slug)} and \${index} would both be at \${slug}. Change ${path} on one of them.\`);`,
    '    }',
    '    seen.set(slug, index);',
  ];
}

type HttpSource = Extract<DataSource, { readonly kind: 'http-json' }>;
type SanitySource = Extract<DataSource, { readonly kind: 'sanity' }>;

function httpRequestLines(source: HttpSource): readonly string[] {
  const secrets = source.headers.flatMap((header, index) => secretLines(`secret${index}`, header.env));
  const headers = source.headers.map((header, index) => {
    const value = header.scheme === 'bearer' ? `\`Bearer \${secret${index}}\`` : `secret${index}`;
    return `${quoted(header.name)}: ${value}`;
  });
  return [
    `  const url = ${quoted(source.url)};`,
    ...secrets,
    '  const response = await fetch(url, {',
    ...(headers.length === 0 ? [] : [`    headers: { ${headers.join(', ')} },`]),
    `    signal: AbortSignal.timeout(${REQUEST_TIMEOUT_MS}),`,
    '  });',
  ];
}

function sanityRequestLines(source: SanitySource): readonly string[] {
  const tokenEnv = source.tokenEnv;
  // Sanity's CDN serves public reads; a token's reads go to the live API.
  const host = tokenEnv === undefined ? 'apicdn' : 'api';
  const defined = source.slugPath;
  return [
    '  const query = new URLSearchParams({',
    `    query: ${quoted(`*[_type == $type && defined(${defined})]`)},`,
    `    $type: JSON.stringify(${quoted(source.documentType)}),`,
    '  });',
    `  const url = \`https://${source.projectId}.${host}.sanity.io/${SANITY_API_VERSION}/data/query/${source.dataset}?\${query}\`;`,
    ...(tokenEnv === undefined ? [] : secretLines('secret0', tokenEnv)),
    '  const response = await fetch(url, {',
    ...(tokenEnv === undefined ? [] : ['    headers: { Authorization: `Bearer ${secret0}` },']),
    `    signal: AbortSignal.timeout(${REQUEST_TIMEOUT_MS}),`,
    '  });',
  ];
}

function secretLines(name: string, env: string): readonly string[] {
  return [`  const ${name} = import.meta.env.${env};`, `  if (!${name}) {`, `    throw new Error(${quoted(`Set ${env} in .env to load this page.`)});`, '  }'];
}

function layoutImport(input: TemplatePageInput): readonly string[] {
  const layout = input.layout;
  return layout === undefined ? [] : [`import ${layout.name} from ${quoted(layout.importPath)};`];
}

function prerenderLines(input: TemplatePageInput): readonly string[] {
  return input.prerender === 'explicit' ? ['export const prerender = true;', ''] : [];
}

function pageText(input: TemplatePageInput, frontmatter: readonly string[], content: readonly string[]): string {
  const layout = input.layout;
  const body = layout === undefined ? ['<article>', ...indented(content), '</article>'] : [`<${layout.name}>`, ...indented(content), `</${layout.name}>`];
  const text = ['---', ...frontmatter, '---', '', ...body, ''].join('\n');
  assert(text.includes('export async function getStaticPaths()'), 'A template page declares its paths');
  assert(text.includes('Astro.props'), 'A template page reads its entry');
  return text;
}

function indented(lines: readonly string[]): readonly string[] {
  return lines.map((line) => `  ${line}`);
}

function runtimeKind(kind: SampleFieldKind): string {
  return kind === 'list' ? 'object' : kind;
}

function propType(kind: SampleFieldKind): string {
  switch (kind) {
    case 'string':
      return 'string';
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'object':
      return 'Record<string, unknown>';
    case 'list':
      return 'unknown[]';
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

// `base?.data?.items`, stepping safely because the value came off the network.
function accessor(base: string, path: string): string {
  const steps = dataPathSegments(path);
  assert(steps.ok, 'A data path was parsed at the boundary');
  return steps.value.reduce((code, step) => (isIdentifier(step) ? `${code}?.${step}` : `${code}?.[${quoted(step)}]`), base);
}

function member(name: string): string {
  return isIdentifier(name) ? `.${name}` : `[${quoted(name)}]`;
}

function key(name: string): string {
  return isIdentifier(name) ? name : quoted(name);
}

function isIdentifier(name: string): boolean {
  return /^[A-Za-z_$][\w$]*$/.test(name);
}

function quoted(value: string): string {
  const escaped = value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  assert(!/[\r\n]/.test(escaped), 'Generated strings are one line');
  return `'${escaped}'`;
}
