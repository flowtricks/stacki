// The wire shapes the IPC results are built from: assets, CMS and content,
// git, and the parser's page and node models as they cross the bridge
// (ipcResults.ts).

import type { Data } from '../core/boundary';
import type { MessageRef } from '../core/i18n/messageReference';

export type WireAssetEntry =
  | ({
      readonly rel: string;
      readonly name: string;
      readonly parent: string;
      readonly root: string;
    } & {
      readonly isDir: true;
      readonly isRoot?: true;
    })
  | ({
      readonly rel: string;
      readonly name: string;
      readonly parent: string;
      readonly root: string;
    } & {
      readonly isDir: false;
      readonly size: number;
      readonly abs: string;
    });

export type WireCmsFile = {
  readonly rel: string;
  readonly name: string;
  readonly dir: string;
  readonly abs: string;
  readonly fromFile?: boolean;
  readonly fromPage?: boolean;
  readonly size?: number;
  readonly data?: unknown;
  readonly error?: string;
};

export type WireUsageFile = {
  readonly rel: string;
  readonly path: string;
  readonly kind: 'layout' | 'page' | 'component' | 'file';
  readonly count: number;
};

export type WireLoaderInfo = {
  readonly kind?: string;
  readonly base?: string;
  readonly pattern?: string | ReadonlyArray<string>;
  readonly file?: string;
  readonly generateId?: unknown;
  readonly parser?: unknown;
};

export type WireContentConfig = {
  readonly collections: ReadonlyArray<WireCollection>;
  readonly missing?: true;
  readonly error?: string;
  readonly configPath?: string;
};

export type WireEntry = {
  readonly id: string;
  readonly file: string;
  readonly format: string;
  readonly locator: ReadonlyArray<string | number>;
  readonly data: unknown;
  readonly title: string;
  readonly body?: string;
  readonly hasBody?: boolean;
  readonly error?: string;
  readonly keyed?: boolean;
  /** Its picture: the project file its collection's first image field names. */
  readonly imageFile?: string;
};

export type WireCollection = {
  readonly loader?: WireLoaderInfo & { readonly kind: string };
  readonly extensions?: readonly string[];
  readonly hasBody?: boolean;
  readonly idFromFile?: boolean;
  readonly crossFieldChecks?: boolean;
  readonly freeform?: undefined | boolean;
  readonly error?: undefined | string;
  readonly name: string;
  readonly editable?: boolean;
  readonly schema?: unknown;
};

export type WireMove =
  | {
      readonly kind: 'generated';
      readonly note: string;
      readonly noteRef?: undefined | MessageRef;
    }
  | {
      readonly kind: 'unknown';
      readonly note: string;
      readonly noteRef?: undefined | MessageRef;
    }
  | {
      readonly kind: 'file';
      readonly from: string;
      readonly to: string;
    }
  | {
      readonly kind: 'key';
      readonly file: string;
      readonly locator: ReadonlyArray<string | number>;
    }
  | {
      readonly kind: 'field';
      readonly file: string;
      readonly locator: ReadonlyArray<string | number>;
    };

export type WirePointer = {
  readonly collection: string;
  readonly entryId: string;
  readonly entryTitle: string;
  readonly file: string;
  readonly path: WireSchemaPath;
  readonly entry: {
    readonly file: string;
    readonly locator: ReadonlyArray<string | number>;
  };
};

export type WireImageEdit = {
  readonly path: WireSchemaPath;
  readonly from: unknown;
  readonly value: string;
};

export type WireValidationResult = {
  readonly issues: ReadonlyArray<WireValidationIssue>;
} & {
  readonly unchecked?: boolean;
  readonly error?: string;
};

export type WireFileModel = {
  readonly rel: string;
  readonly name: string;
  readonly groups: ReadonlyArray<WireGroup>;
  readonly error?: string;
  readonly errorRef?: MessageRef | undefined;
  readonly count?: number;
  readonly declarations?: ReadonlyArray<WireRule>;
};

export type WireProjectFile = {
  readonly path: string;
  readonly status: undefined | string;
  readonly staged: boolean;
};

