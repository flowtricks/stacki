import type { ComponentProperties } from './component-properties';
import type { Result } from './result';
// Invoke results mirror the handlers' wire shapes, including legacy null sentinels.
// Main's typed registrar checks every handler against this inventory.
import type { Data } from './boundary';

export type WirePageRead =
  | { readonly source: string; readonly editable: true; readonly model: WireMarkdownModel }
  | { readonly source: string; readonly editable: true; readonly model: WireParserPageModel }
  | {
      readonly source: string;
      readonly editable: false;
      readonly reason: string;
      readonly bail: null | WireParseBail;
    };

export interface IpcResults {
  readonly 'component:properties': Result<ComponentProperties>;
  readonly 'component:editProperties': Result<ComponentProperties>;
  readonly 'assets:delete':
    | {
        readonly ok: false;
      }
    | {
        readonly ok: true;
      };
  readonly 'assets:dimensions': {
    readonly dims: null | {
      readonly w: number;
      readonly h: number;
    };
  };
  readonly 'assets:list': {
    readonly entries: ReadonlyArray<WireAssetEntry>;
    readonly missing: boolean;
  };
  readonly 'assets:mkdir': {
    readonly ok: true;
  };
  readonly 'assets:move':
    | {
        readonly ok: false;
      }
    | {
        readonly ok: true;
      };
  readonly 'assets:pickUpload': {
    readonly added: number;
  };
  readonly 'assets:readText': {
    readonly text: string;
  };
  readonly 'assets:rename': {
    readonly ok: true;
  };
  readonly 'assets:upload': {
    readonly added: number;
  };
  readonly 'assets:writeText': {
    readonly ok: true;
  };
  readonly 'cms:assetRef':
    | {
        readonly value: string;
        readonly name?: never;
        readonly asset?: never;
      }
    | {
        readonly name: string;
        readonly asset: string;
        readonly value?: never;
      };
  readonly 'cms:create': {
    readonly rel: string;
  };
  readonly 'cms:delete': {
    readonly ok: true;
    readonly rewritten: ReadonlyArray<string>;
  };
  readonly 'cms:list': {
    readonly files: ReadonlyArray<WireCmsFile>;
  };
  readonly 'cms:meta': {
    readonly meta: {
      readonly [key: string]: unknown;
    };
  };
  readonly 'cms:read': {
    readonly data: unknown;
  };
  readonly 'cms:setMeta': {
    readonly ok: true;
  };
  readonly 'cms:usage': {
    readonly files: ReadonlyArray<string>;
  };
  readonly 'cms:write': {
    readonly ok: true;
  };
  readonly 'component:create': {
    readonly path: string;
    readonly rel: string;
    readonly name: string;
  };
  readonly 'component:usage': {
    readonly files: ReadonlyArray<WireUsageFile>;
    readonly total: number;
  };
  readonly 'content:collections':
    | {
        readonly collections: ReadonlyArray<never>;
        readonly missing?: true;
        readonly error?: string;
        readonly configPath?: string;
        readonly covered?: never;
      }
    | {
        readonly collections: ReadonlyArray<{
          readonly name: string;
          readonly editable: undefined | boolean;
          readonly loader: undefined | (WireLoaderInfo & { readonly kind: string });
          readonly hasSchema: boolean;
          readonly freeform: boolean;
          readonly error: null | string;
          readonly count: number;
        }>;
        readonly covered: {
          readonly files: ReadonlyArray<string>;
          readonly dirs: ReadonlyArray<string>;
        };
        readonly configPath: undefined | string;
      };
  readonly 'content:config': WireContentConfig;
  readonly 'content:entries': {
    readonly entries: ReadonlyArray<WireEntry>;
    readonly readOnly: boolean;
    readonly reason?: null | string;
    readonly idsAreGuesses?: boolean;
    readonly idNote?: null | string;
    readonly shape?: string;
    readonly parsed?: boolean;
    readonly parserNote?: null | string;
    readonly collection: WireCollection;
  };
  readonly 'content:rename': {
    readonly renamed: boolean;
    readonly pointers: number;
    readonly files: ReadonlyArray<string>;
  };
  readonly 'content:renamePlan': {
    readonly entry: {
      readonly id: string;
      readonly file: string;
    };
    readonly collection: string;
    readonly from: string;
    readonly to: string;
    readonly move: WireMove;
    readonly pointers: ReadonlyArray<WirePointer>;
    readonly imageEdits: ReadonlyArray<WireImageEdit>;
  };
  readonly 'content:sampleEntry': {
    readonly entry: Data;
    readonly error?: null | string;
  };
  readonly 'content:targets': {
    readonly targets: ReadonlyArray<{
      readonly id: string;
      readonly title: string;
    }>;
  };
  readonly 'content:validate': WireValidationResult;
  readonly 'content:writeEntry': {
    readonly ok: true;
    readonly changed: boolean;
  };
  readonly 'css:addSection': {
    readonly ok: boolean;
    readonly error?: string;
    readonly stale?: boolean;
    readonly title?: string;
  };
  readonly 'css:addVariables': {
    readonly ok: boolean;
    readonly error?: string;
    readonly name?: string;
    readonly changed?: boolean;
  };
  readonly 'css:moveHeading': {
    readonly ok: boolean;
    readonly stale?: boolean;
    readonly error?: string;
  };
  readonly 'css:moveVariables': {
    readonly ok: boolean;
    readonly error?: string;
    readonly name?: string;
    readonly changed?: boolean;
  };
  readonly 'css:removeSection': {
    readonly ok: boolean;
    readonly stale?: boolean;
    readonly error?: string;
  };
  readonly 'css:renameVariables': {
    readonly ok: boolean;
    readonly files?: number;
    readonly occurrences?: number;
    readonly error?: string;
  };
  readonly 'css:setSectionTitle': {
    readonly ok: boolean;
    readonly stale?: boolean;
    readonly error?: string;
  };
  readonly 'css:setVariable': {
    readonly ok: boolean;
    readonly stale?: boolean;
    readonly error?: string;
  };
  readonly 'css:variables':
    | {
        readonly files: ReadonlyArray<WireFileModel>;
        readonly values: {
          readonly [key: string]: string;
        };
      }
    | {
        readonly files: ReadonlyArray<never>;
        readonly error: string;
      };
  readonly 'dev:diagnose': {
    readonly kind: string;
    readonly nodePath: null | string;
    readonly nodeVersion: null | string;
    readonly astroVersion: null | string;
    readonly requires: null | string;
    readonly launchedFromGui: boolean;
  };
  readonly 'dev:probe': {
    readonly ok: boolean;
    readonly status: number;
  };
  readonly 'dev:start':
    | {
        readonly trailingSlash: string;
        readonly url: string;
        readonly external: boolean;
        readonly bare?: never;
      }
    | {
        readonly trailingSlash: string;
        readonly url: string;
        readonly external?: never;
        readonly bare?: never;
      }
    | {
        readonly trailingSlash: string;
        readonly url: string;
        readonly bare: boolean;
        readonly external?: never;
      };
  readonly 'dev:stop': {
    readonly ok: true;
  };
  readonly 'git:allFiles': ReadonlyArray<
    WireProjectFile &
      WireFileDescription & {
        readonly from: undefined | string;
      }
  >;
  readonly 'git:checkout':
    | {
        readonly ok: false;
        readonly blocked: true;
        readonly from: string;
        readonly branch: string;
        readonly files: ReadonlyArray<string>;
      }
    | {
        readonly restored: boolean;
        readonly error?: never;
        readonly parkedFrom: null | string;
        readonly ok: true;
        readonly from: string;
        readonly parked: boolean;
      }
    | {
        readonly restored: boolean;
        readonly error: string;
        readonly parkedFrom: null | string;
        readonly ok: true;
        readonly from: string;
        readonly parked: boolean;
      };
  readonly 'git:commit': {
    readonly ok: true;
    readonly files: null | number;
  };
  readonly 'git:commitFiles': ReadonlyArray<
    WireFileChange &
      WireFileDescription & {
        readonly from: undefined | string;
      }
  >;
  readonly 'git:deleteBranch': WireDeleteOutcome;
  readonly 'git:fileAt': null | string;
  readonly 'git:ghStatus':
    | {
        readonly installed: false;
        readonly authed: false;
        readonly user?: never;
      }
    | {
        readonly installed: true;
        readonly authed: true;
        readonly user: null | string;
      }
    | {
        readonly installed: true;
        readonly authed: false;
        readonly user?: never;
      };
  readonly 'git:info':
    | WireGitInfo
    | {
        readonly isRepo: false;
      };
  readonly 'git:init': {
    readonly ok: true;
  };
  readonly 'git:log': {
    readonly commits: ReadonlyArray<WireCommitInfo>;
    readonly atEnd: boolean;
  };
  readonly 'git:merge': WireMergeOutcome;
  readonly 'git:park': {
    readonly ok: true;
    readonly parked: boolean;
    readonly branch: null | string;
  };
  readonly 'git:publish': {
    readonly ok: true;
    readonly url: null | string;
    readonly output: string;
  };
  readonly 'git:push': {
    readonly ok: true;
  };
  readonly 'git:resolveMerge': WireMergeOutcome;
  readonly 'git:restoreFile': {
    readonly ok: boolean;
    readonly missing?: boolean;
    readonly message?: string;
  };
  readonly 'git:restoreProject': {
    readonly ok: boolean;
    readonly parked: boolean;
  };
  readonly 'git:status': ReadonlyArray<
    WireStatusFile &
      WireFileDescription & {
        readonly from: undefined | string;
      }
  >;
  readonly 'git:unpark':
    | {
        readonly restored: boolean;
        readonly error?: never;
      }
    | {
        readonly restored: boolean;
        readonly error: string;
      };
  readonly 'git:worktrees': ReadonlyArray<WireWorktreeInfo>;
  readonly 'native:copy': {
    readonly ok: true;
  };
  readonly 'native:paste': {
    readonly ok: true;
  };
  readonly 'native:redo': {
    readonly ok: true;
  };
  readonly 'native:undo': {
    readonly ok: true;
  };
  readonly 'page:create': {
    readonly pagePath: string;
  };
  readonly 'page:delete': {
    readonly ok: true;
  };
  readonly 'page:dynamicPaths':
    | {
        readonly entries: ReadonlyArray<never>;
        readonly error?: never;
      }
    | {
        readonly entries: ReadonlyArray<{
          readonly params: WireRouteParams;
          readonly props: null | string | number | true | ReadonlyArray<Data> | WireDataRecord;
          readonly route: string;
          readonly label: string;
        }>;
        readonly error: null | string;
      };
  readonly 'page:importPathFor': {
    readonly relative: string;
    readonly srcRelative: null | string;
  };
  readonly 'page:move': {
    readonly newPath: string;
  };
  readonly 'page:parse': WirePageRead;
  readonly 'page:read': WirePageRead;
  readonly 'page:rebaseImport': {
    readonly path: string;
  };
  readonly 'page:write': { readonly ok: true } & WirePageRead;
  readonly 'page:writeRaw': { readonly ok: true } & WirePageRead;
  readonly 'pagefolder:create': {
    readonly ok: true;
  };
  readonly 'pagefolder:delete': {
    readonly ok: true;
  };
  readonly 'pagefolder:rename': {
    readonly ok: true;
  };
  readonly 'preview:atCommit':
    | {
        readonly url: string;
        readonly ref: string;
        readonly reused: true;
      }
    | {
        readonly url: string;
        readonly ref: string;
        readonly reused: false;
      };
  readonly 'preview:stop': {
    readonly ok: true;
  };
  readonly 'project:classes': ReadonlyArray<string>;
  readonly 'project:close': {
    readonly ok: true;
  };
  readonly 'project:createAstro': {
    readonly ok: true;
    readonly installed: boolean;
  };
  readonly 'project:createStarter': {
    readonly ok: boolean;
    readonly projectPath: string;
  };
  readonly 'project:hasNodeModules': boolean;
  readonly 'project:injectedRoutes': {
    readonly routes: ReadonlyArray<WireInjectedRoute>;
  };
  readonly 'project:install': {
    readonly ok: true;
  };
  readonly 'project:newDialog':
    | {
        readonly canceled: true;
        readonly error?: never;
        readonly projectPath?: never;
      }
    | {
        readonly canceled: false;
        readonly error: string;
        readonly projectPath?: never;
      }
    | {
        readonly canceled: false;
        readonly projectPath: string;
        readonly error?: never;
      };
  readonly 'project:openDialog':
    | {
        readonly canceled: true;
        readonly error?: never;
        readonly projectPath?: never;
      }
    | {
        readonly canceled: false;
        readonly error: string;
        readonly projectPath?: never;
      }
    | {
        readonly canceled: false;
        readonly projectPath: string;
        readonly error?: never;
      };
  readonly 'project:parentDialog':
    | {
        readonly canceled: true;
        readonly parentPath?: never;
      }
    | {
        readonly canceled: false;
        readonly parentPath: undefined | string;
      };
  readonly 'project:pending': null | string;
  readonly 'project:resolveImport': {
    readonly path: null | string;
  };
  readonly 'project:scaffold': {
    readonly ok: true;
  };
  readonly 'project:scan': {
    readonly pages: ReadonlyArray<{
      readonly path: string;
      readonly name: string;
      readonly route: string;
    }>;
    readonly layouts: ReadonlyArray<{
      readonly schema: ReadonlyArray<WireSchemaField>;
      readonly extendsTag: null | string;
      readonly slots: ReadonlyArray<string>;
      readonly slotText: boolean;
      readonly renderTag:
        | null
        | {
            readonly tag: string;
            readonly prop?: string;
          }
        | {
            readonly prop: string;
          }
        | {
            readonly options: ReadonlyArray<string>;
          };
      readonly hasRest: boolean;
      readonly path: string;
      readonly name: string;
      readonly folder: string;
      readonly instances: number;
      readonly isLayout: boolean;
    }>;
    readonly components: ReadonlyArray<{
      readonly schema: ReadonlyArray<WireSchemaField>;
      readonly extendsTag: null | string;
      readonly slots: ReadonlyArray<string>;
      readonly slotText: boolean;
      readonly renderTag:
        | null
        | {
            readonly tag: string;
            readonly prop?: string;
          }
        | {
            readonly prop: string;
          }
        | {
            readonly options: ReadonlyArray<string>;
          };
      readonly hasRest: boolean;
      readonly path: string;
      readonly name: string;
      readonly folder: string;
      readonly instances: number;
    }>;
    readonly pageFolders: ReadonlyArray<string>;
    readonly trailingSlash: string;
  };
  readonly 'recents:add': {
    readonly ok: true;
  };
  readonly 'recents:list': ReadonlyArray<{
    readonly thumb: null | string;
    readonly stale: boolean;
    readonly canRefresh: boolean;
    readonly path: string;
    readonly name: string;
    readonly openedAt: number;
  }>;
  readonly 'recents:refreshThumb':
    | {
        readonly thumb: null | string;
        readonly stale: boolean;
        readonly ok: true;
      }
    | {
        readonly thumb: null | string;
        readonly stale: boolean;
        readonly ok: false;
        readonly error: string;
      };
  readonly 'recents:remove': {
    readonly ok: true;
  };
  readonly 'selection:copy':
    | {
        readonly ok: false;
        readonly count?: never;
      }
    | {
        readonly ok: true;
        readonly count: number;
      };
  readonly 'settings:get': {
    readonly sound: boolean;
  };
  readonly 'shell:openExternal': {
    readonly ok: true;
  };
  readonly 'src:readSymbol':
    | {
        readonly ok: false;
        readonly reason?: never;
        readonly rel?: never;
        readonly text?: never;
        readonly line?: never;
      }
    | {
        readonly ok: false;
        readonly reason: string;
        readonly rel?: never;
        readonly text?: never;
        readonly line?: never;
      }
    | {
        readonly ok: true;
        readonly rel: string;
        readonly text: string;
        readonly line: number;
        readonly reason?: never;
      };
  readonly 'src:readText': {
    readonly text: string;
  };
  readonly 'src:resolvePath':
    | {
        readonly ok: false;
        readonly rel?: never;
      }
    | {
        readonly ok: true;
        readonly rel: string;
      };
  readonly 'src:writeText': {
    readonly ok: true;
  };
  readonly 'style:listAstroStyles': {
    readonly files: ReadonlyArray<WireStyleFile>;
  };
  readonly 'style:listFiles': {
    readonly files: ReadonlyArray<WireStyleFile>;
  };
  readonly 'style:readFile': {
    readonly css: string;
  };
  readonly 'style:writeFile': {
    readonly ok: true;
  };
  readonly 'watch:start':
    | {
        readonly ok: false;
      }
    | {
        readonly ok: true;
      };
  readonly 'terminal:start':
    { readonly ok: true; readonly id: string } | { readonly ok: false; readonly error: string };
  readonly 'terminal:resize': { readonly ok: boolean };
  readonly 'terminal:close': { readonly ok: boolean };
  readonly 'terminal:clipboardImage':
    { readonly ok: true; readonly path: string } | { readonly ok: false; readonly error: string };
}

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
    }
  | {
      readonly kind: 'unknown';
      readonly note: string;
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
  readonly count?: number;
  readonly declarations?: ReadonlyArray<WireRule>;
};

