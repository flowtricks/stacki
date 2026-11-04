// The mutable tree is the existing editor protocol. Keep its mutation local to
// parser construction and chunk resolution until the planned intent conversion.
// Kind-specific payloads remain a union so serializers cannot invent a node.
import type { Attr, AttrSpan } from '../../shared/page/pageNode';
import type { FrontmatterModel } from '../../shared/page/frontmatterSource';
import type { CodeKind } from '../../shared/properties/propSchema';

interface NodeMetadata {
  id?: string;
  source?: string | undefined;
  blankBefore?: number;
  blankAfter?: number;
  start?: number;
  end?: number;
  mdSource?: string;
  props?: Record<string, Attr> | undefined;
  attrOrder?: readonly string[] | undefined;
  attrSource?: string;
  attrSpans?: readonly AttrSpan[];
}

type NodeFields =
  | {
      kind: 'component' | 'element';
      name: string;
      children: ParserNode[] | undefined;
      shorthand?: boolean;
      tightClose?: boolean;
      closeSource?: string;
      dynamicTag?: boolean;
      astroAsset?: boolean;
      chunkFile?: string;
      chunkAggregate?: boolean;
    }
  | { kind: 'text' | 'expr' | 'raw-line'; value: string }
  | { kind: 'comment'; value: string; jsx?: boolean }
  | { kind: 'raw'; name: string; inner: string }
  | {
      kind: 'map';
      head: string;
      children: ParserNode[];
      headSource?: string;
      body?: readonly string[];
      bodyParts?: readonly string[];
      bare?: boolean;
    }
  | { kind: 'cond'; op: '?' | '&&'; test: string; children: ParserNode[] }
  | { kind: 'branch'; name: 'then' | 'else'; children: ParserNode[] }
  | { kind: 'chunk-group'; name: string; chunkFile: string; children: ParserNode[] };

type UnionKeys<T> = T extends object ? keyof T : never;
// Missing fields are readable as undefined but cannot be assigned. This keeps
// legacy feature probes honest without accepting mixed node payloads.
type CompleteVariant<T, Keys extends PropertyKey> = T extends object ? T & { [Key in Exclude<Keys, keyof T>]?: never } : never;

export type ParserNode = NodeMetadata & CompleteVariant<NodeFields, UnionKeys<NodeFields>>;
export type MapNode = Extract<ParserNode, { kind: 'map' }>;
export type CondNode = Extract<ParserNode, { kind: 'cond' }>;
export type BranchNode = Extract<ParserNode, { kind: 'branch' }>;
export type ValueNode = Extract<ParserNode, { value: string }>;

export interface ParseBail {
  readonly what: string;
  readonly near: string;
}
export type ParsedTemplate =
  | { readonly clean: true; readonly nodes: ParserNode[]; readonly trailingBlank: number }
  | { readonly clean: false; readonly nodes: ParserNode[]; readonly trailingBlank?: never };

export interface ParserPageModel extends FrontmatterModel {
  readonly hadFrontmatter: boolean;
  readonly trailingBlank: number;
  readonly eol: '\n' | '\r\n';
  readonly nodes: ParserNode[];
  readonly bodyStart?: number;
}
export type ParsedPage =
  { readonly editable: true; readonly model: ParserPageModel } | { readonly editable: false; readonly reason: string; readonly bail: ParseBail | undefined };

export interface NumberRules {
  min?: number;
  max?: number;
  step?: number;
  minExclusive?: boolean;
  maxExclusive?: boolean;
}
export interface DefaultRule {
  readonly prop: string;
  readonly is: string;
  readonly then: string;
  readonly otherwise: string;
}
export interface StatedDefault {
  readonly value?: string | number;
  readonly hint?: string;
  readonly when?: DefaultRule;
}
export interface UnionBranch {
  readonly forbids: readonly string[];
  readonly pins: Readonly<Record<string, readonly string[]>>;
  readonly defaults: Readonly<Record<string, string | number>>;
  readonly rules: Readonly<Record<string, DefaultRule>>;
  readonly docs: Readonly<Record<string, string>>;
}
export interface PropUnion {
  readonly names: readonly string[];
  readonly branches: readonly UnionBranch[];
}
// What a value set in code is: an object (edited as its fields when they are
// simple), a function (an action, never typed into a field) or a type that says
// nothing a field could fill in (`any`, `unknown`, a promise). Lists carry none.
export type { CodeKind } from '../../shared/properties/propSchema';
export interface NormalizedType {
  readonly type: 'enum' | 'attrs' | 'code' | 'string' | 'number' | 'boolean' | 'other';
  readonly options?: readonly string[] | undefined;
  readonly numeric?: boolean | undefined;
  // The options of a mixed choice written as expressions (`true`, `3`), not strings.
  readonly expressionOptions?: readonly string[] | undefined;
  readonly codeKind?: CodeKind | undefined;
}
export interface SchemaField extends NumberRules {
  readonly name: string;
  type: NormalizedType['type'];
  optional: boolean;
  default: string | number | boolean | undefined;
  defaultExpr?: boolean;
  // The project file an expression default imports ("src/assets/hero.webp").
  readonly defaultAsset?: string;
  hint?: string;
  readonly options?: readonly string[] | undefined;
  readonly numeric?: boolean | undefined;
  readonly expressionOptions?: readonly string[] | undefined;
  codeKind?: CodeKind | undefined;
  // The declared type as written, for the code row; only on code-only props.
  typeText?: string | undefined;
  readonly doc?: string | undefined;
  readonly shape?: readonly { readonly name: string; readonly type: string }[];
  readonly shapeIsList?: boolean;
  readonly unions?: readonly PropUnion[] | undefined;
}

export type RenderTag = { readonly tag: string; readonly prop?: string } | { readonly prop: string } | { readonly options: readonly string[] };

export type SourceLocation = { readonly file: string } | { readonly file: string; readonly startLine: number; readonly endLine: number };
