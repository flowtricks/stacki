// The Settings panel's MCP channels (shared/properties/mcp.ts): the project's `.mcp.json` listed, read as
// text, one server revealed, a change or the whole text applied against a revision, and Codex's file read and
// changed. The work is electron/content/mcpFiles.ts; this resolves the project and keeps values out of every log:
// no handler here prints, and the replies hold summaries, one server's values on request, or the file's text.
//
// Codex's file is `~/.codex/config.toml` under the home folder `homeDirectory` names (the person's, unless a
// test supplies another). No channel takes a path for it.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { assert } from '../../shared/core/assert';
import {
  applyCodexChange,
  applyMcpChange,
  readCodexState,
  readMcpListing,
  readMcpText,
  revealCodexServer,
  revealMcpServer,
  saveMcpText,
} from '../content/mcpFiles';
import type { MainHost } from './mainHost';

export function registerMcpHandlers(host: Pick<MainHost, 'ipcMain' | 'assertInProject'>, homeDirectory: () => string = os.homedir): void {
  // The canonical project, checked to be the one the app has open.
  const root = (projectPath: string): string => {
    const canonical = fs.realpathSync(projectPath);
    host.assertInProject(path.join(canonical, 'package.json'));
    assert(path.isAbsolute(canonical), 'A project root is absolute');
    return canonical;
  };
  host.ipcMain.handle('mcp:read', (_event, input) => readMcpListing(root(input.projectPath)));
  host.ipcMain.handle('mcp:readText', (_event, input) => readMcpText(root(input.projectPath)));
  host.ipcMain.handle('mcp:reveal', (_event, input) => revealMcpServer(root(input.projectPath), input.revision, input.name));
  host.ipcMain.handle('mcp:apply', (_event, input) => applyMcpChange(root(input.projectPath), input.revision, input.change));
  host.ipcMain.handle('mcp:saveText', (_event, input) => saveMcpText(root(input.projectPath), input.revision, input.text));
  host.ipcMain.handle('mcp:readCodex', (_event, input) => {
    root(input.projectPath);
    return readCodexState(homeDirectory());
  });
  host.ipcMain.handle('mcp:revealCodex', (_event, input) => {
    root(input.projectPath);
    return revealCodexServer(homeDirectory(), input.revision, input.name);
  });
  host.ipcMain.handle('mcp:applyCodex', (_event, input) =>
    applyCodexChange(homeDirectory(), root(input.projectPath), input.revision, input.projectRevision, input.change),
  );
}