export type WireFileDescription = {
  readonly path: string;
  readonly kind: WireFileKind;
  readonly label: string;
};

export type WireFileChange = {
  readonly status: string;
  readonly path: string;
  readonly from?: undefined | string;
};

export type WireDeleteOutcome =
  | {
      readonly ok: true;
    }
  | {
      readonly ok: false;
      readonly unmerged: true;
      readonly message: string;
      readonly messageRef?: MessageRef | undefined;
    };

export type WireGitInfo = {
  readonly isRepo: true;
  readonly branch: string;
  readonly branches: ReadonlyArray<string>;
  readonly remote: undefined | string;
  readonly dirty: boolean;
  readonly ahead: number;
  readonly parked: ReadonlyArray<string>;
  readonly head?: undefined | string;
  readonly userEmail?: undefined | string;
  readonly trunk?: undefined | string;
  /** The remote's default branch (origin/HEAD), else main or master: what publishing is expected to send. */
  readonly defaultBranch?: undefined | string;
  readonly dirtyFiles?: ReadonlyArray<string>;
  readonly hasUpstream?: boolean;
};

export type WireCommitInfo = {
  readonly files: undefined | ReadonlyArray<WireFileChange & WireFileDescription & { readonly from: undefined | string }>;
  readonly hash: undefined | string;
  readonly shortHash: undefined | string;
  readonly author: undefined | string;
  readonly email: undefined | string;
  readonly when: undefined | string;
  readonly subject: undefined | string;
  readonly parents: ReadonlyArray<string>;
  readonly refs: ReadonlyArray<string>;
  readonly isMerge: boolean;
};

export type WireMergeOutcome =
  | {
      readonly ok: true;
      readonly into: undefined | string;
      readonly changed: boolean;
      readonly resolved?: number;
    }
  | {
      readonly ok: false;
      readonly conflicted: true;
      readonly from: undefined | string;
      readonly branch: string;
      readonly files: ReadonlyArray<WireMergeClash>;
    }
  | {
      readonly ok: false;
      readonly dirty: true;
      readonly from: undefined | string;
      readonly branch: string;
      readonly files: ReadonlyArray<string>;
    };

export type WireStatusFile = {
  readonly path: string;
  readonly from: undefined | string;
  readonly status: string;
  readonly staged: boolean;
  readonly untracked: boolean;
};

export type WireWorktreeInfo = {
  readonly path: string;
  readonly head: undefined | string;
  readonly branch: undefined | string;
  readonly detached: boolean;
  readonly bare: boolean;
};

export type WireRouteParams = {
  readonly [key: string]: Data;
};

export type WireDataRecord = {
  readonly [key: string]: Data;
};

export type WireMarkdownModel = {
  readonly format: 'md' | 'mdx';
  readonly imports: ReadonlyArray<{
    readonly name: string;
    readonly path: string;
  }>;
  readonly extraFrontmatter: string;
  readonly frontmatterLang: 'yaml';
  readonly layoutPath: undefined | string;
  readonly nodes: WireMarkdownNodeList;
  readonly mdEol: string;
  readonly mdEndsWithNewline: boolean;
  readonly mdHasFrontmatter: boolean;
};

export type WireParserPageModel = {
  readonly hadFrontmatter: boolean;
  readonly trailingBlank: number;
  readonly nodes: ReadonlyArray<WireParserNode>;
  readonly bodyStart?: number;
  readonly imports: ReadonlyArray<WireImportMember>;
  readonly frontmatterLead: string;
  readonly extraFrontmatter: string;
  readonly extraFrontmatterSpaced: boolean;
  readonly frontmatterLayout?: WireFrontmatterLayout;
};

export type WireParseBail = {
  readonly what: string;
  readonly near: string;
};

export type WireInjectedRoute = {
  readonly route: string;
  readonly entrypoint: undefined | string;
  readonly from: undefined | string;
  readonly params: ReadonlyArray<unknown>;
};

