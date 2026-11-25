// i18n-ignore-file: the CLI and its MCP tools speak to agents and scripts in English; none of this is interface text.
// A file's key reference as plain data: the one text `stacki schema`, the `stacki_schema` MCP tool and the MCP schema resources all print.
import { assert } from '../../core/assert';
import { describeType, SCHEMA_LIMITS, type FieldSchema, type FileSchema } from './stackiSchema';

export function describeFileSchema(schema: FileSchema): unknown {
  assert(schema.id.length > 0, 'A file has an id');
  return {
    id: schema.id,
    file: schema.file,
    description: schema.description,
    requires: schema.requires,
    commands: schema.commands,
    keys: describeFields(schema.fields, 0),
    empty: schema.empty,
  };
}

function describeFields(fields: Readonly<Record<string, FieldSchema>>, depth: number): unknown {
  assert(depth >= 0, 'Depth counts from zero');
  if (depth > SCHEMA_LIMITS.depthMax) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(fields).map(([key, entry]) => {
      const type = entry.type;
      return [
        key,
        {
          type: describeType(type),
          description: entry.description,
          required: entry.required,
          ...(entry.default === undefined ? {} : { default: entry.default }),
          ...(entry.commands === undefined ? {} : { commands: entry.commands }),
          ...(entry.legacy === true ? { legacy: true } : {}),
          ...(type.kind === 'object' ? { keys: describeFields(type.fields, depth + 1) } : {}),
          ...(type.kind === 'variant'
            ? { variants: Object.fromEntries(Object.entries(type.variants).map(([name, variant]) => [name, describeFields(variant, depth + 1)])) }
            : {}),
          ...(type.kind === 'array' && type.item.kind === 'object' ? { entryKeys: describeFields(type.item.fields, depth + 1) } : {}),
          ...(type.kind === 'map' && type.value.kind === 'object' ? { entryKeys: describeFields(type.value.fields, depth + 1) } : {}),
        },
      ];
    }),
  );
}
