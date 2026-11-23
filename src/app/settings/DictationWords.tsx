// Settings → AI → Dictation → Vocabulary and Snippets: the person's own words (dictationVocabulary.ts).
// Vocabulary is a list of chips, each a word written the person's way, optionally with what Whisper
// hears instead; names from the open project are offered as one-click suggestions. Snippets are a
// trigger to say and the text it writes, listed with a search. Everything is edited in the app's own
// dialogs and kept on this computer (dictationStore.ts), never shared.
import { useEffect, useMemo, useState } from 'react';
import {
  parseSnippet,
  parseVocabularyEntry,
  VOCABULARY_LIMITS,
  type DictationWords,
  type Snippet,
  type VocabularyEntry,
} from '../../../shared/properties/voice/dictationVocabulary';
import { normalizeWords } from '../../../shared/properties/voice/dictationVocabulary';
import { aiMentions } from '../../features/ai/aiBridge';
import { useTranslate } from '../../lib/i18n/useTranslate';
import { confirmDialog } from '../../ui/ConfirmDialog';
import { CloseIcon, PencilIcon, PlusIcon, TrashIcon } from '../../ui/Icons';
import Popup from '../../ui/Popup';
import { SearchField } from '../../ui/SearchField';
import { Switch } from '../../ui/Switch';
import { SettingsEmpty, SettingsRow } from './SettingsLayout';

/** Project names offered as vocabulary at once. */
const SUGGESTIONS_MAX = 12;