export type WireSchemaField = {
  readonly name: string;
  readonly type: 'string' | 'number' | 'boolean' | 'code' | 'enum' | 'attrs' | 'other';
  readonly optional: boolean;
  readonly default: undefined | string | number | boolean;
  readonly defaultExpr?: boolean;
  readonly defaultAsset?: string;
  readonly hint?: string;
  readonly options?: undefined | ReadonlyArray<string>;
  readonly numeric?: undefined | boolean;
  readonly doc?: undefined | string;
  readonly shape?: ReadonlyArray<WirePropShapeField>;
  readonly shapeIsList?: boolean;
  readonly unions?: undefined | ReadonlyArray<WirePropUnion>;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly minExclusive?: boolean;
  readonly maxExclusive?: boolean;
};

export type WireStyleFile = {
  readonly rel: string;
  readonly name: string;
  readonly path: string;
  readonly size: number;
};

export type WireSchemaPath = ReadonlyArray<string | number>;

export type WireValidationIssue = {
  readonly path: ReadonlyArray<string | number>;
  readonly message: string;
  readonly code: string;
};

export type WireGroup = {
  readonly kind: 'modes' | 'single';
  readonly label: string;
  readonly columns: ReadonlyArray<WireColumn>;
  readonly blocks: ReadonlyArray<WireBlock>;
  readonly scope?: WireVariableScope;
};

/** Who a `<style>` block's variables reach, and how the block was written. */
export type WireVariableScope = {
  readonly reach: 'page' | 'rendered' | 'scoped';
  readonly written: 'global' | 'inline' | 'scoped';
};

export type WireRule = {
  readonly selector: string;
  readonly selectors: ReadonlyArray<string>;
  readonly context: ReadonlyArray<string>;
  readonly line: number;
  readonly entries: ReadonlyArray<WireCssEntry>;
};

export type WireFileKind = 'content' | 'asset' | 'layout' | 'page' | 'component' | 'file' | 'style' | 'config' | 'script' | 'doc';

export type WireConflictPart =
  | { readonly kind: 'same'; readonly text: string }
  | {
      readonly kind: 'clash';
      readonly ours: string;
      readonly theirs: string;
      readonly changedBy: 'ours' | 'theirs' | 'both';
      readonly merged?: string | undefined;
    };

export type WireMergeClash = {
  readonly path: string;
  readonly ours: undefined | string;
  readonly theirs: undefined | string;
  readonly parts: undefined | ReadonlyArray<WireConflictPart>;
};

export type WireMarkdownNodeList = ReadonlyArray<WireMdNodeLike> & {
  readonly mdTrailingBlanks?: number;
};

