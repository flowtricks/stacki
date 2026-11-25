// One file the Files editor has open, as state: how it opened (text, media, or not openable), the text session
// (documentSession.ts: the disk's text, the draft, a conflict), and the bytes the session's base stands for, so a save
// is witnessed by the checksum it was edited from and line breaks and the byte-order mark go back as they were.
//
// Saves are explicit (⌘S / Ctrl+S or Save), as in VS Code: half-typed config never reaches a running dev server.
// An outside change reloads a clean editor and becomes a conflict for a dirty one; a deletion closes a clean editor
// and leaves a dirty one holding its text, to be recreated only when the person says so.
import { useCallback, useEffect, useRef, useState } from 'react';
import { assert } from '../../../shared/core/assert';
import type { Digest } from '../../../shared/core/brand';
import { normalizeLineBreaks, restoreLineBreaks, type NormalizedText } from '../../../shared/core/lineBreaks';
import { baseName, parentPath, type ExplorerContent, type ExplorerError, type ExplorerPath } from '../../../shared/ipc/fileExplorer';
import { changedOnDisk, edited, isDirty, openSession, resolved, type ConflictChoice, type DocumentSession } from '../../editor/documentSession';
import { createEntry, onFoldersChanged, readFile, writeFile } from './filesBridge';

export type FileLoad =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed'; readonly error: ExplorerError }
  | { readonly kind: 'text' }
  | { readonly kind: 'other'; readonly content: Exclude<ExplorerContent, { readonly kind: 'text' }> };

export type SaveOutcome = 'saved' | 'conflict' | 'missing' | 'failed';

interface TextState {
  readonly session: DocumentSession;
  /** The base's text as opened, with its line breaks: what a save restores the breaks from. */
  readonly opened: NormalizedText;
  readonly checksum: Digest;
  readonly byteOrderMark: boolean;
  /** The file was deleted on disk while the editor held unsaved text. */
  readonly missing: boolean;
}

export interface FileDocument {
  readonly load: FileLoad;
  readonly text: TextState | undefined;
  readonly saving: boolean;
  readonly dirty: boolean;
  readonly edit: (draft: string) => void;
  readonly save: () => Promise<{ readonly outcome: SaveOutcome; readonly error?: ExplorerError }>;
  readonly resolve: (choice: ConflictChoice) => void;
  readonly recreate: () => Promise<{ readonly outcome: SaveOutcome; readonly error?: ExplorerError }>;
}