export function DictationWordsRows({
  words,
  projectPath,
  onChange,
}: {
  readonly words: DictationWords;
  /** The project open in this window, whose component names are suggested; none on the welcome screen. */
  readonly projectPath: string | undefined;
  readonly onChange: (words: DictationWords) => void;
}) {
  const translate = useTranslate();
  const [wordOpen, setWordOpen] = useState(false);
  const [snippetEdit, setSnippetEdit] = useState<{ readonly kind: 'new' } | { readonly kind: 'edit'; readonly snippet: Snippet } | undefined>(undefined);
  const [search, setSearch] = useState('');
  const suggestions = useProjectNames(projectPath, words.vocabulary);
  const addWord = (entry: VocabularyEntry): void => onChange({ ...words, vocabulary: [...words.vocabulary, entry] });
  const shown = words.snippets.filter((snippet) => {
    const query = normalizeWords(search);
    return query === '' || normalizeWords(`${snippet.trigger} ${snippet.expansion}`).includes(query);
  });
  const removeSnippet = async (snippet: Snippet): Promise<void> => {
    const answer = await confirmDialog({
      title: translate('dictation.words.snippets.deleteTitle'),
      body: translate('dictation.words.snippets.deleteBody', { trigger: snippet.trigger }),
      confirmLabel: translate('dictation.words.snippets.deleteConfirm'),
      danger: true,
    });
    if (answer === true) {
      onChange({ ...words, snippets: words.snippets.filter((each) => each !== snippet) });
    }
  };
  return (
    <>
      <SettingsRow label={translate('dictation.words.vocabulary.label')} info={translate('dictation.words.vocabulary.info')}>
        <button type="button" disabled={words.vocabulary.length >= VOCABULARY_LIMITS.entriesMax} onClick={() => setWordOpen(true)}>
          <PlusIcon size={12} /> {translate('dictation.words.vocabulary.add')}
        </button>
      </SettingsRow>
      {words.vocabulary.length === 0 ? (
        <SettingsEmpty icon={<PlusIcon size={16} />}>{translate('dictation.words.vocabulary.empty')}</SettingsEmpty>
      ) : (
        <div className="audits-chips dictation-words-chips">
          {words.vocabulary.map((entry) => (
            <span
              key={entry.word}
              className="audits-chip-item"
              title={entry.misheard === undefined ? undefined : translate('dictation.words.vocabulary.misheard', { misheard: entry.misheard })}
            >
              {entry.word}
              <button
                type="button"
                className="audits-chip-remove"
                aria-label={translate('dictation.words.vocabulary.remove', { word: entry.word })}
                onClick={() => onChange({ ...words, vocabulary: words.vocabulary.filter((each) => each !== entry) })}
              >
                <CloseIcon size={10} />
              </button>
            </span>
          ))}
        </div>
      )}
      {suggestions.length > 0 && (
        <div className="dictation-words-suggestions" aria-label={translate('dictation.words.vocabulary.suggestions')}>
          <span className="dictation-words-suggestions-label">{translate('dictation.words.vocabulary.suggestions')}</span>
          {suggestions.map((name) => (
            <button
              key={name}
              type="button"
              className="dictation-words-suggestion"
              aria-label={translate('dictation.words.vocabulary.suggestion', { word: name })}
              onClick={() => addWord({ word: name })}
            >
              <PlusIcon size={10} /> {name}
            </button>
          ))}
        </div>
      )}
      <SettingsRow label={translate('dictation.words.snippets.label')} info={translate('dictation.words.snippets.info')}>
        <button type="button" disabled={words.snippets.length >= VOCABULARY_LIMITS.snippetsMax} onClick={() => setSnippetEdit({ kind: 'new' })}>
          <PlusIcon size={12} /> {translate('dictation.words.snippets.add')}
        </button>
      </SettingsRow>
      {words.snippets.length === 0 ? (
        <SettingsEmpty icon={<PlusIcon size={16} />}>{translate('dictation.words.snippets.empty')}</SettingsEmpty>
      ) : (
        <div className="dictation-snippets">
          {words.snippets.length > 4 && (
            <SearchField
              label={translate('dictation.words.snippets.search')}
              value={search}
              clearLabel={translate('elements.panel.clearSearch')}
              onChange={setSearch}
            />
          )}
          {shown.length === 0 && <p className="dictation-snippets-empty">{translate('dictation.words.snippets.noMatch')}</p>}
          <ul className="dictation-snippets-list">
            {shown.map((snippet) => (
              <li key={snippet.trigger} className="dictation-snippet">
                <span className="dictation-snippet-trigger">{snippet.trigger}</span>
                <span className="dictation-snippet-expansion">{snippet.expansion.replace(/\s+/gu, ' ')}</span>
                <button
                  type="button"
                  className="ghost"
                  aria-label={translate('dictation.words.snippets.edit', { trigger: snippet.trigger })}
                  onClick={() => setSnippetEdit({ kind: 'edit', snippet })}
                >
                  <PencilIcon size={12} />
                </button>
                <button
                  type="button"
                  className="ghost"
                  aria-label={translate('dictation.words.snippets.delete', { trigger: snippet.trigger })}
                  onClick={() => void removeSnippet(snippet)}
                >
                  <TrashIcon size={12} />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {wordOpen && (
        <WordDialog
          taken={words.vocabulary.map((entry) => entry.word.toLowerCase())}
          onClose={() => setWordOpen(false)}
          onAdd={(entry) => {
            addWord(entry);
            setWordOpen(false);
          }}
        />
      )}
      {snippetEdit !== undefined && (
        <SnippetDialog
          initial={snippetEdit.kind === 'edit' ? snippetEdit.snippet : undefined}
          taken={words.snippets.filter((each) => snippetEdit.kind === 'new' || each !== snippetEdit.snippet).map((each) => normalizeWords(each.trigger))}
          onClose={() => setSnippetEdit(undefined)}
          onSave={(snippet) => {
            const rest = snippetEdit.kind === 'edit' ? words.snippets.filter((each) => each !== snippetEdit.snippet) : words.snippets;
            onChange({ ...words, snippets: [...rest, snippet] });
            setSnippetEdit(undefined);
          }}
        />
      )}
    </>
  );
}

// The open project's component names (PascalCase file names), as vocabulary suggestions; none without a project.
// The files are asked of the main process for the project Settings names, not through the AI panel's store: that
// store learns a project only when the panel opens, and asking it before then asserted and took Settings down.
function useProjectNames(projectPath: string | undefined, vocabulary: readonly VocabularyEntry[]): readonly string[] {
  const [names, setNames] = useState<readonly string[]>([]);
  useEffect(() => {
    setNames([]); // Another project, or none: the last one's names are not this one's.
    if (projectPath === undefined) {
      return undefined;
    }
    let live = true;
    aiMentions({ projectPath, query: '', kinds: ['file'] })
      .then((reply) => {
        if (!live || !reply.ok) {
          return;
        }
        const found = reply.value.flatMap((candidate) => {
          if (candidate.kind !== 'file') {
            return [];
          }
          const match = /([A-Z][A-Za-z0-9]{3,})\.astro$/u.exec(candidate.path);
          return match?.[1] === undefined ? [] : [match[1]];
        });
        setNames([...new Set(found)]);
      })
      .catch(() => undefined); // Suggestions are a convenience: a failed read leaves none, and the words stay editable.
    return () => {
      live = false;
    };
  }, [projectPath]);
  return useMemo(() => {
    const known = new Set(vocabulary.map((entry) => entry.word.toLowerCase()));
    return names.filter((name) => !known.has(name.toLowerCase())).slice(0, SUGGESTIONS_MAX);
  }, [names, vocabulary]);
}

function WordDialog({
  taken,
  onClose,
  onAdd,
}: {
  readonly taken: readonly string[];
  readonly onClose: () => void;
  readonly onAdd: (entry: VocabularyEntry) => void;
}) {
  const translate = useTranslate();
  const [word, setWord] = useState('');
  const [correcting, setCorrecting] = useState(false);
  const [misheard, setMisheard] = useState('');
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const submit = (): void => {
    if (word.trim() === '' || (correcting && misheard.trim() === '')) {
      setProblem(translate('dictation.words.dialog.required'));
      return;
    }
    if (taken.includes(word.trim().toLowerCase())) {
      setProblem(translate('dictation.words.dialog.duplicate'));
      return;
    }
    try {
      onAdd(parseVocabularyEntry(correcting ? { word, misheard } : { word }));
    } catch {
      setProblem(translate('dictation.words.dialog.tooLong'));
    }
  };
  return (
    <Popup className="modal dictation-words-dialog" role="dialog" label={translate('dictation.words.dialog.wordTitle')} onClose={onClose}>
      {({ close }) => (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <div className="modal-header">{translate('dictation.words.dialog.wordTitle')}</div>
          <div className="modal-body dictation-words-dialog-body">
            <label className="dictation-words-field">
              <span>{translate('dictation.words.dialog.word')}</span>
              <input
                autoFocus
                value={word}
                maxLength={VOCABULARY_LIMITS.wordCharsMax}
                placeholder={translate('dictation.words.dialog.wordPlaceholder')}
                onChange={(event) => setWord(event.currentTarget.value)}
              />
            </label>
            <div className="dictation-words-toggle">
              <Switch label={translate('dictation.words.dialog.correct')} checked={correcting} onToggle={() => setCorrecting((value) => !value)} />
              <span>{translate('dictation.words.dialog.correct')}</span>
            </div>
            {correcting && (
              <label className="dictation-words-field">
                <span>{translate('dictation.words.dialog.misheard')}</span>
                <input
                  value={misheard}
                  maxLength={VOCABULARY_LIMITS.wordCharsMax}
                  placeholder={translate('dictation.words.dialog.misheardPlaceholder')}
                  onChange={(event) => setMisheard(event.currentTarget.value)}
                />
              </label>
            )}
            {problem !== undefined && <p className="ai-compose-problem">{problem}</p>}
          </div>
          <div className="modal-footer">
            <button type="button" onClick={close}>
              {translate('ui.cancel')}
            </button>
            <button type="submit" className="primary">
              {translate('dictation.words.dialog.add')}
            </button>
          </div>
        </form>
      )}
    </Popup>
  );
}

function SnippetDialog({
  initial,
  taken,
  onClose,
  onSave,
}: {
  readonly initial: Snippet | undefined;
  readonly taken: readonly string[];
  readonly onClose: () => void;
  readonly onSave: (snippet: Snippet) => void;
}) {
  const translate = useTranslate();
  const [trigger, setTrigger] = useState(initial?.trigger ?? '');
  const [expansion, setExpansion] = useState(initial?.expansion ?? '');
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const title = translate(initial === undefined ? 'dictation.words.dialog.snippetTitle' : 'dictation.words.dialog.snippetEditTitle');
  const submit = (): void => {
    if (normalizeWords(trigger) === '' || expansion.trim() === '') {
      setProblem(translate('dictation.words.dialog.required'));
      return;
    }
    if (taken.includes(normalizeWords(trigger))) {
      setProblem(translate('dictation.words.dialog.duplicate'));
      return;
    }
    try {
      onSave(parseSnippet({ trigger, expansion }));
    } catch {
      setProblem(translate('dictation.words.dialog.tooLong'));
    }
  };
  return (
    <Popup className="modal dictation-words-dialog" role="dialog" label={title} onClose={onClose}>
      {({ close }) => (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <div className="modal-header">{title}</div>
          <div className="modal-body dictation-words-dialog-body">
            <label className="dictation-words-field">
              <span>{translate('dictation.words.dialog.trigger')}</span>
              <input
                autoFocus
                value={trigger}
                maxLength={VOCABULARY_LIMITS.triggerCharsMax}
                placeholder={translate('dictation.words.dialog.triggerPlaceholder')}
                onChange={(event) => setTrigger(event.currentTarget.value)}
              />
            </label>
            <label className="dictation-words-field">
              <span>{translate('dictation.words.dialog.expansion')}</span>
              <textarea
                rows={4}
                value={expansion}
                maxLength={VOCABULARY_LIMITS.expansionCharsMax}
                onChange={(event) => setExpansion(event.currentTarget.value)}
              />
            </label>
            {problem !== undefined && <p className="ai-compose-problem">{problem}</p>}
          </div>
          <div className="modal-footer">
            <button type="button" onClick={close}>
              {translate('ui.cancel')}
            </button>
            <button type="submit" className="primary">
              {translate('dictation.words.dialog.save')}
            </button>
          </div>
        </form>
      )}
    </Popup>
  );
}