export type WireParserNode =
  | (WireNodeMetadata & {
      readonly kind: 'component' | 'element';
      readonly name: string;
      readonly children: undefined | ReadonlyArray<WireParserNode>;
      readonly shorthand?: boolean;
      readonly tightClose?: boolean;
      readonly closeSource?: string;
      readonly dynamicTag?: boolean;
      readonly astroAsset?: boolean;
      readonly chunkFile?: string;
      readonly chunkAggregate?: boolean;
    } & {
      readonly value?: never;
      readonly jsx?: never;
      readonly inner?: never;
      readonly head?: never;
      readonly headSource?: never;
      readonly body?: never;
      readonly bare?: never;
      readonly op?: never;
      readonly test?: never;
    })
  | (WireNodeMetadata & {
      readonly kind: 'text' | 'expr' | 'raw-line';
      readonly value: string;
    } & {
      readonly name?: never;
      readonly children?: never;
      readonly shorthand?: never;
      readonly tightClose?: never;
      readonly closeSource?: never;
      readonly dynamicTag?: never;
      readonly astroAsset?: never;
      readonly chunkFile?: never;
      readonly chunkAggregate?: never;
      readonly jsx?: never;
      readonly inner?: never;
      readonly head?: never;
      readonly headSource?: never;
      readonly body?: never;
      readonly bare?: never;
      readonly op?: never;
      readonly test?: never;
    })
  | (WireNodeMetadata & {
      readonly kind: 'comment';
      readonly value: string;
      readonly jsx?: boolean;
    } & {
      readonly name?: never;
      readonly children?: never;
      readonly shorthand?: never;
      readonly tightClose?: never;
      readonly closeSource?: never;
      readonly dynamicTag?: never;
      readonly astroAsset?: never;
      readonly chunkFile?: never;
      readonly chunkAggregate?: never;
      readonly inner?: never;
      readonly head?: never;
      readonly headSource?: never;
      readonly body?: never;
      readonly bare?: never;
      readonly op?: never;
      readonly test?: never;
    })
  | (WireNodeMetadata & {
      readonly kind: 'raw';
      readonly name: string;
      readonly inner: string;
    } & {
      readonly value?: never;
      readonly children?: never;
      readonly shorthand?: never;
      readonly tightClose?: never;
      readonly closeSource?: never;
      readonly dynamicTag?: never;
      readonly astroAsset?: never;
      readonly chunkFile?: never;
      readonly chunkAggregate?: never;
      readonly jsx?: never;
      readonly head?: never;
      readonly headSource?: never;
      readonly body?: never;
      readonly bare?: never;
      readonly op?: never;
      readonly test?: never;
    })
  | (WireNodeMetadata & {
      readonly kind: 'map';
      readonly head: string;
      readonly children: ReadonlyArray<WireParserNode>;
      readonly headSource?: string;
      readonly body?: ReadonlyArray<string>;
      readonly bare?: boolean;
    } & {
      readonly name?: never;
      readonly value?: never;
      readonly shorthand?: never;
      readonly tightClose?: never;
      readonly closeSource?: never;
      readonly dynamicTag?: never;
      readonly astroAsset?: never;
      readonly chunkFile?: never;
      readonly chunkAggregate?: never;
      readonly jsx?: never;
      readonly inner?: never;
      readonly op?: never;
      readonly test?: never;
    })
  | (WireNodeMetadata & {
      readonly kind: 'cond';
      readonly op: '?' | '&&';
      readonly test: string;
      readonly children: ReadonlyArray<WireParserNode>;
    } & {
      readonly name?: never;
      readonly value?: never;
      readonly shorthand?: never;
      readonly tightClose?: never;
      readonly closeSource?: never;
      readonly dynamicTag?: never;
      readonly astroAsset?: never;
      readonly chunkFile?: never;
      readonly chunkAggregate?: never;
      readonly jsx?: never;
      readonly inner?: never;
      readonly head?: never;
      readonly headSource?: never;
      readonly body?: never;
      readonly bare?: never;
    })
  | (WireNodeMetadata & {
      readonly kind: 'branch';
      readonly name: 'then' | 'else';
      readonly children: ReadonlyArray<WireParserNode>;
    } & {
      readonly value?: never;
      readonly shorthand?: never;
      readonly tightClose?: never;
      readonly closeSource?: never;
      readonly dynamicTag?: never;
      readonly astroAsset?: never;
      readonly chunkFile?: never;
      readonly chunkAggregate?: never;
      readonly jsx?: never;
      readonly inner?: never;
      readonly head?: never;
      readonly headSource?: never;
      readonly body?: never;
      readonly bare?: never;
      readonly op?: never;
      readonly test?: never;
    })
  | (WireNodeMetadata & {
      readonly kind: 'chunk-group';
      readonly name: string;
      readonly chunkFile: string;
      readonly children: ReadonlyArray<WireParserNode>;
    } & {
      readonly value?: never;
      readonly shorthand?: never;
      readonly tightClose?: never;
      readonly closeSource?: never;
      readonly dynamicTag?: never;
      readonly astroAsset?: never;
      readonly chunkAggregate?: never;
      readonly jsx?: never;
      readonly inner?: never;
      readonly head?: never;
      readonly headSource?: never;
      readonly body?: never;
      readonly bare?: never;
      readonly op?: never;
      readonly test?: never;
    });

export type WireImportMember = {
  readonly name: string;
  readonly path: string;
  readonly quote: string;
  readonly at: number;
  readonly named?: boolean;
  readonly imported?: string;
  readonly typeOnly?: boolean;
};

export type WireFrontmatterLayout = {
  readonly extra: string;
  readonly slots: ReadonlyArray<WireImportSlot>;
};

