// A destination's private deploy link. The saved link is never shown or sent back to the screen: only its host,
// masked. Replace and Remove are the only things to do with a saved one.
import type { DeployLinkState } from '../../../shared/properties/publishDeployLink';
import { useTranslate } from '../../lib/i18n/useTranslate';
import { FieldLabel } from './publishFields';
import { EMPTY_LINK_DRAFT, type LinkDraft } from './useCustomHostInfo';
import type { Translator } from '../../../shared/properties/i18n/messageRef';

interface Props {
  /** Absent while the saved state is being read. */
  readonly state: DeployLinkState | undefined;
  readonly draft: LinkDraft;
  readonly change: (draft: LinkDraft) => void;
  readonly remove: () => void;
}

export function PublishDeployLinkField({ state, draft, change, remove }: Props) {
  const translate = useTranslate();
  const label = translate('publish.custom.mode.link');
  const saved = state?.kind === 'saved' ? state : undefined;
  const blocked = state === undefined || state.kind === 'unsupported' || state.kind === 'unavailable';
  return (
    <div className="publish-field" aria-busy={state === undefined}>
      <FieldLabel label={label} hint={linkHint(state, translate)} />
      {saved !== undefined && !draft.replacing ? (
        <div className="publish-link-saved">
          <output className="publish-link-mask" aria-label={label} dir="ltr">
            {saved.mask}
          </output>
          <button type="button" onClick={() => change({ text: '', replacing: true })}>
            {translate('publish.custom.link.replace')}
          </button>
          <button type="button" onClick={remove}>
            {translate('publish.custom.link.remove')}
          </button>
        </div>
      ) : (
        <div className="publish-link-saved">
          <input
            // A password field: the link is not left readable on a shared screen while it is pasted.
            type="password"
            aria-label={label}
            value={draft.text}
            maxLength={2048}
            autoComplete="off"
            spellCheck={false}
            dir="ltr"
            disabled={blocked}
            placeholder={placeholder(state, translate)}
            onChange={(event) => change({ ...draft, text: event.target.value })}
          />
          {draft.replacing && (
            <button type="button" onClick={() => change(EMPTY_LINK_DRAFT)}>
              {translate('publish.custom.link.keep')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function placeholder(state: DeployLinkState | undefined, translate: Translator): string {
  if (state === undefined) {
    return translate('publish.common.loading');
  }
  return state.kind === 'unsupported' ? translate('publish.custom.link.desktopOnly') : 'https://…'; // i18n-ignore: a URL scheme.
}

function linkHint(state: DeployLinkState | undefined, translate: Translator): string {
  switch (state?.kind) {
    case 'unsupported':
      return translate('publish.custom.link.studio');
    case 'unavailable':
      return translate('publish.custom.link.unavailable');
    case 'other-repository':
      return translate('publish.custom.link.otherRepository');
    case 'saved':
    case 'none':
    case undefined:
      return translate('publish.custom.link.privacy');
  }
}
