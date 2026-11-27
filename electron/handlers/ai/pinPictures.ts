// The pictures of a parallel pin send as files, so each pin's own subagent can see them.
//
// Why files: a send of pins to Claude is one message, and the main agent starts a subagent per pin. A subagent gets
// only the words of the Agent tool's prompt (https://code.claude.com/docs/en/agent-sdk/subagents, "What subagents
// inherit"), never the message's images, so a path it can open with its Read tool is the way a picture reaches it.
// Checked with Claude Code 2.1.332 against a local fake API: with the read rule below a subagent's Read put the
// image into its own model request; without it the Read was refused.
//
// Bounds and privacy: the files are Stacki's own, under userData and never in the project; readable by this person
// only; at most one send's pictures per chat (a message's attachment bound). A chat's pictures go when the turn that
// carried them ends, unless a pin asked the person a question (the answer may start that pin again), and in any case
// at the chat's next pin send, when the chat is deleted and when the agents stop. What a crash leaves behind is
// removed once it is a day old; younger folders may be another running Stacki's.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { assert } from '../../../shared/core/assert';
import { err, ok, type Result } from '../../../shared/core/result';
import type { AiFailure, PromptAttachment } from '../../../shared/ipc/aiChat';
import { AI_LIMITS } from '../../../shared/properties/ai/aiLimits';
import type { ChatId } from '../../../shared/properties/ai/chatModel';
import type { PinBrief } from '../../../shared/properties/ai/commentPinBrief';
import { described } from './aiMessages';

export const PIN_PICTURE_LIMITS = {
  staleMsMin: 24 * 60 * 60 * 1000,
  /** Folders looked at by one sweep. */
  sweptMax: 2_000,
} as const satisfies Record<string, number>;

/** One of a pin's pictures as a file: where, and the note that says what it shows. */
export interface PinPictureFile {
  readonly path: string;
  readonly note: string | undefined;
}

export type PinPictureFiles = ReadonlyMap<number, readonly PinPictureFile[]>;

const EXTENSIONS: Readonly<Record<string, string>> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

/** A Claude Code read rule for everything under `folder` (`//` begins an absolute path; Windows drives as `//c/…`). */
export function readRuleFor(folder: string): string {
  const posix = folder.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_whole, drive: string) => `/${drive.toLowerCase()}`);
  assert(posix.startsWith('/'), 'readRuleFor: an absolute folder');
  return `Read(/${posix}/**)`;
}

export class PinPictures {
  private readonly written = new Set<string>();
  private readonly base: string;

  constructor(userData: string) {
    assert(path.isAbsolute(userData), 'PinPictures: userData is absolute');
    this.base = path.join(userData, 'ai', 'pin-pictures');
  }

  /** The rule a session of the project gets: reading its pin pictures' folder, and nothing else, without asking. */
  readRule(root: string): string {
    return readRuleFor(this.projectFolder(root));
  }

  /** Writes each pin's pictures, replacing the chat's earlier ones. */
  keep(root: string, chat: ChatId, brief: PinBrief, attachments: readonly PromptAttachment[]): Result<PinPictureFiles, AiFailure> {
    assert(attachments.length <= AI_LIMITS.attachmentsMax, 'PinPictures.keep: a message’s pictures are bounded');
    this.drop(root, chat);
    const files = new Map<number, readonly PinPictureFile[]>();
    try {
      const folder = path.join(this.projectFolder(root), chat);
      fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
      this.written.add(folder);
      for (const pin of brief.pins) {
        const own: PinPictureFile[] = [];
        for (const index of pin.images) {
          const attachment = attachments[index];
          if (attachment?.kind !== 'image') {
            continue; // The prompt builder refuses such a brief.
          }
          const extension = EXTENSIONS[attachment.mimeType];
          assert(extension !== undefined, 'PinPictures.keep: a parsed image type');
          const file = path.join(folder, `pin-${pin.number}-image-${own.length + 1}.${extension}`);
          fs.writeFileSync(file, Buffer.from(attachment.data, 'base64'), { mode: 0o600, flag: 'wx' });
          own.push({ path: file, note: attachment.note });
        }
        files.set(pin.number, own);
      }
    } catch (error: unknown) {
      this.drop(root, chat);
      return err({ code: 'agent-failed', ...described('ai.error.pinPictures', { detail: error instanceof Error ? error.message : String(error) }) });
    }
    return ok(files);
  }

  /** Removes the chat's pictures, if it has any. */
  drop(root: string, chat: ChatId): void {
    this.remove(path.join(this.projectFolder(root), chat));
  }

  /** Removes everything this run wrote: the agents are stopping. */
  dropAll(): void {
    for (const folder of [...this.written]) {
      this.remove(folder);
    }
    assert(this.written.size === 0, 'PinPictures.dropAll: nothing of this run is left');
  }

  /** Removes chat folders a day old or more, left by a run that ended without cleaning up. */
  sweep(nowMs: number): void {
    let looked = 0;
    for (const project of listing(this.base)) {
      for (const chat of listing(path.join(this.base, project))) {
        looked += 1;
        if (looked > PIN_PICTURE_LIMITS.sweptMax) {
          return;
        }
        const folder = path.join(this.base, project, chat);
        if (nowMs - fs.statSync(folder).mtimeMs >= PIN_PICTURE_LIMITS.staleMsMin) {
          this.remove(folder);
        }
      }
    }
  }

  // Resolved through links, so the rule and the paths name the folder as the agent's own check will see it.
  private projectFolder(root: string): string {
    const folder = path.join(this.base, createHash('sha256').update(root).digest('hex').slice(0, 24));
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    return fs.realpathSync(folder);
  }

  private remove(folder: string): void {
    fs.rmSync(folder, { recursive: true, force: true });
    this.written.delete(folder);
  }
}

function listing(folder: string): readonly string[] {
  try {
    return fs.readdirSync(folder);
  } catch {
    return []; // Nothing was ever written there.
  }
}
