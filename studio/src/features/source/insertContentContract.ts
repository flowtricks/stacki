import { HTML_TAGS } from '../../../vendor/stacki/src/editor/elementSchemas';
import { record, string } from '../../shared/validation';

export type InsertContent =
  | { readonly type: 'element'; readonly tag: string }
  | { readonly type: 'astroAsset'; readonly name: 'Image' | 'Picture' }
  | {
      readonly type: 'map' | 'cond' | 'text' | 'comment' | 'expr' | 'doctype' | 'style' | 'script';
    };

export function parseInsertContent(input: unknown): InsertContent {
  const value = record(input);
  const type = string(value['type'], 20);
  if (type === 'element') {
    const tag = string(value['tag'], 30);
    if (!HTML_TAGS.includes(tag) && tag !== 'slot') {
      throw new Error('Invalid HTML element');
    }
    return { type, tag };
  }
  if (type === 'astroAsset' && (value['name'] === 'Image' || value['name'] === 'Picture')) {
    return { type, name: value['name'] };
  }
  if (
    type === 'map' ||
    type === 'cond' ||
    type === 'text' ||
    type === 'comment' ||
    type === 'expr' ||
    type === 'doctype' ||
    type === 'style' ||
    type === 'script'
  ) {
    return { type };
  }
  throw new Error('Invalid insert choice');
}
