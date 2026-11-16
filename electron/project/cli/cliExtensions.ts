// Commands installed apps contribute to the CLI, as an `ExtensionProvider` built from the project's apps on disk (cliAppLoad.ts).
//
// Role gating of an app command, all through the existing model (shared/properties/projectRoles.ts): the role must hold `cli:apps` (admin only by
// default, so write commands are unavailable to other roles until an admin grants it), hold the app's own grant `app:<appId>` (or `app:*`), and,
// when the command declares a `permission`, `appPermissionsFor(...)` must resolve that manifest permission to true for the role. The same check
// hides the command from `visibleCommands` and refuses it in `runCommand`, so the tool list and the call can never disagree.
import { can, appPermissionsFor } from '../../../shared/properties/projectRoles';
import type { CommandSpec } from '../../../shared/properties/cli/stackiCommands';
import type { CliError } from '../../../shared/properties/cli/stackiOutput';
import { clearAppFiles, registerAppFiles } from '../../../shared/properties/cli/stackiFiles';
import { appHandler } from './cliAppHandlers';
import { commandNamed, loadProjectApps, type LoadedApp } from './cliAppLoad';
import { findProject } from './cliFiles';
import type { ExtensionProvider } from './cliExtensionTypes';
import { roleDenial, type RoleContext } from './cliRole';

/**
 * The provider for the project at or above `project`, or undefined when no installed app declares a CLI section (or there is no project). It also
 * replaces the registry's app files for this run with those of the active apps, so `schema`, `config`, `doctor` and the MCP schema resources see
 * an install, an update or `apps disable` made since the last call (stackiFiles.ts says why the registry is module state).
 */
export async function loadExtensions(project: string): Promise<ExtensionProvider | undefined> {
  const root = findProject(project);
  if (!root.ok) {
    clearAppFiles();
    return undefined;
  }
  const apps = loadProjectApps(root.value).apps.filter((app) => app.section !== undefined);
  const active = apps.filter((app) => app.state.kind === 'active');
  const files = active.flatMap((app) => app.files);
  registerAppFiles(files);
  return apps.length === 0 ? undefined : providerOf(apps, files);
}

function providerOf(apps: readonly LoadedApp[], files: ExtensionProvider['files']): ExtensionProvider {
  const appOf = (spec: CommandSpec): LoadedApp | undefined => apps.find((app) => app.id === spec.appId);
  const declared = apps.flatMap((app) => app.specs);
  const denial = (role: RoleContext, spec: CommandSpec): CliError | undefined => {
    const app = appOf(spec);
    if (app === undefined) {
      return { code: 'refused', message: `"${spec.words.join(' ')}" belongs to no installed app.` };
    }
    const feature = roleDenial(role.view, spec.feature, spec.featureKey);
    if (feature !== undefined) {
      return feature;
    }
    if (!can(role.view, `app:${app.id}`)) {
      return {
        code: 'role-denied',
        message: `Role "${role.view.id}" may not run this command: it needs app:${app.id} (${spec.featureKey}). Ask a project admin to grant it in Settings > Roles.`,
      };
    }
    if (spec.permission !== undefined && appPermissionsFor(role.view, app.id, app.permissions)[spec.permission] !== true) {
      return {
        code: 'role-denied',
        message: `Role "${role.view.id}" may not run this command: the ${app.id} app permission "${spec.permission}" is off for it (${spec.featureKey}). Ask a project admin to turn it on in Settings > Roles.`,
      };
    }
    if (app.state.kind !== 'active') {
      return { code: 'app-untrusted', message: `The ${app.id} app's commands are off: ${app.state.kind === 'none' ? 'it declares none' : app.state.reason}` };
    }
    return undefined;
  };
  return {
    declared,
    files,
    denial,
    commands: (role) => declared.filter((spec) => appOf(spec)?.state.kind === 'active' && denial(role, spec) === undefined),
    find: (words) => declared.find((spec) => spec.words.length === words.length && spec.words.every((word, index) => word === words[index])),
    handler: (words) => {
      const [id, name] = words;
      const app = apps.find((candidate) => candidate.id === id);
      const command = app === undefined || name === undefined ? undefined : commandNamed(app, name);
      return app === undefined || command === undefined || words.length !== 2 ? undefined : appHandler(app, command);
    },
  };
}
