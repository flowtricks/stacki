import { useMemo, useState } from 'react';
import { assert } from '../../../shared/core/assert';
import { gitBranchColors, gitBranchColor } from '../../lib/gitBranchColors';
import type { Conflict, ConflictChoice } from './gitConflictModel';
import { createConflictDraft, chooseConflictRegion, conflictChoiceText } from './conflictDraft';
import type { ConflictDraft, ConflictDrafts } from './conflictDraft';

export function useMergeConflict(conflict: Conflict, branches: readonly string[], trunk: string) {
  const [drafts, setDrafts] = useState<ConflictDrafts>(() =>
    Object.fromEntries(conflict.files.flatMap((file) => (file.parts === undefined ? [] : [[file.path, createConflictDraft(file)]]))),
  );
  const [whole, setWhole] = useState<Readonly<Record<string, 'ours' | 'theirs'>>>({});
  const first = conflict.files[0];
  assert(first !== undefined, 'Merge conflict: at least one file is required');
  const [openPath, setOpenPath] = useState(first.path);
  const [selected, setSelected] = useState<Readonly<Record<string, number>>>({});
  const file = conflict.files.find((entry) => entry.path === openPath) ?? first;
  const draft = drafts[file.path];
  const clashes = useMemo(() => draft?.regions.map((region) => region.clash) ?? [], [draft]);
  const active = selected[file.path] ?? 0;
  const ours = conflict.from ?? 'Current branch';
  const colors = gitBranchColors([...branches, ours, conflict.branch], trunk);
  const select = (index: number) => setSelected((current) => ({ ...current, [file.path]: index }));
  const edit = (value: ConflictDraft) => setDrafts((current) => ({ ...current, [file.path]: value }));
  const choose = (choice: ConflictChoice) =>
    setDrafts((current) => {
      const value = current[file.path];
      const clash = clashes[active];
      assert(value !== undefined, 'Merge editor: chosen draft exists');
      assert(clash !== undefined, 'Merge editor: chosen change exists');
      return {
        ...current,
        [file.path]: chooseConflictRegion(value, active, {
          choice,
          text: conflictChoiceText(clash, choice),
        }),
      };
    });
  const pendingFor = (path: string) => {
    const value = drafts[path];
    return value === undefined ? (whole[path] === undefined ? 1 : 0) : value.regions.filter((region) => region.review === 'pending').length;
  };
  const pending = conflict.files.reduce((sum, entry) => sum + pendingFor(entry.path), 0);
  return {
    files: conflict.files,
    drafts,
    whole,
    file,
    clashes,
    draft,
    active,
    ours,
    pending,
    pendingFor,
    setOpenPath,
    select,
    edit,
    choose,
    setWhole: (choice: 'ours' | 'theirs') => setWhole((current) => ({ ...current, [file.path]: choice })),
    colors: {
      ours: gitBranchColor(colors.get(ours) ?? 0),
      theirs: gitBranchColor(colors.get(conflict.branch) ?? 1),
    },
  };
}
export type MergeConflictModel = ReturnType<typeof useMergeConflict>;