export type WireProjectFile = {
  readonly path: string;
  readonly status: null | string;
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
    };

export type WireGitInfo = {
  readonly isRepo: true;
  readonly branch: string;
  readonly branches: ReadonlyArray<string>;
  readonly remote: null | string;
  readonly dirty: boolean;
  readonly ahead: number;
  readonly parked: ReadonlyArray<string>;
  readonly head?: null | string;
  readonly userEmail?: null | string;
  readonly trunk?: null | string;
  readonly dirtyFiles?: ReadonlyArray<string>;
  readonly hasUpstream?: boolean;
};

export type WireCommitInfo = {
  readonly files:
    | undefined
    | ReadonlyArray<WireFileChange & WireFileDescription & { readonly from: undefined | string }>;
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
      readonly into: null | string;
      readonly changed: boolean;
      readonly resolved?: number;
    }
  | {
      readonly ok: false;
      readonly conflicted: true;
      readonly from: null | string;
      readonly branch: string;
      readonly files: ReadonlyArray<WireMergeClash>;
    }
  | {
      readonly ok: false;
      readonly dirty: true;
      readonly from: null | string;
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
  readonly head: null | string;
  readonly branch: null | string;
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
  readonly layoutPath: null | string;
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
  readonly entrypoint: null | string;
  readonly from: null | string;
  readonly params: ReadonlyArray<unknown>;
};