/** One member of a prop's object or list-of-objects shape; nested members carry their own (propSchema.ts PropShapeField). */
export interface WirePropShapeField {
  readonly name: string;
  readonly type: string;
  readonly format?: string;
  readonly options?: ReadonlyArray<string>;
  readonly shape?: ReadonlyArray<WirePropShapeField>;
  readonly shapeIsList?: boolean;
}

export type WirePropUnion = {
  readonly names: ReadonlyArray<string>;
  readonly branches: ReadonlyArray<WireUnionBranch>;
};

export type WireColumn = {
  readonly id: string;
  readonly label: string;
  readonly selector: string;
  readonly context: ReadonlyArray<string>;
  readonly line: number;
};

export type WireBlock = {
  readonly kind: 'rows' | 'matrix';
  readonly title: undefined | string;
  readonly titleStart?: number;
  readonly titleEnd?: number;
  readonly description?: string;
  readonly rows: ReadonlyArray<WireRow>;
  readonly columns?: ReadonlyArray<WireColumn>;
};

export type WireCssEntry = WireVarEntry | WireCommentEntry;

export type WireMdNodeLike = {
  readonly id?: string;
  readonly kind: string;
  readonly name?: string;
  readonly value?: string;
  readonly inner?: string;
  readonly props?:
    | undefined
    | {
        readonly [key: string]: WirePropValue;
      };
  readonly children?: undefined | ReadonlyArray<WireMdNodeLike>;
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
  readonly mdNumbers?: ReadonlyArray<number>;
  readonly mdLoose?: boolean;
  readonly mdMarker?: string;
  readonly mdSource?: string;
  readonly mdEsm?: boolean;
};

export type WireNodeMetadata = {
  readonly id?: string;
  readonly source?: undefined | string;
  readonly blankBefore?: number;
  readonly blankAfter?: number;
  readonly start?: number;
  readonly end?: number;
  readonly mdSource?: string;
  readonly props?:
    | undefined
    | {
        readonly [key: string]: WireAttr;
      };
  readonly attrOrder?: undefined | ReadonlyArray<string>;
  readonly attrSource?: string;
};

export type WireImportSlot = {
  readonly at: number;
  readonly offset: number;
  readonly source: string;
  readonly suffix: string;
  readonly tail: string;
  readonly members: ReadonlyArray<WireImportMember>;
};

export type WireUnionBranch = {
  readonly forbids: ReadonlyArray<string>;
  readonly pins: WireUnionPins;
  readonly defaults: WireUnionDefaults;
  readonly rules: WireUnionRules;
  readonly docs: WireUnionDocs;
};

export type WireRow = {
  readonly label: string;
  readonly name?: string;
  readonly cells: ReadonlyArray<undefined | WireCell>;
};

export type WireVarEntry = {
  readonly kind: 'var';
  readonly name: string;
  readonly value: string;
  readonly important: boolean;
  readonly valueStart: number;
  readonly valueEnd: number;
  readonly line: number;
};

export type WireCommentEntry = {
  readonly kind: 'comment';
  readonly text: string;
  readonly textStart: number;
  readonly textEnd: number;
  readonly description?: string;
};

export type WirePropValue = {
  readonly type: string;
  readonly value?: string;
};

export type WireAttr =
  | {
      readonly type: 'string';
      readonly value: string;
    }
  | {
      readonly type: 'expr';
      readonly value: string;
    }
  | {
      readonly type: 'bare';
    }
  | {
      readonly type: 'spread';
      readonly value: string;
    };

export type WireUnionPins = {
  readonly [key: string]: ReadonlyArray<string>;
};

export type WireUnionDefaults = {
  readonly [key: string]: string | number;
};

export type WireUnionRules = {
  readonly [key: string]: WireDefaultRule;
};

export type WireUnionDocs = {
  readonly [key: string]: string;
};

export type WireCell = {
  readonly name: string;
  readonly value: string;
  readonly file: string;
  readonly selector: string;
  readonly valueStart: number;
  readonly valueEnd: number;
  readonly line: number;
  readonly column: string;
};

export type WireDefaultRule = {
  readonly prop: string;
  readonly is: string;
  readonly then: string;
  readonly otherwise: string;
};
