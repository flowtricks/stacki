// Applying audit fixes. A fix is a plan of attribute patches and inserted
// elements on nodes named by path (shared/page/auditFindings.ts); here each
// plan becomes edit gestures — the same propsGesture and insertGesture the
// inspectors use — so every byte goes through the intent path:
//
// - The open page: one gesture on its own edit queue, so the canvas shows it at
//   once and its save, conflict handling and undo are the page's own.
// - Any other file: read, stated against the bytes read, and sent with
//   sendGesture; the replies' inverse hunks are what Undo reverts.
//
// However many files a batch touches, it is one undo step: the other files'
// writes ride on the open page's step as its `files` work when the open page
// is among them (one ⌘Z takes back both), and are one undo command otherwise.
// Before an edit is planned, the node at its path must still be the element the
// finding saw; a file that moved since the audit is refused, never guessed at.
import { assert } from '../../../shared/core/assert';
import { toFilePath } from '../../../shared/core/brand';
import { encodeText } from '../../../shared/page/htmlText';
import type { Attr, PageNode } from '../../../shared/page/pageNode';
import type { AuditEdit, AuditFinding, AuditNewElement } from '../../../shared/page/auditFindings';
import type { EditBatchRequest, EditRequest } from '../../../shared/engine/editRequest';
import type { PageDiskRead, PageEditError, PageEdited } from '../../../shared/ipc/pageSave';
import type { Result } from '../../../shared/core/result';
import { nodeGesture, propsGesture, sequence } from '../../editor/editGestures';
import { insertGesture } from '../../editor/insertGestures';
import { nodeAtPath } from '../../editor/editorTree';
import { sendGesture, type AppliedEdit, type EditGesture, type EditsRecord } from '../../editor/pageEdits';
import { nodeId, type EditorModel, type EditorNode } from '../../editor/pageView';

export interface FixDeps {
  readonly projectPath: string;
  /** The open file, when it is editable: edits to it go on its own queue. */
  readonly open:
    { readonly path: string; readonly model: EditorModel; readonly commit: (gesture: EditGesture, files: StepWork | undefined) => boolean } | undefined;
  readonly readPage: (path: string) => Promise<PageDiskRead>;
  readonly send: (request: EditRequest) => Promise<Result<PageEdited, PageEditError>>;
  readonly sendBatch: (request: EditBatchRequest) => Promise<Result<PageEdited, PageEditError>>;
  /** A stylesheet's text, and its write over the bytes read: for fixes in files that are not markup. */
  readonly readText: (path: string) => Promise<string>;
  readonly writeText: (path: string, text: string) => Promise<void>;
  /** Records a step for files other than the open page. */
  readonly pushCommand: (command: { readonly label: string; readonly undo: () => Promise<void>; redo: () => Promise<void> }) => void;
}

/** The work a step does on files beside the open page (src/app/appTypes.ts StepFiles). */
export interface StepWork {
  readonly undo: () => Promise<void>;
  readonly redo: () => Promise<void>;
}

export interface FixOutcome {
  /** Files written, the open page included. */
  readonly files: number;
  readonly fixed: number;
  readonly failures: readonly { readonly file: string; readonly message: string }[];
}

/** The gesture a set of edits makes on `model`, or why it cannot be made. */
export function fixGesture(model: EditorModel, edits: readonly AuditEdit[], options: { readonly coalesceKey: string }): Result<EditGesture, string> {
  assert(edits.length > 0, 'fixGesture: a fix makes at least one edit');
  let gesture: EditGesture | undefined;
  const add = (next: EditGesture): void => {
    gesture = gesture === undefined ? next : sequence(gesture, next);
  };
  // Swaps inside one node's text are made together, from the end back, so each offset still names its bytes.
  const swaps = new Map<string, Extract<AuditEdit, { readonly tag: 'raw-text' | 'text' }>[]>();
  for (const edit of edits) {
    if (edit.tag === 'raw-text' || edit.tag === 'text') {
      const key = edit.path.join('.');
      swaps.set(key, [...(swaps.get(key) ?? []), edit]);
      continue;
    }
    const next = editGesture(model, edit, options.coalesceKey);
    if (!next.ok) {
      return next;
    }
    add(next.value);
  }
  for (const group of swaps.values()) {
    const next = swapGesture(model, group, options.coalesceKey);
    if (!next.ok) {
      return next;
    }
    add(next.value);
  }
  assert(gesture !== undefined, 'fixGesture: at least one gesture was made');
  return { ok: true, value: gesture };
}

