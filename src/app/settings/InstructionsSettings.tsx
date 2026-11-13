// Settings → Instructions: the paths and patterns the Instructions panel leaves
// out, stored in the project's tracked `.stacki/instructions.json`
// (shared/properties/instructions.ts). The panel's "Hide file" and "Hide folder"
// write the same list. A pattern is anchored at the project root; `**/` reaches
// any depth. Each change saves at once, against the text it was read from.
import { useCallback, useEffect, useState } from 'react';
import { parseHiddenPattern, withHidden, withoutHidden, type InstructionSettings } from '../../../shared/properties/instructions';
import { can } from '../../../shared/properties/projectRoles';
import { useCurrentRole } from '../../lib/useCurrentRole';
import { CloseIcon, HideIcon } from '../../ui/Icons';
import { Skeleton } from '../../ui/Skeleton';
import { useTranslate } from '../../lib/i18n/useTranslate';
import { SettingsEmptyState } from './SettingsEmptyState';
import { SettingsSection } from './SettingsLayout';
import '../../features/instructions/instructions.css';
import './instructionsSettings.css';
import {
  onInstructionsChanged,
  readInstructionSettings,
  writeInstructionSettings,
  type StoredInstructionSettings,
} from '../../features/instructions/instructionsBridge';

type State =
  { readonly kind: 'loading' } | { readonly kind: 'error'; readonly message: string } | { readonly kind: 'ready'; readonly stored: StoredInstructionSettings };

/** Common cases offered in the empty state. node_modules and build output are always hidden already (shared/properties/instructions.ts), so they are not offered. */
const SUGGESTIONS = ['docs/archive', '**/CHANGELOG.md', 'docs/drafts'] as const;

/** Rows the loading card draws: two, so the card is about as tall as the empty state it becomes. */
const SKELETON_ROWS = 2;

type Draft = { readonly kind: 'empty' } | { readonly kind: 'valid'; readonly pattern: string } | { readonly kind: 'invalid'; readonly message: string };

export function InstructionsSettings({ projectPath }: { readonly projectPath: string }) {
  const translate = useTranslate();
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
    // Skeleton rows in the card's own shape, so nothing jumps when the list arrives.
    return (
      <div className="instructions-settings">
        <SettingsSection title={translate('settings.instructions.hidden.title')} info={translate('settings.instructions.hidden.info')}>
          <div className="instructions-hidden-card" role="status" aria-busy="true">
            {Array.from({ length: SKELETON_ROWS }, (_, index) => (
              <Skeleton key={index} height="36px" radius="6px" />
            ))}
          </div>
        </SettingsSection>
      </div>
    );
  }
  if (state.kind === 'error') {
    return (
      <div className="props-empty" role="alert">
        {state.message}
      </div>
    );
  }
  const hidden = state.stored.settings.hidden;
  // One check serves the live message, the Hide button and Enter: what is typed is valid, or says why not.
  const check = (text: string): Draft => {
    if (text.trim() === '') {
      return { kind: 'empty' };
    }
    let pattern: string;
    try {
      pattern = parseHiddenPattern(text);
    } catch (failure: unknown) {
      return { kind: 'invalid', message: failure instanceof Error ? failure.message : String(failure) };
    }
    if (hidden.includes(pattern)) {
      return { kind: 'invalid', message: translate('settings.instructions.hidden.duplicate', { pattern }) };
    }
    return { kind: 'valid', pattern };
  };
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
  const hide = (pattern: string): void => {
    const next = withHidden(state.stored.settings, pattern);
    if (next.ok) {
      setDraft('');
      void save(next.value);
    } else {
      setProblem(next.error);
    }
  };
  const draftState = check(draft);
  const message = draftState.kind === 'invalid' ? draftState.message : problem;
  const suggestions = SUGGESTIONS.filter((suggestion) => !hidden.includes(suggestion));
  return (
    <div className="instructions-settings">
      <SettingsSection title={translate('settings.instructions.hidden.title')} info={translate('settings.instructions.hidden.info')}>
        <div className="instructions-hidden-card">
          {hidden.length === 0 ? (
            <SettingsEmptyState
              icon={<HideIcon size={16} />}
              title={translate('settings.instructions.hidden.empty.title')}
              hint={translate('settings.instructions.hidden.empty.hint')}
            >
              {editable &&
                suggestions.map((suggestion) => (
                  <button key={suggestion} type="button" className="instructions-hidden-chip" onClick={() => hide(suggestion)}>
                    {suggestion}
                  </button>
                ))}
            </SettingsEmptyState>
          ) : (
            <ul className="instructions-hidden-list">
              {hidden.map((pattern) => (
                <li key={pattern} className="instructions-hidden-row">
                  <code>{pattern}</code>
                  {editable && (
                    <button
                      type="button"
                      className="instructions-hidden-remove"
                      aria-label={translate('settings.instructions.hidden.show', { pattern })}
                      title={translate('settings.instructions.hidden.show.title')}
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
                if (draftState.kind === 'valid') {
                  hide(draftState.pattern);
                }
              }}
            >
              <input
                type="text"
                aria-label={translate('settings.instructions.hidden.input')}
                placeholder={translate('settings.instructions.hidden.placeholder')}
                spellCheck={false}
                value={draft}
                onChange={(event) => {
                  setDraft(event.target.value);
                  setProblem(undefined);
                }}
              />
              <button type="submit" disabled={draftState.kind !== 'valid'}>
                {translate('settings.instructions.hidden.hide')}
              </button>
            </form>
          )}
          {message !== undefined && (
            <div className="instructions-hidden-problem" role="alert">
              {message}
            </div>
          )}
        </div>
      </SettingsSection>
    </div>
  );
}
