// The page tree's shapes: an attribute, each kind of node with the source
// metadata it carries, an import, the page model and a parse result. The
// parsers that admit them across a boundary are in pageNode.ts.

import type { NodeId, Utf16Offset } from '../core/brand';
import { type ImportSlot } from './frontmatter';
import { type Utf16Span } from '../core/span';

export type Attr =
  | { readonly type: 'string'; readonly value: string }
  | { readonly type: 'expr'; readonly value: string }
  | { readonly type: 'bare' }
  | { readonly type: 'spread'; readonly value: string };

/** Fields a component or element tag can carry. children is undefined exactly
 * when the tag is self-closing; layout fields preserve how the source was
 * written so serialization round-trips. */
export interface PairedNode {
  readonly kind: 'component' | 'element';
  readonly id: NodeId;
  readonly name: string;
  readonly children: readonly PageNode[] | undefined;
  readonly props?: Readonly<Record<string, Attr>>;
  readonly attrOrder?: readonly string[];
  readonly attrSource?: string;
  readonly tightClose?: boolean;
  readonly shorthand?: boolean;
  readonly source?: string;
  readonly blankBefore?: number;
  readonly blankAfter?: number;
  readonly closeSource?: string;
  readonly dynamicTag?: boolean;
  readonly astroAsset?: boolean;
}

/** <style>/<script>: inner kept verbatim, never parsed. */
export interface RawNode {
  readonly kind: 'raw';
  readonly id: NodeId;
  readonly name: string;
  readonly inner: string;
  readonly props?: Readonly<Record<string, Attr>>;
  readonly attrOrder?: readonly string[];
  readonly attrSource?: string;
}

export interface ValueNode {
  readonly kind: 'text' | 'expr' | 'raw-line';
  readonly id: NodeId;
  readonly value: string;
}

export interface CommentNode {
  readonly kind: 'comment';
  readonly id: NodeId;
  readonly value: string;
  /** Written inside JSX braces ({/* ... *\/}) rather than as HTML. */
  readonly jsx?: boolean;
}

/** A `.map(...)` loop: head is the normalized loop header, children the body. */
export interface MapNode {
  readonly kind: 'map';
  readonly id: NodeId;
  readonly head: string;
  readonly children: readonly PageNode[];
  readonly headSource?: string;
  readonly bare?: boolean;
  readonly body?: readonly string[];
  /** JavaScript between callback markup roots, including the closing call/braces. */
  readonly bodyParts?: readonly string[];
  readonly source?: string;
}

/** Conditional markup: one 'then' branch, and an 'else' branch for ternaries. */
export interface CondNode {
  readonly kind: 'cond';
  readonly id: NodeId;
  readonly op: '?' | '&&';
  readonly test: string;
  readonly children: readonly BranchNode[];
}

export interface BranchNode {
  readonly kind: 'branch';
  readonly id: NodeId;
  readonly name: 'then' | 'else';
  readonly children: readonly PageNode[];
}

/** A serialization chunk group — produced by resolveChunks, not parsePage. */
export interface ChunkGroupNode {
  readonly kind: 'chunk-group';
  readonly id: NodeId;
  readonly name: string;
  readonly chunkFile: string;
  readonly children: readonly PageNode[];
}

export interface MarkdownNodeMetadata {
  readonly mdBlanksBefore?: number;
  readonly mdIndent?: string;
  readonly mdFence?: string;
  readonly mdInfo?: string;
  readonly mdUnclosed?: boolean;
  readonly mdRaw?: string;
  readonly mdGap?: string;
  readonly mdTrail?: string;
  readonly mdSetext?: string;
  readonly mdImage?: boolean;
  readonly mdNumbers?: readonly number[];
  readonly mdLoose?: boolean;
  readonly mdMarker?: string;
  readonly mdSource?: string;
  readonly mdEsm?: boolean;
}

/** Where one attribute was written (plan §3.2), in the file's UTF-16 offsets.
 * `span` covers the whole attribute (`name="v"`, `{...rest}`, `hidden`); the
 * name span slices to the name and the value span to the value exactly as the
 * props record reports it — inside the quotes, or the trimmed expression inside
 * the braces. Each field exists only on the variants that have it.
 *
 * A `markdown` attribute (step 10) is one Markdown writes in its own syntax,
 * with no name in the source: an image's alt text between its brackets, its
 * source and title in its parentheses, a fence's language, an ordered list's
 * first number. The props record holds it as a string. */
export type AttrSpan =
  | {
      readonly type: 'string' | 'expr';
      readonly name: string;
      readonly span: Utf16Span;
      readonly nameSpan: Utf16Span;
      readonly valueSpan: Utf16Span;
    }
  | {
      readonly type: 'bare';
      readonly name: string;
      readonly span: Utf16Span;
      readonly nameSpan: Utf16Span;
    }
  | {
      readonly type: 'spread';
      readonly name: string;
      readonly span: Utf16Span;
      readonly valueSpan: Utf16Span;
    }
  | {
      readonly type: 'markdown';
      readonly name: string;
      readonly span: Utf16Span;
      readonly valueSpan: Utf16Span;
    };

/** Source offsets, present only on a parse that asked for them (`locs`): they
 * describe the file as read and go stale the moment the model is edited. */
export interface SourceNodeMetadata {
  readonly start?: Utf16Offset;
  readonly end?: Utf16Offset;
  /** Every attribute occurrence in source order — a duplicated name appears
   * twice here and once in props, where the last occurrence wins. */
  readonly attrSpans?: readonly AttrSpan[];
}

export type PageNode = (PairedNode | RawNode | ValueNode | CommentNode | MapNode | CondNode | BranchNode | ChunkGroupNode) &
  MarkdownNodeMetadata &
  SourceNodeMetadata;

export type PageNodeList = readonly PageNode[] & { readonly mdTrailingBlanks?: number };

/** One import declaration in a frontmatter block. */
export interface ImportDecl {
  readonly name: string;
  readonly path: string;
  readonly quote: string;
  readonly named?: boolean;
  readonly imported?: string;
  readonly typeOnly?: boolean;
  /** Existing imports retain their source slot; new imports have no slot yet. */
  readonly at?: number;
}

/** The frontmatter model plus the parsed body tree, as parsePage returns it. */
export interface PageModel {
  readonly imports: readonly ImportDecl[];
  readonly frontmatterLead: string;
  readonly extraFrontmatter: string;
  readonly extraFrontmatterSpaced: boolean;
  readonly frontmatterLayout: {
    readonly extra: string;
    readonly slots: readonly ImportSlot[];
  };
  readonly hadFrontmatter: boolean;
  readonly trailingBlank: number;
  readonly eol?: '\n' | '\r\n';
  readonly nodes: PageNodeList;
  readonly bodyStart?: number;
  readonly format?: 'md' | 'mdx';
  readonly frontmatterLang?: 'yaml';
  readonly layoutPath?: string | undefined;
  readonly mdEol?: string;
  readonly mdEndsWithNewline?: boolean;
  readonly mdHasFrontmatter?: boolean;
}

export type ParsePageResult =
  | {
      readonly editable: false;
      readonly reason: string;
      readonly bail: { readonly what: string; readonly near: string } | undefined;
    }
  | { readonly editable: true; readonly model: PageModel };
