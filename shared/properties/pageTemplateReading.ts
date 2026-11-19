// A template page's settings as main read them back from its code (electron/content/pageTemplateRead.ts), on the
// wire to the Page settings dialog. `custom` carries only the code: a template changed by hand is shown, never modelled.
import { list, record, text } from '../core/boundary';
import { parseContentSlug, type ContentSlug } from './pageTemplate';

export const TEMPLATE_READING_LIMITS = {
  usedFieldsMax: 100,
  fieldNameCharsMax: 200,
} as const satisfies Record<string, number>;

export type TemplateReading =
  | { readonly kind: 'none' }
  | { readonly kind: 'custom'; readonly code: string }
  | {
      readonly kind: 'content';
      readonly collection: string;
      readonly slug: ContentSlug;
      readonly param: string;
      readonly api: 'current' | 'legacy';
      readonly code: string;
      /** Fields of the entry the page's markup shows (`entry.data.title`), to warn when a new collection lacks one. */
      readonly usedFields: readonly string[];
    };

/** The reply as it crosses IPC: the same shape. */
export type WireTemplateReading = TemplateReading;

export function parseTemplateReading(input: unknown): TemplateReading {
  const value = record(input);
  switch (value['kind']) {
    case 'none':
      return { kind: 'none' };
    case 'custom':
      return { kind: 'custom', code: text(value['code']) };
    case 'content': {
      const collection = text(value['collection']);
      if (collection.length === 0) {
        throw new Error('Template reading: empty collection');
      }
      const param = text(value['param']);
      if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(param)) {
        throw new Error('Template reading: invalid route parameter');
      }
      const api = value['api'];
      if (api !== 'current' && api !== 'legacy') {
        throw new Error('Template reading: unknown collection API');
      }
      const usedFields = list(text)(value['usedFields']);
      if (usedFields.length > TEMPLATE_READING_LIMITS.usedFieldsMax) {
        throw new Error('Template reading: too many used fields');
      }
      if (usedFields.some((field) => field.length === 0 || field.length > TEMPLATE_READING_LIMITS.fieldNameCharsMax)) {
        throw new Error('Template reading: invalid field name');
      }
      return { kind: 'content', collection, slug: parseContentSlug(value['slug']), param, api, code: text(value['code']), usedFields };
    }
    default:
      throw new Error('Template reading: unknown kind');
  }
}
