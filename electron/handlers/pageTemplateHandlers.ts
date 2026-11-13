// The template form's IPC: a sample of an external source, the files a template
// will write, writing them, and saving a secret to the project's .env. Expected
// failures come back as messages for the form (RemoteResult); the renderer only
// ever receives parsed samples, never a reply body or a secret.

import { record, list } from '../../shared/core/boundary';
import type { RemoteResult } from '../../shared/properties/cmsRemote';
import { parseContentConfig } from '../app/mainValidation';
import { readContentConfig } from '../content/contentConfig';
import { listEntries } from '../content/contentEntries';
import type { CmsConnectionStore } from '../content/cmsConnectionStore';
import { sampleData, type SanityTarget } from '../content/dataSample';
import { applyPageTemplate, planPageTemplate, type PageTemplateHost } from '../content/pageTemplatePlan';
import { readProjectEnv, writeProjectSecret } from '../content/projectEnv';
import { DescribedError } from '../../shared/properties/describedError';
import { errorMessage, toPosix } from '../lib/mainHelpers';
import { git } from '../lib/nodeTools';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { collectionOf } from './cmsFiles';
import type { MainHost } from './mainHost';
import { translateMain } from '../lib/mainLocale';

/** What the handlers ask of the running preview (DevServers). */
export interface TemplatePreview {
  readonly restartForNewContentConfig: (devUrl: string) => Promise<boolean>;
  readonly restartForProjectEnv: (projectPath: string) => Promise<boolean>;
}

const PATHS_ATTEMPTS_MAX = 12;
const PATHS_ATTEMPT_DELAY_MS = 500;

export function registerPageTemplateHandlers(
  host: Pick<MainHost, 'ipcMain' | 'noteAppWrite' | 'send'>,
  preview: TemplatePreview,
  connections: CmsConnectionStore,
): void {
  const { ipcMain, noteAppWrite, send } = host;
  ipcMain.handle('pageTemplate:sample', (_event, { projectPath, request }) =>
    answered(() =>
      sampleData(request, {
        fetch: (url, init) => fetch(url, init),
        env: readProjectEnv(projectPath),
        sanityConnection: (id) => sanityConnection(connections, projectPath, id),
        readCollection: async (name) => {
          const { collection } = await collectionOf(projectPath, name);
          return listEntries(projectPath, collection).entries.map((entry) => entry.data);
        },
      }),
    ),
  );
  ipcMain.handle('pageTemplate:plan', (_event, { projectPath, draft }) => answered(() => planPageTemplate(draft, templateHost(projectPath))));
  ipcMain.handle('pageTemplate:create', (_event, { projectPath, draft, devUrl, keyCopy }) =>
    answered(async () => {
      // Planned first: a template that cannot be written copies no key.
      await planPageTemplate(draft, templateHost(projectPath));
      if (keyCopy !== undefined) {
        const { token } = sanityConnection(connections, projectPath, keyCopy.connectionId);
        await writeProjectSecret(projectPath, { name: keyCopy.env, value: token }, git);
      }
      const created = await applyPageTemplate(draft, templateHost(projectPath));
      noteAppWrite();
      send('cms:changed', {});
      if (keyCopy !== undefined) {
        await preview.restartForProjectEnv(projectPath);
      }
      if (devUrl) {
        await preview.restartForNewContentConfig(devUrl);
        await waitForPaths(devUrl, toPosix(path.relative(projectPath, created.pagePath)));
      }
      return created;
    }),
  );
  ipcMain.handle('project:setEnv', (_event, { projectPath, name, value }) =>
    answered(async () => {
      const gitignore = await writeProjectSecret(projectPath, { name, value }, git);
      await preview.restartForProjectEnv(projectPath);
      return { gitignore };
    }),
  );
}

// Connections are kept by the project's real path (cmsConnectionStore.ts).
function sanityConnection(connections: CmsConnectionStore, projectPath: string, id: string): SanityTarget {
  const root = realpathSync(projectPath);
  const connection = connections.list(root).connections.find((candidate) => candidate.id === id);
  const token = connections.secret(root, id);
  if (connection?.kind !== 'sanity') {
    throw new Error(translateMain('error.pageTemplate.connectionGone'));
  }
  if (token === undefined) {
    throw new Error(translateMain('error.pageTemplate.keyUnreadable'));
  }
  return { projectId: connection.projectId, dataset: connection.dataset, token };
}

function templateHost(projectPath: string): PageTemplateHost {
  return {
    projectPath,
    readConfig: async () => parseContentConfig(await readContentConfig(projectPath, { force: true })),
    env: readProjectEnv(projectPath),
  };
}

// A new page and a new collection reach the dev server a moment after they
// reach the disk. The canvas asks for the page's paths once, on opening, so the
// reply waits until the server can answer with an entry, up to a few seconds.
async function waitForPaths(devUrl: string, rel: string): Promise<void> {
  for (let attempt = 0; attempt < PATHS_ATTEMPTS_MAX; attempt += 1) {
    if (await pathsReady(devUrl, rel)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, PATHS_ATTEMPT_DELAY_MS));
  }
}

async function pathsReady(devUrl: string, rel: string): Promise<boolean> {
  try {
    const response = await fetch(`${devUrl}/__avb/paths?p=${encodeURIComponent(rel)}`, { signal: AbortSignal.timeout(PATHS_ATTEMPT_DELAY_MS * 4) });
    const reply: unknown = await response.json();
    return list(record)(record(reply)['entries']).length > 0;
  } catch {
    // Still starting: the next attempt asks again.
    return false;
  }
}

async function answered<T>(run: () => Promise<T>): Promise<RemoteResult<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (error: unknown) {
    if (error instanceof DescribedError) {
      return {
        ok: false,
        message: error.problem.message.slice(0, 900),
        ...(error.problem.messageRef === undefined ? {} : { messageRef: error.problem.messageRef }),
      };
    }
    const message = errorMessage(error).slice(0, 900);
    return { ok: false, message: message || translateMain('error.pageTemplate.generic') };
  }
}
