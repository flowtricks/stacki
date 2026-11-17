// Deleting a component prop across the whole site (docs/component-properties.md,
// "Deleting a prop"). The component loses the prop's declarations, every
// variant's member included, and its destructure (propertyDefinitions.ts);
// every instance in the project loses the attribute that passes it, in any
// form: `direction="back"`, `direction={value}`, `{direction}`, a bare
// `direction`, and the key of an inline spread (`{...{ direction: 'back' }}`).
//
// A read in the component's own code (`direction === 'back'`) keeps working:
// a constant of the prop's name takes the destructure's place, holding its
// default (propertyDefinitions.ts). Two things are never guessed at. A read
// no constant can stand in for (`Astro.props.direction`, a default that reads
// the prop itself) refuses the deletion, and the lines are listed. A spread
// of an object Stacki cannot see into (`{...props}`) may still carry the prop:
// the deletion goes ahead, leaves that object alone, and lists the line.
//
// The plan is the same batch every property edit is: each file's exact
// before and after text, written together and undone together
// (componentProperties.ts). Untouched bytes are copied, never re-printed.
import path from 'node:path';
import type { AttributeNode, Node } from '@astrojs/compiler/types';
import { assert } from '../../shared/core/assert';
import { err, ok, type Result } from '../../shared/core/result';
import { PROPERTY_LIMITS } from '../../shared/properties/propertyEditing';
import { inFile, refusal } from '../../shared/properties/propertyErrors';
import type { PropertyRemovalPreview, PropertyRemovalReview, PropertyRemovalUsage } from '../../shared/properties/propertyRemoval';
import { sameFilesystemPath } from '../lib/platform';
import { readPropertyConsumers } from './propertyConsumers';
import { removePropertyDeclarations } from './propertyDefinitions';
import { astroOffset, lineAt, parseAstroTemplate } from './propertyReads';
import { literalSpreadObject } from './propertyRename';
import { applySourceEdits, propertyKey, type SourceEdit } from './propertySyntax';

interface RemovalRequest {
  readonly projectPath: string;
  readonly file: string;
  /** The component's text the plan starts from. */
  readonly source: string;
}
export interface RemovalFileChange {
  readonly file: string;
  readonly before: string;
  readonly after: string;
}
export interface PropertyRemovalPlan {
  readonly changes: readonly RemovalFileChange[];
  readonly preview: PropertyRemovalPreview;
}

// The spread a literal object is parsed after, as propertyRename.ts parses it.
const SPREAD_PREFIX = 'const spread = (';

/** What deleting `name` writes, file by file, and the summary the confirmation shows. A file that cannot be read safely refuses the whole plan. */
export function planPropertyRemoval(request: RemovalRequest, name: string): Result<PropertyRemovalPlan> {
  const removed = removePropertyDeclarations(request.source, name);
  if (!removed.ok) {
    return err(inFile(projectRelative(request.projectPath, request.file), removed.error));
  }
  const removal = removed.value;
  const consumers = readPropertyConsumers(request);
  if (!consumers.ok) {
    return consumers;
  }
  const changes: RemovalFileChange[] = [];
  const usages: PropertyRemovalUsage[] = [];
  const reviews: PropertyRemovalReview[] = [];
  let written: RemovalFileChange | undefined;
  for (const consumer of consumers.value) {
    const own = sameFilesystemPath(consumer.file, request.file);
    const relative = projectRelative(request.projectPath, consumer.file);
    const before = own ? removal.source : consumer.source;
    const edited = consumer.names.size === 0 ? ok(unchanged(before)) : removeInstanceValues(before, consumer.names, name);
    if (!edited.ok) {
      return err(inFile(relative, edited.error));
    }
    if (edited.value.count > 0) {
      usages.push({ path: relative, count: edited.value.count });
    }
    reviews.push(...edited.value.spreads.map((line) => ({ kind: 'spread' as const, path: relative, line })));
    if (own) {
      written = { file: consumer.file, before: request.source, after: edited.value.source };
      changes.push(written);
    } else if (edited.value.count > 0) {
      changes.push({ file: consumer.file, before: consumer.source, after: edited.value.source });
    }
  }
  assert(written !== undefined, 'The removal plan includes the component');
  assert(changes.length <= PROPERTY_LIMITS.filesMax, 'The removal plan is bounded by the project');
  // Reads no constant can stand in for refuse the deletion; their lines are listed first.
  const component = projectRelative(request.projectPath, request.file);
  const blocked = removal.blocked.map((line) => ({ kind: 'reads' as const, path: component, line }));
  const preview = { name, component, usages, reviews: [...blocked, ...reviews] };
  return ok({ changes, preview: removal.kept === undefined ? preview : { ...preview, kept: removal.kept } });
}

