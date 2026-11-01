// Content schemas are supplied by a project-owned dev server. Parse every used
// field and bound both depth and total work before constructing form controls.
import { BOUNDARY_LIMITS, boolean, count, data, dictionary, list, object, optional, text } from '../../../shared/core/boundary';
import type { ContentSchema } from './contentSchemaTypes';

const finite = (input: unknown): number => {
  if (typeof input !== 'number' || !Number.isFinite(input)) {
    throw new Error('Schema constraint must be a finite number');
  }
  return input;
};
const parseMetadata = object({
  type: optional((input) => (typeof input === 'string' ? text(input) : list(text)(input))),
  $ref: optional(text),
  required: optional(list(text)),
  enum: optional(list(data)),
  description: optional(text),
  format: optional(text),
  pattern: optional(text),
  const: optional(data),
  default: optional(data),
  minLength: optional(count),
  maxLength: optional(count),
  minimum: optional(finite),
  maximum: optional(finite),
  exclusiveMinimum: optional(finite),
  exclusiveMaximum: optional(finite),
  minItems: optional(count),
  maxItems: optional(count),
  astroImage: optional(boolean),
  astroDate: optional(boolean),
  astroReference: optional(text),
  astroTransform: optional(boolean),
  astroCoerced: optional(boolean),
  recursive: optional(text),
  recursiveOnly: optional(boolean),
});

export function parseContentSchema(input: unknown): ContentSchema {
  let remaining = BOUNDARY_LIMITS.itemsMax;
  const visit = (value: unknown, depth: number): ContentSchema => {
    if (--remaining < 0) {
      throw new Error('Content schema exceeds item limit');
    }
    if (depth > BOUNDARY_LIMITS.depthMax) {
      throw new Error('Content schema exceeds depth limit');
    }
    const child = (node: unknown): ContentSchema => visit(node, depth + 1);
    const structure = object({
      $defs: optional(dictionary(child)),
      properties: optional(dictionary(child)),
      items: optional(child),
      anyOf: optional(list(child)),
      oneOf: optional(list(child)),
      additionalProperties: optional((node): ContentSchema | boolean => (typeof node === 'boolean' ? node : child(node))),
    })(value);
    return { ...parseMetadata(value), ...structure };
  };
  return visit(input, 0);
}
