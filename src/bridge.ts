import type { PreloadBridge } from '../shared/preload-api';
// The renderer's typed face of window.avb. Raw IPC results are unknown; every
// call through here is parsed by the contract layer (shared/) before any
// renderer code sees it. A contract violation throws — a malformed payload is
// a programmer error (AGENTS.md §9), and crashing next to the channel beats
// corrupting the tree twenty renders later.
//
// New and converted code imports from here, not from window.avb.

// Vite consumes the ESM sources; dist/shared is CommonJS for Electron and Node.
import { toProjectPath, toFilePath } from '../shared/brand';
import { parseScanResult, type ScanResult } from '../shared/scan';
import { parsePageReadResult, type ParsePageResult } from '../shared/page-node';
import {
  parseSymbolReadResult,
  parseResolvePathResult,
  parseTextResult,
  parseOkResult,
  type SymbolReadResult,
  type ResolvePathResult,
} from '../shared/ipc';

// Raw results stay unknown. Renderer boundary modules parse them before use.
declare global {
  interface Window {
    avb: PreloadBridge;
  }
}

export async function scanProject(projectPath: string): Promise<ScanResult> {
  const result = await window.avb.scanProject(toProjectPath(projectPath));
  return parseScanResult(result);
}

export async function readPage(path: string): Promise<ParsePageResult & { readonly source: string }> {
  const result = await window.avb.readPage(toFilePath(path));
  return parsePageReadResult(result);
}

export async function parsePageSource(
  path: string,
  source: string,
): Promise<ParsePageResult & { readonly source: string }> {
  const result = await window.avb.parsePageSource({ pagePath: toFilePath(path), source });
  return parsePageReadResult(result);
}

export async function readText(projectPath: string, rel: string): Promise<string> {
  const result = await window.avb.readSourceText({ projectPath: toProjectPath(projectPath), rel });
  return parseTextResult(result).text;
}

export async function writeText(projectPath: string, rel: string, text: string): Promise<void> {
  const result = await window.avb.writeSourceText({ projectPath: toProjectPath(projectPath), rel, text });
  parseOkResult(result);
}

export async function readSymbol(
  projectPath: string,
  fromFile: string,
  spec: string,
  name: string,
): Promise<SymbolReadResult> {
  const result = await window.avb.readSymbolSource({
    projectPath: toProjectPath(projectPath),
    fromFile: toFilePath(fromFile),
    spec,
    name,
  });
  return parseSymbolReadResult(result);
}

export async function resolvePath(projectPath: string, fromFile: string, spec: string): Promise<ResolvePathResult> {
  const result = await window.avb.resolveSourcePath({
    projectPath: toProjectPath(projectPath),
    fromFile: toFilePath(fromFile),
    spec,
  });
  return parseResolvePathResult(result);
}
