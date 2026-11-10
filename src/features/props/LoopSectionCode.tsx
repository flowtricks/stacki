// Filters, Sort and Limit items as code: the `{}` a prop field has beside its
// name, here beside a section's, and the code box it swaps the section's
// controls for. The editor is ExprInput, the one a prop's own code view uses:
// this text is JavaScript or GROQ, so CssCodeEditor's `--` variables would mean
// nothing in it (`--` decrements here), and only that editor offers them.
//
// Nothing is written by opening a section or by the switch alone. Typed code is
// written when the box is left, once it passes the checks in loopSections.ts;
// until then the reason shows and the text stays. Code the controls cannot show
// opens here on its own and stays here, as code a prop's control cannot hold does.

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { Completion } from '@codemirror/autocomplete';
import ExprInput from '../../ui/ExprInput';
import { useCodeAccess } from '../../ui/CodeAccess';
import { BracesIcon } from '../../ui/Icons';
import { AppliedLabel } from './LoopRows';
import type { LoopSection, LoopSections } from '../../editor/loopSections';

/** What a list's sections need to be edited as code. */
export interface SectionCodeContext {
  readonly sections: LoopSections;
  /** Why the code cannot go in the section, or undefined when it can. */
  readonly problemOf: (section: LoopSection, code: string) => string | undefined;
  /** Why the section's controls would not show the code, or undefined when they would. */
  readonly refusalOf: (section: LoopSection, code: string) => string | undefined;
  /** Writes the section; a message says why it could not be. */
  readonly write: (section: LoopSection, code: string) => string | undefined;
  readonly completions: (section: LoopSection) => readonly Completion[];
  readonly placeholder: (section: LoopSection) => string;
}

const SECTION_TITLES: Readonly<Record<LoopSection, string>> = { filter: 'Filters', sort: 'Sort', limit: 'Limit items' };

export interface SectionCodeView {
  /** The `{}` for the section's heading; undefined where the section has no code. */
  readonly toggle: ReactNode;
  /** The section as code, in place of its controls, while that is what is shown. */
  readonly editor: ReactNode;
}

/** The section's `{}` and, while it is on, its code box. */
export function useSectionCode(section: LoopSection, context: SectionCodeContext | undefined): SectionCodeView {
  const access = useCodeAccess();
  const reading = context?.sections[section];
  const code = reading?.code ?? '';
  const custom = reading?.custom;
  const [open, setOpen] = useState(custom !== undefined);
  const [draft, setDraft] = useState(code);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  // A change from outside (a control, undo, the Code field) replaces what is shown.
  useEffect(() => {
    setDraft(code);
    setProblem(undefined);
  }, [code]);
  // Sticky: code that becomes readable mid-edit must not swap the box out from
  // under the caret. The switch back is asked for, as it is on a prop field.
  useEffect(() => {
    if (custom !== undefined) {
      setOpen(true);
    }
  }, [custom]);
  if (context === undefined) {
    return { toggle: undefined, editor: undefined };
  }
  const shown = open || custom !== undefined;
  const commit = (text: string): boolean => {
    const next = text.trim();
    if (next === code.trim()) {
      setProblem(undefined);
      return true;
    }
    const found = context.problemOf(section, next) ?? context.write(section, next);
    setProblem(found);
    return found === undefined;
  };
  const press = (): void => {
    if (!shown) {
      setOpen(true);
      return;
    }
    if (!commit(draft)) {
      return;
    }
    const refusal = context.refusalOf(section, draft);
    if (refusal === undefined) {
      setOpen(false);
    }
    setProblem(refusal);
  };
  const toggle = access ? <SectionCodeToggle section={section} on={shown} onPress={press} /> : undefined;
  return {
    toggle,
    editor: shown ? (
      <div className="loop-settings-section">
        <div className="loop-settings-header">
          <span className="loop-settings-label">
            {/* Reset clears the section's code as typing it away and leaving the box would. */}
            <AppliedLabel
              title={SECTION_TITLES[section]}
              reset={{
                applied: code.trim() !== '',
                onReset: () => {
                  commit('');
                },
              }}
            />
            {toggle}
          </span>
        </div>
        <div className="loop-section-code">
          <ExprInput
            value={draft}
            syncValue={code}
            placeholder={context.placeholder(section)}
            invalid={problem !== undefined}
            multiline={true}
            wrap={true}
            completions={context.completions(section)}
            onChange={(text) => {
              setDraft(text);
              setProblem(undefined);
            }}
            onCommit={commit}
          />
        </div>
        {problem !== undefined && (
          <div className="prop-field-note problem" role="alert">
            {problem}
          </div>
        )}
      </div>
    ) : undefined,
  };
}

function SectionCodeToggle(props: { readonly section: LoopSection; readonly on: boolean; readonly onPress: () => void }) {
  const title = SECTION_TITLES[props.section];
  return (
    <button
      type="button"
      className={`prop-expr-toggle${props.on ? ' on' : ''}`}
      title={props.on ? 'Use the controls' : 'Write as code'}
      aria-pressed={props.on}
      aria-label={`${title} as code`}
      onClick={props.onPress}
    >
      <BracesIcon size={12} />
    </button>
  );
}
