// Which IPC write paths each access feature guards (shared/properties/projectRoles.ts).
// The renderer hides what a role lacks; main refuses the matching writes too, so
// a hidden panel cannot be reached by invoking its channel directly. Reads stay
// open: they change nothing, and shared views (the canvas, scans) depend on them.
// A channel listed with several features is allowed when any one is held: a
// stylesheet write serves both the Style panel and the Selectors panel.
import { assert } from '../../shared/core/assert';
import { record } from '../../shared/core/boundary';
import type { IpcChannel } from '../../shared/ipc/ipcPayloads';
import type { MetadataKind } from '../../shared/properties/projectMetadata';
import type { AccessFeature } from '../../shared/properties/projectRoles';

/** The write channels and the features that allow them. Channels not listed are not gated. */
export const CHANNEL_ACCESS: Readonly<Partial<Record<IpcChannel, readonly AccessFeature[]>>> = {
  'page:create': ['page:create'],
  'pageTemplate:create': ['page:create'],
  'pagefolder:create': ['page:create'],
  'page:delete': ['page:delete'],
  'pagefolder:delete': ['page:delete'],
  'page:move': ['page:rename'],
  'pagefolder:rename': ['page:rename'],
  'component:create': ['component:create'],
  'component:editProperties': ['panel:properties'],
  'component:revertProperties': ['panel:properties'],
  'project:createDefaultsCanvas': ['component:edit'],
  'project:removeDefaultsCanvas': ['component:edit'],
  'assets:delete': ['panel:assets'],
  'assets:mkdir': ['panel:assets'],
  'assets:move': ['panel:assets'],
  'assets:rename': ['panel:assets'],
  'assets:replace': ['panel:assets'],
  'assets:upload': ['panel:assets'],
  'assets:convert': ['panel:assets'],
  'assets:writeText': ['panel:assets', 'code:edit'],
  'mediaHosting:upload': ['panel:assets'],
  'mediaHosting:createFolder': ['panel:assets'],
  'mediaHosting:rename': ['panel:assets'],
  'mediaHosting:delete': ['panel:assets'],
  'mediaHosting:reorder': ['panel:assets'],
  'mediaHosting:replace': ['panel:assets'],
  'mediaHosting:save': ['settings:cms'],
  'mediaHosting:remove': ['settings:cms'],
  'mediaHosting:connectAccount': ['settings:cms'],
  'cms:create': ['panel:cms'],
  'cms:delete': ['panel:cms'],
  'cms:setMeta': ['panel:cms'],
  'cms:write': ['panel:cms'],
  'content:writeEntry': ['panel:cms'],
  'content:rename': ['panel:cms'],
  'content:remoteEdit': ['panel:cms'],
  'cmsRemote:create': ['panel:cms'],
  'cmsRemote:delete': ['panel:cms'],
  'cmsRemote:move': ['panel:cms'],
  'cmsRemote:write': ['panel:cms'],
  'cmsRemote:act': ['panel:cms'],
  'cmsRemote:restore': ['panel:cms'],
  'cmsRemote:upload': ['panel:cms'],
  'cmsConnections:save': ['settings:cms'],
  'cmsConnections:remove': ['settings:cms'],
  'cmsConnections:sanityLogin': ['settings:cms'],
  'project:setEnv': ['settings:cms'],
  'css:addSection': ['panel:variables'],
  'css:addVariables': ['panel:variables'],
  'css:moveHeading': ['panel:variables'],
  'css:moveVariables': ['panel:variables'],
  'css:removeSection': ['panel:variables'],
  'css:renameVariables': ['panel:variables'],
  'css:setSectionTitle': ['panel:variables'],
  'css:setVariable': ['panel:variables'],
  'style:writeFile': ['panel:style', 'panel:selectors', 'code:edit'],
  'style:removeSelectors': ['panel:selectors'],
  'style:restoreSelectors': ['panel:selectors'],
  'src:writeText': ['code:edit'],
  // The Instructions panel's writes; reading and revealing need only the panel, which the renderer hides.
  'instructions:write': ['instructions:edit'],
  'instructions:create': ['instructions:edit'],
  'instructions:createFolder': ['instructions:edit'],
  // An app's file calls read and write raw project files: code editing, the feature that already does that by hand.
  'apps:files': ['code:edit'],
  // The terminal runs anything in the project, so it belongs to code editing,
  // the feature that hides it in the title bar. Starting a shell is the gate:
  // input, resize and close only reach a shell that was allowed to start.
  'terminal:start': ['code:edit'],
  'terminal:clipboardImage': ['code:edit'],
  // An agent in the AI chat panel reads, edits and runs anything in the project, as the
  // terminal does, so every AI write path is code editing. Listing chats and reading
  // one stay open; the renderer hides the panel from roles without `panel:ai`.
  'ai:installAgent': ['code:edit'],
  'ai:trust': ['code:edit'],
  'ai:chatCreate': ['code:edit'],
  'ai:chatUpdate': ['code:edit'],
  'ai:chatDelete': ['code:edit'],
  'ai:prompt': ['code:edit'],
  'ai:cancel': ['code:edit'],
  'ai:permission': ['code:edit'],
  'ai:setOption': ['code:edit'],
  'ai:review': ['code:edit'],
  'ai:setup': ['code:edit'],
  'git:commit': ['panel:history'],
  'git:checkout': ['panel:history'],
  'git:merge': ['panel:history'],
  'git:pull': ['panel:history'],
  'git:push': ['panel:history', 'publish'],
  'git:deleteBranch': ['panel:history'],
  'git:restoreFile': ['panel:history'],
  'git:restoreProject': ['panel:history'],
  'git:resolveMerge': ['panel:history'],
  'git:park': ['panel:history'],
  'git:unpark': ['panel:history'],
  'git:init': ['panel:history'],
  'git:connect': ['panel:history'],
  'git:publish': ['publish'],
  'publish:start': ['publish'],
  'publish:repository': ['publish'],
  'studio:install': ['settings:studio'],
  // A read, but it spends the publishing account's GitHub budget; only those who edit roles need it.
  'github:searchUsers': ['settings:roles'],
  // Installing, updating and removing apps is an admin's: `settings:roles` is the
  // feature only admin holds (projectRoles.ts). Reading the account's repositories
  // spends its GitHub budget, so it goes with installing.
  'apps:pickFile': ['settings:roles'],
  'apps:stageGitHub': ['settings:roles'],
  'apps:githubRepositories': ['settings:roles'],
  'apps:githubReleases': ['settings:roles'],
  'apps:commit': ['settings:roles'],
  'apps:uninstall': ['settings:roles'],
  'apps:applyUpdate': ['settings:roles'],
  // Auto-update lets an app's new code in without anyone choosing it, so only admin switches it.
  'apps:setAutoUpdate': ['settings:roles'],
  // Where an app lives (a row's pills): anyone who sees the Apps panel; main reads only installed apps' repositories.
  'apps:repositoryVisibility': ['panel:apps'],
  // The marketplace: a read, but it reaches the network for the index, so seeing it is its own feature;
  // installing an approved version is another (projectRoles.ts). Admin holds both.
  'apps:marketplace': ['marketplace:view'],
  'apps:installMarketplace': ['marketplace:install'],
  // Sharing an uploaded app to GitHub, and switching it to that release, is `apps:share`;
  // making a repository public, adding its license and submitting it is `marketplace:publish`.
  // Scanning and reading a repository's status serve both, and spend the account's GitHub budget.
  'apps:scanSecrets': ['apps:share', 'marketplace:publish'],
  'apps:repositoryStatus': ['apps:share', 'marketplace:publish'],
  'apps:share': ['apps:share'],
  'apps:switchSource': ['apps:share'],
  'apps:makePublic': ['marketplace:publish'],
  'apps:addLicense': ['marketplace:publish'],
  'apps:checkMarketplace': ['marketplace:publish'],
  'apps:submitMarketplace': ['marketplace:publish'],
  // Anyone who can open apps fills in their settings; secrets stay on their own computer.
  'apps:writeSettings': ['panel:apps'],
  // App storage writes and the person: whoever can use apps. The renderer also checks the app's own grant (`app:<id>`).
  'apps:storageSet': ['panel:apps'],
  'apps:person': ['panel:apps'],
  'apps:people': ['panel:apps'],
};