/** The plan as a batch to write: refused while the component's own code still reads the prop, so a deletion never leaves code broken. */
export function removalChanges(plan: PropertyRemovalPlan): Result<readonly RemovalFileChange[]> {
  const reads = plan.preview.reviews.filter((review) => review.kind === 'reads');
  if (reads.length > 0) {
    return err(refusal('in-use', 'props.edit.readsInCode', { name: plan.preview.name, lines: reads.map((review) => review.line).join(', ') }));
  }
  assert(plan.changes.length > 0, 'A removal writes the component at least');
  return ok(plan.changes);
}

interface InstanceRemoval {
  readonly source: string;
  /** The attributes and spread keys taken out. */
  readonly count: number;
  /** Lines of spreads that may still carry the prop. */
  readonly spreads: readonly number[];
}

function unchanged(source: string): InstanceRemoval {
  return { source, count: 0, spreads: [] };
}

// Every instance of the component in one file, without the attribute that passes `name`.
function removeInstanceValues(source: string, names: ReadonlySet<string>, name: string): Result<InstanceRemoval> {
  const root = parseAstroTemplate(source);
  if (!root.ok) {
    return root;
  }
  const edits: SourceEdit[] = [];
  const spreads: number[] = [];
  let count = 0;
  const pending: Node[] = [root.value];
  for (let index = 0; index < pending.length; index += 1) {
    assert(pending.length <= PROPERTY_LIMITS.nodesMax, 'Astro removal node budget');
    const node = pending[index];
    assert(node !== undefined, 'Queued Astro node exists');
    if (node.type === 'component' && names.has(node.name)) {
      for (const attribute of node.attributes) {
        const removed = removeAttributeValue(source, attribute, name);
        if (!removed.ok) {
          return removed;
        }
        switch (removed.value.kind) {
          case 'none':
            break;
          case 'removed':
            edits.push(...removed.value.edits);
            count += 1;
            break;
          case 'review':
            spreads.push(lineAt(source, astroOffset(source, attribute)));
            break;
          default: {
            const exhaustive: never = removed.value;
            return exhaustive;
          }
        }
      }
    }
    if ('children' in node) {
      if (node.type === 'element' && ['script', 'style'].includes(node.name)) {
        continue;
      }
      pending.push(...node.children);
    }
  }
  if (edits.length === 0) {
    return ok({ source, count, spreads });
  }
  const output = applySourceEdits(source, edits);
  // The post-edit check: what is written must parse as the file did.
  const parsed = parseAstroTemplate(output);
  if (!parsed.ok) {
    return positionError();
  }
  assert(output.length < source.length, 'Removing attributes only takes text out');
  return ok({ source: output, count, spreads });
}

type AttributeRemoval = { readonly kind: 'none' } | { readonly kind: 'removed'; readonly edits: readonly SourceEdit[] } | { readonly kind: 'review' };

function removeAttributeValue(source: string, attribute: AttributeNode, name: string): Result<AttributeRemoval> {
  const start = astroOffset(source, attribute);
  if (attribute.kind === 'spread') {
    return removeSpreadKey(source, attribute, name, start);
  }
  if (attribute.name !== name) {
    return ok({ kind: 'none' });
  }
  const range = attributeRange(source, attribute, start);
  if (range === undefined) {
    return positionError();
  }
  return ok({ kind: 'removed', edits: [{ start: leadingSpace(source, range.start), end: range.end, text: '' }] });
}

