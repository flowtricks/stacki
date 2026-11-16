// Commands installed apps add to the CLI. Until the extension host is built this provides none, so the core CLI is complete without it.
import type { ExtensionProvider } from './cliExtensionTypes';

export async function loadExtensions(project: string): Promise<ExtensionProvider | undefined> {
  void project;
  return undefined;
}
