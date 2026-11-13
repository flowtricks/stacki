import { useTranslate } from '../../lib/i18n/useTranslate';
import { useId, useState } from 'react';
import { CloseIcon, PlusIcon } from '../../ui/Icons';
import Popup from '../../ui/Popup';
import { branchNameError, sanitizeBranchName } from './branchName';

interface BranchCreateProps {
  readonly branches: readonly string[];
  readonly working: boolean;
  readonly name: string;
  readonly onName: (name: string) => void;
  readonly onCreate: (name: string) => void;
}

type BranchCreateState =
  | { readonly kind: 'closed' }
  | {
      readonly kind: 'open';
      readonly anchor: HTMLButtonElement;
      readonly top: number;
      readonly left: number;
      readonly width: number;
    };

export default function BranchCreate(props: BranchCreateProps) {
  const translate = useTranslate();
  const [state, setState] = useState<BranchCreateState>({ kind: 'closed' });
  const popupId = useId();
  const close = (): void => {
    setState({ kind: 'closed' });
    props.onName('');
  };
  return (
    <>
      <button
        type="button"
        className="git-add-branch"
        disabled={props.working}
        aria-haspopup="dialog"
        aria-expanded={state.kind === 'open'}
        aria-controls={state.kind === 'open' ? popupId : undefined}
        onClick={(event) => {
          if (state.kind === 'open') {
            close();
          } else {
            setState(branchCreatePosition(event.currentTarget));
          }
        }}
      >
        <PlusIcon size={12} />
        {translate('git.branch.new')}
      </button>
      {state.kind === 'open' && (
        <Popup
          mode="popover"
          role="dialog"
          label={translate('git.branch.new')}
          id={popupId}
          anchor={state.anchor}
          className="git-branch-editor"
          style={{ top: state.top, left: state.left, width: state.width }}
          onClose={close}
        >
          <BranchCreateForm {...props} onClose={close} />
        </Popup>
      )}
    </>
  );
}

function BranchCreateForm(props: BranchCreateProps & { readonly onClose: () => void }) {
  const translate = useTranslate();
  const inputId = useId();
  const errorId = useId();
  const error = branchNameError(props.name, props.branches, translate);
  const disabled = props.working || !props.name.trim() || Boolean(error);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (disabled) {
          return;
        }
        props.onCreate(props.name.trim());
        props.onClose();
      }}
    >
      <div className="git-branch-editor-heading">
        <span>{translate('git.branch.new')}</span>
        <button type="button" className="ghost" aria-label={translate('git.branch.closeNew')} onClick={props.onClose}>
          <CloseIcon size={12} />
        </button>
      </div>
      <label className="git-create-branch-label" htmlFor={inputId}>
        {translate('git.branch.name')}
      </label>
      <div className="git-create-branch">
        <input
          id={inputId}
          aria-label={translate('git.branch.newNameLabel')}
          autoFocus
          autoComplete="off"
          spellCheck={false}
          disabled={props.working}
          placeholder="new-branch-name"
          value={props.name}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? errorId : undefined}
          onChange={(event) => props.onName(sanitizeBranchName(event.target.value))}
        />
        <button type="submit" className="primary" disabled={disabled}>
          {translate('git.branch.create')}
        </button>
      </div>
      {error && (
        <div className="git-hint" id={errorId}>
          {error}
        </div>
      )}
    </form>
  );
}

function branchCreatePosition(anchor: HTMLButtonElement): BranchCreateState {
  const rectangle = anchor.getBoundingClientRect();
  // Keep the editor inside the viewport, including when the Git panel is narrow.
  const width = Math.min(Math.max(rectangle.width, 260), window.innerWidth - 16);
  return {
    kind: 'open',
    anchor,
    top: Math.max(8, Math.min(rectangle.bottom + 6, window.innerHeight - 180)),
    left: Math.max(8, Math.min(rectangle.left, window.innerWidth - width - 8)),
    width,
  };
}
