// A rich text edit typed on the canvas, on its way into the page. What was typed is never dropped without a word: the
// save is applied to the page as it is when it arrives (not to the page the catalog was built from, whose node handles
// a later read may have replaced), and does not depend on that catalog, which is rebuilt whenever the page, the
// components or the settings change. While the editor is between two readings of the page it is tried again, a bounded
// number of times. Content that changed under the editor is never written over. Every save ends in one of three ways:
// written, found to change nothing (the frame is told, so it shows the page's own nodes again), or refused with a
// toast (the frame is told, and keeps the typed words on screen in an open editor).
import { assert } from '../../../shared/core/assert';
import { LIMITS } from '../../../shared/core/limits';
import type { CanvasTextBreaks } from '../../../shared/properties/canvasText';
import type { CanvasSourceNode } from './canvasTextSource';

/** How one try at writing rich text ended. `busy`: nothing was written yet, and a later try may. */
export type RichWritten = 'written' | 'unchanged' | 'conflict' | 'refused' | 'busy';

/** How long a save waits for the editor to be ready for it: 50 tries, 100 ms apart. */
export const RICH_SAVE_RETRY = { triesMax: 50, intervalMs: 100 } as const;
/** How many open edits' starting content is remembered. */
const RICH_BASES_MAX = 16;

/** Which content an edit is of, as the frame says it with every message of the edit. */
export interface CanvasRichEdit {
  /** Names the edit, from its first draft to its save. */
  readonly edit: string;
  readonly file: string;
  /** The page path of the instance (rich), or of the edited words (a line of words). */
  readonly root: string;
  readonly breaks: CanvasTextBreaks;
}

export interface CanvasRichSave extends CanvasRichEdit {
  readonly html: string;
  /** The content as the editor opened on it. */
  readonly base: string;
}

/** What a save needs of the page open now. */
export interface CanvasRichDocument {
  readonly file: string;
  readonly nodes: readonly CanvasSourceNode[];
  readonly pathFor: (id: string) => string | undefined;
  readonly format?:
    | {
        readonly contentOwner?: (textId: string, breaks: CanvasTextBreaks | undefined) => string | undefined;
        readonly content?: (ownerId: string) => string | undefined;
        readonly richText?: (ownerId: string, html: string, bases: readonly string[]) => RichWritten;
      }
    | undefined;
}

export interface CanvasRichSaveHost {
  /** The page open now; undefined while it is being read again. */
  readonly document: () => CanvasRichDocument | undefined;
  /** The save could not be made: the person is told why, and the frame keeps what they typed. */
  readonly refused: (why: 'conflict' | 'refused', save: CanvasRichSave) => void;
  /** The page already reads this way: nothing will render, so the frame is told. */
  readonly unchanged: (save: CanvasRichSave) => void;
  readonly wait: (delayMs: number) => Promise<void>;
}

/** The writer of canvas rich text saves; it remembers what each open edit started from. */
export function createCanvasRichSaver(): {
  readonly opened: (edit: CanvasRichEdit, document: CanvasRichDocument | undefined) => void;
  /** Resolves once the save has ended; the first try is made before it returns. */
  readonly save: (save: CanvasRichSave, host: CanvasRichSaveHost) => Promise<void>;
} {
  // The page's own content when each edit began, read by the same code a save reads it with.
  const bases = new Map<string, string>();
  const attempt = async (save: CanvasRichSave, host: CanvasRichSaveHost): Promise<void> => {
    for (let tries = 0; tries <= RICH_SAVE_RETRY.triesMax; tries++) {
      const outcome = writeRichText(save, host.document(), bases.get(save.edit));
      switch (outcome) {
        case 'written':
          return;
        case 'unchanged':
          host.unchanged(save);
          return;
        case 'conflict':
        case 'refused':
          host.refused(outcome, save);
          return;
        case 'busy':
          await host.wait(RICH_SAVE_RETRY.intervalMs);
          break;
        default: {
          const exhaustive: never = outcome;
          return exhaustive;
        }
      }
    }
    host.refused('refused', save);
  };
  return {
    opened: (edit, document) => {
      if (bases.has(edit.edit)) {
        return;
      }
      const owner = document === undefined ? undefined : richOwnerOf(edit, document);
      const content = owner === undefined ? undefined : document?.format?.content?.(owner);
      if (content !== undefined) {
        bases.set(edit.edit, content);
        const oldest = bases.keys().next().value;
        if (bases.size > RICH_BASES_MAX && oldest !== undefined) {
          bases.delete(oldest);
        }
      }
    },
    save: (save, host) => attempt(save, host),
  };
}

function writeRichText(save: CanvasRichSave, document: CanvasRichDocument | undefined, opened: string | undefined): RichWritten {
  if (document === undefined) {
    return 'busy';
  }
  if (document.file !== save.file || document.format?.richText === undefined) {
    return 'refused';
  }
  const owner = richOwnerOf(save, document);
  if (owner === undefined) {
    return 'busy';
  }
  return document.format.richText(owner, save.html, opened === undefined ? [save.base] : [save.base, opened]);
}

// The node whose content the edit writes, by its place on the page: handles change when a page is read again.
export function richOwnerOf(edit: CanvasRichEdit, document: CanvasRichDocument): string | undefined {
  const pending: CanvasSourceNode[] = [...document.nodes];
  for (let visited = 0; visited < pending.length && visited < LIMITS.treeNodesMax; visited++) {
    const node = pending[visited];
    assert(node !== undefined, 'A visited node exists');
    if (node.id !== undefined && document.pathFor(node.id) === edit.root) {
      return edit.breaks === 'line' ? document.format?.contentOwner?.(node.id, 'line') : node.id;
    }
    pending.push(...(node.children ?? []));
  }
  return undefined;
}
