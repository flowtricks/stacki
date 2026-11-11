// The Instructions panel's calls to main (shared/properties/instructions.ts): each
// payload is checked before it leaves and each answer is parsed before use. The
// hidden paths travel through the project metadata bridge, like every tracked
// `.stacki/` setting, so Desktop and Studio read and write them the same way.
import { parseIpcPayload } from '../../../shared/ipc/ipcPayloads';
import { list, pathText, record } from '../../../shared/core/boundary';
import {
  INSTRUCTION_LIMITS,
  instructionSettingsSource,
  parseInstructionListing,
  parseInstructionWriteResult,
  readInstructionSettingsSource,
  type InstructionListing,
  type InstructionSettings,
  type InstructionWriteResult,
} from '../../../shared/properties/instructions';
import { readMetadata, writeMetadata } from '../../ipc/projectMetadataBridge';

export async function listInstructions(projectPath: string): Promise<InstructionListing> {
  const input = parseIpcPayload('instructions:list', { projectPath });
  return parseInstructionListing(await window.avb.listInstructions(input));
}

export async function readInstruction(projectPath: string, file: string): Promise<InstructionWriteResult> {
  const input = parseIpcPayload('instructions:read', { projectPath, file });
  return parseInstructionWriteResult(await window.avb.readInstruction(input));
}

export async function writeInstruction(
  projectPath: string,
  write: { readonly file: string; readonly source: string; readonly base: string },
): Promise<InstructionWriteResult> {
  const input = parseIpcPayload('instructions:write', { projectPath, ...write });
  return parseInstructionWriteResult(await window.avb.writeInstruction(input));
}

export async function createInstruction(projectPath: string, file: string, source: string): Promise<InstructionWriteResult> {
  const input = parseIpcPayload('instructions:create', { projectPath, file, source });
  return parseInstructionWriteResult(await window.avb.createInstruction(input));
}

export async function createInstructionFolder(projectPath: string, folder: string): Promise<InstructionWriteResult> {
  const input = parseIpcPayload('instructions:createFolder', { projectPath, folder });
  return parseInstructionWriteResult(await window.avb.createInstructionFolder(input));
}

export async function revealInstruction(projectPath: string, file: string): Promise<void> {
  const input = parseIpcPayload('instructions:reveal', { projectPath, file });
  await window.avb.revealInstruction(input);
}

/** The hidden paths and the file text they came from, which a save names as its base. */
export interface StoredInstructionSettings {
  readonly settings: InstructionSettings;
  readonly source: string | undefined;
}

export async function readInstructionSettings(projectPath: string): Promise<StoredInstructionSettings> {
  const file = await readMetadata(projectPath, 'instructions');
  const settings = readInstructionSettingsSource(file.source);
  if (!settings.ok) {
    throw new Error(settings.error);
  }
  return { settings: settings.value, source: file.source };
}

/** Saves the settings against the text they were read from; a change made elsewhere meanwhile is refused. */
export async function writeInstructionSettings(
  projectPath: string,
  settings: InstructionSettings,
  base: string | undefined,
): Promise<StoredInstructionSettings> {
  const source = instructionSettingsSource(settings);
  const saved = await writeMetadata(projectPath, base === undefined ? { kind: 'instructions', source } : { kind: 'instructions', source, base });
  announceInstructionsChanged([]);
  return { settings, source: saved.source };
}

// The panel and the Settings tab are separate trees; a save in one lists the other again.
// Main skips the app's own writes, so this is how the app hears them.
type ChangeListener = (files: readonly string[]) => void;
const listeners = new Set<ChangeListener>();
/** At most this many panels and tabs listen at once: one window has one of each. */
const LISTENERS_MAX = 16;

/** Hears every change: main's watcher (`instructions:changed`) and the app's own saves. Returns the unsubscribe. */
export function onInstructionsChanged(listener: ChangeListener): () => void {
  if (listeners.size >= LISTENERS_MAX) {
    throw new Error('Too many Instructions listeners');
  }
  listeners.add(listener);
  const off = window.avb.onInstructionsChanged((data: unknown) => listener(changedFiles(data)));
  return () => {
    listeners.delete(listener);
    off();
  };
}

export function announceInstructionsChanged(files: readonly string[]): void {
  for (const listener of listeners) {
    listener(files);
  }
}

/** The `instructions:changed` payload's files; none (list again) when it carries no usable list. */
function changedFiles(data: unknown): readonly string[] {
  const files: unknown = record(data)['files'];
  if (files === undefined) {
    return [];
  }
  const parsed = list(pathText)(files);
  return parsed.length > INSTRUCTION_LIMITS.filesMax ? [] : parsed;
}
