import { createRequire } from 'node:module';
import { z } from 'astro/zod';

const META = Symbol.for('stacki.astro.schema-meta');
// This file is copied alone into the project to run there, so it cannot import shared/core/limits.
// A chain of refinements is written by hand, one call per rule; 64 is far past any real one.
const SCHEMA_LIMITS = { effectsDepthMax: 64 };
export const definitionOf = (schema) => schema?._zod?.def || schema?._def || undefined;

// Astro 5 exposes Zod 3; newer versions expose Zod 4. Stubs create these
// schemas themselves, so attaching metadata to the older definition is local
// to introspection and never changes a schema inside the user's dev server.
export function withMetadata(schema, metadata) {
  if (typeof schema.meta === 'function') {
    return schema.meta(metadata);
  }
  schema._def[META] = { ...schema._def[META], ...metadata };
  return schema;
}

export function hasCrossFieldChecks(schema, depth = 0) {
  // The schema is the project's code. Past the bound, answer as if it had checks: the entry is
  // then validated by the schema itself, which is the answer that cannot miss a rule.
  if (depth > SCHEMA_LIMITS.effectsDepthMax) {
    return true;
  }
  const definition = definitionOf(schema);
  if (Array.isArray(definition?.checks) && definition.checks.length > 0) {
    return true;
  }
  if (definition?.typeName === 'ZodEffects') {
    return definition.effect?.type === 'refinement' || hasCrossFieldChecks(definition.schema, depth + 1);
  }
  return false;
}

// Preserve file-side values: a transformed schema describes what the file
// stores, while date/image/reference annotations drive the editor's fields.
export function toJsonSchema(schema) {
  if (typeof z.toJSONSchema === 'function') {
    return z.toJSONSchema(schema, {
      io: 'input',
      unrepresentable: 'any',
      cycles: 'ref',
      reused: 'inline',
      override({ zodSchema, jsonSchema }) {
        const definition = definitionOf(zodSchema);
        if (definition?.type === 'date') {
          jsonSchema.astroDate = true;
          if (definition.coerce) {
            jsonSchema.astroCoerced = true;
          }
        }
        if (definition?.type === 'pipe' || definition?.type === 'transform') {
          jsonSchema.astroTransform = true;
        }
      },
    });
  }
  // Resolve through Astro's package, whose private dependencies may be in a
  // pnpm store rather than hoisted beside the project's staged runner.
  const projectRequire = createRequire(import.meta.url);
  const astroRequire = createRequire(projectRequire.resolve('astro/package.json'));
  const { zodToJsonSchema } = astroRequire('zod-to-json-schema');
  return zodToJsonSchema(schema, {
    effectStrategy: 'input',
    pipeStrategy: 'input',
    definitionPath: '$defs',
    postProcess(jsonSchema, definition) {
      if (!jsonSchema) {
        return jsonSchema;
      }
      Object.assign(jsonSchema, definition[META]);
      if (definition.typeName === 'ZodDate') {
        jsonSchema.astroDate = true;
        if (definition.coerce) {
          jsonSchema.astroCoerced = true;
        }
      }
      if (definition.typeName === 'ZodPipeline' || (definition.typeName === 'ZodEffects' && definition.effect?.type !== 'refinement')) {
        jsonSchema.astroTransform = true;
      }
      return jsonSchema;
    },
  });
}
