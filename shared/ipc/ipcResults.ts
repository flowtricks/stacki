import type { MicrophoneReport } from '../properties/microphone';
import type { AiResults } from './aiChat';
import type { AppFileAnswer } from '../properties/appFiles';
import type { AppAccessToken, AppAuthStatus } from '../properties/appAuth';
import type { AppNetResponse } from '../properties/appNet';
import type { AccountState } from './publishAccount';
import type { CmsConnectionList, CmsSaveResult, SanityLoginState } from '../properties/cmsConnections';
import type {
  RemoteCollection,
  RemoteAsset,
  RemoteDocument,
  RemoteReferenceOption,
  RemoteRevision,
  RemoteDocumentList,
  RemoteDocumentSummary,
  RemoteResult,
} from '../properties/cmsRemote';
import type { LinkPreview } from '../properties/linkPreview';
import type { MediaAccountChoices } from '../properties/mediaAccounts';
import type { AppRelease, AppRepository, AppStaged, AppSummary, AppUpdateOutcome, AppsResult } from '../properties/apps';
import type { AppFolderBroken } from '../properties/appFolders';
import type { MarketplaceIndex } from '../properties/appMarketplace';
import type { AppRepositoryPlaceReply } from '../properties/appPlace';
import type { MediaConnectionList, MediaListing, MediaResult, MediaSaveResult } from '../properties/mediaHosting';
import type { DataSample, PageTemplatePlan } from '../properties/pageTemplate';
import type { AstroRemoteEditAnswer, AstroRemoteReadAnswer } from '../properties/astroContent';
import type { RepositoryResult } from '../ipc/publishRepository';
import type { PublishDiscovery } from '../properties/publishDiscovery';
import type { DesktopPublishState, PublishAvailability } from '../properties/publishState';
import type { MetadataFile } from '../properties/projectMetadata';
import type { InstructionListing, InstructionWriteResult } from '../properties/instructions';
import type { LengthUnit } from '../properties/lengthUnit';
import type { SelectorRemoval, SelectorReport } from '../properties/selectorUsage';
import type { ConversionResult } from './assetConversion';
import type { CommitDiffResult } from './gitCommitDiff';
import type { CommitAvatarResult } from './commitAvatars';
import type { GitHubUserSearchResult } from './githubUserSearch';
import type { StudioStatus, StudioInstallResult } from './studioSetup';
import type { StudioInstallProgress } from './studioProgress';
import type { AppSecretScan } from '../properties/appSecrets';
import type { SecretsListing, SecretsResult, SecretValue } from '../properties/secrets';
import type { McpCodexState, McpListing, McpResult, McpText } from '../properties/mcp';
import type { McpServerConfig } from '../properties/mcpConfig';
import type { AppSettingValues } from '../properties/appSettings';
import type { AppEditOutcome, AppMember, AppPerson } from '../properties/appsRpc';
import type { AppRepositoryStatus, AppShareOutcome, AppVisibilityOutcome, MarketplacePrecheck, MarketplaceSubmissionOutcome } from '../properties/appPublish';

export interface StudioEventResults {
  readonly 'studio:progress': StudioInstallProgress;
}
import type { ComponentProperties } from '../properties/propertyEditing';
import type { PreviewVerdict } from '../page/previewToken';
import type { Result } from '../core/result';
import type { Digest } from '../core/brand';
import type { Data } from '../core/boundary';
import {
  type WireAssetEntry,
  type WireCmsFile,
  type WireUsageFile,
  type WireLoaderInfo,
  type WireContentConfig,
  type WireEntry,
  type WireCollection,
  type WireMove,
  type WirePointer,
  type WireImageEdit,
  type WireValidationResult,
  type WireFileModel,
  type WireProjectFile,
  type WireFileDescription,
  type WireDeleteOutcome,
  type WireGitInfo,
  type WireCommitInfo,
  type WireMergeOutcome,
  type WireStatusFile,
  type WireWorktreeInfo,
  type WireRouteParams,
  type WireDataRecord,
  type WireMarkdownModel,
  type WireParserPageModel,
  type WireParseBail,
  type WireInjectedRoute,
  type WireSchemaField,
  type WireStyleFile,
} from './ipcWire';
// Every wire shape is still answered here, where callers import it from.
export type * from './ipcWire';

