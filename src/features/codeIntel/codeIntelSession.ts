// One editor's questions to code intelligence (shared/ipc/codeIntel.ts): each carries the editor's text as it is now,
// and each answer is parsed before the editor sees it. Until a first answer has come back the editor's own grammar
// suggestions do not wait for one, so a project whose types are still being read feels like an editor, not a spinner.
import { parseIpcPayload } from '../../../shared/ipc/ipcPayloads';
import { CODE_INTEL_LIMITS, parseCodeIntelReply, UNAVAILABLE, type CodeIntelQuery, type CodeIntelReply } from '../../../shared/ipc/codeIntel';

/** The file an editor shows, asked for each time: a renamed file keeps its editor. */
export interface CodeIntelFile {
  readonly projectPath: string;
  /** Project-relative, `/`-separated. */
  readonly path: string;
}

export interface CodeIntelSession {
  readonly ask: (text: string, query: CodeIntelQuery) => Promise<CodeIntelReply>;
  /** Whether an answer has come back for this editor. */
  readonly ready: () => boolean;
}

/** Extensions whose files have something to ask about. */
const ANSWERED = /\.(astro|ts|tsx|mts|cts|js|jsx|mjs|cjs|css|scss|sass|less|pcss|postcss|mdx|html)$/i;

export function codeIntelAnswers(path: string): boolean {
  return ANSWERED.test(path);
}

export function codeIntelSession(file: () => CodeIntelFile | undefined): CodeIntelSession {
  let ready = false;
  return {
    ready: () => ready,
    ask: async (text, query) => {
      const shown = file();
      // A host without the channel (a test's stand-in) or a document past the bound keeps the plain editor.
      if (shown === undefined || !codeIntelAnswers(shown.path) || text.length > CODE_INTEL_LIMITS.documentCharsMax) {
        return UNAVAILABLE;
      }
      if (typeof window.avb?.codeIntel !== 'function') {
        return UNAVAILABLE;
      }
      try {
        const payload = parseIpcPayload('codeIntel:request', { projectPath: shown.projectPath, path: shown.path, text, query });
        const reply = parseCodeIntelReply(await window.avb.codeIntel(payload));
        ready = ready || reply.kind !== 'unavailable';
        return reply;
      } catch (error: unknown) {
        // Suggestions are an extra: a failed question leaves the editor as it is, and says why where a developer looks.
        console.warn('[code intelligence]', error);
        return UNAVAILABLE;
      }
    },
  };
}
