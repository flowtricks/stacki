// Sample inputs for a component preview: the props a component declares as required, filled with values
// its own types allow, so a component that "needs data" can still be drawn. Pure: it reads a prop model
// (electron/parse/propModel) and returns JSON the preview route hands the component. Nothing here runs
// the project's code.
//
// What a prop gets, in order of trust: its declared type (a choice takes its first option, a list three
// items of its item type, a group each of its members), then the words of its name (`href` is `#`,
// `src` is a picture), then a generic bag of the fields components usually read (`title`, `href`, `src`).
// A wrong guess throws inside the component, and the route's guard catches that and tries the next,
// plainer set of inputs (componentPreview.ts), so a guess costs a render and not a preview.

import { assert } from '../../shared/core/assert';
import { LIMITS } from '../../shared/core/limits';
import type { ComponentPropModel, PropControl, PropMember, PropModel } from '../../shared/properties/propModel';

export type PreviewJSON = string | number | boolean | readonly PreviewJSON[] | { readonly [key: string]: PreviewJSON };

export const SAMPLE_LIMITS = {
  /** Items in a sample list; three shows a row, a carousel and a table without making the page long. */
  listItems: 3,
  /** How deep a group or list nests before the sample stops (matches the model's own bound). */
  depthMax: 6,
  /** Members of a sample group; a larger one is cut, since nothing reads fifty fields in a card. */
  membersMax: 24,
} as const;

/** A neutral picture for any prop that wants one: a soft grey card with a landscape mark. */
export const SAMPLE_IMAGE_URL = sampleImageURL();

function sampleImageURL(): string {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800" viewBox="0 0 1200 800">' +
    '<rect width="1200" height="800" fill="#e4e6ea"/>' +
    '<path d="M0 640 300 400l220 200 160-120 520 360H0z" fill="#cfd3d9"/>' +
    '<circle cx="880" cy="230" r="70" fill="#f5f6f8"/></svg>';
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
}

/** The shape Astro's own image components read: an imported asset's metadata, here an SVG so nothing is resized. */
export function sampleImageMetadata(): PreviewJSON {
  return { src: SAMPLE_IMAGE_URL, width: 1200, height: 800, format: 'svg' };
}

export interface SampleInputs {
  /** Values for the props that need one. */
  readonly props: Readonly<Record<string, PreviewJSON>>;
  /** Required props no value can stand in for (a function the component calls). */
  readonly unsampled: readonly string[];
}

/** What to include: the props the component cannot render without, or those and the ones that make it look like itself. */
export type SampleScope = 'required' | 'illustrative';

export function sampleInputs(model: ComponentPropModel, label: string, scope: SampleScope): SampleInputs {
  assert(label.length > 0, 'A sample is made for a named component');
  const props: Record<string, PreviewJSON> = {};
  const unsampled: string[] = [];
  for (const prop of model.props) {
    if (prop.fallback.kind !== 'none' && scope === 'required') {
      // The author wrote a default; the component renders without this prop.
      continue;
    }
    const wanted = wantsSample(prop, scope);
    if (!wanted) {
      continue;
    }
    const value = sampleMember(prop, label, 0);
    if (value === undefined) {
      if (prop.presence === 'required') {
        unsampled.push(prop.name);
      }
      continue;
    }
    props[prop.name] = value;
  }
  assert(Object.keys(props).length <= model.props.length, 'A sample holds only declared props');
  return { props, unsampled };
}

function wantsSample(prop: PropModel, scope: SampleScope): boolean {
  if (prop.fallback.kind !== 'none') {
    // An authored default stands, whatever the scope: the component author chose that value.
    return false;
  }
  if (prop.presence === 'required' && prop.control.kind !== 'callback') {
    return true;
  }
  if (prop.presence === 'required') {
    return true;
  }
  if (scope === 'required') {
    return false;
  }
  // Optional props that make a card look like itself: its words and its picture, never behaviour.
  return /^(heading|title|label|text|description|caption|summary|content|eyebrow|subtitle|body|image|src|alt|href|name)$/i.test(prop.name);
}