// The node restated with its swaps made: a style block's inside, or a text node's words.
function swapGesture(
  model: EditorModel,
  group: readonly Extract<AuditEdit, { readonly tag: 'raw-text' | 'text' }>[],
  coalesceKey: string,
): Result<EditGesture, string> {
  const [first] = group;
  assert(first !== undefined, 'swapGesture: a group has an edit');
  const node = nodeAtPath<EditorNode>(model.nodes, first.path);
  if (first.tag === 'text') {
    if (node?.kind !== 'text' || node.value !== first.before || group.length !== 1) {
      return { ok: false, error: 'The text this change is for has changed; search again.' };
    }
    return { ok: true, value: nodeGesture(node.id, { ...node, value: first.value }, { coalesceKey, urgency: true }) };
  }
  if (node?.kind !== 'raw' || node.name.toLowerCase() !== first.expect.toLowerCase()) {
    return { ok: false, error: `The <${first.expect}> this fix is for has moved; audit again.` };
  }
  let inner = node.inner;
  const ordered = [...group].sort((left, right) => (right.tag === 'raw-text' && left.tag === 'raw-text' ? right.offset - left.offset : 0));
  for (const edit of ordered) {
    if (edit.tag !== 'raw-text' || inner.slice(edit.offset, edit.offset + edit.before.length) !== edit.before) {
      return { ok: false, error: 'The style block changed since the audit; audit again.' };
    }
    inner = `${inner.slice(0, edit.offset)}${edit.after}${inner.slice(edit.offset + edit.before.length)}`;
  }
  return { ok: true, value: nodeGesture(node.id, { ...node, inner }, { coalesceKey, urgency: true }) };
}

function editGesture(model: EditorModel, edit: AuditEdit, coalesceKey: string): Result<EditGesture, string> {
  if (edit.tag === 'frontmatter-append') {
    return { ok: true, value: frontmatterGesture(edit.code, coalesceKey) };
  }
  if (edit.tag === 'file-text' || edit.tag === 'raw-text' || edit.tag === 'text') {
    return { ok: false, error: 'A text swap is made with its node or its file, not on its own.' };
  }
  const node = nodeAtPath<EditorNode>(model.nodes, edit.path);
  if (node === undefined || node.name === undefined || node.name.toLowerCase() !== edit.expect.toLowerCase()) {
    return { ok: false, error: `The <${edit.expect}> this fix is for has moved; audit again.` };
  }
  switch (edit.tag) {
    case 'attributes':
      return { ok: true, value: propsGesture(node.id, edit.patch, { coalesceKey, urgency: true }) };
    case 'append-child': {
      const index = (node.children ?? []).length;
      return { ok: true, value: insertGesture(model, newElement(edit.element), { parentId: node.id, index }, { urgency: true }) };
    }
    default: {
      const exhaustive: never = edit;
      return exhaustive;
    }
  }
}

/** A statement added to the frontmatter's code, unless it is there already. It has no
 * specialized request: sending derives the frontmatter slot edit from the model (pageEdits.ts). */
export function frontmatterGesture(code: string, coalesceKey: string): EditGesture {
  assert(code.trim().length > 0, 'frontmatterGesture: adds a statement');
  return {
    coalesceKey,
    urgency: true,
    stream: undefined,
    request: () => undefined,
    apply: (model) => {
      if (model.extraFrontmatter.includes(code)) {
        return model;
      }
      const extraFrontmatter = model.extraFrontmatter.trim().length === 0 ? `${code}\n` : `${model.extraFrontmatter.replace(/\n*$/, '')}\n${code}\n`;
      return { ...model, extraFrontmatter };
    },
  };
}

const freshId = () => nodeId(`g${crypto.randomUUID().replace(/-/g, '')}`);
const VOID_ELEMENTS: ReadonlySet<string> = new Set(['meta', 'link', 'img', 'br', 'hr', 'input']);