// A literal spread loses the key, or, when the key is all it holds, the whole spread.
function removeSpreadKey(source: string, attribute: AttributeNode, name: string, start: number): Result<AttributeRemoval> {
  const object = literalSpreadObject(attribute.name, SPREAD_PREFIX);
  if (object === undefined) {
    // An object Stacki cannot see into may carry the key, or may not: the line is listed, the object left as it is.
    return ok({ kind: 'review' });
  }
  const properties = object.properties;
  const matching = properties.filter((property) => propertyKey(property.name) === name);
  if (matching.length === 0) {
    return ok({ kind: 'none' });
  }
  if (source.slice(start, start + attribute.name.length) !== attribute.name) {
    return positionError();
  }
  if (matching.length === properties.length) {
    const range = spreadRange(source, start, attribute.name.length);
    return range === undefined ? positionError() : ok({ kind: 'removed', edits: [{ start: leadingSpace(source, range.start), end: range.end, text: '' }] });
  }
  const base = start - SPREAD_PREFIX.length;
  const edits = matching.map((property): SourceEdit => {
    const index = properties.indexOf(property);
    const next = properties[index + 1];
    const previous = properties[index - 1];
    // With a key after it, the key and its comma go; the last key goes with the comma before it.
    if (next !== undefined) {
      return { start: base + property.getStart(), end: base + next.getStart(), text: '' };
    }
    assert(previous !== undefined, 'A spread that keeps other keys has one before its last');
    return { start: base + previous.end, end: base + property.end, text: '' };
  });
  return ok({ kind: 'removed', edits });
}

interface Range {
  readonly start: number;
  readonly end: number;
}

// Where an attribute's text begins and ends, checked against the text: a parser offset the text does not bear out refuses the plan.
function attributeRange(source: string, attribute: AttributeNode, start: number): Range | undefined {
  if (attribute.kind === 'shorthand') {
    return braced(source, start, attribute.name.length);
  }
  if (source.slice(start, start + attribute.name.length) !== attribute.name) {
    return undefined;
  }
  const afterName = start + attribute.name.length;
  if (attribute.kind === 'empty') {
    return { start, end: afterName };
  }
  const equals = skipSpace(source, afterName);
  if (source[equals] !== '=') {
    return undefined;
  }
  const value = skipSpace(source, equals + 1);
  switch (attribute.kind) {
    case 'quoted':
    case 'template-literal': {
      const raw = attribute.raw;
      return raw !== undefined && raw !== '' && source.startsWith(raw, value) ? { start, end: value + raw.length } : undefined;
    }
    case 'expression': {
      if (source[value] !== '{') {
        return undefined;
      }
      const inner = source.indexOf(attribute.value, value + 1);
      if (inner < 0 || source.slice(value + 1, inner).trim() !== '') {
        return undefined;
      }
      const close = skipSpace(source, inner + attribute.value.length);
      return source[close] === '}' ? { start, end: close + 1 } : undefined;
    }
    case 'spread':
      return undefined;
    default: {
      const exhaustive: never = attribute.kind;
      return exhaustive;
    }
  }
}

// `{name}` with the braces, spaces inside them allowed.
function braced(source: string, start: number, length: number): Range | undefined {
  const open = skipSpaceBack(source, start);
  const close = skipSpace(source, start + length);
  if (source[open - 1] !== '{' || source[close] !== '}') {
    return undefined;
  }
  return { start: open - 1, end: close + 1 };
}

// `{...expression}`, from its brace to its brace.
function spreadRange(source: string, start: number, length: number): Range | undefined {
  const dots = skipSpaceBack(source, start);
  if (source.slice(dots - 3, dots) !== '...') {
    return undefined;
  }
  return braced(source, dots - 3, start + length - (dots - 3));
}

function skipSpace(source: string, position: number): number {
  let index = position;
  while (index < source.length && /\s/.test(source.charAt(index))) {
    index += 1;
  }
  return index;
}

function skipSpaceBack(source: string, position: number): number {
  let index = position;
  while (index > 0 && /\s/.test(source.charAt(index - 1))) {
    index -= 1;
  }
  return index;
}

// The space before an attribute goes with it, so `<Button direction="back" />` leaves `<Button />` and a line of its own leaves no blank line.
function leadingSpace(source: string, start: number): number {
  const space = skipSpaceBack(source, start);
  assert(space <= start, 'Leading space ends where the attribute starts');
  return space;
}

function projectRelative(projectPath: string, file: string): string {
  const relative = path.relative(projectPath, file);
  assert(!relative.startsWith('..'), 'A planned file is inside the project');
  return relative.split(path.sep).join('/');
}

function positionError(): Result<never> {
  return err(refusal('position', 'props.rename.position'));
}