function sampleMember(member: PropMember, label: string, depth: number): PreviewJSON | undefined {
  if (depth > SAMPLE_LIMITS.depthMax) {
    return sampleByName(member.name, label);
  }
  return sampleControl(member.control, member, label, depth);
}

function sampleControl(control: PropControl, member: PropMember, label: string, depth: number): PreviewJSON | undefined {
  switch (control.kind) {
    case 'text':
      return sampleText(member, control.format, label);
    case 'number':
      return sampleNumber(control, member.name);
    case 'switch':
      return true;
    case 'choice':
      return sampleChoice(control);
    case 'attributes':
      return {};
    case 'list': {
      const item: PropMember = { name: member.name, typeText: member.typeText, control: control.item, presence: 'required' };
      const items: PreviewJSON[] = [];
      for (let index = 0; index < SAMPLE_LIMITS.listItems; index += 1) {
        const value = sampleMember(item, label, depth + 1);
        if (value === undefined) {
          return undefined;
        }
        items.push(varied(value, index));
      }
      return items;
    }
    case 'group':
      return sampleGroup(control.fields, label, depth);
    case 'callback':
      return undefined;
    case 'code':
      return sampleCode(member, label);
    default: {
      const exhaustive: never = control;
      return exhaustive;
    }
  }
}

function sampleGroup(fields: readonly PropMember[], label: string, depth: number): PreviewJSON {
  const value: Record<string, PreviewJSON> = {};
  for (const field of fields.slice(0, SAMPLE_LIMITS.membersMax)) {
    const member = sampleMember(field, label, depth + 1);
    if (member !== undefined) {
      value[field.name] = member;
    }
  }
  return value;
}

function sampleText(member: PropMember, format: string | undefined, label: string): PreviewJSON {
  if (format === 'color') {
    return '#3b6ef5';
  }
  if (format === 'date') {
    return '2025-01-15';
  }
  if (format === 'longtext') {
    return SAMPLE_PARAGRAPH;
  }
  return sampleByName(member.name, label);
}

const SAMPLE_PARAGRAPH = 'This is sample text that shows how the component lays out a sentence or two of content.';

/** The value a prop of this name most likely wants, when its type says only "string". */
export function sampleByName(name: string, label: string): PreviewJSON {
  if (/^(href|url|link|to|action|cta(Href|Url)|.*(Href|Url|Link))$/i.test(name) || /href$|url$/i.test(name)) {
    return '#';
  }
  if (/^(src|image|img|poster|photo|picture|thumbnail|avatar|logo|icon)$/i.test(name) || /(Src|Image|Img|Poster|Photo|Thumbnail)$/.test(name)) {
    return SAMPLE_IMAGE_URL;
  }
  if (/^(alt|.*Alt)$/.test(name)) {
    return 'Sample image';
  }
  if (name === 'id' || /Id$/.test(name)) {
    return 'stacki-preview-' + label.replace(/[^\w-]/g, '-');
  }
  if (/email/i.test(name)) {
    return 'name@example.com';
  }
  if (
    /^(heading|title|label|text|name|caption|eyebrow|subtitle|headline)$/i.test(name) ||
    /(Heading|Title|Label|Text|Name|Caption|Eyebrow|Headline)$/.test(name)
  ) {
    return label;
  }
  if (/^(description|summary|body|content|excerpt|intro|copy|quote|message)$/i.test(name) || /(Description|Summary|Body|Intro|Quote|Copy)$/.test(name)) {
    return SAMPLE_PARAGRAPH;
  }
  if (/(width|height|count|index|size|limit|columns|rows|slides|per)/i.test(name)) {
    return 3;
  }
  if (/^(is|has|show|can|should|enable)[A-Z]/.test(name)) {
    return true;
  }
  return 'Sample ' + name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
}