/** The node an `append-child` edit inserts, with fresh handles. */
export function newElement(element: AuditNewElement): EditorNode {
  const props: Readonly<Record<string, Attr>> = element.props;
  const content = element.content;
  const children: PageNode[] | undefined = VOID_ELEMENTS.has(element.name)
    ? undefined
    : content === undefined
      ? []
      : [
          content.kind === 'text'
            ? { kind: 'text', id: freshId(), value: encodeText(content.value) }
            : { kind: 'expr', id: freshId(), value: `{${content.value}}` },
        ];
  assert(children === undefined || children.length <= 1, 'newElement: at most one child');
  return { kind: 'element', id: freshId(), name: element.name, props, children };
}

/** Applies every fix of `findings`, grouped by file, as one undo step. */
export async function applyFixes(findings: readonly AuditFinding[], deps: FixDeps, label: string): Promise<FixOutcome> {
  const byFile = new Map<string, AuditFinding[]>();
  for (const finding of findings) {
    const fix = finding.fix;
    if (fix !== undefined) {
      const list = byFile.get(fix.file) ?? [];
      list.push(finding);
      byFile.set(fix.file, list);
    }
  }
  const coalesceKey = `audit-fix:${crypto.randomUUID()}`;
  const failures: { file: string; message: string }[] = [];
  const written: { readonly path: string; readonly applied: readonly AppliedEdit[] }[] = [];
  let openGesture: { readonly gesture: EditGesture; readonly count: number } | undefined;
  const textWrites: TextWrite[] = [];
  let fixed = 0;
  for (const [file, list] of byFile) {
    const path = absolutePath(deps.projectPath, file);
    const edits = list.flatMap((finding) => finding.fix?.edits ?? []);
    if (deps.open !== undefined && samePath(deps.open.path, path)) {
      const gesture = fixGesture(deps.open.model, edits, { coalesceKey });
      if (gesture.ok) {
        openGesture = { gesture: gesture.value, count: list.length };
      } else {
        failures.push({ file, message: gesture.error });
      }
      continue;
    }
    if (!/\.(astro|mdx?)$/.test(file)) {
      const swapped = await fixTextFile(path, edits, deps);
      if (swapped.ok) {
        textWrites.push(swapped.value);
        fixed += list.length;
      } else {
        failures.push({ file, message: swapped.error });
      }
      continue;
    }
    const outcome = await fixFile(path, edits, deps, coalesceKey);
    if (outcome.ok) {
      written.push({ path, applied: outcome.value });
      fixed += list.length;
    } else {
      failures.push({ file, message: outcome.error });
    }
  }
  const work = written.length === 0 && textWrites.length === 0 ? undefined : joinedWork(stepWork(written, deps), textWork(textWrites, deps));
  if (openGesture !== undefined && deps.open !== undefined) {
    if (deps.open.commit(openGesture.gesture, work)) {
      fixed += openGesture.count;
      return { files: written.length + textWrites.length + 1, fixed, failures };
    }
    failures.push({ file: deps.open.path, message: 'The open page is busy saving; try again in a moment.' });
  }
  if (work !== undefined) {
    deps.pushCommand({ label, undo: work.undo, redo: work.redo });
  }
  return { files: written.length + textWrites.length, fixed, failures };
}

/** One stylesheet's write: the text before and after, for Undo and Redo. */
interface TextWrite {
  readonly path: string;
  readonly before: string;
  readonly after: string;
}

// A stylesheet's swaps, made from the end back on the text as it is now; refused when a swap's bytes moved.
async function fixTextFile(path: string, edits: readonly AuditEdit[], deps: FixDeps): Promise<Result<TextWrite, string>> {
  const before = await deps.readText(path);
  let after = before;
  const swaps = edits
    .filter((edit): edit is Extract<AuditEdit, { readonly tag: 'file-text' }> => edit.tag === 'file-text')
    .sort((left, right) => right.offset - left.offset);
  if (swaps.length !== edits.length) {
    return { ok: false, error: 'Only text swaps are made in a stylesheet.' };
  }
  for (const swap of swaps) {
    if (after.slice(swap.offset, swap.offset + swap.before.length) !== swap.before) {
      return { ok: false, error: 'The stylesheet changed since the audit; audit again.' };
    }
    after = `${after.slice(0, swap.offset)}${swap.after}${after.slice(swap.offset + swap.before.length)}`;
  }
  await deps.writeText(path, after);
  return { ok: true, value: { path, before, after } };
}

