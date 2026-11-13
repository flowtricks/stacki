import { cleanError } from '../../lib/cleanError';
import { useTranslate, useTranslateDescribed } from '../../lib/i18n/useTranslate';
import { DescribedError, problemOf } from '../../../shared/properties/describedError';
import { useId, useRef, useState } from 'react';
import Popup from '../../ui/Popup';
import { parsePageRename, type PageRename } from '../../../shared/properties/pageRename';
import { pageRenameConflicts, type RenameInventory } from '../../../shared/properties/pageRenameConflicts';
import { err, ok, type Result } from '../../../shared/core/result';
import { pageExtension } from './pageTree';
import type { Described, Translator } from '../../../shared/properties/i18n/messageRef';
import { stripPageExtension } from '../../lib/pageName';

export interface RenamePageDialogProps {
  readonly item: Pick<PageRename, 'kind' | 'from'>;
  readonly inventory: RenameInventory;
  readonly save: (change: PageRename) => Promise<void>;
  readonly close: () => void;
}
type SaveState = { readonly kind: 'idle' } | { readonly kind: 'saving' } | { readonly kind: 'error'; readonly problem: Described };

export function RenamePageDialog(props: RenamePageDialogProps) {
  const translate = useTranslate();
  const title = translate(props.item.kind === 'page' ? 'pages.rename.page' : 'pages.rename.folder');
  const model = useRenameDialog(props, translate);
  return (
    <Popup className="modal" label={title} onClose={props.close} dismissible={!model.busy}>
      {({ close }) => (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void model.submit();
          }}
        >
          <div className="modal-header">{title}</div>
          <RenameFields model={model} />
          <div className="modal-footer">
            <button type="button" disabled={model.busy} onClick={close}>
              {translate('ui.cancel')}
            </button>
            <button type="submit" className="primary" disabled={!model.canApply}>
              {model.busy ? translate('pages.rename.applying') : translate('ui.apply')}
            </button>
          </div>
        </form>
      )}
    </Popup>
  );
}
function RenameFields({ model }: { readonly model: ReturnType<typeof useRenameDialog> }) {
  const translate = useTranslate();
  const id = useId();
  return (
    <div className="modal-body">
      <label htmlFor={id}>{translate('pages.rename.urlName')}</label>
      <input
        id={id}
        autoFocus
        maxLength={200}
        value={model.name}
        disabled={model.busy}
        spellCheck={false}
        aria-invalid={!!model.error}
        aria-describedby={id + '-error'}
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => model.change(event.target.value)}
      />
      <div id={id + '-error'} className="page-rename-error" role="alert">
        {model.error}
      </div>
    </div>
  );
}
function useRenameDialog({ item, inventory, save, close }: RenamePageDialogProps, translate: Translator) {
  const base = item.from.split('/').at(-1) ?? '';
  const [name, setName] = useState(item.kind === 'page' ? stripPageExtension(base) : base);
  const translateDescribed = useTranslateDescribed();
  const [state, setState] = useState<SaveState>({ kind: 'idle' });
  const pending = useRef(false);
  const parsed = renameCandidate(item, name, translate);
  const valid = parsed.ok ? pageRenameConflicts(parsed.value, inventory) : parsed;
  const error = !valid.ok ? translateDescribed(valid.error) : state.kind === 'error' ? translateDescribed(state.problem) : '';
  const busy = state.kind === 'saving';
  const canApply = !busy && valid.ok && parsed.ok && parsed.value.to !== item.from;
  const submit = async () => {
    if (pending.current || !canApply || !parsed.ok) {
      return;
    }
    pending.current = true;
    setState({ kind: 'saving' });
    try {
      await save(parsed.value);
      close();
    } catch (problem: unknown) {
      // A refusal that names a catalog sentence shows in the language on screen; anything else shows as received.
      setState({ kind: 'error', problem: problem instanceof DescribedError ? problem.problem : { message: cleanError(problem) } });
    } finally {
      pending.current = false;
    }
  };
  const change = (value: string) => {
    setName(value);
    setState({ kind: 'idle' });
  };
  return { name, change, error, busy, canApply, submit };
}
function renameCandidate(item: Pick<PageRename, 'kind' | 'from'>, name: string, translate: Translator): Result<PageRename> {
  const clean = name.trim();
  if (!clean || clean.includes('/') || clean.includes('\\')) {
    return err({ code: 'name', message: translate('pages.rename.separators') });
  }
  const directory = item.from.slice(0, item.from.lastIndexOf('/') + 1);
  const extension = item.kind === 'page' ? pageExtension(item.from) : '';
  const base = item.kind === 'page' ? stripPageExtension(clean) : clean;
  try {
    return ok(parsePageRename({ ...item, to: directory + base + extension }));
  } catch (problem: unknown) {
    const refusal = problem instanceof DescribedError ? problemOf(problem) : { message: cleanError(problem) };
    return err({ code: 'name', message: refusal.message, messageRef: refusal.messageRef });
  }
}