export type WirePageRead =
  | { readonly source: string; readonly editable: true; readonly model: WireMarkdownModel }
  | { readonly source: string; readonly editable: true; readonly model: WireParserPageModel }
  | {
      readonly source: string;
      readonly editable: false;
      readonly reason: string;
      readonly bail: undefined | WireParseBail;
    };

/** A page read from disk: the parse plus the SHA-256 of the exact bytes read. */
export type WirePageDiskRead = WirePageRead & { readonly checksum: string };

/** A page write that did not happen, or may have. Every variant left the page
 * file untouched, except `write-race`, where another writer replaced it after
 * Stacki's write, and `uncertain`, where the write may have landed and a
 * comparison could not tell (plan §3.5). `backpressured` means the page's
 * actor queue was full: the edit was never accepted and stays unsaved (plan
 * §7). A refusal of the edit itself is `rejected` (WirePageEditError). */
export type WirePageWriteFailure =
  | { readonly code: 'missing'; readonly message: string }
  | { readonly code: 'filesystem'; readonly message: string }
  | { readonly code: 'write-race'; readonly message: string }
  | { readonly code: 'uncertain'; readonly message: string }
  | { readonly code: 'backpressured'; readonly message: string };

/** Why a visual edit did not apply (step 6). `rejected` carries the actor's
 * reason, for the notice (plan §7), and the checksum on disk when it could be
 * read; the rest are the page-write failures. */
export type WirePageEditError =
  | {
      readonly code: 'rejected';
      readonly reason: string;
      readonly message: string;
      readonly diskChecksum: string | undefined;
    }
  | WirePageWriteFailure;

/** An applied edit: the page as written, and the inverse hunks Undo submits
 * against its checksum (byte spans of these bytes). */
export type WirePageEdit =
  | ({
      readonly ok: true;
      readonly inverse: ReadonlyArray<{
        readonly span: { readonly start: number; readonly end: number };
        readonly text: string;
      }>;
    } & WirePageDiskRead)
  | { readonly ok: false; readonly error: WirePageEditError };