// Undo writes each stylesheet back while it still holds what the fix wrote; Redo the reverse.
function textWork(writes: readonly TextWrite[], deps: FixDeps): StepWork {
  const flip = (from: 'before' | 'after', to: 'before' | 'after') => async (): Promise<void> => {
    for (const write of writes) {
      const now = await deps.readText(write.path);
      if (now !== write[from]) {
        throw new Error(`${write.path.split(/[\\/]/).pop() ?? write.path} changed since the fix; it was left as it is.`);
      }
      await deps.writeText(write.path, write[to]);
    }
  };
  return { undo: flip('after', 'before'), redo: flip('before', 'after') };
}

function joinedWork(first: StepWork, second: StepWork): StepWork {
  return {
    undo: async () => {
      await second.undo();
      await first.undo();
    },
    redo: async () => {
      await first.redo();
      await second.redo();
    },
  };
}

async function fixFile(path: string, edits: readonly AuditEdit[], deps: FixDeps, coalesceKey: string): Promise<Result<readonly AppliedEdit[], string>> {
  const read = await deps.readPage(path);
  if (!read.editable) {
    return { ok: false, error: 'This file cannot be edited visually.' };
  }
  const gesture = fixGesture(read.model, edits, { coalesceKey });
  if (!gesture.ok) {
    return gesture;
  }
  const record: EditsRecord = { outcome: { tag: 'pending', waiting: 1, applied: [] } };
  const sent = await sendGesture({
    path,
    origin: { checksum: read.checksum, source: read.source, model: read.model },
    gesture: gesture.value,
    record,
    send: deps.send,
    sendBatch: deps.sendBatch,
  });
  switch (sent.tag) {
    case 'applied':
      return { ok: true, value: sent.replies.map((reply) => ({ checksum: reply.checksum, inverse: reply.inverse })) };
    case 'refused':
      return { ok: false, error: `The file changed before the fix could be written (${sent.reason}).` };
    case 'retry':
      return { ok: false, error: sent.message };
    case 'uncertain':
      return { ok: false, error: sent.message };
    default: {
      const exhaustive: never = sent;
      return exhaustive;
    }
  }
}

// Undo reverts each file's writes, newest first; redo reverts those reverts. Each
// run keeps the inverses its own replies returned, so the step can go back and forth.
function stepWork(written: readonly { readonly path: string; readonly applied: readonly AppliedEdit[] }[], deps: FixDeps): StepWork {
  let state = written.map((entry) => ({ path: entry.path, applied: entry.applied }));
  const flip = async (): Promise<void> => {
    const next: { path: string; applied: readonly AppliedEdit[] }[] = [];
    for (const entry of [...state].reverse()) {
      const done: AppliedEdit[] = [];
      for (const step of [...entry.applied].reverse()) {
        if (step.inverse.length === 0) {
          continue;
        }
        const answer = await deps.send({ pagePath: toFilePath(entry.path), authoredChecksum: step.checksum, edit: { tag: 'revert', hunks: step.inverse } });
        if (!answer.ok) {
          throw new Error(`${entry.path.split(/[\\/]/).pop() ?? entry.path} changed since the fix; it was left as it is.`);
        }
        done.push({ checksum: answer.value.checksum, inverse: answer.value.inverse });
      }
      next.unshift({ path: entry.path, applied: done });
    }
    state = next;
  };
  return { undo: flip, redo: flip };
}

export function absolutePath(projectPath: string, file: string): string {
  assert(!file.startsWith('/'), 'absolutePath: a finding names a project-relative file');
  const separator = projectPath.includes('\\') && !projectPath.includes('/') ? '\\' : '/';
  return `${projectPath.replace(/[\\/]+$/, '')}${separator}${separator === '\\' ? file.split('/').join('\\') : file}`;
}

function samePath(left: string, right: string): boolean {
  return left.split('\\').join('/') === right.split('\\').join('/');
}
