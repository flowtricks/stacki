// Settings → Instructions: the paths and patterns the Instructions panel leaves
// out, stored in the project's tracked `.stacki/instructions.json`
// (shared/properties/instructions.ts). The panel's "Hide file" and "Hide folder"
// write the same list. A pattern is anchored at the project root; `**/` reaches
// any depth. Each change saves at once, against the text it was read from.
import { useCallback, useEffect, useState } from 'react';
import { parseHiddenPattern, withHidden, withoutHidden, type InstructionSettings } from '../../../shared/properties/instructions';
import { can } from '../../../shared/properties/projectRoles';
import { useCurrentRole } from '../../lib/useCurrentRole';
import { CloseIcon } from '../../ui/Icons';
import '../../features/instructions/instructions.css';
import {
  onInstructionsChanged,
  readInstructionSettings,
  writeInstructionSettings,
  type StoredInstructionSettings,
} from '../../features/instructions/instructionsBridge';

type State =
  { readonly kind: 'loading' } | { readonly kind: 'error'; readonly message: string } | { readonly kind: 'ready'; readonly stored: StoredInstructionSettings };

export function InstructionsSettings({ projectPath }: { readonly projectPath: string }) {
  const role = useCurrentRole();
  const editable = can(role, 'settings:instructions') || can(role, 'instructions:edit');
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [draft, setDraft] = useState('');
  const [problem, setProblem] = useState<string>();
  const load = useCallback(() => {
    void readInstructionSettings(projectPath).then(
      (stored) => setState({ kind: 'ready', stored }),
      (failure: unknown) => setState({ kind: 'error', message: failure instanceof Error ? failure.message : String(failure) }),
    );
  }, [projectPath]);
  useEffect(load, [load]);
  useEffect(() => onInstructionsChanged(load), [load]);

  if (state.kind === 'loading') {
    return <div className="props-empty">Reading the hidden paths…</div>;
  }
  if (state.kind === 'error') {
    return (
      <div className="props-empty" role="alert">
        {state.message}
      </div>
    );
  }
  const save = async (next: InstructionSettings): Promise<void> => {
    try {
      const stored = await writeInstructionSettings(projectPath, next, state.stored.source);
      setState({ kind: 'ready', stored });
      setProblem(undefined);
    } catch (failure: unknown) {
      setProblem(failure instanceof Error ? failure.message : String(failure));
      load();
    }
  };
  const add = (): void => {
    let pattern: string;
    try {
      pattern = parseHiddenPattern(draft);
    } catch (failure: unknown) {
      setProblem(failure instanceof Error ? failure.message : String(failure));
      return;
    }
    if (state.stored.settings.hidden.includes(pattern)) {
      setProblem(`${pattern} is already hidden.`);
      return;
    }
    const next = withHidden(state.stored.settings, pattern);
    if (!next.ok) {
      setProblem(next.error);
      return;
    }
    setDraft('');
    void save(next.value);
  };
  const hidden = state.stored.settings.hidden;
  return (
    <div className="app-settings-section instructions-settings" aria-label="Hidden instructions">
      <p className="app-settings-help">
        Files and folders the Instructions panel leaves out. Paths start at the project root: <code>docs/archive</code> hides that folder,{' '}
        <code>**/CHANGELOG.md</code> every changelog. Saved in <code>.stacki/instructions.json</code>, shared with everyone on the project.
      </p>
      {hidden.length === 0 ? (
        <div className="instructions-empty">Nothing is hidden. Build output and node_modules are never listed.</div>
      ) : (
        <ul className="instructions-hidden-list">
          {hidden.map((pattern) => (
            <li key={pattern} className="instructions-hidden-row">
              <code>{pattern}</code>
              {editable && (
                <button
                  type="button"
                  className="ghost"
                  aria-label={`Show ${pattern} again`}
                  title="Show again"
                  onClick={() => void save(withoutHidden(state.stored.settings, pattern))}
                >
                  <CloseIcon size={12} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {editable && (
        <form
          className="instructions-hidden-add"
          onSubmit={(event) => {
            event.preventDefault();
            add();
          }}
        >
          <input
            type="text"
            aria-label="Path or pattern to hide"
            placeholder="docs/archive or **/CHANGELOG.md"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <button type="submit" disabled={draft.trim() === ''}>
            Hide
          </button>
        </form>
      )}
      {problem !== undefined && (
        <div className="instructions-form-problem" role="alert">
          {problem}
        </div>
      )}
    </div>
  );
}