export interface IpcResults extends AiResults {
  readonly 'project:createDefaultsCanvas': { readonly file: string };
  readonly 'project:removeDefaultsCanvas': undefined;
  readonly 'instructions:create': InstructionWriteResult;
  readonly 'instructions:createFolder': InstructionWriteResult;
  readonly 'instructions:list': InstructionListing;
  readonly 'instructions:read': InstructionWriteResult;
  readonly 'instructions:reveal': { readonly ok: true };
  readonly 'instructions:write': InstructionWriteResult;
  readonly 'project:metadata': Result<MetadataFile>;
  readonly 'project:writeMetadata': Result<MetadataFile>;
  /** A folder chosen in the system dialog, project-relative; `outside` when it is not in the project. */
  readonly 'project:pickFolder':
    { readonly kind: 'canceled' } | { readonly kind: 'picked'; readonly path: string } | { readonly kind: 'outside'; readonly message: string };
  /** The signed-in GitHub user roles resolve for; undefined when nobody is signed in (the local user is then admin). */
  readonly 'roles:identity': { readonly login: undefined | string };
  readonly 'github:searchUsers': GitHubUserSearchResult;
  readonly 'studio:status': StudioStatus;
  readonly 'studio:install': StudioInstallResult;
  readonly 'component:properties': Result<ComponentProperties>;
  readonly 'component:editProperties': Result<ComponentProperties & { readonly undo: string }>;
  readonly 'component:revertProperties': Result<{ readonly undo: string }>;
  readonly 'assets:delete':
    | {
        readonly ok: false;
      }
    | {
        readonly ok: true;
      };
  readonly 'assets:dimensions': {
    readonly dims:
      | undefined
      | {
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
  readonly 'assets:convert': ConversionResult;
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
    readonly checksum: Digest;
  };
  readonly 'component:discard': {
    readonly outcome: 'deleted' | 'edited' | 'missing';
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
          readonly error: undefined | string;
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
    readonly reason?: undefined | string;
    readonly idsAreGuesses?: boolean;
    readonly idNote?: undefined | string;
    readonly shape?: string;
    readonly parsed?: boolean;
    readonly parserNote?: undefined | string;
    readonly collection: WireCollection;
  };
  readonly 'content:remoteEdit': RemoteResult<AstroRemoteEditAnswer>;
  readonly 'content:remoteRead': RemoteResult<AstroRemoteReadAnswer>;
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
    readonly error?: undefined | string;
  };
  /** The rendered page's HTML for the Audits panel, or why it could not be fetched. */
  readonly 'audit:render': { readonly ok: true; readonly status: number; readonly html: string } | { readonly ok: false; readonly message: string };
  /** A page's performance report from a hidden window, unparsed: shared/page/auditPerformance.ts parses it. */
  readonly 'audit:measure': { readonly ok: true; readonly measurement: unknown } | { readonly ok: false; readonly message: string };
  readonly 'content:sampleValue': {
    readonly value: Data;
    readonly error?: undefined | string;
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
    readonly paths?: ReadonlyArray<string>;
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
    readonly nodePath: undefined | string;
    readonly nodeVersion: undefined | string;
    readonly astroVersion: undefined | string;
    readonly requires: undefined | string;
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
        readonly parkedFrom: undefined | string;
        readonly ok: true;
        readonly from: string;
        readonly parked: boolean;
      }
    | {
        readonly restored: boolean;
        readonly error: string;
        readonly parkedFrom: undefined | string;
        readonly ok: true;
        readonly from: string;
        readonly parked: boolean;
      };
  readonly 'git:commit': {
    readonly ok: true;
    readonly files: undefined | number;
  };
  readonly 'git:deleteBranch': WireDeleteOutcome;
  readonly 'git:ghStatus':
    | {
        readonly installed: false;
        readonly authed: false;
        readonly user?: never;
      }
    | {
        readonly installed: true;
        readonly authed: true;
        readonly user: undefined | string;
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
  readonly 'git:commitDiff': CommitDiffResult;
  readonly 'git:avatars': CommitAvatarResult;
  readonly 'git:merge': WireMergeOutcome;
  readonly 'git:park': {
    readonly ok: true;
    readonly parked: boolean;
    readonly branch: undefined | string;
  };
  readonly 'git:repositories': readonly string[];
  readonly 'git:clone': IpcResults['project:openDialog'];
  readonly 'git:connect': IpcResults['git:publish'];
  readonly 'publish:start': DesktopPublishState;
  readonly 'publish:state': DesktopPublishState;
  readonly 'publish:availability': PublishAvailability;
  readonly 'publish:siteURL': string | undefined;
  readonly 'publish:repository': RepositoryResult;
  readonly 'publish:discover': PublishDiscovery;
  readonly 'publish:account': AccountState;
  readonly 'cmsConnections:list': CmsConnectionList;
  readonly 'cmsConnections:save': CmsSaveResult;
  readonly 'cmsConnections:remove': CmsConnectionList;
  readonly 'cmsConnections:sanityLogin': SanityLoginState;
  readonly 'cmsRemote:collections': RemoteResult<readonly RemoteCollection[]>;
  readonly 'cmsRemote:documents': RemoteResult<RemoteDocumentList>;
  readonly 'cmsRemote:create': RemoteResult<RemoteDocumentSummary>;
  readonly 'cmsRemote:delete': RemoteResult<number>;
  readonly 'cmsRemote:move': RemoteResult<RemoteDocumentList>;
  readonly 'cmsRemote:document': RemoteResult<RemoteDocument>;
  readonly 'cmsRemote:template': RemoteResult<RemoteDocument>;
  readonly 'cmsRemote:write': RemoteResult<RemoteDocument>;
  readonly 'cmsRemote:act': RemoteResult<RemoteDocument | undefined>;
  readonly 'cmsRemote:history': RemoteResult<readonly RemoteRevision[]>;
  readonly 'cmsRemote:restore': RemoteResult<RemoteDocument>;
  readonly 'cmsRemote:references': RemoteResult<readonly RemoteReferenceOption[]>;
  readonly 'cmsRemote:upload': RemoteResult<RemoteAsset | undefined>;
  readonly 'cmsRemote:linkPreview': RemoteResult<LinkPreview | undefined>;
  readonly 'apps:list': AppsResult<readonly AppSummary[]>;
  readonly 'apps:pickFile': AppsResult<AppStaged | undefined>;
  readonly 'apps:stageGitHub': AppsResult<AppStaged>;
  readonly 'apps:githubRepositories': AppsResult<readonly AppRepository[]>;
  readonly 'apps:githubReleases': AppsResult<readonly AppRelease[]>;
  readonly 'apps:commit': AppsResult<AppSummary>;
  readonly 'apps:discard': { readonly ok: true };
  readonly 'apps:uninstall': AppsResult<readonly AppSummary[]>;
  readonly 'apps:checkUpdates': AppsResult<readonly AppUpdateOutcome[]>;
  readonly 'apps:applyUpdate': AppsResult<AppSummary>;
  readonly 'apps:folders': AppsResult<readonly AppFolderBroken[]>;
  readonly 'apps:revealFolder': { readonly ok: true };
  readonly 'apps:marketplace': AppsResult<MarketplaceIndex>;
  readonly 'apps:installMarketplace': AppsResult<AppSummary>;
  readonly 'apps:setAutoUpdate': AppsResult<readonly AppSummary[]>;
  readonly 'apps:repositoryVisibility': AppsResult<AppRepositoryPlaceReply>;
  readonly 'apps:scanSecrets': AppsResult<AppSecretScan>;
  readonly 'apps:repositoryStatus': AppsResult<AppRepositoryStatus>;
  readonly 'apps:makePublic': AppsResult<AppVisibilityOutcome>;
  readonly 'apps:addLicense': AppsResult<AppRepositoryStatus>;
  readonly 'apps:share': AppsResult<AppShareOutcome>;
  readonly 'apps:switchSource': AppsResult<AppSummary>;
  readonly 'apps:checkMarketplace': AppsResult<MarketplacePrecheck>;
  readonly 'apps:submitMarketplace': AppsResult<MarketplaceSubmissionOutcome>;
  readonly 'apps:readSettings': AppsResult<AppSettingValues>;
  readonly 'apps:writeSettings': AppsResult<AppSettingValues>;
  /** Each file's modification stamp, in the order asked; undefined for a file that is gone or not a file. */
  readonly 'apps:fileStamps': { readonly stamps: readonly ({ readonly mtimeMs: number; readonly sizeBytes: number } | undefined)[] };
  readonly 'apps:storageGet': AppsResult<{ readonly value: string | undefined }>;
  readonly 'apps:storageSet': AppsResult<AppEditOutcome>;
  readonly 'apps:storageKeys': AppsResult<readonly string[]>;
  readonly 'apps:storageWatch': { readonly ok: true };
  readonly 'apps:person': AppsResult<AppPerson>;
  readonly 'apps:people': AppsResult<readonly AppMember[]>;
  readonly 'apps:hostVersion': { readonly version: string };
  /** A PNG data URL of the region asked, at most APP_RPC_LIMITS.snapshotBytesMax. */
  readonly 'apps:canvasSnapshot': AppsResult<{ readonly url: string; readonly width: number; readonly height: number }>;
  readonly 'apps:files': AppsResult<AppFileAnswer>;
  readonly 'apps:authConnect': AppsResult<AppAuthStatus>;
  readonly 'apps:authStatus': AppsResult<readonly AppAuthStatus[]>;
  readonly 'apps:authToken': AppsResult<AppAccessToken>;
  readonly 'apps:authDisconnect': AppsResult<readonly AppAuthStatus[]>;
  readonly 'apps:netFetch': AppsResult<AppNetResponse>;
  readonly 'mediaHosting:connections': MediaConnectionList;
  readonly 'mediaHosting:save': MediaSaveResult;
  readonly 'mediaHosting:remove': MediaConnectionList;
  readonly 'mediaHosting:discover': MediaResult<MediaAccountChoices>;
  readonly 'mediaHosting:connectAccount': MediaSaveResult;
  readonly 'mediaHosting:list': MediaResult<MediaListing>;
  readonly 'mediaHosting:pickUpload': MediaResult<MediaListing | undefined>;
  readonly 'mediaHosting:upload': MediaResult<MediaListing>;
  readonly 'mediaHosting:createFolder': MediaResult<MediaListing>;
  readonly 'mediaHosting:rename': MediaResult<MediaListing>;
  readonly 'mediaHosting:delete': MediaResult<MediaListing>;
  readonly 'mediaHosting:reorder': MediaResult<MediaListing>;
  readonly 'mediaHosting:replace': MediaResult<MediaListing | undefined>;
  /** Whether a file was chosen and written over the asset; a refusal says why. */
  readonly 'assets:replace': MediaResult<boolean>;
  readonly 'git:publish': {
    readonly ok: true;
    readonly url: undefined | string;
    readonly output: string;
  };
  readonly 'git:push': {
    readonly ok: true;
  };
  readonly 'git:pull': WireMergeOutcome;
  readonly 'git:incoming': number;
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
  readonly 'microphone:openSettings': {
    readonly ok: true;
  };
  readonly 'microphone:request': MicrophoneReport;
  readonly 'microphone:status': MicrophoneReport;
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
  readonly 'pageTemplate:create': RemoteResult<{ readonly pagePath: string }>;
  readonly 'pageTemplate:plan': RemoteResult<PageTemplatePlan>;
  readonly 'pageTemplate:sample': RemoteResult<DataSample>;
  readonly 'project:setEnv': RemoteResult<{ readonly gitignore: 'already-ignored' | 'added' }>;
  readonly 'secrets:list': SecretsResult<SecretsListing>;
  readonly 'secrets:read': SecretsResult<SecretValue>;
  readonly 'secrets:apply': SecretsResult<SecretsListing>;
  readonly 'secrets:ignore': SecretsResult<SecretsListing>;
  readonly 'mcp:read': McpResult<McpListing>;
  readonly 'mcp:readText': McpResult<McpText>;
  readonly 'mcp:reveal': McpResult<McpServerConfig>;
  readonly 'mcp:apply': McpResult<McpListing>;
  readonly 'mcp:saveText': McpResult<McpListing>;
  readonly 'mcp:readCodex': McpCodexState;
  readonly 'mcp:revealCodex': McpResult<McpServerConfig>;
  readonly 'mcp:applyCodex': McpResult<McpCodexState>;
  readonly 'page:dynamicPaths':
    | {
        readonly entries: ReadonlyArray<never>;
        readonly error?: never;
      }
    | {
        readonly entries: ReadonlyArray<{
          readonly params: WireRouteParams;
          readonly props: undefined | string | number | true | ReadonlyArray<Data> | WireDataRecord;
          readonly route: string;
          readonly label: string;
        }>;
        readonly error: undefined | string;
      };
  readonly 'page:edit': WirePageEdit;
  readonly 'page:editBatch': WirePageEdit;
  readonly 'page:importPathFor': {
    readonly relative: string;
    readonly srcRelative: undefined | string;
  };
  readonly 'page:move': {
    readonly newPath: string;
  };
  readonly 'page:parse': WirePageRead;
  readonly 'page:previewEdit': WirePageEdit;
  readonly 'page:read': WirePageDiskRead;
  readonly 'page:rebaseImport': {
    readonly path: string;
  };
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
  // Whether a canvas rendering's files are still the bytes its stamps name (step 7).
  readonly 'preview:check': PreviewVerdict;
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
    readonly projectPath: string;
  };
  readonly 'project:createStarter': {
    readonly ok: boolean;
    readonly projectPath: string;
  };
  readonly 'project:injectedRoutes': {
    readonly routes: ReadonlyArray<WireInjectedRoute>;
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
  readonly 'project:pending': undefined | string;
  readonly 'project:resolveImport': {
    readonly path: undefined | string;
  };
  readonly 'project:scan': {
    readonly pages: ReadonlyArray<{
      readonly path: string;
      readonly name: string;
      readonly route: string;
    }>;
    readonly layouts: ReadonlyArray<{
      readonly schema: ReadonlyArray<WireSchemaField>;
      readonly extendsTag: undefined | string;
      readonly slots: ReadonlyArray<string>;
      readonly slotText: boolean;
      readonly renderTag:
        | undefined
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
      readonly rootComponent: undefined | string;
      readonly hasRest: boolean;
      readonly path: string;
      readonly name: string;
      readonly folder: string;
      readonly instances: number;
      readonly isLayout: boolean;
    }>;
    readonly components: ReadonlyArray<{
      readonly schema: ReadonlyArray<WireSchemaField>;
      readonly extendsTag: undefined | string;
      readonly slots: ReadonlyArray<string>;
      readonly slotText: boolean;
      readonly renderTag:
        | undefined
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
      readonly rootComponent: undefined | string;
      readonly hasRest: boolean;
      readonly path: string;
      readonly name: string;
      readonly folder: string;
      readonly instances: number;
    }>;
    readonly pageFolders: ReadonlyArray<string>;
    readonly trailingSlash: string;
    readonly lengthUnit: LengthUnit;
  };
  readonly 'recents:add': {
    readonly ok: true;
  };
  readonly 'recents:list': ReadonlyArray<{
    readonly thumb: undefined | string;
    readonly stale: boolean;
    readonly canRefresh: boolean;
    readonly path: string;
    readonly name: string;
    readonly openedAt: number;
  }>;
  readonly 'recents:refreshThumb':
    | {
        readonly thumb: undefined | string;
        readonly stale: boolean;
        readonly ok: true;
      }
    | {
        readonly thumb: undefined | string;
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
    readonly usageCountsEnabled: boolean;
    readonly appsPersonHidden: boolean;
  };
  readonly 'settings:set': {
    readonly sound: boolean;
    readonly usageCountsEnabled: boolean;
    readonly appsPersonHidden: boolean;
    readonly saved: boolean;
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
  readonly 'style:selectorUsage': Result<SelectorReport>;
  readonly 'style:removeSelectors': Result<SelectorRemoval>;
  readonly 'style:restoreSelectors': Result<SelectorRemoval>;
  readonly 'watch:start':
    | {
        readonly ok: false;
      }
    | {
        readonly ok: true;
      };
  readonly 'terminal:start': { readonly ok: true; readonly id: string } | { readonly ok: false; readonly error: string };
  readonly 'terminal:resize': { readonly ok: boolean };
  readonly 'terminal:close': { readonly ok: boolean };
  readonly 'terminal:clipboardImage': { readonly ok: true; readonly path: string } | { readonly ok: false; readonly error: string };
}