export type WireSchemaField = {
  readonly name: string;
  readonly type: 'string' | 'number' | 'boolean' | 'code' | 'enum' | 'attrs' | 'other';
  readonly optional: boolean;
  readonly default: undefined | string | number | boolean;
  readonly defaultExpr?: boolean;
  readonly hint?: string;
  readonly options?: undefined | ReadonlyArray<string>;
  readonly numeric?: undefined | boolean;
  readonly doc?: undefined | string;
  readonly shape?: ReadonlyArray<{
    readonly name: string;
    readonly type: string;
  }>;
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
};

export type WireRule = {
  readonly selector: string;
  readonly selectors: ReadonlyArray<string>;
  readonly context: ReadonlyArray<string>;
  readonly line: number;
  readonly entries: ReadonlyArray<WireCssEntry>;
};

export type WireFileKind =
  | 'content'
  | 'asset'
  | 'layout'
  | 'page'
  | 'component'
  | 'file'
  | 'style'
  | 'config'
  | 'script'
  | 'doc';

export type WireConflictPart =
  | { readonly kind: 'same'; readonly text: string }
  | {
      readonly kind: 'clash';
      readonly ours: string;
      readonly theirs: string;
      readonly changedBy: 'ours' | 'theirs' | 'both';
      readonly merged?: string | null;
    };

export type WireMergeClash = {
  readonly path: string;
  readonly ours: null | string;
  readonly theirs: null | string;
  readonly parts: null | ReadonlyArray<WireConflictPart>;
};

export type WireMarkdownNodeList = ReadonlyArray<WireMdNodeLike> & {
  readonly mdTrailingBlanks?: number;
};

export type WireParserNode =
  | (WireNodeMetadata & {
      readonly kind: 'component' | 'element';
      readonly name: string;
      readonly children: null | ReadonlyArray<WireParserNode>;
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
  readonly title: null | string;
  readonly titleStart?: number;
  readonly titleEnd?: number;
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
  readonly children?: null | ReadonlyArray<WireMdNodeLike>;
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
  readonly cells: ReadonlyArray<null | WireCell>;
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