function sampleNumber(control: Extract<PropControl, { readonly kind: 'number' }>, name: string): number {
  const named = sampleByName(name, 'x');
  let value = typeof named === 'number' ? named : 3;
  if (control.min !== undefined && value < control.min) {
    value = control.min;
  }
  if (control.max !== undefined && value > control.max) {
    value = control.max;
  }
  return value;
}

function sampleChoice(control: Extract<PropControl, { readonly kind: 'choice' }>): PreviewJSON | undefined {
  const first = control.options[0];
  if (first === undefined) {
    return undefined;
  }
  return control.numeric && Number.isFinite(Number(first.value)) ? Number(first.value) : first.value;
}

/** A prop only code can fill: read what its type says as text, then fall back to its name. */
function sampleCode(member: PropMember, label: string): PreviewJSON | undefined {
  const type = member.typeText.trim();
  if (/\bImageMetadata\b/.test(type)) {
    return sampleImageMetadata();
  }
  if (/\bDate\b/.test(type)) {
    return '2025-01-15';
  }
  const list = /^(?:readonly\s+)?(\w+)\[\]$/.exec(type) ?? /^(?:Readonly)?Array<(\w+)>$/.exec(type);
  const itemType = list?.[1];
  if (itemType !== undefined) {
    const item = sampleNamedType(itemType, member.name, label);
    return item === undefined ? undefined : [item, varied(item, 1), varied(item, 2)];
  }
  if (type.startsWith('Record<') || /^\{\s*\[/.test(type)) {
    return {};
  }
  if (/^(string|number|boolean)$/.test(type)) {
    return type === 'string' ? sampleByName(member.name, label) : type === 'number' ? 3 : true;
  }
  if (/=>/.test(type)) {
    return undefined;
  }
  // A named type the preview could not read (a package's, a generated one): the generic bag, or a list of them
  // when the prop is named in the plural.
  const bag = genericBag(label);
  return /(s|ies)$/.test(member.name) && !/(status|address|class|alias|process|progress|access)$/i.test(member.name)
    ? [bag, varied(bag, 1), varied(bag, 2)]
    : bag;
}

function sampleNamedType(typeName: string, name: string, label: string): PreviewJSON | undefined {
  if (typeName === 'string') {
    return sampleByName(name, label);
  }
  if (typeName === 'number') {
    return 3;
  }
  if (typeName === 'boolean') {
    return true;
  }
  if (typeName === 'ImageMetadata') {
    return sampleImageMetadata();
  }
  return genericBag(label);
}

/** The fields components most often read from an item they are handed; enough for most cards, rows and links. */
function genericBag(label: string): PreviewJSON {
  return {
    id: 'sample',
    title: label,
    heading: label,
    label,
    name: label,
    text: SAMPLE_PARAGRAPH,
    description: SAMPLE_PARAGRAPH,
    body: SAMPLE_PARAGRAPH,
    href: '#',
    url: '#',
    src: SAMPLE_IMAGE_URL,
    image: sampleImageMetadata(),
    alt: 'Sample image',
  };
}

/** Item `index` of a list differs from item zero in its words, so three rows do not look like one row three times. */
function varied(value: PreviewJSON, index: number, depth = 0): PreviewJSON {
  assert(depth <= LIMITS.treeDepthMax, 'A varied sample is no deeper than the tree bound');
  if (index === 0) {
    return value;
  }
  if (typeof value === 'string') {
    return /^(#|data:|stacki-preview-)/.test(value) ? value : `${value} ${index + 1}`;
  }
  if (typeof value === 'object') {
    if (Array.isArray(value)) {
      const items: readonly PreviewJSON[] = value;
      return items;
    }
    const copy: Record<string, PreviewJSON> = {};
    for (const [key, entry] of Object.entries(value)) {
      copy[key] = key === 'id' ? `${String(entry)}-${index + 1}` : varied(entry, index, depth + 1);
    }
    return copy;
  }
  return value;
}