/** What each project settings file needs to be written. Roles are admin-only. */
export const METADATA_ACCESS: Readonly<Record<MetadataKind, readonly AccessFeature[] | undefined>> = {
  // Ignoring an audit finding is part of working in the Audits panel.
  audits: ['panel:audits', 'settings:audits'],
  componentSources: ['settings:folders'],
  components: ['component:edit'],
  folders: ['settings:folders'],
  // Column guides are a view preference kept with the project; anyone who sees the canvas sets them.
  guide: undefined,
  // The Settings list and the panel's "Hide" menu both write the hidden paths.
  instructions: ['settings:instructions', 'instructions:edit'],
  pages: ['panel:pages'],
  publish: ['publish'],
  roles: ['settings:roles'],
  styles: ['panel:selectors'],
};

/** The features that allow `channel` with `payload`, or undefined when it is not gated. */
export function channelAccess(channel: IpcChannel, payload: unknown): readonly AccessFeature[] | undefined {
  if (channel === 'project:writeMetadata') {
    const write = record(record(payload)['write']);
    const kind = write['kind'];
    const found = Object.entries(METADATA_ACCESS).find(([name]) => name === kind);
    assert(found !== undefined, 'A parsed metadata write names a known kind');
    return found[1];
  }
  const features = CHANNEL_ACCESS[channel];
  assert(features === undefined || features.length > 0, 'A gated channel names at least one feature');
  return features;
}
