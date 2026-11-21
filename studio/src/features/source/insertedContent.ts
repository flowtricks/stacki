// The node a palette pick writes, apart from the writer (insertContent.ts) so the browser can
// build the same node for the canvas stand-in shown before the write (QuickInsert.tsx,
// shared/page/canvasInsert.ts): the stand-in and the rendered node then agree. Pure.
import { VOID_TAGS } from '../../../vendor/stacki/src/editor/elementSchemas';
import type { InsertContent } from './insertContentContract';
import type { ParserNode } from './source';

/** The node the canvas stands in for a pick; an Astro asset stands in as its component. */
export function insertedContentPreview(content: InsertContent): ParserNode {
  return content.type === 'astroAsset' ? { kind: 'component', name: content.name, props: {}, children: undefined } : insertedContentNode(content);
}

export function insertedContentNode(content: Exclude<InsertContent, { readonly type: 'astroAsset' }>): ParserNode {
  switch (content.type) {
    case 'element': {
      const text = /^h[1-6]$/.test(content.tag) ? 'Heading' : content.tag === 'p' ? PARAGRAPH : '';
      return {
        kind: 'element',
        name: content.tag,
        props: {},
        children: VOID_TAGS.has(content.tag) ? undefined : text ? [{ kind: 'text', value: text }] : [],
      };
    }
    case 'map':
      return { kind: 'map', head: '[].map((item) => (', children: [] };
    case 'cond':
      return {
        kind: 'cond',
        op: '&&',
        test: 'true',
        children: [{ kind: 'branch', name: 'then', children: [] }],
      };
    case 'text':
      // i18n-ignore: starter content written into the person's page, not interface text.
      return { kind: 'text', value: 'Text' };
    case 'comment':
      return { kind: 'comment', value: ' Comment ' };
    case 'expr':
      return { kind: 'expr', value: '{/* code */}' };
    case 'doctype':
      return { kind: 'raw-line', value: '<!doctype html>' };
    case 'style':
    case 'script':
      return { kind: 'raw', name: content.type, props: {}, inner: '' };
  }
}
const PARAGRAPH =
  'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Suspendisse varius ' +
  'enim in eros elementum tristique. Duis cursus, mi quis viverra ornare, eros ' +
  'dolor interdum nulla, ut commodo diam libero vitae erat. Aenean faucibus nibh ' +
  'et justo cursus id rutrum lorem imperdiet. Nunc ut sem vitae risus tristique ' +
  'posuere.';