export function useFileDocument(projectPath: string, path: ExplorerPath, onDeleted: () => void): FileDocument {
  const [load, setLoad] = useState<FileLoad>({ kind: 'loading' });
  const [text, setText] = useState<TextState | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const latest = useRef<TextState | undefined>(undefined);
  const deletedRef = useRef(onDeleted);
  deletedRef.current = onDeleted;
  const replace = useCallback((next: TextState | undefined) => {
    latest.current = next;
    setText(next);
  }, []);

  // The disk as it is now, folded into the session: reloads a clean editor, records a conflict for a dirty one.
  const reread = useCallback(async () => {
    const read = await readFile(projectPath, path);
    const current = latest.current;
    if (current === undefined) {
      return;
    }
    if (!read.ok) {
      if (read.error.code !== 'missing') {
        return;
      }
      if (!isDirty(current.session)) {
        deletedRef.current();
        return;
      }
      replace({ ...current, missing: true });
      return;
    }
    if (read.value.kind !== 'text') {
      return;
    }
    if (read.value.checksum === current.checksum) {
      return;
    }
    const theirs = normalizeLineBreaks(read.value.text);
    const next = changedOnDisk(current.session, theirs.text);
    const adopted = next.conflict === undefined && next.base === theirs.text;
    replace({
      session: next,
      opened: adopted ? theirs : current.opened,
      checksum: adopted ? read.value.checksum : current.checksum,
      byteOrderMark: adopted ? read.value.byteOrderMark : current.byteOrderMark,
      missing: false,
    });
  }, [projectPath, path, replace]);

  useEffect(() => {
    let active = true;
    // The same editor with a new path is its file renamed or moved (the host gives a new opening a new editor): the
    // session, unsaved text included, carries over while the file at the new path holds the bytes it was read from.
    const carried = latest.current;
    if (carried === undefined) {
      setLoad({ kind: 'loading' });
    }
    void readFile(projectPath, path).then(
      (read) => {
        if (!active) {
          return;
        }
        if (carried !== undefined && read.ok && read.value.kind === 'text' && read.value.checksum === carried.checksum) {
          replace({ ...carried, session: { ...carried.session, file: path } });
          setLoad({ kind: 'text' });
          return;
        }
        if (carried !== undefined) {
          replace(undefined);
        }
        if (!read.ok) {
          setLoad({ kind: 'failed', error: read.error });
          return;
        }
        if (read.value.kind !== 'text') {
          setLoad({ kind: 'other', content: read.value });
          return;
        }
        const opened = normalizeLineBreaks(read.value.text);
        replace({ session: openSession(path, opened.text), opened, checksum: read.value.checksum, byteOrderMark: read.value.byteOrderMark, missing: false });
        setLoad({ kind: 'text' });
      },
      () => {
        if (active) {
          setLoad({ kind: 'failed', error: { code: 'filesystem', names: [], detail: undefined } });
        }
      },
    );
    return () => {
      active = false;
    };
  }, [projectPath, path, replace]);

  // A change in the file's folder may be this file: read it again.
  useEffect(() => {
    const folder = parentPath(path);
    return onFoldersChanged((directories) => {
      if (folder !== undefined && directories.includes(folder)) {
        void reread();
      }
    });
  }, [path, reread]);

  const edit = useCallback(
    (draft: string) => {
      const current = latest.current;
      if (current !== undefined) {
        replace({ ...current, session: edited(current.session, draft) });
      }
    },
    [replace],
  );

  const save = useCallback(async (): Promise<{ readonly outcome: SaveOutcome; readonly error?: ExplorerError }> => {
    const current = latest.current;
    if (current === undefined) {
      return { outcome: 'failed' };
    }
    if (current.missing) {
      return { outcome: 'missing' };
    }
    if (current.session.conflict !== undefined) {
      return { outcome: 'conflict' };
    }
    if (!isDirty(current.session)) {
      return { outcome: 'saved' };
    }
    setSaving(true);
    const draft = current.session.draft;
    const disk = restoreLineBreaks(current.opened, draft);
    try {
      const written = await writeFile(projectPath, { path, text: disk, byteOrderMark: current.byteOrderMark, base: current.checksum });
      const now = latest.current;
      assert(now !== undefined, 'save: the document is still open');
      if (written.ok) {
        // Typing that came after the save started stays a draft over the new base.
        replace({ ...now, session: { ...now.session, base: draft }, opened: normalizeLineBreaks(disk), checksum: written.value.checksum });
        return { outcome: 'saved' };
      }
      if (written.error.code === 'conflict') {
        await reread();
        return { outcome: 'conflict' };
      }
      if (written.error.code === 'missing') {
        replace({ ...now, missing: true });
        return { outcome: 'missing' };
      }
      return { outcome: 'failed', error: written.error };
    } finally {
      setSaving(false);
    }
  }, [projectPath, path, reread, replace]);

  const resolve = useCallback(
    (choice: ConflictChoice) => {
      const current = latest.current;
      const conflict = current?.session.conflict;
      if (current === undefined || conflict === undefined) {
        return;
      }
      void readFile(projectPath, path).then((read) => {
        const now = latest.current;
        if (now === undefined || !read.ok || read.value.kind !== 'text') {
          return;
        }
        const theirs = normalizeLineBreaks(read.value.text);
        const session = resolved({ ...now.session, conflict: { ...conflict, theirs: theirs.text } }, choice);
        replace({ session, opened: theirs, checksum: read.value.checksum, byteOrderMark: read.value.byteOrderMark, missing: false });
      });
    },
    [projectPath, path, replace],
  );

  // A deleted file comes back empty, then takes the draft through an ordinary witnessed save.
  const recreate = useCallback(async () => {
    const current = latest.current;
    const parent = parentPath(path);
    if (current === undefined || parent === undefined) {
      return { outcome: 'failed' as const };
    }
    const created = await createEntry(projectPath, parent, baseName(path), 'file');
    if (!created.ok) {
      return { outcome: 'failed' as const, error: created.error };
    }
    const read = await readFile(projectPath, path);
    if (!read.ok || read.value.kind !== 'text') {
      return { outcome: 'failed' as const };
    }
    const now = latest.current ?? current;
    const opened = normalizeLineBreaks(read.value.text);
    replace({
      session: { ...now.session, base: opened.text, conflict: undefined },
      opened,
      checksum: read.value.checksum,
      byteOrderMark: false,
      missing: false,
    });
    return save();
  }, [projectPath, path, replace, save]);

  return { load, text, saving, dirty: text !== undefined && (isDirty(text.session) || text.missing), edit, save, resolve, recreate };
}
